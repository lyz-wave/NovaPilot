#!/usr/bin/env node
/**
 * 下载 B2 语义嵌入模型到 `models/bge-small-zh-v1.5/`。
 *
 * 模型二进制不进 git(24 MB,见 .gitignore)。三平台免安装包的 release
 * workflow 在 build 前跑一次本脚本,把 models/ 一起打进 zip;之后运行时
 * `NP_EMBEDDING_MODEL_DIR` 指向它,全程断网可用。
 *
 * 幂等:文件已存在且大小一致就跳过。用 `--force` 强制重下。
 *
 * 用法:node scripts/fetch-embedding-model.mjs [--force]
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const REPO = "Xenova/bge-small-zh-v1.5";
const BASE = `https://huggingface.co/${REPO}/resolve/main/`;
const OUT_DIR = path.join(process.cwd(), "models", "bge-small-zh-v1.5");

/**
 * 只取推理必需的文件。挑 `model_quantized.onnx`(int8,24 MB)而不是 fp32
 * (128 MB)—— 打包体积是三平台免安装包的硬约束。
 */
const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
];

const force = process.argv.includes("--force");

async function remoteSize(url) {
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!res.ok) return null;
  const len = res.headers.get("content-length");
  return len ? Number(len) : null;
}

async function download(rel) {
  const dest = path.join(OUT_DIR, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  if (!force && fs.existsSync(dest)) {
    const local = fs.statSync(dest).size;
    const remote = await remoteSize(BASE + rel).catch(() => null);
    if (remote === null || remote === local) {
      console.log(`skip   ${rel} (${local} bytes)`);
      return;
    }
    console.log(`stale  ${rel} (local ${local} != remote ${remote}), re-downloading`);
  }

  const res = await fetch(BASE + rel, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载 ${rel} 失败: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
  console.log(`get    ${rel} (${buf.length} bytes)`);
}

console.log(`模型目录: ${OUT_DIR}`);
for (const f of FILES) await download(f);

const total = FILES.reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0);
console.log(`完成,共 ${(total / 1024 / 1024).toFixed(1)} MB`);
