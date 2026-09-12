#!/usr/bin/env node
/**
 * 下载 B2 语义嵌入模型到 `models/bge-small-zh-v1.5/`。
 *
 * 模型二进制不进 git(24 MB,见 .gitignore)。三平台免安装包的 release
 * workflow 在 build 前跑一次本脚本,把 models/ 一起打进 zip;之后运行时
 * `NP_EMBEDDING_MODEL_DIR` 指向它,全程断网可用。
 *
 * 镜像支持:优先读取 HF_ENDPOINT 环境变量,默认按 [hf-mirror.com, huggingface.co]
 * 顺序探测与自动故障转移,防止国内网络下载超时。
 *
 * 幂等:文件已存在且大小一致就跳过。用 `--force` 强制重下。
 *
 * 用法:node scripts/fetch-embedding-model.mjs [--force]
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const REPO = "Xenova/bge-small-zh-v1.5";
const MIRRORS = [
  process.env.HF_ENDPOINT ? `${process.env.HF_ENDPOINT.replace(/\/+$/, "")}/${REPO}/resolve/main/` : null,
  `https://hf-mirror.com/${REPO}/resolve/main/`,
  `https://huggingface.co/${REPO}/resolve/main/`,
].filter(Boolean);

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

async function fetchWithFallback(rel, options = {}) {
  let lastError = null;
  for (const base of MIRRORS) {
    const url = base + rel;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
      clearTimeout(timer);
      if (res.ok) {
        return { res, base };
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`下载 ${rel} 失败 (已尝试所有可用镜像): ${lastError?.message || "网络不可达"}`);
}

async function remoteSize(rel) {
  for (const base of MIRRORS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(base + rel, { method: "HEAD", redirect: "follow", signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const len = res.headers.get("content-length");
        if (len) return Number(len);
      }
    } catch {
      // 尝试下一个镜像
    }
  }
  return null;
}

async function download(rel) {
  const dest = path.join(OUT_DIR, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  if (!force && fs.existsSync(dest)) {
    const local = fs.statSync(dest).size;
    const remote = await remoteSize(rel).catch(() => null);
    if (remote === null || remote === local) {
      console.log(`skip   ${rel} (${local} bytes)`);
      return;
    }
    console.log(`stale  ${rel} (local ${local} != remote ${remote}), re-downloading`);
  }

  const { res, base } = await fetchWithFallback(rel);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
  const host = new URL(base).hostname;
  console.log(`get    ${rel} (${buf.length} bytes) via ${host}`);
}

console.log(`模型目录: ${OUT_DIR}`);
console.log(`可用镜像源: ${MIRRORS.map((m) => new URL(m).hostname).join(", ")}`);
for (const f of FILES) await download(f);

const total = FILES.reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0);
console.log(`完成,共 ${(total / 1024 / 1024).toFixed(1)} MB`);
