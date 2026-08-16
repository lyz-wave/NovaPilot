const { chromium } = require("playwright");
const BASE = "http://localhost:3210";
const results = [];
function check(name, ok, detail) { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : "")); }
(async () => {
  const browser = await chromium.launch();
  /* 桌面:长对话滚动时角色栏钉在列顶 */
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.click('.welcome-scenes button:has-text("实验方案设计")');
  await page.waitForSelector(".decision-title-row h2", { timeout: 45000 });
  await page.waitForTimeout(600);
  // 再补四张卡(含转接演示的长内容块),确保咨询列充分溢出
  for (const label of ["数据分析", "论文支持", "追问演示", "转接演示"]) {
    await page.click('.scenario-strip button:has-text("' + label + '")');
    await page.press('textarea[aria-label="科研问题"]', "Enter");
    await page.waitForTimeout(1200);
  }
  await page.waitForFunction(() => document.querySelectorAll(".agent-message").length >= 5, null, { timeout: 45000 });
  const pos = await page.evaluate(() => getComputedStyle(document.querySelector(".role-bar")).position);
  check("桌面:角色栏 position=sticky", pos === "sticky", pos);
  // 等所有流式渲染结束(内容不再长高)后滚到底,再复滚一次
  await page.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => { const c = document.querySelector(".consultation-column"); c.scrollTop = c.scrollHeight; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const c = document.querySelector(".consultation-column"); c.scrollTop = c.scrollHeight; });
  await page.waitForTimeout(250);
  const box = await page.locator(".role-bar").boundingBox();
  const expectedTop = await page.evaluate(() => {
    const c = document.querySelector(".consultation-column");
    const pad = parseFloat(getComputedStyle(c).paddingTop) || 0;
    return c.getBoundingClientRect().top + pad; // sticky 钉在内容盒顶部(列边框盒 + 内边距)
  });
  check("桌面:向下滚动后角色栏钉在列顶", !!box && Math.abs(box.y - expectedTop) < 5, "barTop=" + Math.round(box.y) + " expected=" + Math.round(expectedTop));
  await ctx.close();

  /* 移动端:角色栏不钉(static) */
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await ctx2.newPage();
  await mp.goto(BASE + "/", { waitUntil: "networkidle" });
  const mpos = await mp.evaluate(() => getComputedStyle(document.querySelector(".role-bar")).position);
  check("移动端:角色栏 position=static(不钉)", mpos === "static", mpos);
  const mOverflow = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check("移动端:无横向溢出", mOverflow.sw <= mOverflow.cw + 1, JSON.stringify(mOverflow));
  await ctx2.close();

  console.log("CONSOLE_ERRORS:", errors.length);
  const fails = results.filter((r) => !r.ok);
  console.log("PIN_SUMMARY:", results.length, "checks,", fails.length, "failed");
  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
