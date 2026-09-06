import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteContext } from "../write-context";
import { getDb } from "@/server/db/client";
import {
  getExpertCaseRecord,
  listExpertCases,
  saveCandidate,
  updateExpertCase,
} from "@/server/db/repositories";
import { createCandidateKnowledge } from "@/domain/consultation-journey";
import { recordCaseClosure } from "@/server/telemetry/case-closure";

// Node runtime required for node:sqlite (not available on the edge runtime).
export const runtime = "nodejs";

const BEARER = "Bearer demo-research-session";

// Actions the expert desk performs on a case. All are pure SQLite writes, so
// claim / return / approve work fully offline with no model or key.
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim"), caseId: z.string().min(1) }),
  z.object({ action: z.literal("return"), caseId: z.string().min(1), note: z.string().optional() }),
  z.object({
    action: z.literal("approve"),
    caseId: z.string().min(1),
    amendment: z.string().min(1),
    createCandidate: z.boolean().optional(),
    // 埋点 C:未产出候选知识时必填原因。schema 不在这里做条件必填(留给
    // recordCaseClosure 统一判定),否则同一条规则会有两处实现、两处口径。
    noCandidateReason: z.string().max(500).optional(),
    // 专家在证据审查中最终采用的证据(排除项不在此列)。缺省回退到
    // 演示固定的两条证据,保持既有行为。
    evidenceIds: z.array(z.string().min(1)).max(12).optional(),
  }),
]);

/** GET /api/expert-cases → { cases: ExpertCaseRecord[] } (bearer). */
export async function GET(request: Request) {
  if (request.headers.get("authorization") !== BEARER) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  return NextResponse.json({ cases: listExpertCases(getDb()) });
}

/**
 * POST /api/expert-cases (write contract) — claim / return / approve a case.
 * Approving with `createCandidate` also generates a governed candidate-knowledge
 * entry from the expert's amendment, which then surfaces on /knowledge.
 */
export async function POST(request: Request) {
  const write = requireWriteContext(request);
  if (write.error) return write.error;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_ACTION" }, { status: 400 });
  }

  const db = getDb();
  const now = new Date().toISOString();
  const body = parsed.data;
  const headers = { "x-trace-id": write.context.traceId };

  if (!getExpertCaseRecord(db, body.caseId)) {
    return NextResponse.json({ error: "CASE_NOT_FOUND" }, { status: 404 });
  }

  if (body.action === "claim") {
    const record = updateExpertCase(db, { id: body.caseId, status: "claimed", claimedAt: now, now });
    return NextResponse.json({ case: record }, { headers });
  }

  if (body.action === "return") {
    const record = updateExpertCase(db, {
      id: body.caseId,
      status: "awaiting-claim",
      claimedAt: null,
      returnNote: body.note?.trim() || "已退回：请补充缺失条件后重新提交。",
      now,
    });
    return NextResponse.json({ case: record }, { headers });
  }

  // action === "approve"
  // 埋点 C 的必填校验放在**任何写入之前**:如果先把案例置为 resolved 再发现理由
  // 没填而返回 400,案例已经办结但办结记录没落 —— 那一条会永远缺在回流率的分母
  // 里,且没人知道它缺了。宁可整个请求原地失败,让专家补一句话重试。
  if (!body.createCandidate && !(body.noCandidateReason ?? "").trim()) {
    return NextResponse.json({ error: "NO_CANDIDATE_REASON_REQUIRED" }, { status: 400 });
  }

  const record = updateExpertCase(db, {
    id: body.caseId,
    status: "resolved",
    resolution: body.amendment,
    now,
  });
  let candidate = null;
  if (body.createCandidate) {
    // 候选 id 唯一:同一案例的多次修订各自成为可切换、可分别晋级的候选,
    // 而不是互相覆盖(旧实现固定 id 会让后生成的候选吞掉先前的)。
    const candidateId = `CK-${now.replace(/\D/g, "").slice(0, 14)}`;
    candidate = createCandidateKnowledge({
      id: candidateId,
      sourceCaseId: body.caseId,
      expertModification: body.amendment,
      evidenceIds:
        body.evidenceIds && body.evidenceIds.length > 0
          ? body.evidenceIds
          : ["E-SOP-042", "E-PMID-24637835"],
    });
    saveCandidate(db, candidate, now);
  }
  // 埋点 C:办结即落一条记录,产出与未产出都落 —— 只记「产出了」的那些会让
  // 回流率的分母消失,分子当分母用永远是 100%。
  recordCaseClosure(db, {
    caseId: body.caseId,
    projectId: record?.projectId ?? "",
    owner: "expert-desk",
    resolution: body.amendment,
    producedCandidate: !!body.createCandidate,
    candidateId: candidate?.id ?? null,
    noCandidateReason: body.noCandidateReason,
    now,
  });
  return NextResponse.json({ case: record, candidate }, { headers });
}
