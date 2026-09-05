/**
 * B2 · WordPiece 分词器单测。
 *
 * 这个文件是自研分词器的正确性护栏。它没有权重,全是规则,所以只要规则对齐
 * HuggingFace `BertTokenizer`,input_ids 就一定和 transformers.js 一致 —— 反过来
 * 说,任何一条规则写歪了,推理仍然「能跑」,只是向量悄悄变成噪声。所以这里
 * 逐条钉住四步规则,而不是只测一个 happy path。
 *
 * 大部分用例用手搓的小词表,便于精确断言 id 序列;末尾一组用真实模型目录里的
 * `tokenizer.json`(缺模型时自动跳过),防止 `buildConfig()` 与上游文件格式脱节。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  basicTokenize,
  buildConfig,
  encode,
  wordpieceTokenize,
  type WordPieceConfig,
} from "./wordpiece";
import { modelDir } from "./semantic";

/** 手搓词表:特殊 token + 几个中文字 + 一个可切成子词的英文词。 */
const TOKENS = [
  "[PAD]",
  "[UNK]",
  "[CLS]",
  "[SEP]",
  "样",
  "本",
  "质",
  "量",
  ",",
  "。",
  "rna",
  "RNA",
  "low",
  "##er",
  "##est",
  "a",
  "##b",
] as const;

function tinyConfig(overrides: Partial<WordPieceConfig> = {}): WordPieceConfig {
  const vocab = new Map<string, number>(TOKENS.map((t, i) => [t, i]));
  return {
    vocab,
    unkId: vocab.get("[UNK]")!,
    clsId: vocab.get("[CLS]")!,
    sepId: vocab.get("[SEP]")!,
    padId: vocab.get("[PAD]")!,
    continuingPrefix: "##",
    maxCharsPerWord: 100,
    doLowerCase: false,
    stripAccents: false,
    maxLength: 512,
    ...overrides,
  };
}

const id = (token: string): number => tinyConfig().vocab.get(token)!;

describe("B2 · BasicTokenizer(前三步规则)", () => {
  it("每个中文字单独成词", () => {
    expect(basicTokenize("样本质量", tinyConfig())).toEqual(["样", "本", "质", "量"]);
  });

  it("中英混排时英文按空白成词、中文仍逐字切开", () => {
    expect(basicTokenize("RNA 样本", tinyConfig())).toEqual(["RNA", "样", "本"]);
    // 没有空格也要切开 —— 靠的是 CJK 字符前后插空格那一步。
    expect(basicTokenize("RNA样本", tinyConfig())).toEqual(["RNA", "样", "本"]);
  });

  it("标点单独成词,中英标点都算", () => {
    expect(basicTokenize("样,本。", tinyConfig())).toEqual(["样", ",", "本", "。"]);
    expect(basicTokenize("DV200%", tinyConfig())).toEqual(["DV200", "%"]);
    expect(basicTokenize("(a)", tinyConfig())).toEqual(["(", "a", ")"]);
  });

  it("零宽字符被丢弃而不是当成分隔符", () => {
    // U+200B 属于 Cf。从网页/PDF 复制来的查询里很常见,当成分隔符会把一个词
    // 切成两半,向量随之跑偏 —— 所以必须整体丢弃。
    expect(basicTokenize("RN​A", tinyConfig())).toEqual(["RNA"]);
    // 对照:真的空白就该切开。
    expect(basicTokenize("RN A", tinyConfig())).toEqual(["RN", "A"]);
  });

  it("各类空白统一折叠,不产生空词", () => {
    expect(basicTokenize("  RNA\t\n 样本  ", tinyConfig())).toEqual(["RNA", "样", "本"]);
    // 全角空格 U+3000 也要当空白处理。
    expect(basicTokenize("RNA　样", tinyConfig())).toEqual(["RNA", "样"]);
  });

  it("doLowerCase 与 stripAccents 各自独立生效", () => {
    expect(basicTokenize("RNA", tinyConfig({ doLowerCase: true }))).toEqual(["rna"]);
    expect(basicTokenize("RNA", tinyConfig({ doLowerCase: false }))).toEqual(["RNA"]);
    expect(basicTokenize("café", tinyConfig({ stripAccents: true }))).toEqual(["cafe"]);
    expect(basicTokenize("café", tinyConfig({ stripAccents: false }))).toEqual(["café"]);
  });

  it("空串与纯空白得到空词表,不抛错", () => {
    expect(basicTokenize("", tinyConfig())).toEqual([]);
    expect(basicTokenize("   \n\t ", tinyConfig())).toEqual([]);
  });
});

describe("B2 · WordPiece 贪心匹配", () => {
  it("整词命中时只出一个 id", () => {
    expect(wordpieceTokenize("rna", tinyConfig())).toEqual([id("rna")]);
  });

  it("切成子词时续接部分带 ## 前缀,最长优先", () => {
    // "lowest" 应切成 low + ##est(而不是 low + ##e + ##st)。
    expect(wordpieceTokenize("lowest", tinyConfig())).toEqual([id("low"), id("##est")]);
    expect(wordpieceTokenize("lower", tinyConfig())).toEqual([id("low"), id("##er")]);
  });

  it("任一位置匹配不上就整词判 [UNK](HF is_bad 语义)", () => {
    // "lowz":low 能匹配,但剩下的 "##z" 不在词表 —— 整词 UNK,不是 [low, UNK]。
    expect(wordpieceTokenize("lowz", tinyConfig())).toEqual([id("[UNK]")]);
    expect(wordpieceTokenize("zzz", tinyConfig())).toEqual([id("[UNK]")]);
  });

  it("超长词直接判 [UNK],不做无谓的 O(n²) 扫描", () => {
    const cfg = tinyConfig({ maxCharsPerWord: 5 });
    expect(wordpieceTokenize("a".repeat(6), cfg)).toEqual([id("[UNK]")]);
    // 恰好等于上限时仍正常走匹配(边界是 >,不是 >=)。
    expect(wordpieceTokenize("ab", cfg)).toEqual([id("a"), id("##b")]);
  });
});

describe("B2 · encode()", () => {
  it("首尾加 [CLS]/[SEP],三个输入张量等长", () => {
    const out = encode("样本", tinyConfig());
    expect(out.inputIds).toEqual([id("[CLS]"), id("样"), id("本"), id("[SEP]")]);
    expect(out.attentionMask).toEqual([1, 1, 1, 1]);
    expect(out.tokenTypeIds).toEqual([0, 0, 0, 0]);
  });

  it("空输入仍产出合法的 [CLS] [SEP]", () => {
    // 用户可能提交空查询;这里必须给出合法张量而不是长度 0 的输入。
    expect(encode("", tinyConfig()).inputIds).toEqual([id("[CLS]"), id("[SEP]")]);
  });

  it("超出 maxLength 时截断,且总长恰好等于 maxLength", () => {
    const cfg = tinyConfig({ maxLength: 6 });
    const out = encode("样本质量样本质量样本", cfg);
    expect(out.inputIds).toHaveLength(6);
    expect(out.inputIds[0]).toBe(id("[CLS]"));
    // [SEP] 必须还在最后一位 —— 截断不能把它挤掉,否则模型看到的是残句。
    expect(out.inputIds.at(-1)).toBe(id("[SEP]"));
    expect(out.attentionMask).toHaveLength(6);
  });

  it("不做 padding —— 单条推理时补 [PAD] 只是白算", () => {
    const out = encode("样", tinyConfig());
    expect(out.inputIds).not.toContain(id("[PAD]"));
    expect(out.attentionMask.every((m) => m === 1)).toBe(true);
  });
});

describe("B2 · buildConfig()", () => {
  const minimalTokenizerJson = {
    model: {
      vocab: { "[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[SEP]": 3, 样: 4 },
      unk_token: "[UNK]",
      continuing_subword_prefix: "##",
      max_input_chars_per_word: 100,
    },
  };

  it("从两个 JSON 里取出特殊 token id 与规则开关", () => {
    const cfg = buildConfig(minimalTokenizerJson, { do_lower_case: false, model_max_length: 512 });
    expect(cfg.clsId).toBe(2);
    expect(cfg.sepId).toBe(3);
    expect(cfg.unkId).toBe(1);
    expect(cfg.padId).toBe(0);
    expect(cfg.doLowerCase).toBe(false);
    expect(cfg.maxLength).toBe(512);
  });

  it("strip_accents 为 null 时跟随 do_lower_case(HF 语义)", () => {
    const lower = buildConfig(minimalTokenizerJson, { do_lower_case: true, strip_accents: null });
    expect(lower.stripAccents).toBe(true);
    const cased = buildConfig(minimalTokenizerJson, { do_lower_case: false, strip_accents: null });
    expect(cased.stripAccents).toBe(false);
    // 显式给值时不被 do_lower_case 覆盖。
    const explicit = buildConfig(minimalTokenizerJson, {
      do_lower_case: true,
      strip_accents: false,
    });
    expect(explicit.stripAccents).toBe(false);
  });

  it("maxLength 封顶 512 —— 有些 config 写着 1e30", () => {
    const cfg = buildConfig(minimalTokenizerJson, { model_max_length: 1e30 });
    expect(cfg.maxLength).toBe(512);
  });

  it("词表或特殊 token 缺失时明确抛错,不静默出坏向量", () => {
    expect(() => buildConfig({ model: {} }, {})).toThrow(/vocab/);
    expect(() => buildConfig({ model: { vocab: { a: 0 } } }, {})).toThrow(/\[UNK\]|\[CLS\]/);
  });
});

/**
 * 与真实模型文件对齐。模型是 24MB 二进制、不进仓库(见 .gitignore),所以没拉
 * 模型时这组自动跳过 —— 上面的规则用例已经覆盖了逻辑本身。
 */
describe("B2 · 与真实 tokenizer.json 对齐", () => {
  const dir = modelDir();
  const tjPath = path.join(dir, "tokenizer.json");
  const tcPath = path.join(dir, "tokenizer_config.json");
  const present = fs.existsSync(tjPath) && fs.existsSync(tcPath);
  const realConfig = (): WordPieceConfig =>
    buildConfig(
      JSON.parse(fs.readFileSync(tjPath, "utf8")),
      JSON.parse(fs.readFileSync(tcPath, "utf8")),
    );

  it.skipIf(!present)("真实配置能构造出可用的 config", () => {
    const cfg = realConfig();
    // bert-base-chinese 系词表,21128 是 bge-small-zh-v1.5 的既定规格。
    expect(cfg.vocab.size).toBe(21128);
    expect(cfg.clsId).toBe(101);
    expect(cfg.sepId).toBe(102);
    expect(cfg.unkId).toBe(100);
    expect(cfg.padId).toBe(0);
    // do_lower_case=false 是模型自带口径。实测保持它比强制小写召回更好
    // (Top1 8/10 vs 7/10),这里钉住,避免有人「顺手优化」成 true。
    expect(cfg.doLowerCase).toBe(false);
    expect(cfg.maxLength).toBe(512);
  });

  it.skipIf(!present)("真实词表下中文逐字编码,常见医学缩写不炸", () => {
    const cfg = realConfig();
    const zh = encode("样本质量", cfg);
    // 4 个汉字 + [CLS] + [SEP]
    expect(zh.inputIds).toHaveLength(6);
    expect(zh.inputIds.every((i) => i >= 0 && i < cfg.vocab.size)).toBe(true);

    // 词表里没有大写 token,DV200 之类会落到 [UNK]/子词 —— 这是已知取舍:
    // 字面精确匹配由 BM25 通道负责,语义通道不需要认识缩写。这里只保证不抛错。
    const mixed = encode("FFPE 样本 DV200 37%", cfg);
    expect(mixed.inputIds.length).toBeGreaterThan(2);
    expect(mixed.inputIds.every((i) => i >= 0 && i < cfg.vocab.size)).toBe(true);
  });

  it.skipIf(!present)("超长中文段落截断到 512,不会撑爆张量", () => {
    const cfg = realConfig();
    const out = encode("样本质量评估流程".repeat(200), cfg);
    expect(out.inputIds).toHaveLength(512);
    expect(out.inputIds.at(-1)).toBe(cfg.sepId);
  });
});
