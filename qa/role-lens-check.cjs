/* 角色镜头 + 快捷提问诚实化验收:同卡四镜头、徽标、事实拼装、场景条回填 */
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
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  const roleDefs = [
    { id: "pi", tab: 0, label: "实验室 PI", kw: /风险|预算|周期/, action: "预约专家复核" },
    { id: "postdoc", tab: 1, label: "博士后", kw: /参数|证据|复现/, action: "导出决策卡" },
    { id: "student", tab: 2, label: "研究生", kw: /步骤|概念|DV200/, action: "术语卡" },
    { id: "rnd", tab: 3, label: "企业研发", kw: /SLA|报价|合规/, action: "SLA" },
  ];

  let cardIdentity = null;

  for (const def of roleDefs) {
    if (def.tab > 0) {
      await page.click(".clear-conversation");
      await page.waitForSelector(".thread-welcome", { timeout: 15000 });
    }
    const roleBtns = page.locator(".role-switcher button");
    await roleBtns.nth(def.tab).click();
    await page.waitForTimeout(150);

    await page.click('.welcome-scenes button:has-text("实验方案设计")');
    await page.waitForSelector(".decision-title-row h2", { timeout: 45000 });
    await page.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });

    const userMsg = page.locator(".user-message").last();
    const badge = await userMsg.locator(".quick-badge").count();
    check("[" + def.label + "] 快捷提问徽标", badge === 1, "badge=" + badge);

    const agentMsg = page.locator(".agent-message").last();
    const lensChip = await agentMsg.locator(".lens-chip").textContent();
    const lensText = await agentMsg.locator(".role-lens p").textContent();
    check("[" + def.label + "] 镜头标签", (lensChip || "").includes(def.label + " 视角"), (lensChip || "").trim());
    check("[" + def.label + "] 镜头含侧重点关键词", def.kw.test(lensText || ""), (lensText || "").trim());

    const title = (await page.textContent(".decision-title-row h2"))?.trim();
    const evTab = (await page.textContent('.decision-tabs [role="tab"]:has-text("证据")')) || "";
    const evCount = evTab.replace(/\D/g, "");
    const riskLine = (await page.textContent(".card-status small"))?.trim();
    if (cardIdentity === null) {
      cardIdentity = { title, evCount, riskLine };
      check("[" + def.label + "] 记录基准卡:" + evCount + " 证据 " + riskLine, true, (title || "").slice(0, 26));
    } else {
      check(
        "[" + def.label + "] 决策卡与基准一致",
        title === cardIdentity.title && evCount === cardIdentity.evCount && riskLine === cardIdentity.riskLine,
        (title || "").slice(0, 20) + " vs " + (cardIdentity.title || "").slice(0, 20),
      );
    }

    if (def.id === "rnd") {
      const sla = await page.textContent(".sla-note");
      check("[企业研发] SLA 注记", /SLA/.test(sla || "") && /18 天/.test(sla || "") && /不出域/.test(sla || ""));
    } else {
      const actionBtn = page.locator(".role-actions > button");
      const actionText = (await actionBtn.textContent()) || "";
      check("[" + def.label + "] 主动作 = " + def.action, actionText.includes(def.action), actionText.trim());
      if (def.id === "student") {
        await actionBtn.click();
        const terms = await page.locator(".glossary div").count();
        const glossaryText = (await page.textContent(".glossary")) || "";
        check("[研究生] 术语卡展开 3 词条", terms === 3 && /DV200/.test(glossaryText) && /链特异性/.test(glossaryText) && /PE150/.test(glossaryText));
      }
    }
  }

  // 场景条 = 回填输入框(事实拼装 + 不自动发送)
  await page.click(".clear-conversation");
  await page.waitForSelector(".thread-welcome", { timeout: 15000 });
  await page.click('.welcome-scenes button:has-text("实验方案设计")');
  await page.waitForSelector(".decision-title-row h2", { timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });

  const agentBefore = await page.locator(".agent-message").count();
  await page.click('.scenario-strip button:has-text("数据分析")');
  await page.waitForTimeout(300);
  const filled = await page.inputValue('textarea[aria-label="科研问题"]');
  const agentAfterFill = await page.locator(".agent-message").count();
  check("场景条:回填输入框(含实时事实 DV200 62%)", /DV200 62%/.test(filled), filled.slice(0, 60));
  check("场景条:回填不自动发送", agentAfterFill === agentBefore);
  await page.press('textarea[aria-label="科研问题"]', "Enter");
  await page.waitForFunction((n) => document.querySelectorAll(".agent-message").length > n, agentBefore, { timeout: 45000 });
  check("场景条:回车后正常出卡", true);

  console.log("CONSOLE_ERRORS:", errors.length);
  if (errors.length) console.log(errors.slice(0, 5));
  const fails = results.filter((r) => !r.ok);
  console.log("LENS_SUMMARY:", results.length, "checks,", fails.length, "failed");
  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });