#!/usr/bin/env vite-node
/**
 * B3-1/B3-2 · 知识摄取 CLI。把 `data/knowledge/*.md` 灌进检索库,并且**挂在金标
 * 回归门禁上**。
 *
 * 流程:解析 → 事务内入库 → 跑 NovaBench 金标回归 → 门禁 proceed 才 COMMIT,
 * stop 就 ROLLBACK。这不是「先灌再看」——门禁没过的知识一个 chunk 都不留。
 *
 * 为什么用 SQLite 事务而不是「失败后 removeDocument 挨个删」:
 * `indexDocument()` 是「按 doc id 删旧重插」的幂等 upsert,所以重跑一篇**已存在**
 * 的文档会先把旧 chunk 删掉。此时若靠 removeDocument 回滚,新的删掉了、旧的也回
 * 不来 —— 修一版文案没通过回归,反而把库里原来能用的那版弄丢了。事务是唯一能真
 * 正还原到摄取前状态的办法。
 *
 * ensureSeeded 放在 BEGIN 之前:种子库不属于本次摄取的内容,不该被回滚掉。
 * ingest_runs 日志行写在事务之外:回滚掉的摄取**更**需要留痕。
 *
 * 用法:
 *   npm run kb:ingest                  # 摄取 + 门禁
 *   npm run kb:ingest -- --no-gate     # 跳过门禁(会在日志里如实记为 gate-skipped)
 *   npm run kb:ingest -- --dry-run     # 只解析和分块,不写库
 *   npm run kb:ingest -- --dir <path>  # 换摄取目录
 *   NOVAPILOT_DB_PATH=... 可指定库;默认 .data/novapilot.db
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createDb, queryAll, type NovaDb } from "../src/server/db/client";
import { runNovaBench } from "../src/server/eval/novabench";
import {
  ingestKnowledgeDirectory,
  knowledgeDir,
  parseKnowledgeDirectory,
  type IngestReport,
} from "../src/server/rag/ingest";
import { semanticUnavailableReason, warmupSemantic } from "../src/server/rag/semantic";
import { ensureSeeded } from "../src/server/service";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const dir = resolve(opt("dir", knowledgeDir()));
const dbPath = process.env.NOVAPILOT_DB_PATH ?? resolve(process.cwd(), ".data/novapilot.db");
const noGate = flag("no-gate");
const dryRun = flag("dry-run");

console.log(`摄取目录: ${dir}`);
console.log(`库: ${dbPath}`);

// ── 1. 解析 ────────────────────────────────────────────────────────────────
// 解析阶段先独立跑一遍。有坏文档就整体不摄取 —— 知识库是引用来源,宁可一篇不入,
// 也不要入一半让 NovaGuard 反查到残缺的引用号。
const parsed = parseKnowledgeDirectory(dir);
if (parsed.errors.length > 0) {
  console.error(`\n解析失败 ${parsed.errors.length} 项,本次不摄取:`);
  for (const e of parsed.errors) console.error(`  · ${e}`);
  process.exit(1);
}
if (parsed.docs.length === 0) {
  console.error(`\n${dir} 下没有可摄取的 .md 文件(以 _ 开头的文件会被跳过)。`);
  process.exit(1);
}

const totalChunks = parsed.docs.reduce((n, d) => n + d.passages.length, 0);
console.log(`\n解析通过 ${parsed.docs.length} 篇,共 ${totalChunks} 个 chunk:`);
for (const d of parsed.docs) {
  const lens = d.passages.map((p) => p.length);
  const avg = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
  console.log(
    `  ${d.id.padEnd(20)} ${String(d.passages.length).padStart(3)} chunk` +
      `  均 ${avg} 字 (${Math.min(...lens)}~${Math.max(...lens)})  ${d.title}`,
  );
}

if (dryRun) {
  console.log("\n--dry-run:不写库,结束。");
  process.exit(0);
}

// ── 2. 入库(事务内) ──────────────────────────────────────────────────────
const db = createDb(dbPath);
ensureSeeded(db);

if (await warmupSemantic()) {
  console.log("\n语义模型就绪 —— 入库时同时写 512 维真实语义向量。");
} else {
  console.log(`\n语义模型不可用(${semanticUnavailableReason()})—— 只写哈希向量,`);
  console.log("检索仍可用但走降级通道。装好模型后跑 npm run model:backfill 补齐。");
}

const runId = `ING-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
let report: IngestReport;
let gate: Awaited<ReturnType<typeof runNovaBench>>["gate"] | null = null;
let benchLine = "";
let outcome: "committed" | "rolled-back" | "parse-failed" = "committed";
let detail = "";

db.exec("BEGIN");
try {
  const started = Date.now();
  report = await ingestKnowledgeDirectory(db, dir);
  console.log(`\n入库 ${report.docs.length} 篇 / ${report.chunks} chunk,耗时 ${Date.now() - started} ms`);

  if (noGate) {
    detail = "--no-gate:跳过金标回归门禁";
    console.log(`\n${detail}`);
    db.exec("COMMIT");
  } else {
    console.log("\n跑金标回归门禁(NovaBench,provider=off)…");
    const bench = await runNovaBench(db);
    gate = bench.gate;
    benchLine =
      `${bench.passed}/${bench.total} 通过 (准确率 ${(bench.accuracy * 100).toFixed(0)}%),` +
      `引用有效性 ${(bench.metrics.citationValidity * 100).toFixed(1)}%,` +
      `升级召回 ${(bench.metrics.escalationRecall * 100).toFixed(1)}%`;
    console.log(`  ${benchLine}`);
    console.log(`  门禁: ${gate.decision}(灰度上限 ${gate.maxTrafficPercent}%)`);

    if (gate.decision === "proceed") {
      db.exec("COMMIT");
      console.log("\n✓ 门禁通过,已提交。");
    } else {
      db.exec("ROLLBACK");
      outcome = "rolled-back";
      detail = `门禁未通过: ${gate.failed.join(", ")}`;
      console.error(`\n✗ ${detail} —— 已回滚,库回到摄取前状态。`);
    }
  }
} catch (err) {
  db.exec("ROLLBACK");
  outcome = "rolled-back";
  detail = `摄取异常: ${err instanceof Error ? err.message : String(err)}`;
  console.error(`\n✗ ${detail} —— 已回滚。`);
  report = { docs: [], chunks: 0, errors: [] };
}

// ── 3. 留痕(事务之外) ────────────────────────────────────────────────────
function logRun(db: NovaDb): void {
  db.prepare(
    `INSERT INTO ingest_runs
       (id, source_dir, doc_count, chunk_count, docs, parse_errors, gate, outcome, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    dir,
    report.docs.length,
    report.chunks,
    JSON.stringify(report.docs),
    JSON.stringify(parsed.errors),
    JSON.stringify(gate ? { ...gate, bench: benchLine } : { decision: "gate-skipped" }),
    outcome,
    detail,
    new Date().toISOString(),
  );
}
logRun(db);
console.log(`\n摄取记录: ${runId}(outcome=${outcome})`);

const stats = queryAll<{ docs: number; chunks: number }>(
  db,
  "SELECT (SELECT COUNT(*) FROM documents) AS docs, (SELECT COUNT(*) FROM chunks) AS chunks",
)[0]!;
console.log(`当前库: ${stats.docs} 篇文档 / ${stats.chunks} chunk`);

if (outcome === "rolled-back") process.exit(1);
