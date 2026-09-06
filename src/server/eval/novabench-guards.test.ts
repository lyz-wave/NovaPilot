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
import { ensureSeeded } from "../service";
import { createDb } from "../db/client";

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
