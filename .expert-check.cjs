/* 专家工作台补强验收:证据审查、门禁预览、队列过滤、SLA、跳转链接 */
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
  await page.goto(BASE + "/expert", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  // 1) 交接包证据审查区(种子冲突案例含证据)
  const evRows = await page.locator(".evidence-check-row").count();
  check("证据审查:存在且条数 ≥2", evRows >= 2, "rows=" + evRows);
  const evText = await page.locator(".evidence-review").textContent();
  check("证据审查:含引用与核验状态", /NV-SOP|PMID|DOI/.test(evText || "") && /已核验|存在冲突/.test(evText || ""));
  await page.locator(".evidence-check-row input").first().click();
  check("证据审查:可排除(划线态)", (await page.locator(".evidence-check-row.excluded").count()) === 1);

  // 2) 门禁预览
  const gates = page.locator(".gate-preview li");
  check("门禁预览:5 步", (await gates.count()) === 5, "steps=" + (await gates.count()));
  const gateText = await page.locator(".gate-preview").textContent();
  check("门禁预览:含 NovaBench/灰度", /NovaBench/.test(gateText || "") && /5% 灰度/.test(gateText || ""));
  check("门禁预览:当前步骤=生成候选", /生成候选/.test(await gates.first().textContent() || ""));

  // 3) 队列:分组过滤 + 计数
  const filters = page.locator(".queue-filters button");
  check("队列过滤:4 个分组", (await filters.count()) === 4);
  await filters.nth(1).click(); // 待认领
  await page.waitForTimeout(200);
  const awaitingBtns = await page.locator(".case-queue > button").count();
  check("待认领分组:案例按钮 ≥1", awaitingBtns >= 1, "count=" + awaitingBtns);
  await filters.nth(0).click();
  const shiftText = await page.textContent(".shift-card");
  check("值班卡:真实计数且无假数字", /队列/.test(shiftText || "") && !/在线 4 人/.test(shiftText || ""), (shiftText || "").replace(/\s+/g, " ").trim());

  // 4) 认领 → 时间戳 + SLA 剩余
  await page.locator(".case-queue > button").first().click();
  const claimBtn = page.locator(".case-topline .primary-action");
  if (((await claimBtn.textContent()) || "").includes("认领案例")) {
    await claimBtn.click();
    await page.waitForTimeout(600);
  }
  const caseIdText = await page.textContent(".case-id");
  check("认领后:显示认领时间", /认领 \d{2}:\d{2}/.test(caseIdText || ""), (caseIdText || "").replace(/\s+/g, " ").trim());
  const slaText = await page.textContent(".case-queue");
  check("认领后:SLA 剩余显示", /SLA 剩余 \d+ 分钟/.test(slaText || ""), (slaText || "").match(/SLA 剩余 \d+ 分钟/)?.[0]);

  // 4.5) 待决策项可勾选清单
  const checklist = page.locator(".decision-checklist li");
  check("待决策项:清单 ≥1 项", (await checklist.count()) >= 1, "items=" + (await checklist.count()));
  check("编辑范围注记:存在", (await page.locator(".edit-scope-note").count()) === 1);
  await checklist.first().locator("input").check();
  await page.waitForTimeout(200);
  check("待决策项:勾选后划线+计数", (await page.locator(".decision-checklist span.done").count()) === 1 && /1\//.test(await page.textContent(".handoff-grid article:has(.decision-checklist) p") || ""));
  const firstDecision = (await checklist.first().textContent() || "").trim();

  // 5) 批准 → 候选知识 + 跳转链接
  await page.locator(".decision-controls .primary-action").click();
  await page.waitForTimeout(800);
  const notice = await page.textContent(".case-notice");
  check("批准:候选知识提示", /候选知识/.test(notice || ""), (notice || "").replace(/\s+/g, " ").trim());
  const linkHref = await page.locator(".notice-link").getAttribute("href");
  check("批准:跳转知识进化链接", linkHref === "/knowledge", linkHref);

  // 5.5) 候选知识并入已解决待决策项
  await page.goto(BASE + "/knowledge", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const statement = await page.textContent(".candidate-statement");
  check("候选知识:含已解决待决策项", (statement || "").includes("已解决待决策项") && (statement || "").includes(firstDecision.slice(0, 6)), (statement || "").replace(/\s+/g, " ").slice(0, 80));

  console.log("CONSOLE_ERRORS:", errors.length);
  const fails = results.filter((r) => !r.ok);
  console.log("EXPERT_SUMMARY:", results.length, "checks,", fails.length, "failed");
  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });