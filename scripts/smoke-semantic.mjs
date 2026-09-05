#!/usr/bin/env node
/**
 * B2-3 · 语义向量烟雾测试(纯 JS,零 TS,可在免安装包的便携 Node 下直接跑)。
 *
 * 方案 5.2 评审补强要求「在 release workflow 的三平台构建中各实际执行一次
 * 语义编码作双保险」。这里刻意**不**复用 `semantic.ts`:
 *
 *  - 便携包里的 Node 跑 .ts 要开实验标志、还要处理无扩展名 import,增加不确定性;
 *  - 更重要的是,烟雾测试要验的是「**发出去的这一份**能不能推理」——
 *    打包进去的 .wasm、打包进去的模型字节、打包进去的那个 Node 二进制。
 *    换一条独立实现反而更能暴露打包问题(单测那边已经覆盖了 wordpiece 本身)。
 *
 * 中文分词在 BERT 里就是逐字成词,所以这里对纯中文输入手工构造 input_ids 即可,
 * 不需要完整的 WordPiece 实现。
 *
 * 用法: node scripts/smoke-semantic.mjs [--model-dir <dir>] [--text 测试]
 * 退出码: 0 = 推理成功;1 = 任一环节失败(CI 会因此 fail)。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_DIM = 512;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const modelDir = path.resolve(
  arg("model-dir", process.env.NP_EMBEDDING_MODEL_DIR ?? path.join("models", "bge-small-zh-v1.5")),
);
const text = arg("text", "测试");

function die(msg) {
  console.error(`✗ 语义烟雾测试失败: ${msg}`);
  process.exit(1);
}

console.log(`模型目录: ${modelDir}`);
console.log(`Node: ${process.version} (${process.platform}/${process.arch})`);

const modelPath = path.join(modelDir, "onnx", "model_quantized.onnx");
const vocabPath = path.join(modelDir, "tokenizer.json");
for (const f of [modelPath, vocabPath]) {
  if (!fs.existsSync(f)) die(`缺少文件 ${f}`);
}

// ── onnxruntime-web 的 wasm 子入口:纯 JS + .wasm,不碰原生绑定 ──
let ort;
try {
  const mod = await import("onnxruntime-web/wasm");
  ort = mod.default ?? mod;
} catch (err) {
  die(`无法加载 onnxruntime-web/wasm —— ${err.message}`);
}

// .wasm 必须从本地 node_modules 取(默认会去 CDN 拉,断网即失败);
// ORT 在 Node 下用 ESM 动态 import 加载它,所以必须是 file:// URL。
const distCandidates = [
  path.join(process.cwd(), "node_modules", "onnxruntime-web", "dist"),
  path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "node_modules", "onnxruntime-web", "dist"),
];
const distDir = distCandidates.find((d) => fs.existsSync(d));
if (!distDir) die(`找不到 onnxruntime-web/dist(试过 ${distCandidates.join(" , ")})`);
ort.env.wasm.wasmPaths = pathToFileURL(distDir + path.sep).href;
ort.env.wasm.numThreads = 1;
console.log(`wasm 目录: ${distDir}`);

// ── 分词:纯中文逐字成词,前后加 [CLS]/[SEP] ──
const vocab = JSON.parse(fs.readFileSync(vocabPath, "utf8")).model?.vocab;
if (!vocab) die("tokenizer.json 缺少 model.vocab");
const CLS = vocab["[CLS]"];
const SEP = vocab["[SEP]"];
const UNK = vocab["[UNK]"];
if (CLS === undefined || SEP === undefined || UNK === undefined) die("词表缺少特殊 token");
const ids = [CLS, ...Array.from(text).map((ch) => vocab[ch] ?? UNK), SEP];
if (ids.slice(1, -1).every((i) => i === UNK)) die(`「${text}」全部落到 [UNK],词表可能损坏`);
console.log(`input_ids(${ids.length}): ${ids.join(", ")}`);

// ── 推理 ──
const loadStart = Date.now();
let session;
try {
  const bytes = new Uint8Array(fs.readFileSync(modelPath));
  console.log(`模型字节: ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
  session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
} catch (err) {
  die(`InferenceSession.create 失败 —— ${err.message}`);
}
console.log(`会话加载: ${Date.now() - loadStart} ms`);

const dims = [1, ids.length];
const big = (xs) => BigInt64Array.from(xs, BigInt);
const runStart = Date.now();
let out;
try {
  out = await session.run({
    input_ids: new ort.Tensor("int64", big(ids), dims),
    attention_mask: new ort.Tensor("int64", big(ids.map(() => 1)), dims),
    token_type_ids: new ort.Tensor("int64", big(ids.map(() => 0)), dims),
  });
} catch (err) {
  die(`推理失败 —— ${err.message}`);
}
const elapsed = Date.now() - runStart;

const hidden = out.last_hidden_state;
if (!hidden) die(`输出缺少 last_hidden_state(实际有 ${Object.keys(out).join(", ")})`);
const dim = hidden.dims[hidden.dims.length - 1];
if (dim !== EXPECTED_DIM) die(`hidden 维度是 ${dim},预期 ${EXPECTED_DIM}`);

// CLS pooling —— 与 semantic.ts 的口径一致。
const vec = Array.from({ length: dim }, (_, d) => hidden.data[d]);
if (!vec.every(Number.isFinite)) die("输出含 NaN/Infinity");
const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
if (!(norm > 0)) die("向量模长为 0,输出全零");

console.log(`推理: ${elapsed} ms,dim=${dim},L2 模长=${norm.toFixed(4)}`);
console.log(`前 5 维: ${vec.slice(0, 5).map((x) => x.toFixed(4)).join(", ")}`);
console.log("✓ 语义烟雾测试通过 —— 本平台可离线跑真实向量");
