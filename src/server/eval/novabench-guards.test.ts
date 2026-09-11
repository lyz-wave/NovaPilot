/**
 * 金标集护栏测试 —— 防止 expectedDocIds 被滥用来撑 Hit Rate 数字。
 *
 * W2 把 `expectedDocId` 改成了 `expectedDocIds[]`，允许一条金标标注多个期望
 * 文档（取任意一命中）。这带来了反作弊风险：随手堆几十个文档 ID，命中率必然
 * 是 100%，但那个 100% 没有任何意义。
 *
 * 这里的三条断言来自 W2 计划里的「护栏」要求：
 *   1. 不超过 3 个期望文档（多了说明「期望」失去精确性）
 *   2. 每条 expectedDocIds 必须同时有 whyExpected（无依据的堆文档等于无依据）
 *   3. 没有任何一条金标把超过一半的文档都列为期望（防止把知识库扫一遍的做法）
 */
import { describe, it, expect } from "vitest";
import { GOLD_CASES } from "./novabench";
import { HALLUCINATION_CASES } from "./hallucination-set";
import { ensureSeeded } from "../service";
import { createDb } from "../db/client";
import provenanceMap from "../../../data/eval/case-provenance.json";

describe("金标集 · expectedDocIds 护栏", () => {
  it("每条 expectedDocIds 不超过 3 个", () => {
    for (const g of GOLD_CASES) {
      if (g.expectedDocIds !== undefined) {
        expect(g.expectedDocIds.length, `${g.id} expectedDocIds 超过 3 个`).toBeLessThanOrEqual(3);
      }
    }
  });

  it("每条 expectedDocIds 必须同时有非空 whyExpected 说明", () => {
    for (const g of GOLD_CASES) {
      if (g.expectedDocIds !== undefined) {
        expect(
          (g.whyExpected ?? "").trim().length,
          `${g.id} 有 expectedDocIds 但缺少 whyExpected`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("没有 expectedDocIds 的用例同样不能单独有 whyExpected（字段对齐）", () => {
    for (const g of GOLD_CASES) {
      if (g.expectedDocIds === undefined) {
        expect(
          g.whyExpected,
          `${g.id} 没有 expectedDocIds 但填了 whyExpected，字段不对齐`,
        ).toBeUndefined();
      }
    }
  });

  it("expectedDocIds 中每个 ID 在知识库里真实存在", () => {
    const db = createDb(":memory:");
    ensureSeeded(db);
    const knownIds = new Set<string>(
      (db.prepare("SELECT id FROM documents").all() as { id: string }[]).map((r) => r.id),
    );
    db.close();
    for (const g of GOLD_CASES) {
      for (const id of g.expectedDocIds ?? []) {
        expect(
          knownIds.has(id),
          `${g.id} expectedDocIds 包含不存在的文档 ID: ${id}`,
        ).toBe(true);
      }
    }
  });

  it("expectedDocIds 里没有重复", () => {
    for (const g of GOLD_CASES) {
      if (g.expectedDocIds) {
        expect(
          new Set(g.expectedDocIds).size,
          `${g.id} expectedDocIds 有重复`,
        ).toBe(g.expectedDocIds.length);
      }
    }
  });
});

describe("金标集 · provenance 多样性护栏", () => {
  const ALL_CASES = [...GOLD_CASES.map((c) => c.id), ...HALLUCINATION_CASES.map((c) => c.id)];
  const entries = ALL_CASES.map((id) => ({
    id,
    p: (provenanceMap as Record<string, { origin: string; author: string; authoredAt: string }>)[id],
  })).filter((e) => e.p !== undefined);

  it("sop-derived 案例占比 ≤ 60%", () => {
    const sopCount = entries.filter((e) => e.p.origin === "sop-derived").length;
    expect(
      sopCount / entries.length,
      `sop-derived ${sopCount}/${entries.length} 超过 60%`,
    ).toBeLessThanOrEqual(0.6);
  });

  it("单一作者占比 ≤ 70%", () => {
    const byAuthor = new Map<string, number>();
    for (const { p } of entries) byAuthor.set(p.author, (byAuthor.get(p.author) ?? 0) + 1);
    for (const [author, count] of byAuthor) {
      expect(
        count / entries.length,
        `作者 "${author}" 占比 ${count}/${entries.length} 超过 70%`,
      ).toBeLessThanOrEqual(0.7);
    }
  });

  it("单一日期占比 ≤ 60%", () => {
    const byDate = new Map<string, number>();
    for (const { p } of entries) byDate.set(p.authoredAt, (byDate.get(p.authoredAt) ?? 0) + 1);
    for (const [date, count] of byDate) {
      expect(
        count / entries.length,
        `日期 "${date}" 占比 ${count}/${entries.length} 超过 60%`,
      ).toBeLessThanOrEqual(0.6);
    }
  });

  it("幻觉案例每种 trap 类别至少 4 条", () => {
    const byTrap = new Map<string, number>();
    for (const c of HALLUCINATION_CASES) byTrap.set(c.trap, (byTrap.get(c.trap) ?? 0) + 1);
    for (const [trap, count] of byTrap) {
      expect(count, `trap="${trap}" 仅有 ${count} 条，不足 4 条`).toBeGreaterThanOrEqual(4);
    }
  });
});
