/**
 * B1 · FTS5 候选生成层单测。
 *
 * 三件事必须钉住:
 *  1. `sanitizeFtsQuery()` 面对任意用户输入都不能让 MATCH 抛语法错 —— 一次
 *     正常检索不该因为用户打了个括号就变成 500;
 *  2. FTS5 关键字(NEAR / AND / OR / NOT)必须被当成普通词而不是运算符;
 *  3. `removeDocument()`(一键回滚)之后 FTS 表不能有残留 —— 否则已回滚的
 *     知识仍会被检索到并当作证据引用,直接违背「受控进化」语义。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb, queryAll, type NovaDb } from "../db/client";
import {
  sanitizeFtsQuery,
  searchWithDiagnostics,
  indexDocument,
  removeDocument,
  seedKnowledgeBase,
} from "./retrieval";

function ftsRowCount(db: NovaDb): number {
  return queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM chunks_fts")[0]!.n;
}

function chunkRowCount(db: NovaDb): number {
  return queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM chunks")[0]!.n;
}

/** 直接跑一次 MATCH,断言 SQL 层不抛错。 */
function matchDoesNotThrow(db: NovaDb, raw: string): void {
  const expr = sanitizeFtsQuery(raw);
  if (!expr) return; // 空表达式的约定是「不查 FTS」,调用方走回退
  expect(() =>
    queryAll(db, "SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 5", expr),
  ).not.toThrow();
}

describe("B1 · sanitizeFtsQuery", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
    seedKnowledgeBase(db);
  });

  it("keeps letter/digit/CJK runs and drops everything else", () => {
    expect(sanitizeFtsQuery("DV200 建库补测")).toBe('"dv200" OR "建库补测"');
  });

  it("drops runs shorter than the trigram minimum", () => {
    // 「建库」只有 2 字,trigram 索引里查不到 —— 保留它只会让 MATCH 空转。
    expect(sanitizeFtsQuery("建库 极低质量")).toBe('"极低质量"');
  });

  it("returns an empty expression when every run is too short", () => {
    // 约定:空串 = 不适用 FTS,调用方必须走全量回退。
    expect(sanitizeFtsQuery("建库")).toBe("");
    expect(sanitizeFtsQuery("PE")).toBe("");
    expect(sanitizeFtsQuery("")).toBe("");
    expect(sanitizeFtsQuery("   ")).toBe("");
    expect(sanitizeFtsQuery("!@#$%^&*()")).toBe("");
  });

  it("de-duplicates repeated terms case-insensitively", () => {
    expect(sanitizeFtsQuery("DV200 dv200 Dv200")).toBe('"dv200"');
  });

  it("caps the number of terms so pathological input can't explode the query", () => {
    const huge = Array.from({ length: 200 }, (_, i) => `term${i}`).join(" ");
    const expr = sanitizeFtsQuery(huge);
    expect(expr.split(" OR ")).toHaveLength(32);
    matchDoesNotThrow(db, huge);
  });

  // ── 注入 / 特殊字符 ──────────────────────────────────────────
  // 每一项都是「原样拼进 MATCH 就会 fts5: syntax error」的输入。
  const HOSTILE: Array<[string, string]> = [
    ["单引号", "极低质量's 样本"],
    ["双引号", '极低质量 "样本" 处理'],
    ["未闭合双引号", '极低质量 "样本'],
    ["星号前缀通配", "极低质量*"],
    ["列过滤冒号", "content: 极低质量"],
    ["中文冒号", "极低质量：处理"],
    ["圆括号", "(极低质量 OR 超微量)"],
    ["未闭合括号", "(极低质量"],
    ["方括号", "[极低质量]"],
    ["花括号", "{极低质量}"],
    ["脱字符", "^极低质量"],
    ["减号", "极低质量 -超微量"],
    ["加号", "极低质量 + 超微量"],
    ["逗号分隔", "极低质量,超微量,建库补测"],
    ["反斜杠", "极低质量\\超微量"],
    ["SQL 注入形", "极低质量'); DROP TABLE chunks; --"],
    ["纯符号", "*:()\"'"],
    ["emoji", "极低质量 🧬 样本"],
    ["换行与制表", "极低质量\n\t超微量"],
    ["零宽字符", "极低​质量"],
  ];

  it.each(HOSTILE)("survives hostile input: %s", (_label, raw) => {
    matchDoesNotThrow(db, raw);
  });

  // ── FTS5 关键字必须降级为普通词 ──────────────────────────────
  const KEYWORDS = ["NEAR", "AND", "OR", "NOT", "near", "and", "or", "not"];

  /**
   * 去掉所有双引号字面量后,合法表达式里只该剩下我们自己拼的 " OR " 分隔符。
   * 若有裸关键字(= 真运算符)漏出来,这里就会剩下别的东西。
   */
  function bareResidue(expr: string): string {
    return expr.replace(/"(?:[^"]|"")*"/g, "").replace(/ OR /g, "").trim();
  }

  it.each(KEYWORDS)("never lets FTS5 keyword %s leak through as an operator", (kw) => {
    const raw = `${kw} 极低质量`;
    const expr = sanitizeFtsQuery(raw);
    // 要么被引号包成字面量,要么(长度不足 trigram 时)整个丢掉 —— 两种都安全。
    expect(bareResidue(expr)).toBe("");
    matchDoesNotThrow(db, raw);
  });

  it("quotes keywords that are long enough to survive the trigram filter", () => {
    expect(sanitizeFtsQuery("AND 极低质量")).toBe('"and" OR "极低质量"');
    expect(sanitizeFtsQuery("NEAR 极低质量")).toBe('"near" OR "极低质量"');
    // 「OR」只有 2 字符,连词元都进不来 —— 比引号包起来更彻底。
    expect(sanitizeFtsQuery("OR 极低质量")).toBe('"极低质量"');
  });

  it("handles a query made entirely of FTS5 keywords", () => {
    matchDoesNotThrow(db, "AND OR NOT NEAR");
    // 全是关键字时也必须产出合法表达式(而不是裸运算符串)。
    expect(sanitizeFtsQuery("AND OR NOT NEAR")).toBe('"and" OR "not" OR "near"');
    expect(bareResidue(sanitizeFtsQuery("AND OR NOT NEAR"))).toBe("");
  });

  it("NEAR( syntax cannot smuggle an operator through", () => {
    matchDoesNotThrow(db, "NEAR(极低质量 超微量, 3)");
  });
});

describe("B1 · FTS 索引与 chunks 表的同步", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("INSERT trigger mirrors every chunk into the FTS index", () => {
    seedKnowledgeBase(db);
    expect(ftsRowCount(db)).toBe(chunkRowCount(db));
    expect(ftsRowCount(db)).toBeGreaterThan(5);
  });

  it("removeDocument leaves no residue in the FTS index (rollback integrity)", () => {
    seedKnowledgeBase(db);
    const before = ftsRowCount(db);
    const removedChunks = queryAll<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?",
      "E-SOP-042",
    )[0]!.n;
    expect(removedChunks).toBeGreaterThan(0);

    expect(removeDocument(db, "E-SOP-042")).toBe(true);

    expect(ftsRowCount(db)).toBe(before - removedChunks);
    expect(ftsRowCount(db)).toBe(chunkRowCount(db));
    // 回滚后这份文档的内容不该还能被 MATCH 到。
    const leaked = queryAll<{ chunk_id: string }>(
      db,
      "SELECT chunk_id FROM chunks_fts WHERE document_id = ?",
      "E-SOP-042",
    );
    expect(leaked).toHaveLength(0);
  });

  it("re-indexing a document (idempotent upsert) does not duplicate FTS rows", () => {
    const doc = {
      id: "E-SOP-TEST",
      source: "SOP",
      title: "测试文档",
      citation: "NV-SOP-TEST-001",
      version: "v1.0",
      appliesTo: "测试",
      validUntil: "2030-01-01",
      lang: "zh",
      validation: "verified",
      passages: ["极低质量样本的处理流程", "超微量建库补测的判定条件"],
    };
    indexDocument(db, doc);
    expect(ftsRowCount(db)).toBe(2);
    indexDocument(db, doc);
    indexDocument(db, doc);
    expect(ftsRowCount(db)).toBe(2);
    expect(ftsRowCount(db)).toBe(chunkRowCount(db));
  });

  it("seedKnowledgeBase's bulk clear also clears the FTS index", () => {
    seedKnowledgeBase(db);
    const first = ftsRowCount(db);
    seedKnowledgeBase(db);
    expect(ftsRowCount(db)).toBe(first);
    expect(ftsRowCount(db)).toBe(chunkRowCount(db));
  });
});

describe("B1 · 检索通道诊断", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
    seedKnowledgeBase(db);
  });
  afterEach(() => {
    delete process.env.NP_DISABLE_FTS;
  });

  it("short queries take the fallback path", () => {
    const { diagnostics } = searchWithDiagnostics(db, "建库");
    expect(diagnostics.channel).toBe("fallback");
    expect(diagnostics.fallbackReason).toBe("short-query");
  });

  it("a small corpus falls back because the candidate set is too thin", () => {
    // 种子库只有二十余个 chunk,预筛命中数几乎不可能达到 MIN_CANDIDATES,
    // 因此小库上的打分与改造前逐位一致 —— 这正是零回归的来源。
    const { diagnostics } = searchWithDiagnostics(db, "DV200 门槛 建库 投入量");
    expect(diagnostics.channel).toBe("fallback");
    expect(diagnostics.fallbackReason).toBe("insufficient-candidates");
  });

  it("the FTS channel engages once the corpus is large enough", () => {
    // 造一批共享同一词元的 chunk,把预筛命中数推过 MIN_CANDIDATES。
    indexDocument(db, {
      id: "E-SOP-BULK",
      source: "SOP",
      title: "批量测试文档",
      citation: "NV-SOP-BULK-001",
      version: "v1.0",
      appliesTo: "测试",
      validUntil: "2030-01-01",
      lang: "zh",
      validation: "verified",
      passages: Array.from(
        { length: 40 },
        (_, i) => `极低质量样本处理条目第 ${i} 条,涉及超微量建库补测的判定。`,
      ),
    });
    const { hits, diagnostics } = searchWithDiagnostics(db, "极低质量 超微量");
    expect(diagnostics.channel).toBe("fts");
    expect(diagnostics.fallbackReason).toBeNull();
    expect(diagnostics.candidateCount).toBeLessThanOrEqual(50); // FTS_LIMIT
    expect(hits.length).toBeGreaterThan(0);
  });

  it("NP_DISABLE_FTS=1 forces the full-scan path (escape hatch)", () => {
    process.env.NP_DISABLE_FTS = "1";
    const { diagnostics } = searchWithDiagnostics(db, "极低质量 超微量 建库补测");
    expect(diagnostics.channel).toBe("fallback");
    expect(diagnostics.fallbackReason).toBe("disabled");
  });

  it("reports elapsed time so the P95 gate has something to assert on", () => {
    const { diagnostics } = searchWithDiagnostics(db, "DV200 灰区 处理");
    expect(diagnostics.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(diagnostics.elapsedMs)).toBe(true);
  });

  it("hostile queries still return results instead of throwing", () => {
    for (const [, raw] of [
      ["", '极低质量 "样本'],
      ["", "content: 极低质量*"],
      ["", "极低质量'); DROP TABLE chunks; --"],
    ] as Array<[string, string]>) {
      expect(() => searchWithDiagnostics(db, raw)).not.toThrow();
    }
    // 恶意输入被净化后,chunks 表必须还在。
    expect(chunkRowCount(db)).toBeGreaterThan(5);
  });
});
