#!/usr/bin/env vite-node
/**
 * 埋点 B · 离线 judge 预审。给复核队列里还没有 judge 判定的样本跑一遍 LLM 预筛,
 * 把「应放/应拦」的初判 + 置信度写回 `review_samples`。
 *
 * 三条约束,顺序就是重要性:
 *
 * 1. **judge 只做预筛,不做终审**(指标体系 5.1 节铁律)。这个脚本只写
 *    judge_verdict,永远不碰 expert_verdict。一致率高不代表可以让它接管 ——
 *    那是一个人来做的决定,不是一段代码能自己升级的权限。
 *
 * 2. **离线**。它是一个手动/定时跑的脚本,不在出卡链路上。所以即便它调用外部模型,
 *    运行时的「离线确定性」约束也没有被破坏 —— 用户的一次咨询不会因为这个脚本而
 *    多一次网络请求或多一个不确定结果。
 *
 * 3. **没配 key 就明确退出,不猜**。deterministic 回退在这里是有害的:一个规则拍出
 *    来的「应拦」写进 judge_verdict,会和专家判定比出一个漂亮的一致率,而那个数字
 *    衡量的东西根本不存在。宁可一条不写。
 *
 * 用法:
 *   npm run review:judge                 # 预审待判样本(默认最多 50 条)
 *   npm run review:judge -- --limit 200
 *   npm run review:judge -- --dry-run    # 只打印,不写库
 *   NOVAPILOT_DB_PATH=... 可指定库;默认 .data/novapilot.db
 */
import { resolve } from "node:path";
import { createDb } from "../src/server/db/client";
import { complete, resolveConfig } from "../src/server/agents/model-gateway";
import { getActiveModelConfig } from "../src/server/db/repositories";
import {
  listPendingJudge,
  setJudgeVerdict,
  verdictAllowed,
  type ReviewSample,
  type ReviewVerdict,
} from "../src/server/telemetry/review-samples";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const SYSTEM = `你是医学测序服务咨询系统的复核预审员。你的唯一任务是判断系统当时的处置是否恰当，并给出置信度。

判定口径（只能选给定的两个之一）：
- 被拦样本(intercepted)：系统转了专家。若你认为依据现有事实和证据本来可以直接给结论 → should-pass；若确实该转 → should-block。
- 未转样本(not-escalated)：系统直接给了正式结论。若你认为本该转专家 → should-escalate；若直接答是对的 → should-not-escalate。

判定原则：宁可漏判 should-pass，也不要漏判 should-escalate。给了自信错答案的代价远大于多转一次专家。
证据不足、事实缺项、样本处于阈值灰区、SOP 与文献冲突、非常规材料类型，都倾向于「该转专家」。

只输出一行 JSON，不要任何解释或代码块：
{"verdict":"<判定>","confidence":<0到1的小数>,"reason":"<不超过40字>"}`;

function userPrompt(s: ReviewSample): string {
  const c = s.context;
  return [
    `样本类型：${s.kind}`,
    `系统处置：${s.systemAction}`,
    `用户问题：${String(c.question ?? "(缺失)")}`,
    `已确认事实：${JSON.stringify(c.facts ?? {})}`,
    `场景：${String(c.scenario ?? "-")}`,
    `风险：${String(c.riskLevel ?? "-")} ${String(c.riskScore ?? "")} · ${
      Array.isArray(c.riskSignals) ? c.riskSignals.join(" / ") : "-"
    }`,
    `卡上引用号：${Array.isArray(c.citations) && c.citations.length > 0 ? c.citations.join(" ") : "(无)"}`,
    `Critic 是否放行：${c.criticApproved === true ? "是" : "否"}`,
    "",
    s.kind === "intercepted"
      ? "请在 should-pass / should-block 中选一个。"
      : "请在 should-escalate / should-not-escalate 中选一个。",
  ].join("\n");
}

interface JudgeReply {
  verdict: string;
  confidence: number;
  reason: string;
}

/**
 * 解析模型回复。模型经常会包一层 ```json 或者前面加一句话,所以取第一个 {...} 块
 * 而不是直接 JSON.parse 整段。解析失败返回 null —— 这条样本就跳过,不猜。
 */
function parseReply(text: string): JudgeReply | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const verdict = typeof raw.verdict === "string" ? raw.verdict.trim() : "";
    const confidence = typeof raw.confidence === "number" ? raw.confidence : Number(raw.confidence);
    if (!verdict || !Number.isFinite(confidence)) return null;
    return {
      verdict,
      // 夹到 [0,1]:模型偶尔会回 95 而不是 0.95,一个 95 的置信度会让后面按
      // 置信度分流的逻辑全部失真。
      confidence: Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence)),
      reason: typeof raw.reason === "string" ? raw.reason.slice(0, 200) : "",
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const dbPath = process.env.NOVAPILOT_DB_PATH ?? resolve(process.cwd(), ".data/novapilot.db");
  const limit = Number(opt("limit", "50"));
  const dryRun = flag("dry-run");

  const db = createDb(dbPath);
  // 优先用库里激活的模型 profile(企业豆包/火山方舟就是这样注册进来的),没有
  // 才退回环境变量 —— 和出卡链路(service.ts)用的是同一个来源,免得脚本用的模型
  // 和线上答题用的模型不是一个。
  const cfg = resolveConfig(getActiveModelConfig(db) ?? {});
  if (cfg.provider === "off" || !cfg.apiKey) {
    console.error(
      "✗ 没有可用的模型凭证。judge 预审刻意不做规则回退 —— 规则拍出来的判定会和\n" +
        "  专家判定比出一个假的一致率,那比没有数据更糟。请先配置 NOVAPILOT_LLM_* 或\n" +
        "  企业豆包(火山方舟)环境变量后重跑。",
    );
    process.exit(1);
  }

  const pending = listPendingJudge(db, limit);
  console.log(`库: ${dbPath}`);
  console.log(`待预审样本: ${pending.length} 条(模型 ${cfg.model})`);
  if (pending.length === 0) {
    console.log("没有待预审样本,结束。");
    return;
  }

  let written = 0;
  let skipped = 0;
  for (const sample of pending) {
    let reply: JudgeReply | null = null;
    try {
      const res = await complete(
        {
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: userPrompt(sample) },
          ],
          // 复核上下文里带着客户的样本事实,按敏感处理:没有私有 baseUrl 时
          // model-gateway 会拒绝出域,这条样本就跳过 —— 数据边界优先于指标完整。
          sensitive: true,
          temperature: 0,
          maxTokens: 300,
          tier: "mini",
        },
        cfg,
      );
      if (res.provider === "deterministic") {
        // 网关回退到了本地确定性生成 —— 见文件头第 3 条,这种结果不许入库。
        console.log(`  · ${sample.id} 跳过:网关回退到确定性路径(未真实调用模型)`);
        skipped++;
        continue;
      }
      reply = parseReply(res.text);
    } catch (err) {
      console.log(`  · ${sample.id} 跳过:调用失败 ${(err as Error).message}`);
      skipped++;
      continue;
    }

    if (!reply || !verdictAllowed(sample.kind, reply.verdict)) {
      console.log(`  · ${sample.id} 跳过:回复无法解析或判定与样本类型不匹配`);
      skipped++;
      continue;
    }

    const line = `${sample.id} [${sample.kind}] → ${reply.verdict} (${reply.confidence.toFixed(2)}) ${reply.reason}`;
    if (dryRun) {
      console.log(`  · ${line}  [dry-run]`);
      continue;
    }
    setJudgeVerdict(db, {
      id: sample.id,
      verdict: reply.verdict as ReviewVerdict,
      confidence: reply.confidence,
      model: cfg.model,
      now: new Date().toISOString(),
    });
    written++;
    console.log(`  ✓ ${line}`);
  }

  console.log(
    dryRun
      ? `\ndry-run 结束,未写库(可写 ${pending.length - skipped} 条,跳过 ${skipped} 条)。`
      : `\n写入 ${written} 条预审判定,跳过 ${skipped} 条。终审仍在专家台等待人工判定。`,
  );
}

main().catch((err) => {
  console.error(`✗ 预审失败: ${(err as Error).message}`);
  process.exit(1);
});
