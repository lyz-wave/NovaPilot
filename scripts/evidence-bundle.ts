#!/usr/bin/env npx tsx
/**
 * S5 可复现证据包
 *
 * 将 7 类产物打包进 data/evidence-bundle/ 并生成 MANIFEST.sha256：
 *   1. bench-report        docs/bench-report.json（NovaBench 门禁报告）
 *   2. citation-audit      data/knowledge/citation-provenance.json
 *   3. defense-trace       从 checkpoints 表导出的防线链路摘要（JSON）
 *   4. provenance          data/eval/case-provenance.json
 *   5. scorecard-probe     docs/metric-scorecard.json
 *   6. env                 运行环境快照（Node 版本、关键 env 名称、平台）
 *   7. MANIFEST.sha256     所有产物的 SHA-256 哈希，一行一文件
 *
 * 用法：
 *   npx tsx scripts/evidence-bundle.ts [--out ./data/evidence-bundle]
 *
 * 设计约束：
 *   - 零外部依赖（只用 node:fs / node:path / node:crypto）
 *   - 从 SQLite 提取的摘要仅包含统计数据，不含原始用户输入
 */

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { createDb, queryAll } from "../src/server/db/client";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argVal(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const ROOT = resolve(import.meta.dirname, "..");
const outDir = resolve(argVal("--out") ?? join(ROOT, "data", "evidence-bundle"));
const dbPath = process.env.NOVAPILOT_DB_PATH ?? join(ROOT, "data", "novapilot.db");
const ts = new Date().toISOString().replace(/[:.]/g, "-");

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(name: string, data: unknown): string {
  const path = join(outDir, name);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  return path;
}

function copyFile(src: string, name: string): string | null {
  if (!existsSync(src)) {
    console.warn(`[evidence-bundle] WARNING: ${src} not found, skipping`);
    return null;
  }
  const dst = join(outDir, name);
  cpSync(src, dst);
  return dst;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(function main() {
  mkdirSync(outDir, { recursive: true });
  const artifacts: Array<{ label: string; path: string }> = [];
  const warnings: string[] = [];

  function track(label: string, path: string | null): void {
    if (path) artifacts.push({ label, path });
    else warnings.push(label);
  }

  // 1. bench-report
  track("bench-report", copyFile(join(ROOT, "docs", "bench-report.json"), "bench-report.json"));

  // 2. citation-audit
  track(
    "citation-audit",
    copyFile(
      join(ROOT, "data", "knowledge", "citation-provenance.json"),
      "citation-provenance.json",
    ),
  );

  // 3. defense-trace: checkpoint summary from SQLite
  let checkpointSummary: unknown = { note: "db not found" };
  if (existsSync(dbPath)) {
    const db = createDb(dbPath);
    const rows = queryAll<{ node: string; count: number }>(
      db,
      `SELECT node, COUNT(*) AS count FROM checkpoints GROUP BY node ORDER BY count DESC LIMIT 50`,
    );
    const totalTraces = queryAll<{ n: number }>(
      db,
      `SELECT COUNT(DISTINCT trace_id) AS n FROM checkpoints`,
    )[0]?.n ?? 0;
    checkpointSummary = {
      generatedAt: new Date().toISOString(),
      totalDistinctTraces: totalTraces,
      nodeBreakdown: rows,
    };
  }
  track("defense-trace", writeJson("defense-trace.json", checkpointSummary));

  // 4. provenance
  track(
    "provenance",
    copyFile(join(ROOT, "data", "eval", "case-provenance.json"), "case-provenance.json"),
  );

  // 5. scorecard-probe
  track(
    "scorecard-probe",
    copyFile(join(ROOT, "docs", "metric-scorecard.json"), "metric-scorecard.json"),
  );

  // 6. env snapshot
  const envSnapshot = {
    generatedAt: new Date().toISOString(),
    bundleTimestamp: ts,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    presentEnvKeys: Object.keys(process.env)
      .filter((k) => k.startsWith("NOVAPILOT_") || k.startsWith("NP_") || k === "NODE_ENV")
      .sort(),
  };
  track("env", writeJson("env-snapshot.json", envSnapshot));

  // 7. MANIFEST.sha256
  const manifestLines: string[] = [
    `# NovaPilot evidence bundle MANIFEST`,
    `# generated: ${new Date().toISOString()}`,
    ``,
  ];
  for (const { label, path } of artifacts) {
    const hash = sha256File(path);
    manifestLines.push(`${hash}  ${basename(path)}  # ${label}`);
  }
  if (warnings.length > 0) {
    manifestLines.push(``, `# WARNINGS (files not found, skipped):`, ...warnings.map((w) => `# - ${w}`));
  }
  const manifestPath = join(outDir, "MANIFEST.sha256");
  writeFileSync(manifestPath, manifestLines.join("\n") + "\n", "utf8");

  console.log(`[evidence-bundle] → ${outDir}`);
  for (const { label, path } of artifacts) {
    console.log(`  [ok]   ${label}: ${basename(path)}`);
  }
  for (const w of warnings) {
    console.log(`  [skip] ${w} (not found)`);
  }
  console.log(`  [ok]   MANIFEST.sha256 (${artifacts.length} entries)`);
})();
