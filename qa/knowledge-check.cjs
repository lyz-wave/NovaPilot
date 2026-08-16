/* 知识进化模块重构验收:
   ① 证据一致性(专家排除项不进入候选) ② 多候选切换器 ③ 门禁角色归属
   ④ 一键回滚(灰度→退出生产+索引移除) ⑤ 审计轨迹可见 */
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

  /* ═══ A. 先播种演示候选 ═══ */
  await page.goto(BASE + "/knowledge", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  check("播种:候选状态=候选知识·不参与生产", /不参与生产/.test(await page.textContent(".candidate-status") || ""));
  check("审计轨迹:初始可见且含候选生成/novapilot", /候选生成/.test(await page.textContent(".audit-trail") || "") && /novapilot/.test(await page.textContent(".audit-trail") || ""));
  check("门禁角色:4 条责任标签", (await page.locator(".gate-actor").count()) === 4, "actors=" + (await page.locator(".gate-actor").count()));
  const actorText = await page.locator(".review-console").textContent();
  check("门禁角色:owner/novabench/release-manager/ops", /rna-knowledge-owner/.test(actorText || "") && /novabench/.test(actorText || "") && /release-manager/.test(actorText || "") && /ops/.test(actorText || ""));
  check("单候选:切换器隐藏", (await page.locator(".candidate-switcher").count()) === 0);
  check("未灰度:无回滚按钮", (await page.locator(".rollback-action").count()) === 0);

  /* ═══ B. 专家排除证据 + 批准 → 第二个候选 ═══ */
  await page.goto(BASE + "/expert", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.locator(".case-queue > button").first().click();
  const claimBtn = page.locator(".case-topline .primary-action");
  if (((await claimBtn.textContent()) || "").includes("认领案例")) {
    await claimBtn.click();
    await page.waitForTimeout(600);
  }
  const codeText = ((await page.locator(".evidence-check-row code").first().textContent()) || "").trim();
  const excludedCitation = codeText.split(" · ")[0];
  check("证据审查:捕获被排除证据", excludedCitation.length > 0, excludedCitation);
  // 同一文献可能命中多个检索切片:专家排除该引文的全部切片行。
  const evRows = page.locator(".evidence-check-row");
  const evCount = await evRows.count();
  let excludedRows = 0;
  for (let i = 0; i < evCount; i++) {
    const rowCode = ((await evRows.nth(i).locator("code").textContent()) || "").trim();
    if (rowCode.startsWith(excludedCitation)) {
      const input = evRows.nth(i).locator("input");
      if (await input.isChecked()) { await input.click(); excludedRows++; }
    }
  }
  check("证据审查:被排除切片 ≥1", excludedRows >= 1, "excluded=" + excludedRows);
  await page.waitForTimeout(200);
  await page.locator(".decision-controls .primary-action").click();
  await page.waitForTimeout(800);
  const approveNotice = await page.textContent(".case-notice");
  check("批准:生成候选知识提示", /候选知识/.test(approveNotice || ""), (approveNotice || "").replace(/\s+/g, " ").trim());

  /* ═══ C. 多候选切换器 + 证据一致性 ═══ */
  await page.goto(BASE + "/knowledge", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const switchBtns = page.locator(".candidate-switcher button");
  check("多候选:切换器出现 2 个候选", (await switchBtns.count()) === 2, "count=" + (await switchBtns.count()));
  check("多候选:状态徽章可见", (await page.locator(".candidate-switcher .status-chip").count()) === 2);
  const activeCardId = await page.textContent(".candidate-card .candidate-id");
  check("默认激活:最新批准候选", !(activeCardId || "").includes("CK-260719-017"), (activeCardId || "").trim());
  const statementText = await page.textContent(".candidate-statement");
  check("批准候选:修订文本入卡", (statementText || "").includes("建议先选择"), (statementText || "").replace(/\s+/g, " ").slice(0, 60));
  const evidenceDd = await page.textContent(".candidate-fields > div:nth-child(3) dd");
  check("证据一致性:被排除证据不进入候选", !(evidenceDd || "").includes(excludedCitation), "excluded=" + excludedCitation);
  check("证据一致性:其余证据保留", /NV-SOP|PMID|DOI/.test(evidenceDd || ""));
  const tokens = (evidenceDd || "").split(" · ");
  check("证据一致性:引文去重", tokens.length >= 2 && new Set(tokens).size === tokens.length, evidenceDd || "");

  /* ═══ D. 切换回种子候选,走四道门禁 ═══ */
  await page.locator(".candidate-switcher button", { hasText: "CK-260719-017" }).click();
  await page.waitForTimeout(300);
  check("切换:候选卡显示种子 id", ((await page.textContent(".candidate-card .candidate-id")) || "").includes("CK-260719-017"));
  const stepBtns = page.locator(".review-step button");
  check("切换后:门禁从 0 开始", (await stepBtns.nth(1).isDisabled()) === true);
  await stepBtns.nth(0).click();
  await page.waitForTimeout(600);
  check("Owner 批准:第1步已批准+解锁第2步", ((await stepBtns.nth(0).textContent()) || "").includes("已批准") && !(await stepBtns.nth(1).isDisabled()));
  check("审计轨迹:记录 owner-approved", /Owner 批准/.test(await page.textContent(".audit-trail") || ""));
  await stepBtns.nth(1).click();
  await page.waitForFunction(() => {
    const btn = document.querySelectorAll(".review-step button")[1];
    const t = btn?.textContent || "";
    return t.includes("已通过") || !!document.querySelector(".ops-error");
  }, null, { timeout: 90000 });
  const step2 = await stepBtns.nth(1).textContent();
  const gateNotice = await page.locator(".ops-error").count() ? await page.textContent(".ops-error") : "";
  check("NovaBench:通过或正确拦截", (step2 || "").includes("已通过") || (gateNotice || "").includes("未通过"), (step2 || gateNotice || "").trim());
  const step2passed = (step2 || "").includes("已通过");
  if (step2passed) {
    await stepBtns.nth(2).click();
    await page.waitForTimeout(600);
    check("人工批准:已签署", ((await stepBtns.nth(2).textContent()) || "").includes("已签署"));
    await stepBtns.nth(3).click();
    await page.waitForTimeout(800);
    check("开始灰度:已激活", ((await stepBtns.nth(3).textContent()) || "").includes("已激活"));
    check("灰度激活:verdict ACTIVE", ((await page.textContent(".evolution-verdict strong")) || "").includes("ACTIVE"));
    check("审计轨迹:含灰度激活", /灰度激活/.test(await page.textContent(".audit-trail") || ""));
    check("回滚按钮:出现", (await page.locator(".rollback-action").count()) === 1);
    check("切换器徽章:种子候选灰度生效", /灰度生效/.test(await page.textContent(".candidate-switcher") || ""));

    /* ═══ D.5 刷新持久化:候选影响面切片应从落库报告恢复 ═══ */
    await page.goto(BASE + "/knowledge", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const benchRowsAfterReload = await page.locator(".bench-row").count();
    check("候选影响面:刷新后切片仍显示", benchRowsAfterReload > 0, "rows=" + benchRowsAfterReload);
    await page.locator(".candidate-switcher button", { hasText: "CK-260719-017" }).click();
    await page.waitForTimeout(300);

    /* ═══ E. 一键回滚 ═══ */
    await page.locator(".rollback-action").click();
    await page.waitForTimeout(800);
    check("回滚:生产锁→已回滚", /已回滚/.test(await page.textContent(".production-lock strong") || ""));
    check("回滚:头部状态→灰度知识已回滚", /灰度知识已回滚/.test(await page.textContent(".candidate-status") || ""));
    check("回滚:verdict→NO", ((await page.textContent(".evolution-verdict strong")) || "").includes("NO"));
    check("回滚:审计轨迹末条=已回滚/release-manager", /已回滚/.test(await page.textContent(".audit-trail") || "") && /release-manager/.test(await page.textContent(".audit-trail") || ""));
    check("回滚:回滚按钮消失", (await page.locator(".rollback-action").count()) === 0);
    check("回滚后:第1步保持已批准", ((await page.locator(".review-step button").nth(0).textContent()) || "").includes("已批准"));
    check("回滚后:历史门禁结论保留(第2步仍已通过)", ((await page.locator(".review-step button").nth(1).textContent()) || "").includes("已通过"));
    const grayBtnAfter = page.locator(".review-step button").nth(3);
    check("回滚后:灰度门重新开放", !(await grayBtnAfter.isDisabled()) && ((await grayBtnAfter.textContent()) || "").includes("开始灰度"), ((await grayBtnAfter.textContent()) || "").trim());
    // 重新灰度 → 新一轮周期重新激活
    await grayBtnAfter.click();
    await page.waitForTimeout(800);
    check("重新灰度:verdict 再次 ACTIVE", ((await page.textContent(".evolution-verdict strong")) || "").includes("ACTIVE"));
    check("重新灰度:回滚按钮再次出现", (await page.locator(".rollback-action").count()) === 1);
    const grayHits = ((await page.textContent(".audit-trail")) || "").match(/灰度激活/g);
    check("重新灰度:审计轨迹开启新一轮周期", (grayHits?.length ?? 0) >= 2, "gray-cycles=" + (grayHits?.length ?? 0));
  } else {
    check("灰度链路:门禁拦截,后续步骤保持禁用(正确)", (await stepBtns.nth(2).isDisabled()) === true);
  }

  console.log("CONSOLE_ERRORS:", errors.length);
  const fails = results.filter((r) => !r.ok);
  console.log("KNOWLEDGE_SUMMARY:", results.length, "checks,", fails.length, "failed");
  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
