/* 运行评测模块重构验收:
   真实趋势 sparkline / 装饰雷达移除 / 五开关退化矩阵 / 质量事件闭环(落库+证据必填)
   / 运行历史+回看 / 金标明细 / 模拟标记 / 刷新持久化 */
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

  /* ═══ A. 初始加载 ═══ */
  await page.goto(BASE + "/operations", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const metric0 = await page.textContent(".metric-value strong");
  check("指标卡:有数值", /\d/.test(metric0 || ""), (metric0 || "").trim());
  check("装饰雷达已移除", (await page.locator(".radar-visual").count()) === 0);
  check("退化矩阵:5 个开关", (await page.locator(".degrade-switch").count()) === 5);
  check("运行历史:初始 1 条", (await page.locator(".history-strip button").count()) === 1);
  check("趋势:单次运行显示空态提示", (await page.locator(".sparkline-empty").count()) === 4);
  check("质量事件:初始无未关闭", (await page.locator(".quality-clear").count()) === 1);
  check("初始:无模拟标记", (await page.locator(".sim-tag").count()) === 0);
  check("初始:PASS 裁决", /PASS/.test(await page.textContent(".history-strip button em") || ""));

  /* ═══ B. 金标明细 ═══ */
  await page.click(".case-toggle");
  await page.waitForTimeout(200);
  const caseRows = await page.locator(".case-row").count();
  const failRows = await page.locator(".case-row.fail").count();
  check("金标明细:9 条且全部 PASS", caseRows === 9 && failRows === 0, "rows=" + caseRows + " fails=" + failRows);
  check("金标明细:aria-expanded", (await page.locator(".case-toggle").getAttribute("aria-expanded")) === "true");
  await page.click(".case-toggle");
  check("金标明细:可收起", (await page.locator(".case-table").count()) === 0);

  /* ═══ C. 运行 NovaBench → 真实趋势 ═══ */
  await page.click(".mode-toggle .run-bench");
  await page.waitForFunction(() => !document.querySelector(".mode-toggle .run-bench")?.disabled, null, { timeout: 60000 });
  await page.waitForTimeout(400);
  check("运行 NovaBench:完成并恢复按钮", true);
  check("运行历史:增至 2 条", (await page.locator(".history-strip button").count()) === 2, "count=" + (await page.locator(".history-strip button").count()));
  check("真实趋势:sparkline 出现", (await page.locator(".metric-card .sparkline i").count()) >= 8, "bars=" + (await page.locator(".metric-card .sparkline i").count()));
  check("真实趋势:空态提示消失", (await page.locator(".sparkline-empty").count()) === 0);

  /* ═══ D. 五开关退化矩阵 ═══ */
  await page.click('.degrade-switch:has-text("引用失效")');
  await page.waitForTimeout(500);
  const verdict1 = await page.textContent(".gate-verdict strong");
  const state1 = await page.textContent(".release-state strong");
  check("引用失效:STOP+灰度停止", (verdict1 || "").includes("STOP") && (state1 || "").includes("停止"), (verdict1 || "").trim());
  check("引用失效:开放质量事件 1 条", (await page.locator(".event-open").count()) === 1);
  check("引用失效:模拟标记出现", (await page.locator(".sim-tag").count()) >= 3, "sim=" + (await page.locator(".sim-tag").count()));
  check("引用失效:指标卡 FAIL", (await page.locator(".metric-value em.bad").count()) >= 1);

  await page.click('.degrade-switch:has-text("转接漏判")');
  await page.waitForTimeout(500);
  check("转接漏判:可叠加,2 条开放事件", (await page.locator(".event-open").count()) === 2, "events=" + (await page.locator(".event-open").count()));
  const verdict2 = await page.textContent(".gate-verdict strong");
  check("叠加:STOP 列出门禁", /转接召回|引用有效率/.test(await page.textContent(".gate-verdict span") || ""), verdict2?.trim());

  // 关闭退化开关 → 门禁恢复,但事件必须人工关闭(闭环语义)
  await page.click('.degrade-switch:has-text("引用失效")');
  await page.waitForTimeout(400);
  await page.click('.degrade-switch:has-text("转接漏判")');
  await page.waitForTimeout(400);
  const verdict3 = await page.textContent(".gate-verdict strong");
  check("关掉退化:门禁回 PROCEED", (verdict3 || "").includes("PROCEED"), (verdict3 || "").trim());
  check("关掉退化:事件仍在(待人工关闭)", (await page.locator(".event-open").count()) === 2 && (await page.locator(".quality-clear").count()) === 0);

  /* ═══ E. 质量事件闭环:关闭证据必填 ═══ */
  const resolveBtns = page.locator(".resolve-event");
  await resolveBtns.first().click();
  await page.waitForTimeout(200);
  check("关闭表单:出现", (await page.locator(".resolve-form").count()) === 1);
  const submitBtn = page.locator(".resolve-form .primary-action");
  check("关闭证据必填:空文本禁用提交", (await submitBtn.isDisabled()) === true);
  await page.locator(".resolve-form textarea").fill("已恢复引用门禁并通过复测");
  await page.waitForTimeout(200);
  check("关闭证据填写后:提交启用", (await submitBtn.isDisabled()) === false);
  await submitBtn.click();
  await page.waitForTimeout(600);
  check("关闭后:开放事件剩 1 条", (await page.locator(".event-open").count()) === 1);
  check("关闭后:已关闭列表出现+证据展示", /已恢复引用门禁/.test(await page.textContent(".resolved-list") || ""));

  await page.locator(".resolve-event").first().click();
  await page.waitForTimeout(200);
  await page.locator(".resolve-form textarea").fill("转接召回复测全命中");
  await page.locator(".resolve-form .primary-action").click();
  await page.waitForTimeout(600);
  check("全部关闭:quality-clear 出现", (await page.locator(".quality-clear").count()) === 1 && (await page.locator(".event-open").count()) === 0);
  check("已关闭列表:2 条", (await page.locator(".resolved-list article").count()) === 2);

  /* ═══ F. 刷新持久化 + 历史回看 ═══ */
  await page.goto(BASE + "/operations", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  check("刷新:事件闭环持久化(仍 0 开放/2 已关闭)", (await page.locator(".event-open").count()) === 0 && (await page.locator(".resolved-list article").count()) === 2);
  check("刷新:运行历史累积(≥3 条)", (await page.locator(".history-strip button").count()) >= 3, "count=" + (await page.locator(".history-strip button").count()));
  const historyBtns = page.locator(".history-strip button");
  await historyBtns.nth(2).click();
  await page.waitForTimeout(300);
  check("历史回看:提示条出现", (await page.locator(".history-viewing").count()) === 1 && /历史回看/.test(await page.textContent(".release-state small") || ""));
  check("历史回看:明细仍可看", (await page.locator(".history-strip button.active").count()) === 1);
  await page.click(".history-viewing button");
  await page.waitForTimeout(300);
  check("回到最新:提示条消失", (await page.locator(".history-viewing").count()) === 0);

  /* ═══ G. 证据抽屉(保留) ═══ */
  await page.click(".board-link");
  check("证据抽屉:展开 6 项", (await page.locator(".evidence-drawer .evidence-item").count()) === 6);
  await page.click(".board-link");
  check("证据抽屉:收起", (await page.locator(".evidence-drawer").count()) === 0);

  console.log("CONSOLE_ERRORS:", errors.length);
  const fails = results.filter((r) => !r.ok);
  console.log("OPERATIONS_SUMMARY:", results.length, "checks,", fails.length, "failed");
  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
