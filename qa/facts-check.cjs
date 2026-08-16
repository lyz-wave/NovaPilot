/* 项目事实扩展验收:物种/目标下拉、元信息、待确认追问 chips */
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

  // 1) 下拉与默认值
  const selects = page.locator(".fact-field select");
  check("物种/研究目标下拉:2 个", (await selects.count()) === 2, "count=" + (await selects.count()));
  const speciesVal = await selects.nth(0).inputValue();
  const goalVal = await selects.nth(1).inputValue();
  check("默认物种 = Homo sapiens", speciesVal === "Homo sapiens", speciesVal);
  check("默认目标 = 差异表达 · 通路富集", goalVal === "差异表达 · 通路富集", goalVal);

  // 2) 元信息:每个事实字段带来源注记
  const metas = await page.locator(".fact-field small:has-text(\"客户方案书\")").count();
  check("事实元信息:来源注记 ≥5 处", metas >= 5, "metas=" + metas);

  // 3) 待确认 chips
  const chips = page.locator(".pending-ask");
  check("待确认 chips:3 个(配对/批次/组织量)", (await chips.count()) === 3, "count=" + (await chips.count()));
  const chipText = await page.locator(".pending-ask").allTextContents();
  check("chips 文案:待确认状态", /配对设计/.test(chipText.join("")) && /批次信息/.test(chipText.join("")) && /组织量/.test(chipText.join("")) && /待确认/.test(chipText.join("")));

  // 4) 切换物种/目标 → 场景条回填含新值
  await selects.nth(0).selectOption("Mus musculus");
  await selects.nth(1).selectOption("肿瘤微环境与免疫");
  await page.click(".confirm-facts");
  await page.waitForSelector(".decision-title-row h2", { timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });
  await page.click('.scenario-strip button:has-text("数据分析")');
  const filled = await page.inputValue('textarea[aria-label="科研问题"]');
  check("回填问句含新物种/目标", /Mus musculus/.test(filled) && /肿瘤微环境/.test(filled), filled.slice(0, 80));
  await page.fill('textarea[aria-label="科研问题"]', "");

  // 5) 点击“配对设计”追问
  const userBefore = await page.locator(".user-message").count();
  await page.locator(".pending-ask:has-text(\"配对设计\")").click();
  await page.waitForFunction((n) => document.querySelectorAll(".user-message").length > n, userBefore, { timeout: 30000 });
  const lastUser = await page.locator(".user-message").last().textContent();
  check("配对追问:注入问题含“配对”", /配对/.test(lastUser || ""), (lastUser || "").trim().slice(0, 60));
  check("配对追问:带快捷提问徽标", (await page.locator(".user-message").last().locator(".quick-badge").count()) === 1);
  // 等待“思考中”块消失(结果落地)且流式结束,再读最新助手消息
  await page.waitForFunction(() => !document.querySelector('.thinking-block:not(.thinking-done)'), null, { timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });
  const lastAgent = await page.locator(".agent-message").last().textContent();
  check("配对追问:回答切题(统计功效/配对/批次证据)", /配对|批次|统计功效|Paired|batch/i.test(lastAgent || ""), (lastAgent || "").trim().slice(0, 60));
  const askedChip = await page.locator(".pending-ask.asked:has-text(\"配对设计\")").count();
  check("配对追问:chip 变已追问", askedChip === 1);

  console.log("CONSOLE_ERRORS:", errors.length);
  const fails = results.filter((r) => !r.ok);
  console.log("FACTS_SUMMARY:", results.length, "checks,", fails.length, "failed");
  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });