/* 官方口径对齐验证 */
const { chromium } = require("playwright");
const BASE = "http://localhost:3210";
const results = [];
function check(name, ok, detail) { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : "")); }
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  // 1. 角色面板(PI 默认视图)周期
  const cycle = await page.textContent(".role-bar");
  check("角色面板周期:官方 18 天口径", /18 天/.test(cycle || ""), (cycle || "").match(/周期[^·]*·[^·]+/)?.[0]?.trim());

  // 2. 标准方案 → 决策卡
  await page.click('.welcome-scenes button:has-text("实验方案设计")');
  await page.waitForSelector('.decision-title-row h2', { timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });

  const meta = await page.textContent('.decision-meta-list');
  check("决策卡周期:18 天(≤30 样本)", /18 天/.test(meta || ""), (meta || "").trim().slice(0, 60));

  const serviceTitle = await page.textContent('.service-fit strong');
  const serviceP = await page.textContent('.service-fit p');
  check("服务适配标题:医学转录组测序", /医学转录组/.test(serviceTitle || ""), serviceTitle?.trim());
  check("服务适配说明:官方口径(Q30/0.4 μg)", /Q30 ≥ 85%|0\.4 μg/.test(serviceP || ""), (serviceP || "").trim().slice(0, 70));

  const depth = await page.textContent('.card-section:has-text("主方案")');
  check("主方案深度口径:6–12 Gb/Q30", /6–12 Gb/.test(depth || "") && /Q30/.test(depth || ""), (depth || "").trim().slice(0, 80));

  // 3. 证据 Tab 包含官方规格
  await page.click('.decision-tabs [role="tab"]:has-text("证据")');
  const evidence = await page.textContent('.evidence-list');
  check("证据列表:含 NV-SOP-MED-001 官方规格", /NV-SOP-MED-001/.test(evidence || "") && /医学转录组服务规格/.test(evidence || ""));

  console.log("CONSOLE_ERRORS:", errors.length);
  const fails = results.filter((r) => !r.ok);
  console.log("ALIGN_SUMMARY:", results.length, "checks,", fails.length, "failed");
  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
