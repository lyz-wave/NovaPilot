/**
 * B3 · 知识摄取流水线单测。
 *
 * 摄取是知识库的**唯一批量入口**,它出错的后果不是「少一篇文档」,而是引用号指向
 * 一份残缺或错误的证据 —— NovaGuard 反查会通过,评委点开却对不上。所以这里钉四件事:
 *
 *  1. frontmatter 契约:字段缺、枚举错、日期格式错,一律整篇拒收,不入半篇;
 *  2. 分块:块长落在约定区间、每块带小节标题、超长段能切开、H1 不产生噪声块;
 *  3. 目录级摄取:doc id 重复要报错(幂等 upsert 会静默互相覆盖)、`_` 前缀跳过;
 *  4. 幂等:同一目录反复摄取,chunk 数不增长,且检索结果稳定。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, queryAll, type NovaDb } from "../db/client";
import { search } from "./retrieval";
import {
  CHUNK_MAX,
  chunkMarkdown,
  ingestKnowledgeDirectorySync,
  listKnowledgeFiles,
  parseFrontmatter,
  parseKnowledgeDirectory,
  parseKnowledgeFile,
  seedKnowledgeWithIngestion,
} from "./ingest";

const GOOD_META = [
  "---",
  "id: T-SOP-001",
  "source: SOP",
  "title: 测试用规范",
  "citation: NV-TEST-001",
  "version: v1.0",
  "appliesTo: 单测",
  "validUntil: 2030-01-01",
  "lang: zh",
  "validation: verified",
  "---",
].join("\n");

/** 一篇最小可用文档。`extraBody` 追加在标准正文之后。 */
function goodDoc(extraBody = ""): string {
  return `${GOOD_META}\n\n# 测试用规范\n\n## 一、送样要求\n\n切片厚度控制在 4~5 μm,单张组织面积不小于 25 mm²。${extraBody}\n`;
}

/** frontmatter 里替换 / 删除某个字段,用来逐字段验证校验行为。 */
function metaWith(overrides: Record<string, string | null>): string {
  const lines = GOOD_META.split("\n").slice(1, -1);
  const out: string[] = [];
  const applied = new Set<string>();
  for (const line of lines) {
    const key = line.slice(0, line.indexOf(":")).trim();
    if (key in overrides) {
      applied.add(key);
      const v = overrides[key];
      if (v === null) continue; // 删字段
      out.push(`${key}: ${v}`);
      continue;
    }
    out.push(line);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (!applied.has(k) && v !== null) out.push(`${k}: ${v}`);
  }
  return `---\n${out.join("\n")}\n---\n\n## 小节\n\n正文内容,足够短但不为空。\n`;
}

let tmpDir: string;
function write(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "np-ingest-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("B3 · parseFrontmatter", () => {
  it("解析平铺 key: value,并把正文原样留下", () => {
    const { meta, body } = parseFrontmatter(goodDoc());
    expect(meta.id).toBe("T-SOP-001");
    expect(meta.validation).toBe("verified");
    expect(body.startsWith("\n# 测试用规范")).toBe(true);
  });

  it("剥掉值两侧的引号", () => {
    const { meta } = parseFrontmatter('---\ntitle: "带引号的标题"\nid: \'X\'\n---\n正文\n');
    expect(meta.title).toBe("带引号的标题");
    expect(meta.id).toBe("X");
  });

  it("值里的冒号不会被截断(SOP 标题里常有)", () => {
    const { meta } = parseFrontmatter("---\nappliesTo: FFPE: 石蜡切片\n---\n正文\n");
    expect(meta.appliesTo).toBe("FFPE: 石蜡切片");
  });

  it("兼容 CRLF 与 BOM —— Windows 上手改一版就是这个形态", () => {
    const { meta, body } = parseFrontmatter("﻿---\r\nid: X\r\n---\r\n正文\r\n");
    expect(meta.id).toBe("X");
    expect(body).toBe("正文\n");
  });

  it("没有 frontmatter 直接抛错", () => {
    expect(() => parseFrontmatter("# 只有正文\n")).toThrow(/缺少 frontmatter/);
  });

  it("frontmatter 里出现无冒号的行抛错,而不是静默忽略", () => {
    expect(() => parseFrontmatter("---\nid: X\n这行没有冒号\n---\n正文\n")).toThrow(/无法解析/);
  });
});

describe("B3 · frontmatter 校验(整篇拒收)", () => {
  it("完整字段解析通过", () => {
    const doc = parseKnowledgeFile(write("ok.md", goodDoc()));
    expect(doc.id).toBe("T-SOP-001");
    expect(doc.citation).toBe("NV-TEST-001");
    expect(doc.passages.length).toBeGreaterThan(0);
  });

  it.each(["id", "source", "title", "citation", "version", "appliesTo", "validUntil", "lang", "validation"])(
    "缺 %s 则整篇拒收",
    (field) => {
      const p = write("bad.md", metaWith({ [field]: null }));
      expect(() => parseKnowledgeFile(p)).toThrow(/frontmatter 校验失败/);
    },
  );

  it("source 只接受 SOP / SCI", () => {
    expect(() => parseKnowledgeFile(write("bad.md", metaWith({ source: "BLOG" })))).toThrow(
      /frontmatter 校验失败/,
    );
  });

  it("validation 只接受 verified / conflict / expired", () => {
    expect(() => parseKnowledgeFile(write("bad.md", metaWith({ validation: "ok" })))).toThrow(
      /frontmatter 校验失败/,
    );
  });

  it("validUntil 必须是 YYYY-MM-DD —— 有效期比对是字符串比较,格式错就永不过期", () => {
    expect(() => parseKnowledgeFile(write("bad.md", metaWith({ validUntil: "2030/01/01" })))).toThrow(
      /YYYY-MM-DD/,
    );
  });

  it("报错带上文件名,便于定位", () => {
    const p = write("有问题的文件.md", metaWith({ id: null }));
    expect(() => parseKnowledgeFile(p, path.join(tmpDir, "x"))).toThrow(/有问题的文件\.md/);
  });

  it("正文为空的文档拒收 —— 元数据齐全但没有可引用内容", () => {
    expect(() => parseKnowledgeFile(write("empty.md", `${GOOD_META}\n\n\n`))).toThrow(/正文为空/);
  });
});

describe("B3 · chunkMarkdown", () => {
  it("每块都带所属小节标题前缀", () => {
    const chunks = chunkMarkdown("## 送样要求\n\n厚度 4~5 μm。\n\n## 运输\n\n常温即可。\n");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatch(/^【送样要求】/);
    expect(chunks[1]).toMatch(/^【运输】/);
  });

  it("H1 整行丢掉,不产生纯标题噪声块", () => {
    const chunks = chunkMarkdown("# 文档标题\n\n## 小节\n\n正文。\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("【小节】正文。");
    expect(chunks.some((c) => c.includes("文档标题"))).toBe(false);
  });

  it("同一小节内的短自然段会被合并", () => {
    const p = "甲".repeat(120);
    const chunks = chunkMarkdown(`## 小节\n\n${p}\n\n${p}\n`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length).toBe("【小节】".length + 241); // 两段 + 一个连接空格
  });

  it("段内换行被折成空格 —— md 源码的软换行不该变成块内换行", () => {
    const chunks = chunkMarkdown("## 小节\n\n第一行\n第二行\n");
    expect(chunks[0]).toBe("【小节】第一行 第二行");
  });

  it("超长段按句末标点切开,每块不超过上限", () => {
    const long = "这是一句测试用的中文句子。".repeat(60); // 780 字
    const chunks = chunkMarkdown(`## 小节\n\n${long}\n`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_MAX + "【小节】".length);
    }
    // 内容不丢:拼回去应当覆盖原文所有字符。
    const rejoined = chunks.map((c) => c.replace("【小节】", "")).join("");
    expect(rejoined).toBe(long);
  });

  it("没有标点的超长行也能硬切(表格行/基因列表)", () => {
    const noPunct = "A".repeat(1200);
    const chunks = chunkMarkdown(`## 小节\n\n${noPunct}\n`);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= CHUNK_MAX + "【小节】".length)).toBe(true);
  });

  it("小节边界强制断块 —— 两个小节的内容不会串到一块里", () => {
    const chunks = chunkMarkdown("## 甲\n\n短句一。\n\n## 乙\n\n短句二。\n");
    expect(chunks).toEqual(["【甲】短句一。", "【乙】短句二。"]);
  });

  it("空正文返回空数组", () => {
    expect(chunkMarkdown("\n\n   \n")).toEqual([]);
  });
});

describe("B3 · 目录级摄取", () => {
  it("按文件名排序,跳过 _ 前缀文件", () => {
    write("_README.md", "这不是知识文档");
    write("b.md", goodDoc());
    write("a.md", metaWith({ id: "T-A" }));
    write("notes.txt", "也不是");
    const files = listKnowledgeFiles(tmpDir).map((f) => path.basename(f));
    expect(files).toEqual(["a.md", "b.md"]);
  });

  it("目录不存在时返回空数组,而不是抛错", () => {
    expect(listKnowledgeFiles(path.join(tmpDir, "nope"))).toEqual([]);
  });

  it("doc id 重复报错 —— 幂等 upsert 会让两篇静默互相覆盖", () => {
    write("a.md", goodDoc());
    write("b.md", goodDoc()); // 同一个 id
    const { errors } = parseKnowledgeDirectory(tmpDir);
    expect(errors.some((e) => /doc id 重复/.test(e))).toBe(true);
  });

  it("坏文档只影响自己,其余照常解析,错误如实上报", () => {
    write("good.md", goodDoc());
    write("bad.md", metaWith({ validUntil: "昨天" }));
    const { docs, errors } = parseKnowledgeDirectory(tmpDir);
    expect(docs.map((d) => d.id)).toEqual(["T-SOP-001"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/bad\.md/);
  });
});

describe("B3 · 入库与幂等", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("摄取后文档可被检索,并带回正确的引用号", () => {
    write("a.md", goodDoc());
    const report = ingestKnowledgeDirectorySync(db, tmpDir);
    expect(report.docs).toHaveLength(1);
    expect(report.chunks).toBeGreaterThan(0);
    expect(report.errors).toEqual([]);

    const hits = search(db, "切片厚度多少", { topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.citation).toBe("NV-TEST-001");
  });

  it("反复摄取同一目录,chunk 数不增长(幂等 upsert)", () => {
    write("a.md", goodDoc());
    const first = ingestKnowledgeDirectorySync(db, tmpDir);
    const after1 = queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM chunks")[0]!.n;
    const second = ingestKnowledgeDirectorySync(db, tmpDir);
    const after2 = queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM chunks")[0]!.n;
    expect(second.chunks).toBe(first.chunks);
    expect(after2).toBe(after1);
    expect(queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM documents")[0]!.n).toBe(1);
  });

  it("改一版正文重新摄取,旧 chunk 不残留", () => {
    write("a.md", goodDoc());
    ingestKnowledgeDirectorySync(db, tmpDir);
    expect(search(db, "切片厚度", { topK: 5 }).length).toBeGreaterThan(0);

    write("a.md", `${GOOD_META}\n\n## 一、送样要求\n\n本条已废止,改为按项目单独约定。\n`);
    ingestKnowledgeDirectorySync(db, tmpDir);
    const texts = queryAll<{ text: string }>(db, "SELECT text FROM chunks").map((r) => r.text);
    expect(texts.some((t) => t.includes("已废止"))).toBe(true);
    expect(texts.some((t) => t.includes("4~5 μm"))).toBe(false);
  });

  it("FTS 表与 chunks 同步 —— 重新摄取后不会检索到旧版内容", () => {
    write("a.md", goodDoc());
    ingestKnowledgeDirectorySync(db, tmpDir);
    write("a.md", `${GOOD_META}\n\n## 一、送样要求\n\n改版后的全新表述与旧版没有共同词。\n`);
    ingestKnowledgeDirectorySync(db, tmpDir);
    const ftsN = queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM chunks_fts")[0]!.n;
    const chunkN = queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM chunks")[0]!.n;
    expect(ftsN).toBe(chunkN);
  });

  /**
   * 事务回滚:`npm run kb:ingest` 的门禁机制全部押在这一条上。
   *
   * 脚本的做法是 BEGIN → 入库 → 跑 NovaBench → proceed 才 COMMIT,stop 就 ROLLBACK。
   * 之所以不能用「失败后 removeDocument 挨个删」:`indexDocument()` 是「按 doc id
   * 删旧重插」的幂等 upsert,所以重摄一篇**已存在**的文档会先把旧 chunk 删掉。
   * 此时靠 removeDocument 回滚,新的删掉了、旧的也回不来 —— 修一版文案没通过回归,
   * 反而把库里原来能用的那版弄丢了。下面两条钉住「回滚后旧版仍可检索」。
   */
  it("门禁未通过时 ROLLBACK,库回到摄取前状态(含 FTS)", () => {
    write("a.md", goodDoc());
    ingestKnowledgeDirectorySync(db, tmpDir);
    const before = queryAll<{ text: string }>(db, "SELECT text FROM chunks ORDER BY id").map(
      (r) => r.text,
    );
    expect(before.some((t) => t.includes("4~5 μm"))).toBe(true);

    // 改一版文案,在事务里摄取,然后模拟「门禁判 stop」→ ROLLBACK。
    write("a.md", `${GOOD_META}\n\n## 一、送样要求\n\n改版正文,与旧版没有共同词。\n`);
    db.exec("BEGIN");
    ingestKnowledgeDirectorySync(db, tmpDir);
    // 事务内:新版已生效(这正是危险窗口 —— 旧 chunk 此刻已被 upsert 删掉)。
    expect(
      queryAll<{ text: string }>(db, "SELECT text FROM chunks").some((r) =>
        r.text.includes("改版正文"),
      ),
    ).toBe(true);
    db.exec("ROLLBACK");

    // 回滚后:旧版一字不差地回来了,新版一个 chunk 都不留。
    const after = queryAll<{ text: string }>(db, "SELECT text FROM chunks ORDER BY id").map(
      (r) => r.text,
    );
    expect(after).toEqual(before);
    // FTS 是触发器维护的影子表,必须跟着一起回滚 —— 否则会检索到已回滚的内容。
    expect(search(db, "切片厚度", { topK: 5 }).length).toBeGreaterThan(0);
    const ftsHasNew = queryAll<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM chunks_fts WHERE content LIKE '%改版正文%'",
    )[0]!.n;
    expect(ftsHasNew).toBe(0);
  });

  it("摄取途中抛错时 ROLLBACK,不留半篇入库的文档", () => {
    write("a.md", goodDoc());
    ingestKnowledgeDirectorySync(db, tmpDir);
    const baseline = queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM documents")[0]!.n;

    write(
      "b.md",
      `${metaWith({ id: "T-SOP-002", citation: "NV-TEST-002" })}\n\n## 一、送样要求\n\n第二篇文档的正文内容。\n`,
    );
    expect(() => {
      db.exec("BEGIN");
      ingestKnowledgeDirectorySync(db, tmpDir);
      throw new Error("模拟门禁执行期异常");
    }).toThrow();
    db.exec("ROLLBACK");

    // 「宁可一篇不入,也不要入一半让 NovaGuard 反查到残缺的引用号」。
    expect(queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM documents")[0]!.n).toBe(baseline);
  });

  it("空目录摄取是无害的 no-op", () => {    const report = ingestKnowledgeDirectorySync(db, tmpDir);
    expect(report).toEqual({ docs: [], chunks: 0, errors: [] });
  });

  it("seedKnowledgeWithIngestion:内置种子 + 摄取目录都在库里", () => {
    write("a.md", goodDoc());
    const total = seedKnowledgeWithIngestion(db, tmpDir);
    const docs = queryAll<{ id: string }>(db, "SELECT id FROM documents ORDER BY id").map(
      (r) => r.id,
    );
    expect(docs).toContain("T-SOP-001");
    expect(docs.length).toBeGreaterThan(1); // 种子库那几篇也在
    expect(total).toBe(queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM chunks")[0]!.n);
  });

  it("seedKnowledgeWithIngestion 遇到坏文档只跳过它,应用照常起得来", () => {
    write("good.md", goodDoc());
    write("bad.md", "没有 frontmatter\n");
    expect(() => seedKnowledgeWithIngestion(db, tmpDir)).not.toThrow();
    const docs = queryAll<{ id: string }>(db, "SELECT id FROM documents").map((r) => r.id);
    expect(docs).toContain("T-SOP-001");
  });
});
