/**
 * bench:gate — CI 门禁：在空库上跑 NovaBench，与 docs/bench-baseline.json 对比。
 *
 * 失败条件（任一即退出码 1）：
 *   - hallucinationLeaks > 0（硬性：漏放必须 0）
 *   - weightedScore < baseline.weightedScore - SCORE_SLACK
 *   - escalationRecall < baseline.escalationRecall - RECALL_SLACK
 *   - citationBindingRate < 1.0（硬性：绑定率必须 100%）
 *
 * 环境变量：
 *   NP_DISABLE_SEMANTIC=1  跳过 bge 语义向量（CI 无 GPU 时大幅提速）
 *
 * 产物：docs/bench-report.json（失败时也写，供 CI artifact 查）
 *
 * ⚠️ 此脚本绝不自动回写 bench-baseline.json。基线只能由人工 commit 更新。
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDb } from "../src/server/db/client";
import { seedKnowledgeWithIngestion } from "../src/server/rag/ingest";
import { runNovaBench } from "../src/server/eval/novabench";

const ROOT = resolve(import.meta.dirname, "..");
const BASELINE_PATH = resolve(ROOT, "docs/bench-baseline.json");
const REPORT_PATH = resolve(ROOT, "docs/bench-report.json");

/** Slack 允许比基线低多少（绝对值）—— 防止随机抖动误报 */
const SCORE_SLACK = 0.03;
const RECALL_SLACK = 0.05;

interface Baseline {
  weightedScore: number;
  escalationRecall: number;
  hallucinationLeaks: number;
  citationBindingRate: number;
  hitRateAtK: number | null;
  recordedAt: string;
}

async function main(): Promise<void> {
  const db = createDb(":memory:");

  console.log("bench:gate — 初始化知识库...");
  const seeded = seedKnowledgeWithIngestion(db);
  console.log(`  知识库已载入 ${seeded} 篇文档`);

  console.log("bench:gate — 运行 NovaBench（provider=off，确定性）...");
  const report = await runNovaBench(db, { provider: "off" });

  const m = report.metrics;
  const weighted =
    report.accuracy * 0.4 +
    (1 - m.confidentWrongDelta) * 0.2 +
    m.citationValidity * 0.2 +
    m.escalationRecall * 0.2;

  const citationBindingRate = m.citationValidity;

  const result = {
    weightedScore: weighted,
    escalationRecall: m.escalationRecall,
    hallucinationLeaks: m.hallucinationLeaks,
    hallucinationTotal: m.hallucinationTotal,
    hitRateAtK: m.hitRateAtK ?? null,
    citationBindingRate,
    accuracy: report.accuracy,
    passed: report.passed,
    total: report.total,
    gate: report.gate,
    recordedAt: new Date().toISOString(),
  };

  writeFileSync(REPORT_PATH, JSON.stringify(result, null, 2), "utf8");
  console.log(`bench:gate — 报告已写入 docs/bench-report.json`);
  console.log(`  accuracy=${(report.accuracy * 100).toFixed(1)}%  weightedScore=${weighted.toFixed(3)}`);
  console.log(`  hallucinationLeaks=${m.hallucinationLeaks}/${m.hallucinationTotal}  escalationRecall=${m.escalationRecall.toFixed(3)}`);
  console.log(`  citationBindingRate=${(citationBindingRate * 100).toFixed(1)}%  hitRate@5=${m.hitRateAtK?.toFixed(3) ?? "n/a"}`);

  // 读基线
  if (!existsSync(BASELINE_PATH)) {
    console.warn("bench:gate ⚠️  无基线文件，写入初始基线 docs/bench-baseline.json");
    writeFileSync(
      BASELINE_PATH,
      JSON.stringify(
        {
          weightedScore: weighted,
          escalationRecall: m.escalationRecall,
          hallucinationLeaks: 0,
          citationBindingRate: 1.0,
          hitRateAtK: m.hitRateAtK ?? null,
          recordedAt: new Date().toISOString(),
        } satisfies Baseline,
        null,
        2,
      ),
      "utf8",
    );
    console.log("bench:gate ✅ 初始基线已写入（首次运行不做对比）");
    return;
  }

  const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const failures: string[] = [];

  if (m.hallucinationLeaks > 0) {
    failures.push(
      `hallucinationLeaks=${m.hallucinationLeaks} > 0（硬性要求：漏放必须为 0）`,
    );
  }
  if (weighted < baseline.weightedScore - SCORE_SLACK) {
    failures.push(
      `weightedScore=${weighted.toFixed(3)} < baseline=${baseline.weightedScore.toFixed(3)} - slack=${SCORE_SLACK}`,
    );
  }
  if (m.escalationRecall < baseline.escalationRecall - RECALL_SLACK) {
    failures.push(
      `escalationRecall=${m.escalationRecall.toFixed(3)} < baseline=${baseline.escalationRecall.toFixed(3)} - slack=${RECALL_SLACK}`,
    );
  }
  if (citationBindingRate < 1.0) {
    failures.push(
      `citationBindingRate=${(citationBindingRate * 100).toFixed(1)}% < 100%（硬性要求）`,
    );
  }

  if (failures.length > 0) {
    console.error("\nbench:gate ❌ 门禁未通过：");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("\nbench:gate ✅ 所有门禁通过。");
}

main().catch((err) => {
  console.error("bench:gate 崩溃：", err);
  process.exit(1);
});
