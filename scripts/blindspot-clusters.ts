#!/usr/bin/env vite-node
/**
 * W5 · 知识盲区语义聚类。
 *
 * 输入：`retrieval_logs` 中末轮 `verified = 0` 的查询（≥ 3 次出现的簇才上报）。
 * 算法：确定性层次聚类 —— 按固定遍历顺序将每个查询归入第一个余弦相似度 ≥ 阈值
 *        的簇；否则新建簇。不用 k-means（随机初始化破坏离线可复现性）。
 * 输出：`data/blindspot-report.json`
 *
 * 跑两次输出逐字节一致。
 *
 * 用法：npm run blindspot:clusters
 *        NOVAPILOT_DB_PATH=...  可指定库（默认 .data/novapilot.db）
 *        NOVAPILOT_CLUSTER_THRESHOLD=0.75  相似度阈值（默认 0.75）
 */

import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { createDb, queryAll } from "../src/server/db/client";
import { embedSemantic, warmupSemantic, semanticUnavailableReason } from "../src/server/rag/semantic";

const dbPath = process.env.NOVAPILOT_DB_PATH ?? resolve(process.cwd(), ".data/novapilot.db");
const THRESHOLD = parseFloat(process.env.NOVAPILOT_CLUSTER_THRESHOLD ?? "0.75");
/** 簇内查询次数不够此阈值的不上报。 */
const MIN_CLUSTER_SIZE = 3;
/** 连续 N 周无命中才算「连续未命中」。 */
const MIN_CONSECUTIVE_UNHIT_WEEKS = 2;

console.log(`库: ${dbPath}`);
console.log(`聚类相似度阈值: ${THRESHOLD}`);

if (!(await warmupSemantic())) {
  console.error(`模型不可用。原因: ${semanticUnavailableReason()}`);
  console.error("先跑 npm run model:fetch 拉模型。");
  process.exit(1);
}

const db = createDb(dbPath);

// ── 1. 取末轮 verified=0 的查询 ──────────────────────────────────────────
const rawRows = queryAll<{ query: string; created_at: string }>(
  db,
  `WITH last_round AS (
     SELECT r.query, r.created_at
     FROM retrieval_logs r
     WHERE r.round = (
       SELECT MAX(r2.round) FROM retrieval_logs r2 WHERE r2.trace_id = r.trace_id
     )
       AND r.verified = 0
   )
   SELECT query, created_at FROM last_round
   ORDER BY created_at ASC, query ASC`,
);
db.close();

if (rawRows.length === 0) {
  console.log("无 verified=0 的末轮检索记录，输出空报告。");
  const out = { generatedAt: new Date().toISOString(), threshold: THRESHOLD, clusters: [] };
  const outPath = resolve(process.cwd(), "data/blindspot-report.json");
  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf-8");
  process.exit(0);
}

console.log(`原始盲区查询: ${rawRows.length} 条`);

// ── 2. 去重 & 嵌入（按首次出现排序保证确定性） ─────────────────────────────
// Map: query text → { vector, occurrences: [{created_at}] }
const queryMap = new Map<string, { vec: number[]; dates: string[] }>();
for (const row of rawRows) {
  const entry = queryMap.get(row.query);
  if (entry) {
    entry.dates.push(row.created_at);
  } else {
    queryMap.set(row.query, { vec: [], dates: [row.created_at] });
  }
}

// Embed unique queries in insertion order (deterministic).
const uniqueQueries = [...queryMap.keys()]; // insertion order = creation order
console.log(`唯一查询数: ${uniqueQueries.length}，开始嵌入…`);
let embedded = 0;
for (const q of uniqueQueries) {
  const vec = await embedSemantic(q);
  if (vec) {
    queryMap.get(q)!.vec = vec;
    embedded++;
  }
}
console.log(`嵌入成功 ${embedded} / ${uniqueQueries.length}`);

// ── 3. 确定性层次聚类 ────────────────────────────────────────────────────
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

interface Cluster {
  centroid: number[];
  queries: string[];
  dates: string[];
}

const clusters: Cluster[] = [];

for (const q of uniqueQueries) {
  const { vec, dates } = queryMap.get(q)!;
  if (vec.length === 0) continue; // embedding failed — skip, don't break determinism

  let assigned = false;
  for (const cluster of clusters) {
    if (cosine(vec, cluster.centroid) >= THRESHOLD) {
      cluster.queries.push(q);
      cluster.dates.push(...dates);
      // Update centroid as mean of all vectors in the cluster.
      const n = cluster.queries.length;
      for (let i = 0; i < cluster.centroid.length; i++) {
        cluster.centroid[i] = (cluster.centroid[i]! * (n - 1) + vec[i]!) / n;
      }
      assigned = true;
      break;
    }
  }
  if (!assigned) {
    clusters.push({ centroid: [...vec], queries: [q], dates: [...dates] });
  }
}

console.log(`聚类数: ${clusters.length}（含小于 ${MIN_CLUSTER_SIZE} 次的簇）`);

// ── 4. ISO 周工具 ─────────────────────────────────────────────────────────
function isoWeek(dateStr: string): string {
  const d = new Date(dateStr);
  const jan4 = new Date(d.getUTCFullYear(), 0, 4);
  const dayOfYear = Math.floor((d.getTime() - new Date(d.getUTCFullYear(), 0, 0).getTime()) / 864e5);
  const weekNum = Math.ceil((dayOfYear + jan4.getDay()) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/** All ISO weeks between two dates, inclusive. */
function weeksRange(startIso: string, endIso: string): string[] {
  const result: string[] = [];
  let cur = new Date(startIso);
  const end = new Date(endIso);
  while (cur <= end) {
    result.push(isoWeek(cur.toISOString()));
    cur.setDate(cur.getDate() + 7);
  }
  return [...new Set(result)].sort();
}

/** Compute how many consecutive weeks (from the most recent) have no dates. */
function consecutiveUnhitWeeks(clusterDates: string[]): number {
  if (clusterDates.length === 0) return 0;
  const allDates = [...clusterDates].sort();
  const hitWeeks = new Set(allDates.map(isoWeek));
  const firstDate = allDates[0]!;
  const lastDate = allDates[allDates.length - 1]!;
  const allWeeks = weeksRange(firstDate, new Date().toISOString());
  // Count from the most recent week backwards until we hit a week that was hit.
  let consecutive = 0;
  for (let i = allWeeks.length - 1; i >= 0; i--) {
    if (hitWeeks.has(allWeeks[i]!)) break;
    consecutive++;
  }
  // If the cluster's last date is in the past, count weeks since last hit.
  const lastHitWeek = isoWeek(lastDate);
  const weeksFromLastHit = allWeeks.lastIndexOf(allWeeks[allWeeks.length - 1]!) -
    allWeeks.indexOf(lastHitWeek);
  return Math.max(consecutive, weeksFromLastHit);
}

// ── 5. 过滤并格式化 ──────────────────────────────────────────────────────
interface ClusterReport {
  cluster: number;
  size: number;
  weeksUnhit: number;
  sampleQueries: string[];
}

const reported: ClusterReport[] = [];
let clusterIdx = 1;
for (const c of clusters) {
  const totalOccurrences = c.dates.length;
  if (totalOccurrences < MIN_CLUSTER_SIZE) continue;
  const weeksUnhit = consecutiveUnhitWeeks(c.dates);
  reported.push({
    cluster: clusterIdx++,
    size: totalOccurrences,
    weeksUnhit,
    sampleQueries: c.queries.slice(0, 5),
  });
}

// Sort by weeksUnhit desc, then size desc — most urgent first.
reported.sort((a, b) => b.weeksUnhit - a.weeksUnhit || b.size - a.size);

console.log(`上报簇数（≥ ${MIN_CLUSTER_SIZE} 次）: ${reported.length}`);
const urgentCount = reported.filter((c) => c.weeksUnhit >= MIN_CONSECUTIVE_UNHIT_WEEKS).length;
console.log(`其中连续 ≥ ${MIN_CONSECUTIVE_UNHIT_WEEKS} 周未命中的簇: ${urgentCount}`);

// ── 6. 写输出 ────────────────────────────────────────────────────────────
const output = {
  generatedAt: new Date().toISOString(),
  threshold: THRESHOLD,
  minClusterSize: MIN_CLUSTER_SIZE,
  minConsecutiveUnhitWeeks: MIN_CONSECUTIVE_UNHIT_WEEKS,
  totalQueryCount: rawRows.length,
  clusters: reported,
};
const outPath = resolve(process.cwd(), "data/blindspot-report.json");
mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
console.log(`输出: ${outPath}`);
