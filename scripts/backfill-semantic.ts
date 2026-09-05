#!/usr/bin/env vite-node
/**
 * B2-2 · 语义向量回填。给已入库但 `embedding_semantic` 为空的 chunk 补算向量。
 *
 * 什么时候需要跑:
 *  - 存量库(schema v2)升到 v3 之后;
 *  - 用同步 `indexDocument()` 入过库(种子库首页预热走的就是同步路径);
 *  - 之前没装模型、后来补上了 `models/` 目录。
 *
 * 幂等,可反复跑。模型不可用时报告原因并以非零码退出,不会静默「成功」。
 *
 * 用法:`npm run model:backfill`
 *       `NOVAPILOT_DB_PATH=...` 可指定库;默认 `.data/novapilot.db`
 *
 * 跑在 vite-node 上(vitest 自带,零新增依赖):src 树里用的是无扩展名 import,
 * Node 原生的类型剥离解析不了,而 vite-node 用的就是项目本来的 Vite 解析器。
 */
import { resolve } from "node:path";
import { createDb, queryAll } from "../src/server/db/client";
import { backfillSemanticVectors } from "../src/server/rag/retrieval";
import { modelDir, semanticUnavailableReason, warmupSemantic } from "../src/server/rag/semantic";

const dbPath = process.env.NOVAPILOT_DB_PATH ?? resolve(process.cwd(), ".data/novapilot.db");
console.log(`库: ${dbPath}`);
console.log(`模型目录: ${modelDir()}`);

if (!(await warmupSemantic())) {
  console.error(`模型不可用,无法回填。原因: ${semanticUnavailableReason()}`);
  console.error("先跑 npm run model:fetch 拉模型。");
  process.exit(1);
}

const db = createDb(dbPath);
const before = queryAll<{ n: number }>(
  db,
  "SELECT COUNT(*) AS n FROM chunks WHERE embedding_semantic IS NULL",
)[0]!.n;
console.log(`待回填 ${before} 条`);

const started = Date.now();
const { scanned, written } = await backfillSemanticVectors(db);
const elapsed = Date.now() - started;

const after = queryAll<{ n: number }>(
  db,
  "SELECT COUNT(*) AS n FROM chunks WHERE embedding_semantic IS NULL",
)[0]!.n;
console.log(
  `扫描 ${scanned} 条,写入 ${written} 条,耗时 ${elapsed} ms` +
    (written ? ` (${(elapsed / written).toFixed(1)} ms/条)` : ""),
);
console.log(`剩余空缺: ${after}`);
if (after > 0) {
  console.error("仍有空缺 —— 回填中途模型失效,检查上面的日志。");
  process.exit(1);
}
