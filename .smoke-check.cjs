/* NovaPilot 前端优化版 · 冒烟检查脚本(临时) */
const { chromium } = require("playwright");
let AxeBuilder = null;
try { AxeBuilder = require("@axe-core/playwright").default; } catch {}

const BASE = "http://localhost:3210";

async function auditPage(browser, path, name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
  const res = await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(400);

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { sw: doc.scrollWidth, cw: doc.clientWidth };
  });

  let axeIssues = null;
  if (AxeBuilder) {
    try {
      const results = await new AxeBuilder({ page }).analyze();
      axeIssues = results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => v.id + "(" + v.impact + ")x" + v.nodes.length);
    } catch (e) { axeIssues = ["axe-error: " + e.message]; }
  }

  console.log("PAGE", name, "| status", res && res.status(), "| overflow", JSON.stringify(overflow),
    "| consoleErrors", errors.length, "| axe", JSON.stringify(axeIssues));
  if (errors.length) console.log("   errors:", errors.slice(0, 5));
  await ctx.close();
  return { overflow: overflow.sw > overflow.cw + 1, errors: errors.length };
}

(async () => {
  const browser = await chromium.launch();
  const fails = [];
  for (const [p, n] of [["/", "consultation"], ["/expert", "expert"], ["/knowledge", "knowledge"], ["/operations", "operations"]]) {
    const r = await auditPage(browser, p, n);
    if (r.overflow) fails.push(n + ":horizontal-overflow");
    if (r.errors) fails.push(n + ":console-errors");
  }

  // 交互检查:咨询页
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(300);

  // 发送按钮:空输入禁用,输入后启用
  const send = page.locator('button.send-button');
  const disabledEmpty = await send.isDisabled();
  await page.fill('textarea[aria-label="科研问题"]', "测试问题");
  const enabledAfterInput = !(await send.isDisabled());
  await page.fill('textarea[aria-label="科研问题"]', "");
  console.log("INTERACTION send-button empty-disabled:", disabledEmpty, "| enabled-after-input:", enabledAfterInput);


  // 会话下拉:Escape 关闭 + aria-expanded
  const switcher = page.locator('button.project-switcher');
  await switcher.click();
  const expanded = await switcher.getAttribute("aria-expanded");
  await page.keyboard.press("Escape");
  const expandedAfter = await switcher.getAttribute("aria-expanded");
  console.log("INTERACTION switcher expanded:", expanded, "-> after Escape:", expandedAfter);

  // 模型弹窗:dialog 角色 + Escape 关闭 + 焦点归还
  const badge = page.locator('button.model-badge');
  await badge.click();
  await page.waitForTimeout(200);
  const dialogRole = await page.locator('.model-modal').getAttribute("role");
  const activeInModal = await page.evaluate(() => document.activeElement && document.activeElement.className);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const focusBack = await page.evaluate(() => document.activeElement && document.activeElement.className);
  console.log("INTERACTION modal role:", dialogRole, "| focusIn:", activeInModal, "| focusBack:", focusBack);

  // 决策卡 Tab:点击证据后方向键
  await page.fill('textarea[aria-label="科研问题"]', "FFPE RNA 建库路线选择");
  await page.click('button.send-button');
  await page.waitForTimeout(2500);

  // 场景条 aria-pressed(会话开始后才渲染,故放在发送之后)
  await page.waitForSelector('.scenario-strip button', { timeout: 20000 });
  const scenarioBtn = page.locator('.scenario-strip button').first();
  await scenarioBtn.click();
  await page.waitForTimeout(200);
  const pressed = await scenarioBtn.getAttribute("aria-pressed");
  console.log("INTERACTION scenario aria-pressed:", pressed);

  const tabs = page.locator('.decision-tabs [role="tab"]');
  const tabCount = await tabs.count();
  if (tabCount > 0) {
    await tabs.nth(1).click();
    const activePanel = await page.locator('[role="tabpanel"]').first().getAttribute("id");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
    const focusedTab = await page.evaluate(() => document.activeElement && document.activeElement.textContent);
    console.log("INTERACTION tabs count:", tabCount, "| panel id:", activePanel, "| focus after ArrowRight:", focusedTab);
  } else {
    console.log("INTERACTION tabs: not rendered (no card yet)");
  }

  // 移动端横向溢出
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const [p, n] of [["/", "consultation-m"], ["/expert", "expert-m"], ["/knowledge", "knowledge-m"], ["/operations", "operations-m"]]) {
    await mobile.goto(BASE + p, { waitUntil: "networkidle" });
    await mobile.waitForTimeout(300);
    const of = await mobile.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    const bad = of.sw > of.cw + 1;
    console.log("MOBILE", n, JSON.stringify(of), bad ? "OVERFLOW!" : "ok");
    if (bad) fails.push(n + ":overflow");
  }

  await browser.close();
  console.log("SMOKE_SUMMARY fails:", JSON.stringify(fails));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("SMOKE_CRASH", e); process.exit(2); });
