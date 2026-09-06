/**
 * §7 引用核实合规率看板单测（`citation-compliance.ts`）。
 *
 * 只钉这一层自己的职责：查 `documents` 表 + 套台账 + `safe()` 降级——具体的
 * 提取/计算规则已经在 `rag/citation-provenance.test.ts` 钉过，这里不重复。
 */
import { describe, it, expect } from "vitest";
import { createDb, type NovaDb } from "../db/client";
import { indexDocument } from "../rag/retrieval";
import { SEED_DOCS } from "../rag/seed-knowledge";
import { citationComplianceBoard } from "./citation-compliance";
import { loadProvenanceLedger } from "../rag/citation-provenance";

function insert(db: NovaDb, id: string, source: string, citation: string) {
  indexDocument(db, {
    id,
    source,
    title: id,
    citation,
    version: "v1",
    appliesTo: "测试",
    validUntil: "2030-01-01",
    lang: "zh",
    validation: "verified",
    passages: ["占位段落。"],
  });
}

describe("citationComplianceBoard", () => {
  it("库里只有 SOP、没有 SCI 文献:分母为 0,读作「没有样本」", () => {
    const db = createDb(":memory:");
    insert(db, "D-SOP", "SOP", "NV-SOP-RNA-042");
    const board = citationComplianceBoard(db);
    expect(board.total).toBe(0);
    expect(board.rate).toBeNull();
  });

  it("台账未核实的 SCI 文献计入分母但不计入分子", () => {
    const db = createDb(":memory:");
    insert(db, "D-PMID", "SCI", "PMID: 999999");
    const board = citationComplianceBoard(db);
    expect(board.total).toBe(1);
    expect(board.verified).toBe(0);
    expect(board.rate).toBe(0);
    expect(board.violations[0]?.reason).toBe("not-in-ledger");
  });

  it("documents 表被删时只降级不抛 —— 埋点缺失不该让运营页 500", () => {
    const db = createDb(":memory:");
    db.exec("DROP TABLE documents");
    expect(() => citationComplianceBoard(db)).not.toThrow();
    const board = citationComplianceBoard(db);
    expect(board.rate).toBeNull();
    expect(board.total).toBe(0);
  });

  it("真实种子库(SEED_DOCS)接真实台账:诚实反映当前未核实状态,不伪造 verified", () => {
    // 这条测试钉住的是「诚实」本身——沙箱出网受限,两条种子文献(PMID 35361992 /
    // DOI 10.1038/s41598-021-00042-7)当前台账状态是 unverified。这里不断言
    // rate === 1,而是断言看板如实反映台账里写的是什么,防止未来有人为了让
    // 这条测试变绿而悄悄把台账里的 status 硬改成 verified。
    const db = createDb(":memory:");
    for (const doc of SEED_DOCS) insert(db, doc.id, doc.source, doc.citation);
    const ledger = loadProvenanceLedger();
    const board = citationComplianceBoard(db);
    const sciCount = SEED_DOCS.filter((d) => d.source === "SCI").length;
    expect(board.total).toBe(sciCount);
    const expectedVerified = SEED_DOCS.filter(
      (d) => d.source === "SCI" && Object.values(ledger).some((e) => e.status === "verified" && d.citation.includes(e.value)),
    ).length;
    expect(board.verified).toBe(expectedVerified);
  });
});
