/**
 * Governed knowledge promotion (closes the learning loop).
 *
 * The proposal's "候选知识 → 灰度 → 晋级" pipeline: an expert-modified case
 * becomes a candidate; only after owner approval + NovaBench + gray validation +
 * human approval does it become production knowledge. This module runs those
 * gates via the pure domain function `promoteCandidateKnowledge`, persists the
 * candidate, and — crucially — when fully promoted, indexes the new statement
 * into the live knowledge base so future consultations can actually retrieve
 * and cite it. Without this last step "knowledge evolution" would be cosmetic.
 */
import {
  promoteCandidateKnowledge,
  type CandidateKnowledge,
} from "@/domain/consultation-journey";
import type { NovaDb } from "../db/client";
import { saveCandidate } from "../db/repositories";
import { indexDocument } from "../rag/retrieval";

export interface PromotionChecks {
  ownerApproved: boolean;
  novaBenchPassed: boolean;
  grayValidationPassed: boolean;
  humanApproved: boolean;
}

export interface PromotionResult {
  candidate: CandidateKnowledge;
  published: boolean;
  documentId: string | null;
}

/** The document id under which a promoted candidate is indexed. */
export function candidateDocumentId(candidateId: string): string {
  return `CK-DOC-${candidateId}`;
}

/**
 * Run the promotion gates, persist the candidate, and — only when fully
 * promoted to production — index it into the knowledge base as citable
 * evidence (citation === candidate id, so recommendations can reference it).
 */
export function promoteCandidateToKnowledge(
  db: NovaDb,
  candidate: CandidateKnowledge,
  checks: PromotionChecks,
  now: string,
): PromotionResult {
  const promoted = promoteCandidateKnowledge(candidate, checks);
  saveCandidate(db, promoted, now);

  const publishable = promoted.status === "gray-active" && promoted.productionEligible;
  if (!publishable) {
    return { candidate: promoted, published: false, documentId: null };
  }

  const documentId = candidateDocumentId(promoted.id);
  indexDocument(db, {
    id: documentId,
    source: "SOP",
    title: `晋级知识 · ${promoted.sourceCaseId}`,
    citation: promoted.id,
    version: `v${promoted.version}`,
    appliesTo: promoted.scope,
    validUntil: promoted.validUntil,
    lang: "zh",
    // Fully-promoted (owner + NovaBench + gray + human) knowledge is treated as
    // verified production evidence, so the Critic will accept citations to it.
    validation: "verified",
    passages: [
      promoted.statement,
      `适用范围：${promoted.scope}。反例：${promoted.counterexample}。`,
    ],
  });

  return { candidate: promoted, published: true, documentId };
}
