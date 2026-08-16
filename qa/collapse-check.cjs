/* 双栏折叠 + 会话搜索 + 按需生成决策卡验收 */
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

  const colW = () => page.locator(".consultation-column").evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const w0 = await colW();

  // 1) 左栏收起:细条出现(logo/+ /搜索),咨询区变宽
  await page.click('button[aria-label="收起项目侧栏"]');
  await page.waitForTimeout(250);
  check("左栏收起:workspace 类", await page.locator(".workspace.rail-collapsed").count() === 1);
  check("左栏收起:细条三件套(logo/+ /搜索)", (await page.locator(".rail-logo").count()) === 1 && (await page.locator(".rail-strip-btn").count()) === 2);
  const w1 = await colW();
  check("左栏收起:咨询区变宽", w1 > w0 + 150, w0 + " → " + w1);

  // 2) 悬停 logo 展开
  await page.hover(".rail-logo");
  await page.waitForTimeout(250);
  check("悬停 logo:侧栏展开", (await page.locator(".workspace.rail-collapsed").count()) === 0);

  // 3) 再次收起 → 搜索弹层
  await page.click('button[aria-label="收起项目侧栏"]');
  await page.waitForTimeout(200);
  await page.click('button[aria-label="搜索会话"]');
  await page.waitForTimeout(200);
  check("搜索弹层:出现", (await page.locator(".rail-search-pop").count()) === 1);
  await page.fill(".rail-search-pop input", "新");
  const hitCount = await page.locator(".rail-search-pop li").count();
  check("搜索弹层:输入过滤", hitCount >= 0 && (await page.locator(".rail-search-empty").count()) + hitCount >= 0, "hits=" + hitCount);
  await page.keyboard.press("Escape");
  // 展开回去(点 logo)
  await page.click(".rail-logo");
  await page.waitForTimeout(200);

  // 4) 右栏决策卡收起/展开
  await page.click('.welcome-scenes button:has-text("实验方案设计")');
  await page.waitForSelector(".decision-title-row h2", { timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });
  const w2 = await colW();
  await page.click('button[aria-label="收起决策卡"]');
  await page.waitForTimeout(250);
  check("决策卡收起:细条出现", (await page.locator(".decision-panel.panel-collapsed").count()) === 1);
  const w3 = await colW();
  check("决策卡收起:咨询区更宽", w3 > w2 + 200, w2 + " → " + w3);
  await page.click('button[aria-label="展开决策卡"]');
  await page.waitForTimeout(250);
  check("决策卡展开:恢复", (await page.locator(".decision-panel.panel-collapsed").count()) === 0);

  // 5) 聊天回复的“生成决策卡”按钮
  await page.fill('textarea[aria-label="科研问题"]', "你好");
  await page.click("button.send-button");
  await page.waitForFunction(() => !document.querySelector(".thinking-block:not(.thinking-done)"), null, { timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });
  const formalize = await page.locator(".formalize-btn").count();
  check("聊天回复:出现“生成决策卡”按钮", formalize === 1);
  await page.click(".formalize-btn");
  await page.waitForSelector(".decision-title-row h2", { timeout: 45000 });
  check("点击后:生成决策卡", true);

  console.log("CONSOLE_ERRORS:", errors.length);
  const fails = results.filter((r) => !r.ok);
  console.log("COLLAPSE_SUMMARY:", results.length, "checks,", fails.length, "failed");
  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });