/**
 * B2 · 语义通道单测。
 *
 * 方案 5.2/5.4 把「降级」列为硬验收项:模型缺失时检索链路必须照常出结果,
 * 不是报错、也不是静默换向量。所以这个文件的重点不在「模型好用」,而在
 * **模型不可用时系统仍然正确**,以及两个向量空间的裁决不会被悄悄混算。
 *
 * 分三层:
 *  1. 降级契约    —— 不需要模型,任何机器上都跑;
 *  2. 空间裁决    —— 用合成的 512 维向量伪造「已回填」状态,不付模型成本;
 *  3. 真实模型    —— 缺 models/ 目录时自动跳过(24MB 二进制不进仓库)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb, queryAll, type NovaDb } from "../db/client";
import {
  backfillSemanticVectors,
  indexDocument,
  search,
  searchSemantic,
  searchWithDiagnostics,
  seedKnowledgeBase,
  type IndexableDocument,
} from "./retrieval";
import {
  SEMANTIC_DIM,
  embedSemantic,
  modelDir,
  modelPresent,
  resetSemanticState,
  semanticAvailable,
  semanticUnavailableReason,
  warmupSemantic,
} from "./semantic";

const DOC: IndexableDocument = {
  id: "E-SOP-SEM",
  source: "SOP",
  title: "语义通道测试文档",
  citation: "NV-SOP-SEM-001",
  version: "v1.0",
  appliesTo: "测试",
  validUntil: "2030-01-01",
  lang: "zh",
  validation: "verified",
  passages: [
    "FFPE 样本 DV200 处于 30%~50% 灰区时需要评估是否降级处理。",
    "低输入量 RNA 建库推荐使用超微量方案并补测数据量。",
    "差异表达分析需要做归一化与多重检验校正后再判定显著性。",
  ],
};

/** 造一条合法的 L2 归一化 512 维向量,用来伪造「已回填」而不加载模型。 */
function fakeSemanticVector(seed: number): number[] {
  const v = Array.from({ length: SEMANTIC_DIM }, (_, i) => Math.sin(seed * 0.37 + i * 0.11));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function semanticNullCount(db: NovaDb): number {
  return queryAll<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM chunks WHERE embedding_semantic IS NULL",
  )[0]!.n;
}

// ── 层 1:降级契约(不依赖模型)────────────────────────────────

describe("B2 · 降级契约(方案 5.4 硬验收项)", () => {
  let db: NovaDb;
  const savedDir = process.env.NP_EMBEDDING_MODEL_DIR;
  const savedDisable = process.env.NP_DISABLE_SEMANTIC;

  beforeEach(() => {
    db = createDb(":memory:");
    resetSemanticState();
  });

  afterEach(() => {
    // 环境变量必须还原,否则会污染同文件后面的真实模型用例。
    if (savedDir === undefined) delete process.env.NP_EMBEDDING_MODEL_DIR;
    else process.env.NP_EMBEDDING_MODEL_DIR = savedDir;
    if (savedDisable === undefined) delete process.env.NP_DISABLE_SEMANTIC;
    else process.env.NP_DISABLE_SEMANTIC = savedDisable;
    resetSemanticState();
    db.close();
  });

  /** 等价于「删掉 models 目录」—— 指向一个不存在的路径。 */
  function pointAtMissingModel(): string {
    const dir = path.join(os.tmpdir(), `np-no-model-${Date.now()}`);
    process.env.NP_EMBEDDING_MODEL_DIR = dir;
    resetSemanticState();
    return dir;
  }

  it("模型目录不存在时 modelPresent() 为假", () => {
    const dir = pointAtMissingModel();
    expect(fs.existsSync(dir)).toBe(false);
    expect(modelPresent(dir)).toBe(false);
  });

  it("模型文件不齐(只有 config.json)也判为不可用", () => {
    // 半个模型比没有模型更危险 —— 会一路走到 InferenceSession 才炸。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-partial-model-"));
    fs.writeFileSync(path.join(dir, "config.json"), "{}");
    expect(modelPresent(dir)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("模型缺失时 embedSemantic 返回 null 并给出可诊断的原因", async () => {
    pointAtMissingModel();
    expect(await embedSemantic("样本质量怎么判定")).toBeNull();
    expect(semanticUnavailableReason()).toMatch(/^model-missing:/);
  });

  it("模型缺失时 warmup/available 返回 false,不抛异常", async () => {
    pointAtMissingModel();
    await expect(warmupSemantic()).resolves.toBe(false);
    await expect(semanticAvailable()).resolves.toBe(false);
  });

  it("模型缺失时检索链路不中断,整体退回哈希向量空间", async () => {
    pointAtMissingModel();
    indexDocument(db, DOC);
    const { hits, diagnostics } = await searchSemantic(db, "FFPE 灰区怎么处理", { topK: 3 });
    // 关键:仍然有结果。降级只影响排序质量,不影响可用性。
    expect(hits.length).toBeGreaterThan(0);
    expect(diagnostics.vectorSpace).toBe("hash");
    expect(diagnostics.vectorSpaceReason).toBe("no-query-vector");
    // 证据字段照常绑定 —— 降级不能把引用号弄丢(那会直接触发 NovaGuard)。
    expect(hits[0]!.citation).toBe("NV-SOP-SEM-001");
  });

  it("模型缺失时入库仍然成功,只是语义列为空", () => {
    pointAtMissingModel();
    const n = indexDocument(db, DOC);
    expect(n).toBe(DOC.passages.length);
    expect(semanticNullCount(db)).toBe(DOC.passages.length);
    // 哈希向量列必须还在,否则降级检索也没得算。
    const row = queryAll<{ embedding: string }>(db, "SELECT embedding FROM chunks LIMIT 1")[0]!;
    expect((JSON.parse(row.embedding) as number[]).length).toBe(256);
  });

  it("模型缺失时回填是无害的空操作,不改动任何行", async () => {
    pointAtMissingModel();
    indexDocument(db, DOC);
    const { scanned, written } = await backfillSemanticVectors(db);
    expect(scanned).toBe(DOC.passages.length);
    expect(written).toBe(0);
    expect(semanticNullCount(db)).toBe(DOC.passages.length);
  });

  it("NP_DISABLE_SEMANTIC=1 是逃生开关:不加载模型,原因记为 disabled", async () => {
    // 现场万一 WASM 出问题,要能一条环境变量退回已知可用的确定性链路。
    process.env.NP_DISABLE_SEMANTIC = "1";
    resetSemanticState();
    expect(await embedSemantic("样本")).toBeNull();
    expect(semanticUnavailableReason()).toBe("disabled");
    indexDocument(db, DOC);
    expect(search(db, "FFPE 灰区", { topK: 3 }).length).toBeGreaterThan(0);
  });

  it("NP_EMBEDDING_MODEL_DIR 未设时默认落在 models/<模型名>", () => {
    delete process.env.NP_EMBEDDING_MODEL_DIR;
    expect(modelDir()).toBe(path.join(process.cwd(), "models", "bge-small-zh-v1.5"));
  });
});

// ── 层 2:向量空间裁决(合成向量,不依赖模型)──────────────────

describe("B2 · 向量空间裁决", () => {
  let db: NovaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });
  afterEach(() => db.close());

  it("不给查询向量时走哈希空间,原因为 no-query-vector", () => {
    indexDocument(db, DOC);
    const { diagnostics } = searchWithDiagnostics(db, "FFPE 灰区", { topK: 3 });
    expect(diagnostics.vectorSpace).toBe("hash");
    expect(diagnostics.vectorSpaceReason).toBe("no-query-vector");
  });

  it("候选全部已回填时走语义空间", () => {
    indexDocument(
      db,
      DOC,
      DOC.passages.map((_, i) => fakeSemanticVector(i + 1)),
    );
    expect(semanticNullCount(db)).toBe(0);
    const { hits, diagnostics } = searchWithDiagnostics(db, "FFPE 灰区", {
      topK: 3,
      semanticQueryVector: fakeSemanticVector(1),
    });
    expect(diagnostics.vectorSpace).toBe("semantic");
    expect(diagnostics.vectorSpaceReason).toBeNull();
    expect(hits.length).toBeGreaterThan(0);
  });

  it("只要有一条候选没回填,整批退回哈希空间(全有或全无)", () => {
    // 这是本项目刻意选的行为:给缺失候选补 0 会凭空压低它们的分,按维度分别
    // 归一化又会把两个不可比的量纲混进同一个排序 —— 都是静默的排序污染。
    indexDocument(db, DOC, [fakeSemanticVector(1), null, fakeSemanticVector(3)]);
    expect(semanticNullCount(db)).toBe(1);
    const { hits, diagnostics } = searchWithDiagnostics(db, "FFPE 灰区", {
      topK: 3,
      semanticQueryVector: fakeSemanticVector(1),
    });
    expect(diagnostics.vectorSpace).toBe("hash");
    expect(diagnostics.vectorSpaceReason).toBe("candidates-not-backfilled");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("两个空间维度不同,但同一条查询在两个空间下都能出满 topK", () => {
    // 回归护栏:512 维与 256 维绝不能混算。这里断言两次检索的结果集规模一致,
    // 也就是说裁决只换打分空间,不会因为维度不匹配少召回。
    indexDocument(
      db,
      DOC,
      DOC.passages.map((_, i) => fakeSemanticVector(i + 1)),
    );
    const hash = searchWithDiagnostics(db, "差异表达 显著性", { topK: 3 });
    const sem = searchWithDiagnostics(db, "差异表达 显著性", {
      topK: 3,
      semanticQueryVector: fakeSemanticVector(9),
    });
    expect(sem.diagnostics.vectorSpace).toBe("semantic");
    expect(sem.hits.length).toBe(hash.hits.length);
  });

  it("诊断字段齐备,可直接当埋点用", () => {
    // 「短查询回退触发率」「检索 P95」「语义/哈希空间占比」都从这里离线统计。
    indexDocument(db, DOC);
    const { diagnostics } = searchWithDiagnostics(db, "灰区", { topK: 3 });
    expect(diagnostics).toMatchObject({
      channel: expect.any(String),
      candidateCount: expect.any(Number),
      vectorSpace: expect.any(String),
    });
    expect(diagnostics.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

// ── 层 3:真实模型(缺 models/ 时跳过)────────────────────────

describe("B2 · 真实语义向量", () => {
  const present = modelPresent();
  let db: NovaDb;

  beforeEach(() => {
    db = createDb(":memory:");
    resetSemanticState();
  });
  afterEach(() => db.close());

  it.skipIf(!present)("产出 512 维 L2 归一化向量", async () => {
    const vec = await embedSemantic("FFPE 样本 DV200 灰区怎么办");
    expect(vec).not.toBeNull();
    expect(vec!.length).toBe(SEMANTIC_DIM);
    const norm = Math.sqrt(vec!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(semanticUnavailableReason()).toBeNull();
  });

  it.skipIf(!present)("同一句话两次编码逐位一致(可复现)", async () => {
    // 量化 ONNX + 单线程 WASM 是确定性的。这条钉住「同问同答」的前提。
    const a = await embedSemantic("低输入量 RNA 怎么建库");
    resetSemanticState(); // 清缓存,强制真的再跑一次推理
    const b = await embedSemantic("低输入量 RNA 怎么建库");
    expect(b).toEqual(a);
  });

  it.skipIf(!present)("语义相近的句子相似度高于无关句子", async () => {
    const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    const q = (await embedSemantic("样本质量处在中间地带时要怎么决定做不做"))!;
    const near = (await embedSemantic("FFPE 样本 DV200 处于灰区时如何判定是否降级"))!;
    const far = (await embedSemantic("论文方法学部分需要交代的参数清单"))!;
    // 两句几乎没有字面重叠 —— 这正是 B2 相对哈希向量的增量所在。
    expect(cos(q, near)).toBeGreaterThan(cos(q, far));
  });

  it.skipIf(!present)("回填幂等:第二次跑扫描到 0 条", async () => {
    seedKnowledgeBase(db); // 同步入库,语义列全空
    const total = semanticNullCount(db);
    expect(total).toBeGreaterThan(0);

    const first = await backfillSemanticVectors(db);
    expect(first.written).toBe(total);
    expect(semanticNullCount(db)).toBe(0);

    const second = await backfillSemanticVectors(db);
    expect(second.scanned).toBe(0);
    expect(second.written).toBe(0);
  });

  it.skipIf(!present)("回填支持分批,不会一次吃下全库", async () => {
    seedKnowledgeBase(db);
    const total = semanticNullCount(db);
    const { written } = await backfillSemanticVectors(db, { batch: 2 });
    expect(written).toBe(2);
    expect(semanticNullCount(db)).toBe(total - 2);
  });

  it.skipIf(!present)("回填后 searchSemantic 真的走语义空间", async () => {
    seedKnowledgeBase(db);
    await backfillSemanticVectors(db);
    const { hits, diagnostics } = await searchSemantic(db, "样本质量在中间地带怎么办", {
      topK: 5,
    });
    expect(diagnostics.vectorSpace).toBe("semantic");
    expect(diagnostics.vectorSpaceReason).toBeNull();
    expect(hits.length).toBeGreaterThan(0);
    // 证据绑定是硬指标,换空间不能影响它。
    expect(hits.every((h) => h.citation.length > 0)).toBe(true);
  });

  it.skipIf(!present)("回填只补空缺,已有向量不被重算覆盖", async () => {
    indexDocument(db, DOC, [fakeSemanticVector(1), null, null]);
    const before = queryAll<{ embedding_semantic: string }>(
      db,
      "SELECT embedding_semantic FROM chunks WHERE embedding_semantic IS NOT NULL",
    )[0]!.embedding_semantic;
    await backfillSemanticVectors(db);
    const after = queryAll<{ embedding_semantic: string }>(
      db,
      "SELECT embedding_semantic FROM chunks ORDER BY ordinal LIMIT 1",
    )[0]!.embedding_semantic;
    expect(after).toBe(before);
    expect(semanticNullCount(db)).toBe(0);
  });
});
