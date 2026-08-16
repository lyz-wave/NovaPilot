/* 流式输出 + 思考中折叠条专项验证 */
const { chromium } = require("playwright");
const BASE = "http://localhost:3210";
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : ""));
}
(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // ═══ A. 聊天回复:流式 + 思考条 ═══
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  await page.fill('textarea[aria-label="科研问题"]', "你好");
  await page.click("button.send-button");

  // 快速探测“思考中”态(离线流程较快,可能转瞬即逝,未捕获也不算失败)
  const sawPending = await page
    .waitForSelector('.thinking-block:not(.thinking-done) .thinking-toggle', { timeout: 1200 })
    .then(() => true)
    .catch(() => false);
  console.log("INFO | 聊天:捕获到进行中思考条 =", sawPending);
  if (sawPending) {
    try {
      const pendTxt = await page.textContent('.thinking-block:not(.thinking-done) .thinking-toggle', { timeout: 1500 });
      check("思考条(进行中):显示思考中", (pendTxt || "").includes("思考中"), pendTxt?.trim());
      await page.click('.thinking-block:not(.thinking-done) .thinking-toggle', { timeout: 1500 });
      const expanded = (await page.locator('.thinking-block:not(.thinking-done) .thinking-toggle').getAttribute("aria-expanded")) === "true";
      check("思考条(进行中):点击箭头可展开", expanded);
    } catch {
      console.log("INFO | 思考条(进行中):离线流程完成过快,跳过展开断言(非失败)");
    }
  }

  await page.waitForSelector(".agent-message .agent-summary", { timeout: 45000 });

  // 采样渐进增长
  const lens = [];
  for (let i = 0; i < 12; i++) {
    lens.push((await page.locator(".agent-message .agent-summary").last().innerText()).length);
    await page.waitForTimeout(40);
  }
  const growing = lens.filter((l, i) => i === 0 || l > lens[i - 1]).length >= 2;
  check("聊天回复:文本渐进增长", growing, "len=" + lens.join(","));

  await page.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });
  const finalLen = (await page.locator(".agent-message .agent-summary").last().innerText()).length;
  check("聊天回复:完成后文本完整", finalLen > 40, "final=" + finalLen);

  // 完成后的思考条
  const doneToggle = page.locator(".agent-message .thinking-toggle").last();
  const doneToggleTxt = (await doneToggle.textContent()) || "";
  check("思考条(完成后):已思考 N 步", /已思考 \d+ 步/.test(doneToggleTxt), doneToggleTxt.trim());
  await doneToggle.click();
  const chips = await page.locator(".agent-message .thinking-trail .trail-node").count();
  const trailText = (await page.locator(".agent-message .thinking-trail").textContent()) || "";
  check("思考条:点击箭头展开思考过程", chips >= 1 && /对话理解/.test(trailText), trailText.trim());
  await ctx.close();

  // ═══ B. 决策卡:摘要流式 + 多步思考过程 ═══
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pageB = await ctxB.newPage();
  pageB.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await pageB.goto(BASE + "/", { waitUntil: "networkidle" });
  // A 段已留下历史,新建会话回到欢迎态
  await pageB.click('button[aria-label="新建会话"]');
  await pageB.waitForSelector(".thread-welcome", { timeout: 10000 });
  await pageB.click('.welcome-scenes button:has-text("实验方案设计")');
  await pageB.waitForSelector(".decision-title-row h2", { timeout: 45000 });
  const caretOnCard = (await pageB.locator(".agent-message").last().locator(".stream-caret").count()) > 0;
  check("决策卡:摘要气泡流式光标可见", caretOnCard);
  await pageB.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });
  const bubbleSummary = (await pageB.locator(".agent-message").last().locator(".agent-summary").innerText()).trim();
  const panelSummary = (await pageB.locator(".card-section").first().innerText()).trim();
  check("决策卡:气泡摘要与面板一致(共同前缀)", panelSummary.includes(bubbleSummary.slice(0, 12)) || bubbleSummary.includes(panelSummary.slice(0, 12)));

  // 决策卡思考条:步骤数 + 展开
  const cardToggle = pageB.locator(".agent-message").last().locator(".thinking-toggle");
  const cardToggleTxt = (await cardToggle.textContent()) || "";
  const stepCount = parseInt((cardToggleTxt.match(/\d+/) || ["0"])[0], 10);
  check("决策卡思考条:已思考 ≥4 步", /已思考 \d+ 步/.test(cardToggleTxt) && stepCount >= 4, cardToggleTxt.trim());
  await cardToggle.click();
  const cardChips = await pageB.locator(".agent-message").last().locator(".thinking-trail .trail-node").count();
  const cardTrail = (await pageB.locator(".agent-message").last().locator(".thinking-trail").textContent()) || "";
  check("决策卡思考条:展开 = 步骤数且含“形成决策卡”", cardChips === stepCount && /形成决策卡/.test(cardTrail), cardTrail.trim());
  check("决策卡思考条:aria-expanded", (await cardToggle.getAttribute("aria-expanded")) === "true");
  await ctxB.close();

  // ═══ C. reduced-motion ═══
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page2 = await ctx2.newPage();
  await page2.goto(BASE + "/", { waitUntil: "networkidle" });
  await page2.click('button[aria-label="新建会话"]');
  await page2.waitForSelector(".thread-welcome", { timeout: 10000 });
  await page2.fill('textarea[aria-label="科研问题"]', "在吗");
  await page2.click("button.send-button");
  await page2.waitForFunction(() => document.querySelectorAll(".agent-message .agent-summary").length >= 1, null, { timeout: 45000 });
  const rmLen1 = (await page2.locator(".agent-message .agent-summary").last().innerText()).length;
  await page2.waitForTimeout(200);
  const rmLen2 = (await page2.locator(".agent-message .agent-summary").last().innerText()).length;
  const rmCaret = (await page2.locator(".stream-caret").count()) > 0;
  check("reduced-motion:全文立即渲染(无增长)", rmLen1 === rmLen2 && rmLen1 > 0, "len=" + rmLen1);
  check("reduced-motion:无光标", !rmCaret);
  await ctx2.close();

  console.log("CONSOLE_ERRORS:", errors.length);
  if (errors.length) console.log(errors.slice(0, 5));
  const fails = results.filter((r) => !r.ok);
  console.log("STREAMING_SUMMARY:", results.length, "checks,", fails.length, "failed");
  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
