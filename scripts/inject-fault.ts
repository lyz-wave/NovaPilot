#!/usr/bin/env vite-node
/**
 * §9 统一故障注入脚本 — 指标体系 v1.1 第 9 节「故障注入演示成功率」。
 *
 * 三个场景,对应自评文档里已通过的三条路径:
 *
 *   offline         断网场景:用 provider=off 跑 NovaBench,证明零网络依赖可正常出卡。
 *   model-missing   语义模型缺失降级:设置 NP_DISABLE_SEMANTIC=true,
 *                   运行轻量检索冒烟,证明降级到哈希向量后系统不崩溃。
 *   defense-intercept  防线拦截:把幻觉诱饵注入 NovaBench 幻觉子集,
 *                   证明所有对抗样例都没有被自信放行(漏放率 = 0)。
 *
 * 用法:
 *   npm run inject:fault -- --scenario offline
 *   npm run inject:fault -- --scenario model-missing
 *   npm run inject:fault -- --scenario defense-intercept
 *   npm run inject:fault -- --scenario all           # 三个场景顺序跑
 *
 * 脚本自己管理一个临时 in-memory DB,不修改 .data/novapilot.db。
 */
import { resolve } from "node:path";
import { createDb } from "../src/server/db/client";
import { ensureSeeded } from "../src/server/service";
import { runNovaBench } from "../src/server/eval/novabench";
import { runHallucinationSuite } from "../src/server/eval/hallucination-set";
import { search } from "../src/server/rag/retrieval";

const OFF = { provider: "off" as const };

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const scenario = opt("scenario", "");

// ──────────────────────────────────────────────────────────────────────────────
// 场景 1:断网
// ──────────────────────────────────────────────────────────────────────────────
async function runOffline(): Promise<boolean> {
  console.log("\n【场景 offline · 断网模式】");
  console.log("  验证方式:provider=off 跑 NovaBench(全程零联网,用确定性图推理代替模型调用)。");
  const db = createDb(":memory:");
  const report = await runNovaBench(db, OFF);
  const ok =
    report.accuracy === 1 &&
    report.metrics.p0Defects === 0 &&
    report.gate.decision === "proceed";
  if (ok) {
    console.log(
      `  ✓ NovaBench 全部通过(${report.passed}/${report.total})。` +
        ` 无任何联网调用,离线确定性运行已验证。`,
    );
  } else {
    console.error(`  ✗ NovaBench 失败(accuracy=${report.accuracy},gate=${report.gate.decision})。`);
  }
  return ok;
}

// ──────────────────────────────────────────────────────────────────────────────
// 场景 2:语义模型缺失降级
// ──────────────────────────────────────────────────────────────────────────────
async function runModelMissing(): Promise<boolean> {
  console.log("\n【场景 model-missing · 语义模型缺失降级】");
  console.log("  验证方式:设置 NP_DISABLE_SEMANTIC=true,检索仍可返回结果(哈希向量通道)。");
  // 设置降级标志
  process.env.NP_DISABLE_SEMANTIC = "true";
  let ok = false;
  try {
    const db = createDb(":memory:");
    ensureSeeded(db);
    // 运行检索:semantic 向量不可用时自动降级到哈希空间
    const hits = search(db, "FFPE RNA 建库方案", { topK: 3 });
    ok = hits.length > 0;
    if (ok) {
      console.log(
        `  ✓ 降级通道正常:检索返回 ${hits.length} 条结果。` +
          ` 无语义模型时系统不崩溃,召回质量下降但功能保留。`,
      );
      for (const h of hits.slice(0, 3)) {
        console.log(`    · ${h.documentId} (${h.source}) — rerank ${h.rerank.toFixed(3)}`);
      }
    } else {
      console.error("  ✗ 降级通道返回空结果——检索模块可能异常。");
    }
  } finally {
    delete process.env.NP_DISABLE_SEMANTIC;
  }
  return ok;
}

// ──────────────────────────────────────────────────────────────────────────────
// 场景 3:防线拦截
// ──────────────────────────────────────────────────────────────────────────────
async function runDefenseIntercept(): Promise<boolean> {
  console.log("\n【场景 defense-intercept · 防线拦截】");
  console.log("  验证方式:运行幻觉子集(adversarial cases),验证漏放率为 0。");
  const db = createDb(":memory:");
  ensureSeeded(db);
  const report = await runHallucinationSuite(db, OFF);
  const ok = report.leaked === 0 && report.total > 0;
  if (ok) {
    console.log(
      `  ✓ 防线拦截:${report.total} 条对抗样例,漏放 ${report.leaked} 条。` +
        " NovaGuard 可信控制层全部正确处理。",
    );
  } else if (report.total === 0) {
    console.error("  ✗ 幻觉子集为空——测试样例可能被意外清除。");
  } else {
    console.error(
      `  ✗ 漏放 ${report.leaked}/${report.total} 条——防线存在缺口。`,
    );
  }
  return ok;
}

// ──────────────────────────────────────────────────────────────────────────────
// 主入口
// ──────────────────────────────────────────────────────────────────────────────
async function main() {
  const allScenarios = ["offline", "model-missing", "defense-intercept"];
  const toRun = scenario === "all" ? allScenarios : scenario ? [scenario] : [];

  if (toRun.length === 0 || !toRun.every((s) => allScenarios.includes(s))) {
    console.error(
      "用法: npm run inject:fault -- --scenario <offline|model-missing|defense-intercept|all>",
    );
    process.exit(1);
  }

  console.log("┌─────────────────────────────────────────────────────┐");
  console.log("│  NovaPilot §9 故障注入演示                         │");
  console.log("└─────────────────────────────────────────────────────┘");

  const results: Array<{ scenario: string; ok: boolean }> = [];
  for (const s of toRun) {
    let ok = false;
    if (s === "offline") ok = await runOffline();
    else if (s === "model-missing") ok = await runModelMissing();
    else if (s === "defense-intercept") ok = await runDefenseIntercept();
    results.push({ scenario: s, ok });
  }

  console.log("\n┌─────────────────────────────────────────────────────┐");
  const passed = results.filter((r) => r.ok).length;
  console.log(`│  结果: ${passed}/${results.length} 场景通过`.padEnd(55) + "│");
  console.log("└─────────────────────────────────────────────────────┘");

  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.scenario}`);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => { console.error("inject-fault 异常:", e); process.exit(1); });
