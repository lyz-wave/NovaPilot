/* 命题补强 + 新手引导验证:角色栏收起/展开、欢迎场景卡、机制演示、KPI */
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
  /* 0. 移动端先测(库干净、欢迎态;侧栏在移动端隐藏,不能点“新建会话”) */
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await mobile.newPage();
  await mp.goto(BASE + "/", { waitUntil: "networkidle" });
  check("移动端:角色切换器可用", (await mp.locator(".role-switcher button").count()) === 4);
  check("移动端:欢迎场景卡可用(4 张)", (await mp.locator(".welcome-scenes button").count()) === 4);
  check("移动端:机制演示入口可用", (await mp.locator(".welcome-demos button").count()) === 2);
  const mOverflow = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check("移动端:无横向溢出", mOverflow.sw <= mOverflow.cw + 1, JSON.stringify(mOverflow));
  await mobile.close();

  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  /* 1. 新手引导(欢迎态) */
  check("欢迎态:4 张主场景卡(四大核心场景)", (await page.locator(".welcome-scenes button").count()) === 4);
  check("欢迎态:2 个机制演示入口", (await page.locator(".welcome-demos button").count()) === 2);
  check("欢迎态:三步引导可见", (await page.locator(".howto-steps li").count()) === 3);
  check("欢迎态:场景条隐藏(不打扰新手)", (await page.locator(".scenario-strip").count()) === 0);

  /* 2. 角色栏:展开 → 选定后自动收起 → 箭头再展开 */
  const roleBtns = page.locator(".role-switcher button");
  check("角色工作台:4 个角色标签", (await roleBtns.count()) === 4, "count=" + (await roleBtns.count()));
  check("角色工作台:默认 PI 且面板展开", (await roleBtns.nth(0).getAttribute("aria-selected")) === "true" && (await page.locator(".role-panel").count()) === 1);
  let panel = await page.textContent(".role-panel");
  check("PI 面板:决策约束 chips", /研究目标/.test(panel || "") && /周期/.test(panel || ""), (panel || "").trim().slice(0, 50));

  await roleBtns.nth(1).click();
  await page.waitForTimeout(200);
  check("选定角色后:面板自动收起", (await page.locator(".role-bar.collapsed").count()) === 1 && (await page.locator(".role-panel").count()) === 0);
  const miniNote = await page.textContent(".role-mini-note");
  check("收起态:一行注记仍可见", /博士后/.test(miniNote || ""), miniNote?.trim());

  await page.click(".role-collapse");
  await page.waitForTimeout(200);
  panel = await page.textContent(".role-panel");
  check("点击箭头:面板重新展开(博后模块)", /参数面板/.test(panel || "") && /文献对比/.test(panel || ""));

  await roleBtns.nth(2).click();
  await page.waitForTimeout(150);
  await page.click(".role-collapse");
  const guideSteps = await page.locator(".role-steps li").count();
  const stuWelcome = await page.textContent(".thread-welcome p");
  check("研究生视图:三步引导(3 步)", guideSteps === 3, "steps=" + guideSteps);
  check("研究生视图:欢迎语含三步引导", /三步引导/.test(stuWelcome || ""), (stuWelcome || "").slice(0, 40));

  await roleBtns.nth(3).click();
  await page.waitForTimeout(150);
  await page.click(".role-collapse");
  panel = await page.textContent(".role-panel");
  check("企业视图:批次与 SLA 模块", /批次/.test(panel || "") && /SLA/.test(panel || "") && /不出域/.test(panel || ""));

  /* 3. 博士后视角:欢迎卡启动,新卡默认证据 Tab */
  await roleBtns.nth(1).click();
  await page.waitForTimeout(150);
  await page.click('.welcome-scenes button:has-text("实验方案设计")');
  await page.waitForSelector(".decision-title-row h2", { timeout: 45000 });
  await page.waitForTimeout(600);
  const activeTabPostdoc = await page.textContent('.decision-tabs [role="tab"].active');
  check("博后视角:新决策卡默认证据 Tab", /证据/.test(activeTabPostdoc || ""), activeTabPostdoc?.trim());
  check("会话开始后:场景条出现且 6 项(4 主场景 + 2 演示)", (await page.locator(".scenario-strip button").count()) === 6);
  check("场景条:机制演示有分隔标签", (await page.locator(".scenario-divider").count()) === 1);
  check("场景条:演示按钮虚线样式(2 个)", (await page.locator(".scenario-strip button.demo").count()) === 2);

  /* 4. 测序平台选择场景(欢迎卡,新拆分) */
  await page.click(".clear-conversation");
  await page.waitForSelector(".thread-welcome", { timeout: 15000 });
  await page.click('.welcome-scenes button:has-text("测序平台选择")');
  await page.waitForSelector(".decision-title-row h2", { timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });
  const platAll = await page.textContent(".agent-message");
  check("平台选择:卡片含平台/读长/数据量口径", /平台|读长|数据量|Illumina|PE150/.test(platAll || ""), (platAll || "").trim().slice(0, 60));

  /* 5. 数据分析场景(欢迎卡) */
  await page.click(".clear-conversation");
  await page.waitForSelector(".thread-welcome", { timeout: 15000 });
  await page.click('.welcome-scenes button:has-text("数据分析方法")');
  await page.waitForSelector(".decision-title-row h2", { timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });
  const anaAll = await page.textContent(".agent-message");
  check("数据分析:卡片含 DESeq2/edgeR 或富集", /DESeq2|edgeR|富集|GO|KEGG/.test(anaAll || ""), (anaAll || "").trim().slice(0, 60));
  await page.click('.decision-tabs [role="tab"]:has-text("证据")');
  const anaEvidence = await page.textContent(".evidence-list");
  check("数据分析:证据含 NV-SOP-ANALYSIS-001", /NV-SOP-ANALYSIS-001/.test(anaEvidence || ""));

  /* 5. 论文支持场景(欢迎卡) */
  await page.click(".clear-conversation");
  await page.waitForSelector(".thread-welcome", { timeout: 15000 });
  await page.click('.welcome-scenes button:has-text("论文写作支持")');
  await page.waitForSelector(".decision-title-row h2", { timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector(".stream-caret"), null, { timeout: 30000 });
  const paperAll = await page.textContent(".agent-message");
  check("论文支持:卡片含图表/方法学/火山图", /图表|方法学|火山图|热图|统计量/.test(paperAll || ""), (paperAll || "").trim().slice(0, 70));

  /* 6. 运营页 KPI */
  await page.goto(BASE + "/operations", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const kpiCount = await page.locator(".kpi-card").count();
  const kpiText = await page.textContent(".kpi-board");
  check("KPI 预期卡:8 项指标", kpiCount === 8, "count=" + kpiCount);
  check("KPI 预期卡:关键数值齐全", /55–65%/.test(kpiText || "") && /缩短 ≥90%/.test(kpiText || "") && /≥98%/.test(kpiText || ""));


  console.log("CONSOLE_ERRORS:", errors.length);
  if (errors.length) console.log(errors.slice(0, 5));
  const fails = results.filter((r) => !r.ok);
  console.log("CAPABILITY_SUMMARY:", results.length, "checks,", fails.length, "failed");
  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
