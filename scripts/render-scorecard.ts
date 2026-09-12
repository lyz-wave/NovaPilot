/**
 * score:render — 从 docs/metric-scorecard.json 生成 docs/指标体系达成度自评.md
 * score:check  — 同上但只校验，diff 非空则非零退出（CI gate 用）
 *
 * 用法：
 *   npm run score:render   # 写文件
 *   npm run score:check    # 只校验，diff 非空则退出码 1
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCORECARD_PATH = resolve(ROOT, "docs/metric-scorecard.json");
const NARRATIVE_PATH = resolve(ROOT, "docs/scorecard-narrative.md");
const OUT_PATH = resolve(ROOT, "docs/指标体系达成度自评.md");

const CHECK_MODE = process.argv.includes("--check");

interface Indicator {
  id: string;
  section: string;
  indicator: string;
  score: number;
  verdict: string;
  gap: string | null;
  proxyNote: string | null;
  probeExpectation: { isProxy: boolean };
}

interface Scorecard {
  generatedAt: string;
  revision: string;
  dimensions: Record<string, { label: string; weight: number; score: number }>;
  sectionSubtotals: Record<string, number>;
  indicators: Indicator[];
}

const sc: Scorecard = JSON.parse(readFileSync(SCORECARD_PATH, "utf8"));
const narrative = existsSync(NARRATIVE_PATH)
  ? readFileSync(NARRATIVE_PATH, "utf8")
  : "";

const totalScore = Object.values(sc.dimensions).reduce((s, d) => s + d.score, 0);

function verdictIcon(v: string): string {
  if (v === "full") return "✅";
  if (v === "proxy") return "⚠️";
  return "❌";
}

function sectionTitle(s: string): string {
  const titles: Record<string, string> = {
    "§3": "§3 流量与会话",
    "§4": "§4 知识检索与评测",
    "§5": "§5 防线与拦截",
    "§6": "§6 专家协同",
    "§7": "§7 知识演化",
    "§8": "§8 可靠性",
    "§9": "§9 演示就绪度",
  };
  return titles[s] ?? s;
}

// ── 生成 D 维度明细表 ─────────────────────────────────────────────────────

const sections = ["§3", "§4", "§5", "§6", "§7", "§8", "§9"];

const sectionRows = sections
  .map((sec) => {
    const items = sc.indicators.filter((i) => i.section === sec);
    const sub = sc.sectionSubtotals[sec] ?? 0;
    const maxPossible = items.length;
    return `| ${sectionTitle(sec)} | ${items.length} 项 | ${sub.toFixed(1)} / ${maxPossible}.0 |`;
  })
  .join("\n");

const indicatorTable = sections
  .map((sec) => {
    const items = sc.indicators.filter((i) => i.section === sec);
    const rows = items
      .map((i) => {
        const gap = i.gap ?? i.proxyNote ?? "";
        return `| ${i.indicator} | ${i.score.toFixed(1)} | ${verdictIcon(i.verdict)} | ${gap} |`;
      })
      .join("\n");
    return `\n### ${sectionTitle(sec)}（小计 ${(sc.sectionSubtotals[sec] ?? 0).toFixed(1)}）\n\n| 指标 | 分 | 判定 | 缺口 / 备注 |\n|---|---|---|---|\n${rows}`;
  })
  .join("\n");

// ── 组合最终文档 ──────────────────────────────────────────────────────────

const generated = `# 对照《NovaPilot 量化指标体系 v1.1》的达成度自评

> **本文件由 \`npm run score:render\` 自动生成，请勿手工编辑数字部分。**
> 人工论证见 \`docs/scorecard-narrative.md\`。
> scorecard revision: **${sc.revision}**，生成时间: ${sc.generatedAt}

---

## 总分

**${totalScore.toFixed(1)} / 100**

| 维度 | 权重 | 得分 | 说明 |
|---|---|---|---|
${Object.entries(sc.dimensions)
  .map(([, d]) => `| ${d.label} | ${d.weight} | **${d.score}** | |`)
  .join("\n")}

---

## D 维度明细（指标口径覆盖，§3~§9 共 ${sc.indicators.length} 项）

折合得分：${sc.dimensions.D?.score ?? 0}（原始 ${sc.indicators.reduce((s, i) => s + i.score, 0).toFixed(1)} × 30/${sc.indicators.length} 折合）

| 节 | 项数 | 小计 |
|---|---|---|
${sectionRows}
${indicatorTable}

---

${narrative
  .split("\n")
  .filter((l) => !l.startsWith("# "))  // 去掉 narrative 的 H1 标题（已有总标题）
  .join("\n")
  .trim()}
`;

if (CHECK_MODE) {
  const current = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, "utf8") : "";
  if (current.trim() === generated.trim()) {
    console.log("score:check ✅ 自评文档与计分表一致，无 diff。");
    process.exit(0);
  } else {
    console.error("score:check ❌ 自评文档与计分表不一致，请运行 npm run score:render 重新生成。");
    // 输出简单 diff 摘要
    const curLines = current.split("\n");
    const genLines = generated.split("\n");
    let diffCount = 0;
    for (let i = 0; i < Math.max(curLines.length, genLines.length); i++) {
      if (curLines[i] !== genLines[i]) {
        console.error(`  line ${i + 1}:  current: ${(curLines[i] ?? "").slice(0, 80)}`);
        console.error(`  line ${i + 1}: expected: ${(genLines[i] ?? "").slice(0, 80)}`);
        if (++diffCount >= 10) { console.error("  ... (truncated)"); break; }
      }
    }
    process.exit(1);
  }
} else {
  writeFileSync(OUT_PATH, generated, "utf8");
  console.log(`score:render ✅ 已生成 docs/指标体系达成度自评.md（revision=${sc.revision}，总分=${totalScore.toFixed(1)}）`);
}
