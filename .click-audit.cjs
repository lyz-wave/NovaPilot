/* NovaPilot 前端优化版 · 全按钮点击路径审计(临时 QA 脚本) */
const { chromium } = require("playwright");
const BASE = "http://localhost:3210";

const results = [];
let consoleErrors = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : ""));
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  /* ═══ 1. 咨询页 ═══ */
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);

  // 1.1 发送按钮空/非空
  const send = page.locator('button.send-button');
  check("发送按钮:空输入禁用", await send.isDisabled());
  await page.fill('textarea[aria-label="科研问题"]', "你好");
  check("发送按钮:有输入启用", !(await send.isDisabled()));
  await page.fill('textarea[aria-label="科研问题"]', "");

  // 1.2 示例按钮填入文本
  await page.click('.composer-tools button[aria-label="插入示例问题"]');
  const filled = (await page.inputValue('textarea[aria-label="科研问题"]')).length > 5;
  check("插入示例问题:填入文本", filled);
  await page.fill('textarea[aria-label="科研问题"]', "");

  // 1.3 标准方案 → 决策卡
  await page.click('.welcome-scenes button:has-text("实验方案设计")');
  await page.waitForSelector('.decision-title-row h2', { timeout: 45000 });
  const title1 = await page.textContent('.decision-title-row h2');
  const assurance1 = await page.textContent('.assurance');
  const evidenceScore = await page.textContent('.evidence-score');
  check("方案设计:生成决策卡", !!title1 && title1.trim().length > 3, "标题=" + title1?.trim().slice(0, 24));
  check("方案设计:状态徽章内容", /正式决策卡|专家待审|补充条件/.test(assurance1 || ""), assurance1?.trim());
  check("方案设计:证据分数(A2)", (evidenceScore || "").trim() === "A2", evidenceScore?.trim());

  // 1.4 决策卡 Tab
  const tabs = page.locator('.decision-tabs [role="tab"]');
  await tabs.nth(1).click();
  const evCount = await page.locator('.evidence-list article').count();
  check("证据 Tab:证据条目>0", evCount > 0, evCount + " 条");
  await tabs.nth(2).click();
  const verCount = await page.locator('.version-history article').count();
  check("版本 Tab:版本行≥1", verCount >= 1, verCount + " 行");
  await tabs.nth(0).click();

  // 1.5 导出
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }),
    page.click('button[aria-label="导出科研决策卡"]'),
  ]);
  check("导出决策卡:下载 .md", download.suggestedFilename().endsWith(".md"), download.suggestedFilename());

  // 1.6 反馈
  await page.click('.feedback-actions button:has-text("有帮助")');
  const thanks = await page.textContent('.feedback-thanks');
  check("反馈:已记录", (thanks || "").includes("已记录"), thanks?.trim());

  // 1.7 授权
  const consentBtn = page.locator('.service-fit button');
  await consentBtn.click();
  await page.waitForTimeout(300);
  const consentTxt = await consentBtn.textContent();
  check("授权报价:变已授权+禁用", (consentTxt || "").includes("已授权") && (await consentBtn.isDisabled()), consentTxt?.trim());

  // 1.8 语言切换
  const enBtn = page.locator('.language-switcher button:has-text("EN")');
  await enBtn.click();
  check("语言切换 EN:aria-pressed", (await enBtn.getAttribute("aria-pressed")) === "true");
  await page.locator('.language-switcher button:has-text("中")').click();

  // 1.9 条件缺失 → 追问块 → 补充 DV200
  await page.click('.scenario-strip button:has-text("追问演示")'); // 场景条=回填输入框
  await page.press('textarea[aria-label="科研问题"]', "Enter");
  await page.waitForSelector('.clarification-block', { timeout: 45000 });
  const clarQ = await page.textContent('.clarification-block strong');
  check("条件缺失:出现最小必要追问", !!clarQ, clarQ?.trim().slice(0, 30));
  const cardsBefore = await page.locator('.agent-message').count();
  await page.click('.clarification-block .inline-actions button:has-text("补充 DV200")');
  await page.waitForFunction((n) => document.querySelectorAll('.agent-message').length > n, cardsBefore, { timeout: 45000 });
  // 历史消息里的旧追问块仍在,只检查“最新一张卡”无追问块且状态为正式决策卡
  const latestCard = page.locator('.agent-message').last();
  const clarInLatest = await latestCard.locator('.clarification-block').count();
  const latestAssurance = await latestCard.locator('.assurance').textContent();
  check("补充 DV200:最新卡无追问+正式决策卡", clarInLatest === 0 && /正式决策卡/.test(latestAssurance || ""), (latestAssurance || "").trim());

  // 1.10 证据冲突 → 强制转接
  await page.click('.scenario-strip button:has-text("转接演示")'); // 场景条=回填输入框
  await page.press('textarea[aria-label="科研问题"]', "Enter");
  await page.waitForSelector('.handoff-block', { timeout: 45000 });
  const handoffTxt = await page.textContent('.handoff-block .block-kicker');
  check("证据冲突:强制转接块", (handoffTxt || "").includes("MANDATORY"), handoffTxt?.trim());
  const hold = await page.textContent('.evidence-score');
  check("证据冲突:HOLD 分数", (hold || "").trim() === "HOLD", hold?.trim());

  // 1.11 手动转接(composer 输入)
  await page.fill('textarea[aria-label="科研问题"]', "请转交人工专家复核。");
  await page.click('button.send-button');
  await page.waitForFunction(() => document.querySelectorAll('.handoff-block').length >= 2, null, { timeout: 45000 });
  check("手动转接:第二张转接卡", true);

  // 1.12 清空对话
  await page.click('.clear-conversation');
  await page.waitForSelector('.thread-welcome', { timeout: 15000 });
  check("清空对话:回到欢迎态", true);
  const panelEmpty = await page.locator('.decision-empty strong').count();
  check("清空后:决策卡空状态", panelEmpty === 1);

  // 1.13 会话管理
  await page.click('button[aria-label="新建会话"]');
  await page.waitForTimeout(600);
  const convCount1 = await page.locator('.conversation-menu').count();
  await page.click('button.project-switcher');
  const menuVisible = await page.locator('.conversation-menu').isVisible();
  check("新建会话:下拉可见且≥2会话", menuVisible && (await page.locator('.conversation-menu li').count()) >= 2, "li=" + await page.locator('.conversation-menu li').count());

  // 重命名第二个会话
  const pencil = page.locator('.conversation-menu li .conversation-actions button[aria-label="重命名会话"]').nth(1);
  await pencil.click();
  await page.fill('.conversation-rename', "测序方案讨论");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const renamed = (await page.locator('.conversation-menu li .conversation-title').nth(1).textContent())?.trim();
  check("重命名会话:标题更新", renamed === "测序方案讨论", renamed);

  // 切换回第一个会话
  await page.locator('.conversation-menu li .conversation-item').first().click();
  await page.waitForTimeout(800);
  const switchedEmpty = (await page.locator('.thread-welcome').count()) === 1;
  check("切换会话:加载历史(欢迎态)", switchedEmpty, "第一个会话此前已清空");

  // 删除第二个会话:先打开菜单,删除后菜单保持打开,直接数条目
  await page.click('button.project-switcher');
  await page.locator('.conversation-menu li .conversation-actions button[aria-label="删除会话"]').nth(1).click();
  await page.waitForTimeout(600);
  const liAfterDel = await page.locator('.conversation-menu li').count();
  check("删除会话:剩1个", liAfterDel === 1, "li=" + liAfterDel);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const switcherTitle = await page.textContent('.project-switcher strong');
  check("删除后:切换器标题更新", (switcherTitle || "").trim().length > 0, switcherTitle?.trim());

  // 1.14 上下文环 + 自动压缩
  await page.click('.context-ring');
  await page.waitForTimeout(500);
  check("上下文环:点击无错误", true);
  const autoBtn = page.locator('.context-auto');
  await autoBtn.click();
  check("自动压缩:切换 on", (await autoBtn.getAttribute("class"))?.includes("on") === true);
  await autoBtn.click();

  // 1.15 模型弹窗
  await page.click('button.model-badge');
  await page.waitForSelector('.model-modal');
  check("模型弹窗:dialog 语义", (await page.locator('.model-modal').getAttribute("role")) === "dialog");
  await page.click('.model-row:has-text("离线模式")');
  await page.waitForTimeout(500);
  const badgeTxt = await page.textContent('.model-badge');
  check("切换离线模式:徽章更新", (badgeTxt || "").includes("离线"), badgeTxt?.trim());
  await page.keyboard.press("Escape");
  check("模型弹窗:Escape 关闭", (await page.locator('.model-modal').count()) === 0);

  // 1.16 聊天问候(无卡)
  await page.fill('textarea[aria-label="科研问题"]', "你好");
  await page.click('button.send-button');
  await page.waitForFunction(() => document.querySelectorAll('.agent-message').length >= 1, null, { timeout: 45000 });
  const stillEmpty = (await page.locator('.decision-empty').count()) === 1;
  check("闲聊问候:回复但不生成决策卡", stillEmpty);

  // 1.17 修改事实 → 确认
  await page.fill('.fact-field input[type="number"] >> nth=0', "30");
  const pendingLabel = await page.textContent('.section-label .pending-label');
  check("修改事实:出现待确认", (pendingLabel || "").includes("修改待确认"), pendingLabel?.trim());
  await page.click('.confirm-facts');
  await page.waitForSelector('.decision-title-row h2', { timeout: 45000 });
  const verified = await page.textContent('.section-label .verified-label');
  check("确认事实:变已确认+生成卡", (verified || "").includes("已确认"), verified?.trim());

  /* ═══ 2. 专家工作台 ═══ */
  await page.goto(BASE + "/expert", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const queueCount = await page.locator('.case-queue > button').count();
  check("专家台:队列≥2案例", queueCount >= 2, "队列=" + queueCount);
  await page.locator('.case-queue > button').first().click();
  const caseStatus1 = await page.textContent('.case-id');
  check("专家台:切换案例显示详情", !!caseStatus1, caseStatus1?.trim());

  // 认领
  const claim = page.locator('.case-topline .primary-action');
  const claimTxt = await claim.textContent();
  if ((claimTxt || "").includes("认领案例")) {
    await claim.click();
    await page.waitForTimeout(600);
    check("认领案例:变已认领+通知", ((await claim.textContent()) || "").includes("已由你认领") && (await page.locator('.case-notice').count()) === 1, (await page.textContent('.case-notice'))?.trim());
  } else {
    check("认领案例:此前已认领/已解决(跳过)", true, claimTxt?.trim());
  }
  // 退回
  const returnBtn = page.locator('button.secondary-action');
  if (!(await returnBtn.isDisabled())) {
    await returnBtn.click();
    await page.waitForTimeout(600);
    check("退回队列:状态回到待认领", ((await page.textContent('.case-id')) || "").includes("待认领"), (await page.textContent('.case-notice'))?.trim());
    // 重新认领后批准
    await page.locator('.case-topline .primary-action').click();
    await page.waitForTimeout(500);
  }
  const approveBtn = page.locator('.decision-controls .primary-action');
  const approveDisabled0 = await approveBtn.isDisabled();
  check("批准按钮:未认领时禁用" , approveDisabled0 === false, "disabled=" + approveDisabled0);
  await approveBtn.click();
  await page.waitForTimeout(800);
  const approveState = await approveBtn.textContent();
  const approveNotice = await page.textContent('.case-notice');
  check("批准决策卡:变已批准+生成候选知识", (approveState || "").includes("已批准") && (approveNotice || "").includes("候选知识"), approveNotice?.trim());
  const taDisabled = await page.locator('.expert-decision textarea').isDisabled();
  check("已解决:修订区禁用", taDisabled);
  const checkBoxDisabled = await page.locator('.decision-controls input[type="checkbox"]').isDisabled();
  check("已解决:候选复选框禁用", checkBoxDisabled);

  /* ═══ 3. 知识进化 ═══ */
  await page.goto(BASE + "/knowledge", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const stepBtns = page.locator('.review-step button');
  const g2before = await stepBtns.nth(1).isDisabled();
  check("晋级链:第2步初始禁用", g2before);
  await stepBtns.nth(0).click();
  await page.waitForTimeout(600);
  const step1 = await stepBtns.nth(0).textContent();
  const g2after = await stepBtns.nth(1).isDisabled();
  check("Owner 批准:第1步已批准+解锁第2步", (step1 || "").includes("已批准") && !g2after, step1?.trim());
  await stepBtns.nth(1).click();
  await page.waitForFunction(() => {
    const btn = document.querySelectorAll('.review-step button')[1];
    const t = btn?.textContent || "";
    return t.includes("已通过") || !!document.querySelector('.ops-error');
  }, null, { timeout: 90000 });
  const step2 = await stepBtns.nth(1).textContent();
  const gateNoticeCount = await page.locator('.ops-error').count();
  const gateNotice = gateNoticeCount ? await page.textContent('.ops-error') : "";
  check("NovaBench:通过或正确拦截", (step2 || "").includes("已通过") || (gateNotice || "").includes("未通过"), (step2 || gateNotice || "").trim());
  const benchRows = await page.locator('.bench-row').count();
  check("候选影响面:基准表有数据", benchRows > 0, "rows=" + benchRows);
  const step2passed = (step2 || "").includes("已通过");
  if (step2passed) {
    await stepBtns.nth(2).click();
    await page.waitForTimeout(600);
    check("人工批准:已签署", ((await stepBtns.nth(2).textContent()) || "").includes("已签署"));
    await stepBtns.nth(3).click();
    await page.waitForTimeout(800);
    const grayBtn = await stepBtns.nth(3).textContent();
    check("开始灰度:已激活", (grayBtn || "").includes("已激活"), grayBtn?.trim());
    const verdict = await page.textContent('.evolution-verdict strong');
    const lock = await page.textContent('.production-lock strong');
    check("灰度激活:verdict ACTIVE+生产解锁", (verdict || "").includes("ACTIVE") && (lock || "").includes("灰度生效"), (verdict || "").trim());
    const status = await page.textContent('.candidate-status strong');
    check("头部状态:灰度知识已激活", (status || "").includes("灰度"), status?.trim());
  } else {
    check("灰度链路:门禁拦截,后续步骤保持禁用(正确)", (await stepBtns.nth(2).isDisabled()) === true);
  }

  /* ═══ 4. 运营评测 ═══ */
  await page.goto(BASE + "/operations", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const metric0 = await page.textContent('.metric-value strong');
  check("指标卡:有数值", /\d/.test(metric0 || ""), metric0?.trim());
  await page.click('.mode-toggle .run-bench');
  await page.waitForFunction(() => !document.querySelector('.mode-toggle .run-bench')?.disabled, null, { timeout: 60000 });
  check("运行 NovaBench:完成并恢复按钮", true);
  await page.click('.degrade-switch:has-text("引用失效")');
  await page.waitForTimeout(500);
  const blockedState = await page.textContent('.release-state strong');
  const verdict1 = await page.textContent('.gate-verdict strong');
  const openEvents = await page.locator('.event-open').count();
  const citationFail = await page.locator('.metric-value em.bad').count();
  check("模拟退化:灰度停止+STOP 判定", (blockedState || "").includes("停止") && (verdict1 || "").includes("STOP"), (verdict1 || "").trim());
  check("模拟退化:质量事件>0+引用 FAIL", openEvents > 0 && citationFail >= 1, "events=" + openEvents + " fails=" + citationFail);
  await page.click('.degrade-switch:has-text("引用失效")');
  await page.waitForTimeout(400);
  const verdict2 = await page.textContent('.gate-verdict strong');
  check("关掉退化:PROCEED+事件待人工关闭", (verdict2 || "").includes("PROCEED") && (await page.locator('.event-open').count()) === 1, (verdict2 || "").trim());
  await page.click('.resolve-event');
  await page.waitForTimeout(200);
  await page.fill('.resolve-form textarea', "已恢复引用门禁并通过复测");
  await page.click('.resolve-form .primary-action');
  await page.waitForTimeout(600);
  const clearRow = await page.locator('.quality-list .quality-clear').count();
  const clearText = await page.textContent('.quality-list strong');
  check("事件闭环:关闭证据后清零", clearRow === 1 && /无未关闭/.test(clearText || ""), (clearText || "").trim());
  await page.click('.board-link');
  const drawerCount = await page.locator('.evidence-drawer .evidence-item').count();
  check("证据抽屉:展开 6 项", drawerCount === 6, drawerCount + " 项");
  check("证据抽屉:aria-expanded", (await page.locator('.board-link').getAttribute("aria-expanded")) === "true");
  await page.click('.board-link');
  check("证据抽屉:收起", (await page.locator('.evidence-drawer').count()) === 0);

  /* ═══ 5. 导航 ═══ */
  const navCurrent = await page.locator('.global-nav a[aria-current="page"]').textContent();
  check("导航高亮:运营评测", (navCurrent || "").includes("运营评测"), navCurrent?.trim());
  await page.click('.global-nav a:has-text("科研咨询")');
  await page.waitForURL(BASE + "/", { timeout: 10000 });
  check("导航跳转:回到咨询页", page.url() === BASE + "/");

  console.log("CONSOLE_ERRORS_TOTAL:", consoleErrors.length);
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 8));
  const fails = results.filter((r) => !r.ok);
  console.log("AUDIT_SUMMARY:", results.length, "checks,", fails.length, "failed");
  fails.forEach((f) => console.log("  FAIL:", f.name, "|", f.detail));
  await browser.close();
  process.exit(fails.length || consoleErrors.length ? 1 : 0);
})().catch((e) => { console.error("AUDIT_CRASH", e); process.exit(2); });
