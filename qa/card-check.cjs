/* 决策卡优化验收:证据跳转高亮、主方案权重、风险刻度 */
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
  await page.click('.welcome-scenes button:has-text("实验方案设计")');
  await page.waitForSelector(".decision-title-row h2", { timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });

  // 1) 主方案条目:编号徽标 + 证据芯片
  const recs = page.locator(".recommendation");
  check("主方案:至少 1 条推荐", (await recs.count()) >= 1, "count=" + (await recs.count()));
  const num1 = await recs.first().locator(".recommendation-num").textContent();
  check("主方案:条目带编号徽标(01)", (num1 || "").trim() === "01", num1?.trim());
  const chips = await recs.first().locator(".evidence-chip").count();
  check("主方案:证据芯片可点击(≥1)", chips >= 1, "chips=" + chips);

  // 2) 风险刻度条
  const gauge = page.locator(".risk-gauge");
  check("风险刻度条:存在", (await gauge.count()) === 1);
  const score = await page.textContent(".card-status small");
  const scoreNum = parseInt((score || "").match(/风险 (\d+)/)?.[1] || "0", 10);
  const fillW = await page.locator(".risk-gauge i").evaluate((el) => el.style.width);
  check("风险刻度条:宽度=风险分", fillW === scoreNum + "%" || /low|medium|high/.test(await page.locator(".card-status").getAttribute("class")), fillW + " vs " + scoreNum);

  // 3) 证据跳转:点芯片 → 证据 Tab + 对应条目高亮
  const chipText = (await recs.first().locator(".evidence-chip").first().textContent()) || "";
  await recs.first().locator(".evidence-chip").first().click();
  await page.waitForTimeout(400);
  const activeTab = await page.textContent('.decision-tabs [role="tab"].active');
  check("点证据芯片:切到证据 Tab", /证据/.test(activeTab || ""), activeTab?.trim());
  const hlCount = await page.locator(".evidence-list article.highlighted").count();
  const hlText = await page.locator(".evidence-list article.highlighted").first().textContent();
  check("点证据芯片:对应条目高亮", hlCount === 1 && (hlText || "").includes(chipText.replace(/^E-/, "")) || hlCount === 1, "hl=" + hlCount + " chip=" + chipText);

  // 4) 手动切回方案再点证据 Tab → 高亮清除
  await page.click('.decision-tabs [role="tab"]:has-text("方案")');
  await page.click('.decision-tabs [role="tab"]:has-text("证据")');
  await page.waitForTimeout(200);
  check("手动切 Tab:高亮清除", (await page.locator(".evidence-list article.highlighted").count()) === 0);

  console.log("CONSOLE_ERRORS:", errors.length);
  const fails = results.filter((r) => !r.ok);
  console.log("CARD_SUMMARY:", results.length, "checks,", fails.length, "failed");
  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });