#!/usr/bin/env node
/**
 * §9 无人值守演示脚本 — 指标体系 v1.1 第 9 节「demo 动线成功率」。
 *
 * 做三件事:
 *   1. 清库 + 启动 Next.js 服务(PORT=3210 npm start)
 *   2. 等服务就绪后,依次运行全部 14 个 qa/*.cjs 验收脚本
 *   3. 汇总 PASS/FAIL,打印最终报告;非零退出码 = 有失败
 *
 * 用法(服务器必须先 build):
 *   node scripts/demo-e2e.mjs           # 跑全部 14 脚本
 *   node scripts/demo-e2e.mjs --dry-run # 只打印脚本列表,不启动服务
 *   PORT=3211 node scripts/demo-e2e.mjs # 换端口
 *
 * 注意:这个脚本会清除 .data/ 目录以保证演示从干净的初始状态开始。
 * 如果你有想保留的数据,请先备份。
 */
import { spawnSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = Number(process.env.PORT ?? 3210);
const BASE = `http://localhost:${PORT}`;
const DRY_RUN = process.argv.includes("--dry-run");

/** 所有 qa 脚本,按演示视频顺序排列(见 docs/demo视频脚本.md)。 */
const QA_SCRIPTS = [
  "smoke-check.cjs",       // 冒烟:四页无 JS 错误 + 移动端不溢出
  "capability-check.cjs",  // 咨询 + 流式 + 决策卡
  "streaming-check.cjs",   // 流式输出可见
  "align-check.cjs",       // 场景对齐
  "composer-check.cjs",    // 项目事实填写
  "pin-check.cjs",         // 项目固定
  "role-lens-check.cjs",   // 四角色视图
  "facts-check.cjs",       // 项目事实面板
  "card-check.cjs",        // 决策卡交互
  "collapse-check.cjs",    // 折叠/展开
  "expert-check.cjs",      // 专家工作台全链路
  "knowledge-check.cjs",   // 知识进化四门禁 + 回滚
  "operations-check.cjs",  // 运营评测 + 退化矩阵 + 质量事件
  "click-audit.cjs",       // 证据芯片跳转
];

function log(msg) { process.stdout.write(msg + "\n"); }
function err(msg) { process.stderr.write(msg + "\n"); }

/** 轮询 BASE/ 直到返回 200 或超时。 */
async function waitReady(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { status } = await fetch(BASE + "/", { signal: AbortSignal.timeout(2000) });
      if (status < 500) return true;
    } catch { /* 还没起来,继续等 */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

async function main() {
  log("┌─────────────────────────────────────────────────────┐");
  log("│  NovaPilot §9 无人值守全链路演示(demo-e2e)         │");
  log("└─────────────────────────────────────────────────────┘");

  if (DRY_RUN) {
    log("\n--dry-run:将运行以下 " + QA_SCRIPTS.length + " 个脚本(顺序):");
    QA_SCRIPTS.forEach((s, i) => log(`  ${String(i + 1).padStart(2)}. qa/${s}`));
    process.exit(0);
  }

  // ── 1. 清库 ──────────────────────────────────────────────────────────────
  const dataDir = resolve(ROOT, ".data");
  if (existsSync(dataDir)) {
    log("\n[1/3] 清除 .data/ ...");
    rmSync(dataDir, { recursive: true, force: true });
    log("      完成。");
  } else {
    log("\n[1/3] .data/ 不存在,跳过清理。");
  }

  // ── 2. 启动服务 ──────────────────────────────────────────────────────────
  log(`\n[2/3] 启动 Next.js(PORT=${PORT}) ...`);
  const serverProc = spawn(
    "npm",
    ["start"],
    {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "ignore", "pipe"],
      shell: true,
    },
  );
  serverProc.stderr.on("data", (d) => {
    const line = d.toString().trim();
    if (line) err("  [server] " + line);
  });

  log("      等待服务就绪 ...");
  const ready = await waitReady(90_000);
  if (!ready) {
    err("      ✗ 服务 90 秒内未响应。");
    serverProc.kill();
    process.exit(1);
  }
  log("      ✓ 服务已就绪。");

  // ── 3. 逐一跑 qa 脚本 ────────────────────────────────────────────────────
  log(`\n[3/3] 运行 ${QA_SCRIPTS.length} 个 qa 脚本 ...\n`);
  const results = [];
  for (const script of QA_SCRIPTS) {
    const scriptPath = resolve(ROOT, "qa", script);
    if (!existsSync(scriptPath)) {
      results.push({ script, ok: false, reason: "文件不存在" });
      err(`  MISS | qa/${script} → 文件不存在`);
      continue;
    }
    const start = Date.now();
    const r = spawnSync("node", [scriptPath], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      encoding: "utf8",
      timeout: 120_000,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const ok = r.status === 0;
    results.push({ script, ok });
    const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    log(`  ${tag} | qa/${script} (${elapsed}s)`);
    if (!ok && r.stdout) {
      const failLines = r.stdout.split("\n").filter((l) => l.includes("FAIL")).slice(0, 5);
      for (const l of failLines) log("        " + l.trim());
    }
  }

  serverProc.kill();

  // ── 报告 ─────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  log("\n┌─────────────────────────────────────────────────────┐");
  log(`│  DEMO CHAIN: ${passed}/${results.length} 脚本通过`.padEnd(55) + "│");
  log("└─────────────────────────────────────────────────────┘");
  if (failed.length > 0) {
    log("\n失败脚本:");
    for (const { script } of failed) log(`  · qa/${script}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { err("demo-e2e 异常: " + e); process.exit(2); });
