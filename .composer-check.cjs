/* 输入框停靠验证:桌面列内钉底 / 移动端视口钉底(导航上方) */
const { chromium } = require("playwright");
const BASE = "http://localhost:3210";
const results = [];
function check(name, ok, detail) { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : "")); }
(async () => {
  const browser = await chromium.launch();
  const errors = [];

  /* ═══ 桌面 ═══ */
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  const pos = await page.evaluate(() => getComputedStyle(document.querySelector(".composer")).position);
  check("桌面:输入框 position=sticky", pos === "sticky", pos);

  // 造长内容
  await page.click('.welcome-scenes button:has-text("实验方案设计")');
  await page.waitForSelector(".decision-title-row h2", { timeout: 45000 });
  await page.waitForTimeout(800);

  // 滚到列顶,输入框应仍钉在列底可视区内
  await page.evaluate(() => { document.querySelector(".consultation-column").scrollTop = 0; });
  await page.waitForTimeout(200);
  let box = await page.locator(".composer").boundingBox();
  check("桌面:滚到顶部时输入框仍可见(钉底)", !!box && box.y > 0 && box.y + box.height <= 900, box ? "y=" + Math.round(box.y) + " h=" + Math.round(box.height) : "null");

  // 滚到列底,输入框原位可见
  await page.evaluate(() => { const c = document.querySelector(".consultation-column"); c.scrollTop = c.scrollHeight; });
  await page.waitForTimeout(200);
  box = await page.locator(".composer").boundingBox();
  check("桌面:滚到底部输入框可见", !!box && box.y + box.height <= 900, box ? "y=" + Math.round(box.y) : "null");
  await ctx.close();

  /* ═══ 移动端(底部导航固定) ═══ */
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await ctx2.newPage();
  mp.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await mp.goto(BASE + "/", { waitUntil: "networkidle" });
  // 移动端侧栏隐藏,无法新建会话;直接通过(钉住的)输入框发送问题造长内容
  await mp.fill('textarea[aria-label="科研问题"]', "请比较 FFPE RNA 建库路线和测序平台。");
  await mp.click("button.send-button");
  await mp.waitForSelector(".decision-title-row h2", { timeout: 45000 });
  await mp.waitForTimeout(800);

  // 滚到线程上半部分(输入框自然位置仍在视口下方),应钉在视口底部、导航上方
  await mp.evaluate(() => window.scrollTo(0, 260));
  await mp.waitForTimeout(250);
  const mbox = await mp.locator(".composer").boundingBox();
  const navBox = await mp.locator(".global-nav").boundingBox();
  const mnavTop = navBox ? navBox.y : 999;
  check("移动端:阅读线程时输入框钉在视口底部", !!mbox && mbox.y + mbox.height <= 844 && mbox.y + mbox.height >= 700, mbox ? "bottom=" + Math.round(mbox.y + mbox.height) : "null");
  check("移动端:输入框不与底部导航重叠", !!mbox && mbox.y + mbox.height <= mnavTop + 1, "composerBottom=" + Math.round(mbox.y + mbox.height) + " navTop=" + Math.round(mnavTop));
  await ctx2.close();

  console.log("CONSOLE_ERRORS:", errors.length);
  const fails = results.filter((r) => !r.ok);
  console.log("COMPOSER_SUMMARY:", results.length, "checks,", fails.length, "failed");
  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
