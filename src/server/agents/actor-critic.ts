/**
 * Actor–Critic dual agent (创新点 3: Actor-Critic 科研双智能体).
 *
 *   Actor  — drafts recommendations grounded ONLY in retrieved evidence.
 *   Critic — verifies each recommendation: are its citations real, in-scope and
 *            valid? does it respect the SOP boundary? does it over-claim?
 *
 * Both call the model gateway, but the whole thing is designed to produce a
 * correct, deterministic result with NO api key (the gateway falls back and the
 * agents apply rule-based grounding over the retrieved chunks). With a key the
 * gateway returns richer prose; the Critic's checks stay authoritative either
 * way so we never ship an unverifiable claim.
 */
import type { RetrievedChunk } from "../rag/retrieval";
import type { SimilarCase } from "../rag/case-memory";
import { complete, MAX_OUTPUT_TOKENS, type ChatMessage, type ModelGatewayConfig } from "./model-gateway";
import type { Locale, ProjectFacts, Scenario } from "@/domain/consultation-journey";
import {
  canonicalCite,
  buildCitationWhitelist,
  fabricatedCitations,
} from "../guards/novaguard";

export interface DraftRecommendation {
  id: string;
  title: string;
  rationale: string;
  evidenceIds: string[];
  boundary: string;
}

export interface ActorOutput {
  summary: string;
  recommendations: DraftRecommendation[];
  provider: string;
}

export interface CriticFinding {
  recommendationId: string;
  citationValid: boolean;
  inScope: boolean;
  notExpired: boolean;
  issues: string[];
}

export interface CriticOutput {
  approved: boolean;
  findings: CriticFinding[];
  /** Recommendations that survived verification (citations pruned to valid). */
  verified: DraftRecommendation[];
  provider: string;
}

const ACTOR_JSON_TEMPLATE = `{
  "summary": "面向客户的方案综述：推荐的建库/测序路线、依据、适用边界与风险、下一步需客户确认的事项",
  "recommendations": [
    {
      "title": "建议标题",
      "rationale": "建议依据——只能引用【证据】列表中方括号里的证据编号",
      "evidenceIds": ["NV-SOP-RNA-042", "PMID: 35361992"]
    }
  ]
}`;

const ACTOR_SYSTEM: Record<Locale, string> = {
  zh:
    "你是 NovaPilot 的科研方案执行智能体。请只依据提供的证据片段起草面向客户的方案建议。" +
    "你必须只输出一个 JSON 对象（不要输出任何其他文字、解释或 Markdown 代码块标记），格式如下：\n" +
    ACTOR_JSON_TEMPLATE +
    "\n硬性规则：\n" +
    "1. evidenceIds 只能从【证据】列表中方括号里的编号选择，严禁编造任何文献编号、PMID、DOI 或 SOP 编号；\n" +
    "2. 如果证据不足以支撑某条建议，就不要输出该条建议；\n" +
    "3. 严禁编造文献、数据或结论；rationale 中的每一句结论都必须能追溯到 evidenceIds 引用的证据。",
  en:
    "You are NovaPilot's research Actor agent. Draft client-facing recommendations grounded ONLY in the provided evidence. " +
    "You must output a single JSON object (no other text, no explanation, no Markdown fences) with exactly this shape:\n" +
    ACTOR_JSON_TEMPLATE +
    "\nHard rules:\n" +
    "1. evidenceIds must be chosen ONLY from the bracketed ids in the [Evidence] list; never fabricate any reference, PMID, DOI or SOP id;\n" +
    "2. If the evidence does not support a recommendation, do not output that recommendation;\n" +
    "3. Never fabricate literature, data or conclusions; every claim in a rationale must trace back to the cited evidenceIds.",
  ja:
    "あなたは NovaPilot の研究 Actor エージェントです。提供された証拠のみに基づき顧客向けの提案を作成してください。" +
    "JSON オブジェクトを 1 つだけ出力してください（他のテキスト・説明・Markdown フェンスは出力禁止）。形式は以下の通りです：\n" +
    ACTOR_JSON_TEMPLATE +
    "\n厳守事項：\n" +
    "1. evidenceIds は【証拠】リストの角括弧内の ID からのみ選択し、文献番号・PMID・DOI・SOP 番号を捏造してはなりません；\n" +
    "2. 証拠が提案を支えられない場合は、その提案を出力しないこと；\n" +
    "3. 文献・データ・結論の捏造は禁止です。rationale の各主張は evidenceIds の証拠に遡れること。",
};

/** Compact, human-readable block of the confirmed project facts for the prompt. */
function factsBlock(facts?: ProjectFacts): string {
  if (!facts) return "(暂无 / none)";
  const lines: string[] = [];
  if (facts.sampleCount != null) lines.push(`样本数 / sample count: ${facts.sampleCount}`);
  if (facts.dv200 != null) lines.push(`DV200: ${facts.dv200}`);
  if (facts.rnaInputNg != null) lines.push(`RNA 投入量 / RNA input (ng): ${facts.rnaInputNg}`);
  if (facts.material) lines.push(`样本材料 / material: ${facts.material}`);
  return lines.length ? lines.join("\n") : "(暂无 / none)";
}

/**
 * Similar resolved cases, rendered for the prompt as CONTEXT ONLY. The header is
 * emphatic that these are precedent, not evidence: the model may use them to
 * shape structure/emphasis but must never cite them (only SOP/SCI ids are
 * citable, and the Critic enforces that regardless of what the Actor writes).
 */
function similarCasesBlock(cases?: SimilarCase[]): string {
  if (!cases || cases.length === 0) return "";
  const lines = cases.map(
    (c) => `- [${c.scenario} · ${c.status}] ${c.question} —（${c.factsDigest}）→ ${c.outcome}`,
  );
  return (
    `\n\n参考历史相似案例（仅供参考的先例，非证据，严禁作为引用来源）/ ` +
    `Similar past cases (precedent for context ONLY — never cite these):\n${lines.join("\n")}`
  );
}

/**
 * ── Structured-output citation whitelist (P0: claim–evidence alignment) ──────
 *
 * The online Actor is asked to reply with a strict JSON object whose
 * recommendations carry explicit `evidenceIds`. Before any model text is
 * shipped to the customer we validate it against the retrieved chunk set:
 *
 *   1. JSON must parse (fences/leading prose tolerated, malformed = rejected).
 *   2. Every recommendation's evidenceIds must normalize to a retrieved
 *      citation — anything else (a fabricated PMID/DOI/SOP id) is dropped.
 *   3. The rationale AND the summary are scanned for citation-shaped tokens
 *      (PMID:/DOI:/NV-SOP-/E-*- ids); any token that is not in the whitelist
 *      rejects that text — the model may not smuggle a fabricated reference
 *      into prose the structured evidenceIds would have caught.
 *
 * On ANY failure the caller falls back to the rule-derived deterministic
 * recommendations: untrusted model text is never shipped. Safety over recall
 * is deliberate — a false positive costs a retry round, a false negative costs
 * an unverifiable claim in front of a customer.
 *
 * The citation whitelist primitives now live in NovaGuard
 * (src/server/guards/novaguard.ts) as the shared trusted-control surface.
 */

/** Extract the first balanced JSON object from a model reply (fences tolerated). */
function extractJsonObject(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface StructuredActorOutput {
  summary: string;
  recommendations: DraftRecommendation[];
}

/**
 * Parse + whitelist-validate the model's structured reply. Returns null when
 * the output cannot be trusted (bad JSON, no valid recommendation, fabricated
 * citation anywhere) — the caller then keeps the rule-derived fallback.
 */
export function parseActorStructured(
  text: string,
  chunks: RetrievedChunk[],
  appliesToHint?: string,
): StructuredActorOutput | null {
  const raw = extractJsonObject(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as { summary?: unknown; recommendations?: unknown };

  if (typeof obj.summary !== "string" || !obj.summary.trim()) return null;
  if (!Array.isArray(obj.recommendations) || obj.recommendations.length === 0) return null;

  const { canon, toCitation } = buildCitationWhitelist(chunks);

  // The summary becomes the card's executive summary: no fabricated citations.
  const summary = obj.summary.trim();
  if (fabricatedCitations(summary, canon).length > 0) return null;

  const recommendations: DraftRecommendation[] = [];
  for (const item of obj.recommendations) {
    if (!item || typeof item !== "object") continue;
    const r = item as { title?: unknown; rationale?: unknown; evidenceIds?: unknown };
    if (typeof r.title !== "string" || !r.title.trim()) continue;
    if (typeof r.rationale !== "string" || !r.rationale.trim()) continue;
    if (!Array.isArray(r.evidenceIds)) continue;

    // Normalize model-supplied ids to canonical citations; drop unknown ones.
    const evidenceIds: string[] = [];
    for (const id of r.evidenceIds) {
      if (typeof id !== "string") continue;
      const c = toCitation.get(canonicalCite(id));
      if (c && !evidenceIds.includes(c)) evidenceIds.push(c);
    }
    if (evidenceIds.length === 0) continue; // every citation fabricated → drop

    // Defense in depth: the rationale prose must not smuggle citations either.
    if (fabricatedCitations(r.rationale, canon).length > 0) continue;

    const appliesTo = uniq(
      evidenceIds
        .map((cit) => chunks.find((c) => c.citation === cit)?.appliesTo)
        .filter((a): a is string => !!a),
    );
    recommendations.push({
      id: `REC-${recommendations.length + 1}`,
      title: r.title.trim(),
      rationale: r.rationale.trim(),
      evidenceIds,
      boundary: appliesTo.join("; ") || appliesToHint || "",
    });
  }

  if (recommendations.length === 0) return null;
  return { summary, recommendations };
}

/** Actor: draft evidence-grounded recommendations from retrieved chunks. */
export async function runActor(
  input: {
    question: string;
    locale: Locale;
    chunks: RetrievedChunk[];
    appliesToHint?: string;
    sensitive?: boolean;
    facts?: ProjectFacts;
    history?: ChatMessage[];
    /** Similar resolved cases fed as context only (never citable). */
    similarCases?: SimilarCase[];
  },
  cfg: ModelGatewayConfig = {},
): Promise<ActorOutput> {
  const evidenceBlock = input.chunks
    .map((c) => `[${c.citation} · ${c.source} · ${c.version}] ${c.text}`)
    .join("\n");

  // Feed the model the full working context: recent conversation, the confirmed
  // project facts, and the retrieved evidence. A large maxTokens is only a
  // ceiling (billed by tokens actually generated) so the synthesis can run as
  // long as the answer genuinely needs.
  const res = await complete(
    {
      sensitive: input.sensitive,
      maxTokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: ACTOR_SYSTEM[input.locale] },
        ...(input.history ?? []),
        {
          role: "user",
          content:
            `问题/Question: ${input.question}\n\n` +
            `已确认事实/Confirmed facts:\n${factsBlock(input.facts)}\n\n` +
            `证据/Evidence:\n${evidenceBlock}` +
            similarCasesBlock(input.similarCases),
        },
      ],
    },
    cfg,
  );

  // Rule-based grounding: prefer evidence that is IN SCOPE for the sample
  // (e.g. FFPE RNA), not merely the top-ranked chunk — a good Actor grounds in
  // *applicable* evidence. Fall back to the highest-ranked chunk of each source
  // when nothing scope-matches. This is BOTH the offline answer and the safe
  // fallback whenever the online model output fails whitelist validation.
  const hint = input.appliesToHint;
  const inScope = (c: RetrievedChunk) => (hint ? appliesToMatches(c.appliesTo, hint) : true);
  const pick = (source: "SOP" | "SCI") =>
    input.chunks.find((c) => c.source === source && inScope(c)) ??
    input.chunks.find((c) => c.source === source);

  const sop = pick("SOP");
  const sci = pick("SCI");
  const ruleDerived: DraftRecommendation[] = [];
  if (sop) {
    ruleDerived.push({
      id: "REC-PRIMARY",
      title: firstSentence(sop.text),
      rationale: sop.text,
      evidenceIds: uniq([sop.citation, sci?.citation].filter(Boolean) as string[]),
      boundary: sop.appliesTo,
    });
  }
  if (sci && sci.citation !== sop?.citation) {
    ruleDerived.push({
      id: "REC-SUPPORT",
      title: firstSentence(sci.text),
      rationale: sci.text,
      evidenceIds: [sci.citation],
      boundary: sci.appliesTo,
    });
  }

  // Online: prefer the model's structured synthesis, but ONLY after the
  // citation whitelist accepts it. Every evidenceId must resolve to a retrieved
  // chunk and no fabricated PMID/DOI/SOP id may appear in summary or rationale.
  // On any failure we keep the rule-derived answer — untrusted model text is
  // never shipped to the customer. Offline the rule-derived text stays so
  // tests remain deterministic.
  const online = res.provider !== "deterministic";
  let summary = (ruleDerived[0]?.rationale ?? "").slice(0, 200);
  let recommendations = ruleDerived;
  if (online && res.text.trim()) {
    const structured = parseActorStructured(res.text.trim(), input.chunks, hint);
    if (structured) {
      summary = structured.summary;
      recommendations = structured.recommendations;
    }
    // else: keep ruleDerived — the Critic still runs on it, so the answer stays
    // grounded and verifiable; the untrusted model text is discarded entirely.
  }

  return { summary, recommendations, provider: res.provider };
}

/**
 * Critic: verify each recommendation against the retrieved evidence.
 * A citation is valid only if it appears in the retrieved chunk set, is scoped
 * to the sample and has not expired.
 */
export function runCritic(
  input: {
    recommendations: DraftRecommendation[];
    chunks: RetrievedChunk[];
    appliesToHint?: string;
    now: string;
  },
): CriticOutput {
  const byCitation = new Map(input.chunks.map((c) => [c.citation, c]));
  const findings: CriticFinding[] = [];
  const verified: DraftRecommendation[] = [];

  for (const rec of input.recommendations) {
    const issues: string[] = [];
    const validCitations = rec.evidenceIds.filter((id) => {
      const chunk = byCitation.get(id);
      if (!chunk) {
        issues.push(`citation ${id} not found in retrieved evidence`);
        return false;
      }
      if (chunk.validation !== "verified") {
        issues.push(`citation ${id} is ${chunk.validation}`);
        return false;
      }
      if (chunk.validUntil < input.now.slice(0, 10)) {
        issues.push(`citation ${id} expired ${chunk.validUntil}`);
        return false;
      }
      return true;
    });

    const inScope =
      !input.appliesToHint ||
      rec.evidenceIds.some((id) => {
        const chunk = byCitation.get(id);
        return chunk ? appliesToMatches(chunk.appliesTo, input.appliesToHint!) : false;
      });
    if (!inScope) issues.push(`out of scope for ${input.appliesToHint}`);

    const citationValid = validCitations.length > 0;
    const notExpired = !issues.some((i) => i.includes("expired"));

    findings.push({
      recommendationId: rec.id,
      citationValid,
      inScope,
      notExpired,
      issues,
    });

    if (citationValid && inScope) {
      verified.push({ ...rec, evidenceIds: validCitations });
    }
  }

  return {
    approved: verified.length > 0 && findings.every((f) => f.issues.length === 0),
    findings,
    verified,
    provider: "critic-rule-engine",
  };
}

/**
 * Scope-hint derivation. Builds the applicability hint the retriever and Critic
 * use to keep evidence on-topic — from the confirmed sample material plus the
 * consultation modality — instead of a hardcoded constant. Falls back to the
 * broad domain modality when the material is unknown.
 */
export function deriveScopeHint(_scenario: Scenario, facts: ProjectFacts): string {
  const parts: string[] = [];
  const material = (facts.material ?? "").trim();
  if (/ffpe/i.test(material)) parts.push("FFPE");
  else if (material) parts.push(material.split(/\s+/)[0]!);
  // This consultation domain is RNA library prep / expression profiling.
  parts.push("RNA");
  return uniq(parts).join(" ");
}

/**
 * Progressive scope widening for the grounding loop. Each failed round relaxes
 * the hint so the retriever considers a broader slice of the corpus:
 *   round 0   → full hint (e.g. "FFPE RNA")
 *   round 1   → drop the narrow material qualifier, keep the modality ("RNA")
 *   round ≥ 2 → no hint (whole corpus, rank on lexical + vector only)
 */
export function broadenHint(base: string, round: number): string | undefined {
  const tokens = base.split(/\s+/).filter(Boolean);
  if (round <= 0) return tokens.length ? tokens.join(" ") : undefined;
  if (round === 1) return tokens.length > 1 ? tokens.slice(1).join(" ") : undefined;
  return undefined;
}

export interface GroundingCheck {
  /** Recommendations whose evidence the model confirms actually supports them. */
  verified: DraftRecommendation[];
  /** Recommendations dropped because the evidence does not support the claim. */
  dropped: Array<{ id: string; reason: string }>;
  /** "skipped" when offline (no model) — the rule engine's result stands. */
  provider: string;
}

const GROUNDING_SYSTEM: Record<Locale, string> = {
  zh: "你是 NovaPilot 的科研证据复核员。判断给定证据是否真正支撑该结论。请先只回答“支持”或“不支持”，如需可再补一句简短理由。",
  en: "You are NovaPilot's research evidence reviewer. Decide whether the given evidence actually supports the conclusion. Answer with 'support' or 'not support' first, then optionally one short reason.",
  ja: "あなたは NovaPilot の研究証拠レビュアーです。提示された証拠が結論を実際に支持するか判断してください。まず「支持」または「不支持」だけで答え、必要なら短い理由を一文添えてください。",
};

/**
 * Semantic grounding check, layered on top of the rule-based Critic. For each
 * rule-verified recommendation, ask the model whether the cited evidence truly
 * supports the claim, and drop the ones it does not. This catches "the citation
 * is real and in-scope, but it doesn't actually back this statement" — which the
 * provenance-only rule engine cannot see.
 *
 * Offline-safe: with no model the gateway returns a deterministic completion; we
 * never override the rule engine on a deterministic verdict, so the result is
 * unchanged and the whole layer is a no-op (provider "skipped").
 */
export async function verifyGrounding(
  input: {
    recommendations: DraftRecommendation[];
    chunks: RetrievedChunk[];
    question: string;
    locale: Locale;
  },
  cfg: ModelGatewayConfig = {},
): Promise<GroundingCheck> {
  const byCitation = new Map(input.chunks.map((c) => [c.citation, c]));
  const verified: DraftRecommendation[] = [];
  const dropped: Array<{ id: string; reason: string }> = [];
  let provider = "skipped";

  for (const rec of input.recommendations) {
    const evidenceText = rec.evidenceIds
      .map((cit) => byCitation.get(cit))
      .filter((c): c is RetrievedChunk => !!c)
      .map((c) => `[${c.citation}] ${c.text}`)
      .join("\n");

    const res = await complete(
      {
        sensitive: false,
        // A bounded 支持/不支持 verdict — route to the cheap mini model.
        tier: "mini",
        maxTokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: GROUNDING_SYSTEM[input.locale] },
          {
            role: "user",
            content:
              `问题/Question: ${input.question}\n` +
              `结论/Conclusion: ${rec.title}\n` +
              `依据/Rationale: ${rec.rationale}\n` +
              `证据/Evidence:\n${evidenceText || "(无)"}\n\n` +
              `该证据是否支撑该结论？/ Does the evidence support the conclusion?`,
          },
        ],
      },
      cfg,
    );

    // No live model → keep the rule engine's decision; do not fabricate a verdict.
    if (res.provider === "deterministic") {
      verified.push(rec);
      continue;
    }
    provider = res.provider;
    // Inspect the LEADING verdict word (the prompt asks the model to answer
    // 支持/不支持 first). This is more robust than scanning the whole reply,
    // where a long rationale might mention "不支持" while ultimately supporting.
    const head = res.text.trim().slice(0, 40);
    const rejected = /^\s*(不支持|不成立|unsupported|not\s+support|no\s+support)/i.test(head);
    if (rejected) dropped.push({ id: rec.id, reason: res.text.trim().slice(0, 200) });
    else verified.push(rec);
  }

  return { verified, dropped, provider };
}

function firstSentence(s: string): string {
  const m = s.match(/^[^。.!?！？\n]+[。.!?！？]?/);
  return (m ? m[0] : s).trim();
}
function uniq<T>(a: T[]): T[] {
  return [...new Set(a)];
}

/**
 * Token-based applicability: every token of the hint (e.g. "FFPE RNA" →
 * ["ffpe","rna"]) must appear in the evidence's appliesTo string. This treats
 * "FFPE-derived RNA expression profiling" as in-scope for "FFPE RNA" while
 * still excluding a general "degraded RNA" paper that lacks "ffpe".
 */
function appliesToMatches(appliesTo: string, hint: string): boolean {
  const target = appliesTo.toLowerCase();
  const tokens = hint.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.every((t) => target.includes(t));
}
