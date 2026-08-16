import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type NovaDb } from "./client";
import {
  getExpertCaseRecord,
  listCandidates,
  listExpertCases,
  saveCandidate,
  saveExpertCase,
  updateExpertCase,
} from "./repositories";
import { createCandidateKnowledge, type ExpertCase } from "@/domain/consultation-journey";

const T0 = "2026-08-13T00:00:00.000Z";
const T1 = "2026-08-13T00:05:00.000Z";

function sampleCase(id = "CASE-NP-1"): ExpertCase {
  return {
    id,
    status: "awaiting-claim",
    sla: { claimMinutes: 30, substantiveResponseHours: 4 },
    handoff: {
      objective: "FFPE RNA 灰区样本建库路线确认",
      confirmedFacts: { sampleCount: 8, dv200: 55, rnaInputNg: 20, material: "FFPE RNA" },
      attemptedAction: "完成混合检索与科研 Reviewer 审查",
      riskLevel: "high",
      reason: "SOP 与外部文献存在冲突",
      evidenceConflict: true,
      decisionsNeeded: ["确认灰区样本的建库路线", "给出额外质控或试建库要求"],
    },
  };
}

describe("专家案例仓储 · expert_cases", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("save/list/get：落库后可列出并按 id 取回,payload 为普通对象", () => {
    saveExpertCase(db, "NP-EXPERT-2407", sampleCase(), T0);
    const list = listExpertCases(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ projectId: "NP-EXPERT-2407", createdAt: T0 });
    expect(list[0].expertCase.handoff.evidenceConflict).toBe(true);
    // RSC-serialisable: plain object prototype, not the sqlite null prototype.
    expect(Object.getPrototypeOf(list[0])).toBe(Object.prototype);

    const record = getExpertCaseRecord(db, "CASE-NP-1");
    expect(record?.expertCase.status).toBe("awaiting-claim");
    expect(getExpertCaseRecord(db, "nope")).toBeNull();
  });

  it("updateExpertCase：认领→退回→批准 会更新状态并保留 createdAt", () => {
    saveExpertCase(db, "NP-EXPERT-2407", sampleCase(), T0);

    const claimed = updateExpertCase(db, { id: "CASE-NP-1", status: "claimed", now: T1 });
    expect(claimed?.expertCase.status).toBe("claimed");
    expect(claimed?.createdAt).toBe(T0); // creation time preserved on upsert

    const returned = updateExpertCase(db, {
      id: "CASE-NP-1",
      status: "awaiting-claim",
      returnNote: "请补充 RNA 投入量下限",
      now: T1,
    });
    expect(returned?.expertCase.status).toBe("awaiting-claim");
    expect(returned?.expertCase.returnNote).toBe("请补充 RNA 投入量下限");

    const resolved = updateExpertCase(db, {
      id: "CASE-NP-1",
      status: "resolved",
      resolution: "先做两份试建库再决定主路线",
      now: T1,
    });
    expect(resolved?.expertCase.status).toBe("resolved");
    expect(resolved?.expertCase.resolution).toContain("试建库");

    // Persisted, not just returned.
    expect(getExpertCaseRecord(db, "CASE-NP-1")?.expertCase.status).toBe("resolved");
  });

  it("updateExpertCase：不存在的案例返回 null", () => {
    expect(updateExpertCase(db, { id: "missing", status: "claimed", now: T1 })).toBeNull();
  });
});

describe("候选知识仓储 · candidates", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("save/list：落库后可列出,字段解析正确且为普通对象", () => {
    const candidate = createCandidateKnowledge({
      sourceCaseId: "CASE-2407",
      expertModification: "DV200 30–40% 时先进行两份代表样本试建库。",
      evidenceIds: ["E-SOP-042", "E-PMID-35361992"],
    });
    saveCandidate(db, candidate, T0);

    const list = listCandidates(db);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(candidate.id);
    expect(list[0].evidenceIds).toEqual(["E-SOP-042", "E-PMID-35361992"]);
    expect(list[0].status).toBe("candidate");
    expect(list[0].productionEligible).toBe(false);
    expect(Object.getPrototypeOf(list[0])).toBe(Object.prototype);
  });

  it("list 为空时返回空数组", () => {
    expect(listCandidates(db)).toEqual([]);
  });
});
