/**
 * BERT WordPiece 分词器(中文 uncased 系词表)。
 *
 * 为什么自己写:B2 的语义向量走 `onnxruntime-web` 纯 WASM 后端(见
 * `semantic.ts` 的选型说明),没有引入 transformers.js —— 那就必须自己把文本
 * 变成 input_ids。好在 BERT 的分词是完全确定性的规则算法,没有任何模型权重,
 * 逐条对齐 HuggingFace `BertTokenizer` 的四步即可:
 *
 *   1. clean_text        —— 去控制字符、各种空白归一为半角空格
 *   2. 中文字符隔离       —— 每个 CJK 字前后插空格(所以中文是逐字成词)
 *   3. 标点切分(+可选小写/去音标)
 *   4. WordPiece 最长优先贪心匹配,续接子词加 `##` 前缀
 *
 * 全部参数从模型目录的 `tokenizer.json` / `tokenizer_config.json` 读,不写死。
 */

export interface WordPieceConfig {
  vocab: Map<string, number>;
  unkId: number;
  clsId: number;
  sepId: number;
  padId: number;
  /** 续接子词前缀,BERT 系一律是 "##"。 */
  continuingPrefix: string;
  /** 超过这个字符数的单词直接判 [UNK](HF 默认 100)。 */
  maxCharsPerWord: number;
  doLowerCase: boolean;
  stripAccents: boolean;
  /** 含首尾 [CLS]/[SEP] 的最大长度。 */
  maxLength: number;
}

/**
 * HF `_is_chinese_char` 的字符区间,原样照搬。
 * 注意这里**不含**日文假名(0x3040–0x30FF)—— BERT 原实现就不含,
 * 假名会走 Latin 分支交给 WordPiece,行为与上游一致。
 */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0xf900, 0xfaff],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f],
  [0x2b820, 0x2ceaf],
  [0x2f800, 0x2fa1f],
];

function isChineseChar(cp: number): boolean {
  for (const [lo, hi] of CJK_RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** HF `_is_punctuation`:ASCII 符号区 + Unicode P* 类。 */
function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  ) {
    return true;
  }
  return /\p{P}|\p{S}/u.test(ch) && !/\p{L}|\p{N}/u.test(ch);
}

/** HF `_clean_text`:丢弃 NUL 与控制字符,各类空白折叠为半角空格。 */
function cleanText(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd) continue;
    if (ch === "\t" || ch === "\n" || ch === "\r" || /\s/u.test(ch)) {
      out += " ";
      continue;
    }
    // Cc / Cf(控制与格式字符,含零宽空格)整体丢弃。
    if (/\p{Cc}|\p{Cf}/u.test(ch)) continue;
    out += ch;
  }
  return out;
}

/** 在每个 CJK 字前后插空格 —— 中文因此逐字成词。 */
function isolateChineseChars(text: string): string {
  let out = "";
  for (const ch of text) {
    if (isChineseChar(ch.codePointAt(0)!)) out += ` ${ch} `;
    else out += ch;
  }
  return out;
}

function stripAccentsOf(text: string): string {
  return text.normalize("NFD").replace(/\p{Mn}/gu, "");
}

/** 标点单独成词(HF `_run_split_on_punc`)。 */
function splitOnPunctuation(word: string): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const ch of word) {
    if (isPunctuation(ch)) {
      if (current) pieces.push(current);
      pieces.push(ch);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** BasicTokenizer:返回待送进 WordPiece 的「词」序列。 */
export function basicTokenize(text: string, cfg: WordPieceConfig): string[] {
  let t = isolateChineseChars(cleanText(text));
  const words: string[] = [];
  for (let raw of t.split(" ")) {
    if (!raw) continue;
    if (cfg.doLowerCase) raw = raw.toLowerCase();
    if (cfg.stripAccents) raw = stripAccentsOf(raw);
    for (const piece of splitOnPunctuation(raw)) words.push(piece);
  }
  return words;
}

/** WordPiece 最长优先贪心匹配。匹配不上整词判 [UNK]。 */
export function wordpieceTokenize(word: string, cfg: WordPieceConfig): number[] {
  const chars = Array.from(word);
  if (chars.length > cfg.maxCharsPerWord) return [cfg.unkId];

  const ids: number[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let matched = -1;
    while (start < end) {
      const sub = (start > 0 ? cfg.continuingPrefix : "") + chars.slice(start, end).join("");
      const id = cfg.vocab.get(sub);
      if (id !== undefined) {
        matched = id;
        break;
      }
      end--;
    }
    // 任一位置匹配失败 → 整个词判 UNK(HF 语义:is_bad)。
    if (matched === -1) return [cfg.unkId];
    ids.push(matched);
    start = end;
  }
  return ids;
}

export interface EncodedText {
  inputIds: number[];
  attentionMask: number[];
  tokenTypeIds: number[];
}

/**
 * 编码单条文本为 `[CLS] … [SEP]`,并按 `maxLength` 截断。
 * 不做 padding —— 单条推理时序列长度就是 batch 长度,补 [PAD] 只会白算。
 */
export function encode(text: string, cfg: WordPieceConfig): EncodedText {
  const body: number[] = [];
  const budget = cfg.maxLength - 2; // 留给 [CLS] / [SEP]
  for (const word of basicTokenize(text, cfg)) {
    for (const id of wordpieceTokenize(word, cfg)) {
      if (body.length >= budget) break;
      body.push(id);
    }
    if (body.length >= budget) break;
  }
  const inputIds = [cfg.clsId, ...body, cfg.sepId];
  return {
    inputIds,
    attentionMask: inputIds.map(() => 1),
    tokenTypeIds: inputIds.map(() => 0),
  };
}

/**
 * 从模型目录的 `tokenizer.json` + `tokenizer_config.json` 构造配置。
 * 两个文件都由 `scripts/fetch-embedding-model.mjs` 原样落盘,不做任何改写。
 */
export function buildConfig(tokenizerJson: unknown, tokenizerConfig: unknown): WordPieceConfig {
  const tj = tokenizerJson as {
    model?: {
      vocab?: Record<string, number>;
      unk_token?: string;
      continuing_subword_prefix?: string;
      max_input_chars_per_word?: number;
    };
    normalizer?: { lowercase?: boolean; strip_accents?: boolean | null };
  };
  const tc = tokenizerConfig as {
    do_lower_case?: boolean;
    strip_accents?: boolean | null;
    model_max_length?: number;
  };

  const rawVocab = tj.model?.vocab;
  if (!rawVocab) throw new Error("tokenizer.json 缺少 model.vocab");
  const vocab = new Map<string, number>(Object.entries(rawVocab));

  const need = (token: string): number => {
    const id = vocab.get(token);
    if (id === undefined) throw new Error(`词表缺少特殊 token ${token}`);
    return id;
  };

  // strip_accents 为 null 时 HF 的语义是「跟随 do_lower_case」。
  const doLowerCase = tc.do_lower_case ?? tj.normalizer?.lowercase ?? false;
  const stripAccents = tc.strip_accents ?? tj.normalizer?.strip_accents ?? doLowerCase;

  return {
    vocab,
    unkId: need(tj.model?.unk_token ?? "[UNK]"),
    clsId: need("[CLS]"),
    sepId: need("[SEP]"),
    padId: need("[PAD]"),
    continuingPrefix: tj.model?.continuing_subword_prefix ?? "##",
    maxCharsPerWord: tj.model?.max_input_chars_per_word ?? 100,
    doLowerCase,
    stripAccents: Boolean(stripAccents),
    maxLength: Math.min(tc.model_max_length ?? 512, 512),
  };
}
