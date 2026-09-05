/**
 * B3 · 知识库摄取流水线(方案 v2.2 第 6 章)。
 *
 * 把 `data/knowledge/*.md` 变成可检索、可引用的证据块。三件事:
 *
 *  1. **解析** —— frontmatter 用 zod 校验。字段缺一个就整篇拒收,不入库半篇。
 *     知识库是引用来源,元数据不全的文档进来就是给 NovaGuard 挖坑。
 *  2. **分块** —— 按二级标题切段,段内按自然段聚合到 300~500 字。
 *  3. **入库** —— 直接复用 `indexDocument()` 的幂等 upsert(按 doc id 删旧重插),
 *     所以同一篇文档反复摄取不会产生重复 chunk,改一版重跑即可。
 *
 * 门禁与回滚不在这里 —— 那是 `scripts/ingest-documents.ts` 的事。这个模块保持
 * 纯粹:解析 + 分块 + 入库,可被 CLI、种子路径、单测共用。
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { NovaDb } from "../db/client";
import { indexDocument, indexDocumentSemantic, seedKnowledgeBase, type IndexableDocument } from "./retrieval";

/** 分块目标区间。低于 min 的块会继续和下一段合并;超过 max 的段按句切开。 */
export const CHUNK_MIN = 300;
export const CHUNK_MAX = 500;

/**
 * frontmatter 契约。与 `SeedDoc` 对齐 —— 摄取进来的文档和内置种子库在检索侧
 * 完全同构,没有「二等证据」。
 */
export const FrontmatterSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["SOP", "SCI"]),
  title: z.string().min(1),
  citation: z.string().min(1),
  version: z.string().min(1),
  appliesTo: z.string().min(1),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "validUntil 必须是 YYYY-MM-DD"),
  lang: z.enum(["zh", "en"]),
  validation: z.enum(["verified", "conflict", "expired"]),
});
export type Frontmatter = z.infer<typeof FrontmatterSchema>;

export interface ParsedDocument extends IndexableDocument {
  /** 来源文件的相对路径,用于日志与报错定位。 */
  file: string;
}

/**
 * 解析 frontmatter。刻意只支持 `key: value` 平铺格式 —— 不引 YAML 依赖(项目
 * 的零原生依赖 / 最小依赖树是硬约束),而知识库元数据本来就不需要嵌套结构。
 * 值里的引号会被剥掉,`#` 之后不当注释处理(SOP 标题里可能真有 `#`)。
 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const normalized = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!m) throw new Error("缺少 frontmatter(文件必须以 --- 开头)");

  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx < 0) throw new Error(`frontmatter 行无法解析: ${line}`);
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: normalized.slice(m[0].length) };
}

/** 把过长的自然段按句末标点切开。切不动时(没有标点)按 CHUNK_MAX 硬切。 */
function splitLongParagraph(text: string): string[] {
  const sentences = text.match(/[^。！？；!?;]+[。！？；!?;]*/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > CHUNK_MAX) {
      out.push(cur);
      cur = "";
    }
    // 单句就超长(极少见,通常是没加标点的表格行)—— 硬切,保证块大小可控。
    if (s.length > CHUNK_MAX) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      for (let i = 0; i < s.length; i += CHUNK_MAX) out.push(s.slice(i, i + CHUNK_MAX));
      continue;
    }
    cur += s;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 按二级标题 + 自然段递归分块。
 *
 * 每个块都带上所属小节的标题(`【送样要求】…`)。这不是装饰:检索是按 chunk
 * 打分的,脱离小节标题的段落经常丢掉「这段在讲什么」的关键词 —— 比如「厚度
 * 4~5 μm」这一句,不带「送样要求」就很难被「组织块要切多厚」召回。代价是每块
 * 多十几个字,换来的是字面通道和语义通道都拿到了上下文。
 */
export function chunkMarkdown(body: string): string[] {
  const lines = body.split("\n");
  const sections: Array<{ heading: string; text: string[] }> = [{ heading: "", text: [] }];
  for (const line of lines) {
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      sections.push({ heading: h2[1]!.trim(), text: [] });
      continue;
    }
    // H1 整行丢掉。frontmatter 里已有 title,正文的 H1 一般是原样重复,留着会在
    // 首节生成一个十几字的纯标题 chunk —— 它几乎命中不了任何查询,却会占一个候选
    // 位、拉低平均块长,是纯噪声。
    if (/^#\s+/.test(line)) continue;
    sections[sections.length - 1]!.text.push(line);
  }

  const chunks: string[] = [];
  for (const section of sections) {
    const paragraphs = section.text
      .join("\n")
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
      .filter(Boolean);

    const prefix = section.heading ? `【${section.heading}】` : "";
    let cur = "";
    const flush = () => {
      if (cur.trim()) chunks.push(prefix + cur.trim());
      cur = "";
    };
    for (const p of paragraphs) {
      if (p.length > CHUNK_MAX) {
        flush();
        for (const piece of splitLongParagraph(p)) chunks.push(prefix + piece.trim());
        continue;
      }
      if (cur && cur.length + p.length > CHUNK_MAX) flush();
      cur += (cur ? " " : "") + p;
      if (cur.length >= CHUNK_MIN) flush();
    }
    flush();
  }
  return chunks;
}

/** 解析单个知识文件。任何问题都抛错并带上文件名 —— 摄取宁可失败也不半途入库。 */
export function parseKnowledgeFile(filePath: string, baseDir = filePath): ParsedDocument {
  const rel = path.relative(path.dirname(baseDir), filePath) || path.basename(filePath);
  let meta: Record<string, string>;
  let body: string;
  try {
    ({ meta, body } = parseFrontmatter(fs.readFileSync(filePath, "utf8")));
  } catch (err) {
    throw new Error(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = FrontmatterSchema.safeParse(meta);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
      .join("; ");
    throw new Error(`${rel}: frontmatter 校验失败 —— ${issues}`);
  }

  const passages = chunkMarkdown(body);
  if (passages.length === 0) throw new Error(`${rel}: 正文为空,没有可入库的内容`);

  return { ...parsed.data, lang: parsed.data.lang, passages, file: rel };
}

/** 列出目录下的知识文件(按文件名排序,保证摄取顺序确定)。 */
export function listKnowledgeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .sort()
    .map((f) => path.join(dir, f));
}

export const KNOWLEDGE_DIR = path.join("data", "knowledge");

export function knowledgeDir(): string {
  return process.env.NP_KNOWLEDGE_DIR ?? path.join(process.cwd(), KNOWLEDGE_DIR);
}

export interface IngestedDoc {
  id: string;
  file: string;
  title: string;
  chunks: number;
}

export interface IngestReport {
  docs: IngestedDoc[];
  chunks: number;
  /** 解析失败的文件。摄取不因为一篇坏文档就整体中止,但会在报告里如实列出。 */
  errors: string[];
}

/**
 * 解析目录下所有知识文件。解析阶段与入库阶段分开:先把所有文档解析完,
 * 有坏文档时调用方可以选择「一篇都不入」,而不是入了一半才发现问题。
 */
export function parseKnowledgeDirectory(dir = knowledgeDir()): {
  docs: ParsedDocument[];
  errors: string[];
} {
  const docs: ParsedDocument[] = [];
  const errors: string[] = [];
  for (const file of listKnowledgeFiles(dir)) {
    try {
      docs.push(parseKnowledgeFile(file, path.join(dir, "x")));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  // 同一个 doc id 出现两次会让幂等 upsert 互相覆盖,静默丢内容 —— 直接判错。
  const seen = new Map<string, string>();
  for (const doc of docs) {
    const prev = seen.get(doc.id);
    if (prev) errors.push(`doc id 重复: ${doc.id}(${prev} 与 ${doc.file})`);
    seen.set(doc.id, doc.file);
  }
  return { docs, errors };
}

/** 同步摄取:只写确定性哈希向量。种子路径与单测用这个。 */
export function ingestKnowledgeDirectorySync(db: NovaDb, dir = knowledgeDir()): IngestReport {
  const { docs, errors } = parseKnowledgeDirectory(dir);
  const ingested: IngestedDoc[] = [];
  let chunks = 0;
  for (const doc of docs) {
    const n = indexDocument(db, doc);
    chunks += n;
    ingested.push({ id: doc.id, file: doc.file, title: doc.title, chunks: n });
  }
  return { docs: ingested, chunks, errors };
}

/** 异步摄取:同时写真实语义向量。CLI 用这个。 */
export async function ingestKnowledgeDirectory(
  db: NovaDb,
  dir = knowledgeDir(),
): Promise<IngestReport> {
  const { docs, errors } = parseKnowledgeDirectory(dir);
  const ingested: IngestedDoc[] = [];
  let chunks = 0;
  for (const doc of docs) {
    const n = await indexDocumentSemantic(db, doc);
    chunks += n;
    ingested.push({ id: doc.id, file: doc.file, title: doc.title, chunks: n });
  }
  return { docs: ingested, chunks, errors };
}

/**
 * 应用启动路径的种库入口:内置种子库 + `data/knowledge/` 全部摄取。
 *
 * 为什么不直接改 `seedKnowledgeBase()`:它在 `retrieval.ts` 里,而 `ingest.ts`
 * 依赖 `retrieval.ts`,反向 import 会成环。更重要的是,几十个单测直接调
 * `seedKnowledgeBase()`,它们要的是「7 篇固定种子」这个确定输入 —— 让它偷偷多
 * 读一个目录会把测试基线变成随文件系统而动的东西。所以组合放在这一层,由应用
 * 显式调用。
 *
 * 幂等:`chunkCount === 0` 才种。摄取用同步版本(只写哈希向量),语义向量由调用
 * 方随后的 `backfillSemanticVectors()` 补 —— 首页的 ensureSeeded 是同步的,不适合
 * 在 React server component 里等模型加载。
 *
 * 解析错误只告警不抛:免安装包里如果有人手改坏了一篇 md,应用要照常起来、少一篇
 * 知识,而不是白屏。CLI(`npm run kb:ingest`)才是严格模式,那里一篇坏就整体拒收。
 */
export function seedKnowledgeWithIngestion(db: NovaDb, dir = knowledgeDir()): number {
  let count = seedKnowledgeBase(db);
  const report = ingestKnowledgeDirectorySync(db, dir);
  count += report.chunks;
  for (const err of report.errors) {
    console.warn(`[ingest] 跳过一篇知识文档: ${err}`);
  }
  return count;
}
