import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import {
  findOpenQualityEvent,
  listQualityEvents,
  resolveQualityEvent,
  saveQualityEvent,
  type QualityEventRecord,
} from "./repositories";

const NOW = "2026-08-12T09:00:00.000Z";

function event(id: string, gateKey: string): QualityEventRecord {
  return {
    id,
    gateKey,
    label: "引用有效率",
    value: "96.9%",
    owner: "证据治理组 · 引用负责人",
    evidence: "",
    status: "open",
    simulated: true,
    createdAt: NOW,
    resolvedAt: null,
  };
}

describe("质量事件闭环 · quality_events", () => {
  it("open 事件落库、幂等查找、关闭需证据并记录时间", () => {
    const db = createDb(":memory:");
    saveQualityEvent(db, event("QE-citation-1", "citation-validity"));
    expect(listQualityEvents(db)).toHaveLength(1);
    expect(findOpenQualityEvent(db, "citation-validity")?.id).toBe("QE-citation-1");
    expect(findOpenQualityEvent(db, "p0-defects")).toBeNull();

    const resolved = resolveQualityEvent(db, "QE-citation-1", "已恢复门禁并通过复测", NOW);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.evidence).toBe("已恢复门禁并通过复测");
    expect(resolved?.resolvedAt).toBe(NOW);
    expect(findOpenQualityEvent(db, "citation-validity")).toBeNull();
    expect(listQualityEvents(db)[0].status).toBe("resolved");
  });

  it("resolve 不存在的 id 返回 null", () => {
    const db = createDb(":memory:");
    expect(resolveQualityEvent(db, "QE-missing", "证据", NOW)).toBeNull();
  });
});
