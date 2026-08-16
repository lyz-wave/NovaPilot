import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteContext } from "../write-context";
import { getDb } from "@/server/db/client";
import { getCandidate, listCandidates, saveCandidate } from "@/server/db/repositories";
import { rollbackCandidateKnowledge } from "@/domain/consultation-journey";
import { candidateDocumentId, promoteCandidateToKnowledge } from "@/server/eval/promotion";
import { removeDocument } from "@/server/rag/retrieval";

// Node runtime required for node:sqlite (not available on the edge runtime).
export const runtime = "nodejs";

const BEARER = "Bearer demo-research-session";

// The four governed promotion gates. Only when all four pass does
// promoteCandidateToKnowledge index the statement into the live KB.
const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("promote"),
    candidateId: z.string().min(1),
    checks: z.object({
      ownerApproved: z.boolean(),
      novaBenchPassed: z.boolean(),
      grayValidationPassed: z.boolean(),
      humanApproved: z.boolean(),
    }),
  }),
  z.object({
    action: z.literal("rollback"),
    candidateId: z.string().min(1),
  }),
]);

/** GET /api/knowledge → { candidates: CandidateKnowledge[] } (bearer). */
export async function GET(request: Request) {
  if (request.headers.get("authorization") !== BEARER) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  return NextResponse.json({ candidates: listCandidates(getDb()) });
}

/**
 * POST /api/knowledge (write contract) — run the promotion gates for a
 * candidate and persist the result. Pure domain + SQLite, so every pipeline
 * step is demonstrable offline; a fully-promoted candidate is indexed into the
 * knowledge base as citable evidence.
 */
export async function POST(request: Request) {
  const write = requireWriteContext(request);
  if (write.error) return write.error;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_PROMOTION_INPUT" }, { status: 400 });
  }

  const db = getDb();
  const candidate = getCandidate(db, parsed.data.candidateId);
  if (!candidate) {
    return NextResponse.json({ error: "CANDIDATE_NOT_FOUND" }, { status: 404 });
  }

  const now = new Date().toISOString();

  // 一键回滚:灰度知识退出生产 + 生产索引即时移除。
  if (parsed.data.action === "rollback") {
    const rolledBack = rollbackCandidateKnowledge(candidate);
    if (rolledBack.status === "gray-active") {
      return NextResponse.json({ error: "CANDIDATE_NOT_ACTIVE" }, { status: 409 });
    }
    saveCandidate(db, rolledBack, now);
    removeDocument(db, candidateDocumentId(candidate.id));
    return NextResponse.json(
      { candidate: rolledBack, published: false, documentId: null },
      { headers: { "x-trace-id": write.context.traceId } },
    );
  }

  const result = promoteCandidateToKnowledge(db, candidate, parsed.data.checks, now);
  return NextResponse.json(result, { headers: { "x-trace-id": write.context.traceId } });
}
