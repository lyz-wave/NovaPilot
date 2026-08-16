/**
 * Application service layer — the single entry point the API routes call.
 * Owns database bootstrap (schema + knowledge-base seed) and id/trace
 * generation, and delegates the actual work to the orchestration graph.
 */
import { getDb, type NovaDb } from "./db/client";
import {
  appendMessage,
  createConversation,
  getActiveModelConfig,
  listConversation,
  readCompactState,
  titleFromFirstMessage,
  touchConversation,
  writeCompactState,
  type StoredModelConfig,
} from "./db/repositories";
import { chunkCount, seedKnowledgeBase } from "./rag/retrieval";
import { estimateTokens } from "./rag/text";
import {
  runConsultationGraph,
  type GraphInput,
  type GraphResult,
} from "./orchestration/graph";
import { classifyIntent } from "./agents/intent";
import { chatReply } from "./agents/chat-agent";
import type {
  ContextUsage,
  ConversationTurn,
  Locale,
  ProjectFacts,
} from "@/domain/consultation-journey";
import {
  complete,
  contextWindowFor,
  type ChatMessage,
  type ModelGatewayConfig,
} from "./agents/model-gateway";

/** How many recent turns to feed the model as conversation context. */
const HISTORY_TURNS = 12;

/** Fixed overhead (system prompt + instructions) folded into the context ring. */
const BASE_CONTEXT_TOKENS = 1200;

/** How many of the most recent turns a compaction always keeps raw. */
const COMPACT_KEEP_RECENT = 4;

/** One turn's visible text, used both for the ring estimate and summarization. */
function turnText(t: ConversationTurn): string {
  if (t.text) return t.text;
  const card = t.result?.card;
  if (!card) return "";
  return [
    card.title,
    card.customerGoal,
    card.executiveSummary,
    ...(card.alternatives ?? []),
    JSON.stringify(card.recommendations ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Map persisted conversation turns to gateway messages (oldest first, capped to
 * the most recent HISTORY_TURNS). A card turn is compressed to a one-line
 * placeholder — enough context for the model without dumping the whole JSON.
 *
 * Compaction-aware: when a compaction summary exists for the thread, the folded
 * (older) turns are dropped and replaced by a single "【对话摘要】" assistant
 * message, so the context actually sent to the model shrinks after /compact.
 */
function buildHistory(db: NovaDb, conversationId: string): ChatMessage[] {
  const turns = listConversation(db, conversationId);
  const compact = readCompactState(db, conversationId);

  let effective = turns;
  const prefix: ChatMessage[] = [];
  if (compact) {
    const idx = turns.findIndex((t) => t.id === compact.throughMessageId);
    if (idx >= 0) {
      effective = turns.slice(idx + 1);
      prefix.push({ role: "assistant", content: `【对话摘要】${compact.summary}` });
    }
  }

  const recent = effective
    .slice(-HISTORY_TURNS)
    .map((t): ChatMessage | null => {
      if (t.role === "user") {
        return t.text ? { role: "user", content: t.text } : null;
      }
      if (t.kind === "card") {
        const card = t.result?.card;
        if (!card) return null;
        return { role: "assistant", content: `(已生成决策卡：${card.title} · ${card.status})` };
      }
      return t.text ? { role: "assistant", content: t.text } : null;
    })
    .filter((m): m is ChatMessage => m !== null);

  return [...prefix, ...recent];
}

/** Ensure the knowledge base is seeded (idempotent, cheap when already loaded). */
export function ensureSeeded(db: NovaDb): void {
  if (chunkCount(db) === 0) seedKnowledgeBase(db);
}

export interface ConsultInput {
  question: string;
  locale: Locale;
  facts: ProjectFacts;
  tenantId: string;
  traceId: string;
  projectId?: string;
  /**
   * Which conversation thread this turn belongs to. Defaults to `tenantId`
   * (the original single-conversation behaviour) when omitted, so existing
   * callers and tests keep writing to the same thread. Carried in the request
   * body/query — never in the tenant header — so the write contract is intact.
   */
  conversationId?: string;
  /** Recent conversation turns (oldest first) to give the Actor context. */
  history?: ChatMessage[];
}

/** Run a consultation against the live backend and return the graph result. */
export async function consult(
  input: ConsultInput,
  cfg?: ModelGatewayConfig,
  db: NovaDb = getDb(),
): Promise<GraphResult> {
  ensureSeeded(db);
  // When the caller doesn't pass an explicit gateway config, use the active
  // model profile persisted in the DB (selected via the model-config API); that
  // in turn falls back to environment variables and finally the offline
  // deterministic generator.
  const gatewayCfg: ModelGatewayConfig = cfg ?? getActiveModelConfig(db) ?? {};
  const now = new Date().toISOString();
  const projectId = input.projectId ?? `NP-${slug(input.question)}-${input.traceId.slice(0, 8)}`;
  const graphInput: GraphInput = {
    projectId,
    tenantId: input.tenantId,
    question: input.question,
    locale: input.locale,
    facts: input.facts,
    now,
    traceId: input.traceId,
    history: input.history,
    // Live consultations feed the resolved-case memory for future retrieval.
    recordMemory: true,
  };
  return runConsultationGraph(db, graphInput, gatewayCfg);
}

/**
 * Turn outcome: either a plain chat reply (greetings / capability questions /
 * general chit-chat) or a full research decision card. The consultation
 * pipeline only runs for the "card" branch.
 */
export type ConsultOutcome =
  | (GraphResult & { kind: "card" })
  | { kind: "chat"; reply: string; provider: string; traceId: string };

/**
 * Entry point for a conversation turn. Classifies intent, persists the user
 * message and the assistant response into the tenant's conversation, and runs
 * the decision-card pipeline only for actual research questions.
 */
export async function respond(
  input: ConsultInput,
  cfg?: ModelGatewayConfig,
  db: NovaDb = getDb(),
): Promise<ConsultOutcome> {
  ensureSeeded(db);
  const gatewayCfg: ModelGatewayConfig = cfg ?? getActiveModelConfig(db) ?? {};
  // Default to tenantId so single-conversation callers/tests are unchanged.
  const conversationId = input.conversationId ?? input.tenantId;
  const now = new Date().toISOString();

  // Ensure the conversation index row exists (idempotent) so this thread shows
  // up in the history list even if it was created implicitly by a first turn.
  createConversation(db, { id: conversationId, tenantId: input.tenantId, now });

  // Read the prior conversation BEFORE appending the current message, so the
  // model gets the earlier turns as context (this is what makes the assistant
  // actually converse instead of re-introducing itself every turn).
  const history = buildHistory(db, conversationId);

  // Persist the user's message first so ordering (by created_at, rowid) is
  // stable even when the assistant reply lands at the same millisecond.
  appendMessage(db, {
    id: crypto.randomUUID(),
    conversationId,
    role: "user",
    kind: "chat",
    text: input.question,
    traceId: input.traceId,
    now,
  });

  // First user message names the thread (only while still the placeholder);
  // every turn floats it to the top of the list.
  titleFromFirstMessage(db, { id: conversationId, text: input.question, now });
  touchConversation(db, { id: conversationId, now });

  if (classifyIntent(input.question) === "chat") {
    const { reply, provider } = await chatReply(
      { question: input.question, locale: input.locale, history },
      gatewayCfg,
    );
    appendMessage(db, {
      id: crypto.randomUUID(),
      conversationId,
      role: "assistant",
      kind: "chat",
      text: reply,
      traceId: input.traceId,
      now: new Date().toISOString(),
    });
    return { kind: "chat", reply, provider, traceId: input.traceId };
  }

  const result = await consult({ ...input, history }, gatewayCfg, db);
  appendMessage(db, {
    id: crypto.randomUUID(),
    conversationId,
    role: "assistant",
    kind: "card",
    result,
    traceId: input.traceId,
    now: new Date().toISOString(),
  });
  return { ...result, kind: "card" };
}

// ── Context usage + compaction (CC-style "compact") ──────────────

/**
 * Estimate how full the context window is for a conversation. Numerator is a
 * local token estimate over the (post-compaction) transcript plus a fixed
 * system overhead; denominator is the active model's context window. Fully
 * offline — needs no provider — so the ring works with zero API keys.
 */
export function conversationContext(
  db: NovaDb,
  conversationId: string,
  cfg?: StoredModelConfig | null,
): ContextUsage {
  const active = cfg ?? getActiveModelConfig(db);
  const model = active?.model ?? "novapilot-deterministic-v1";
  const provider = active?.provider ?? "deterministic";
  const contextWindow = contextWindowFor(active?.model);

  const turns = listConversation(db, conversationId);
  const compact = readCompactState(db, conversationId);
  const throughIdx = compact
    ? turns.findIndex((t) => t.id === compact.throughMessageId)
    : -1;

  let tokens = BASE_CONTEXT_TOKENS;
  if (compact) tokens += estimateTokens(`【对话摘要】${compact.summary}`);
  turns.forEach((t, i) => {
    if (compact && throughIdx >= 0 && i <= throughIdx) return; // folded away
    tokens += estimateTokens(turnText(t));
  });

  const ratio = contextWindow > 0 ? Math.min(1, tokens / contextWindow) : 0;
  return { contextTokens: tokens, contextWindow, ratio, provider, model, compacted: !!compact };
}

const SUMMARY_SYSTEM =
  "你是对话压缩器。把早期咨询对话压缩为简洁中文要点，包含：用户角色/背景、已确认的关键事实与数值、已给出的结论（决策卡标题与状态）、尚未解决的问题。" +
  "不超过 200 字，保留关键数值与结论，去掉寒暄与重复。只输出要点本身，不要加前后缀说明。";

/** Deterministic offline summary (factsDigest-style) — the offline fallback. */
function deterministicSummary(toFold: ConversationTurn[], prior: string | null): string {
  const parts: string[] = [];
  if (prior) parts.push(prior.trim());
  const questions = toFold
    .filter((t) => t.role === "user" && t.text)
    .map((t) => t.text!.replace(/\s+/g, " ").trim());
  const cards = toFold
    .filter((t) => t.kind === "card" && t.result?.card)
    .map((t) => {
      const c = t.result!.card;
      return `${c.title}（${c.status}）`;
    });
  if (questions.length) {
    parts.push(`用户先前问题：${questions.map((q) => q.slice(0, 40)).join("；")}`);
  }
  if (cards.length) parts.push(`已产出决策卡：${cards.join("、")}`);
  return parts.join("\n") || "（早期对话无实质内容）";
}

/** Summarize folded turns — online via the mini tier, offline deterministically. */
async function summarizeTurns(
  toFold: ConversationTurn[],
  prior: string | null,
  cfg: ModelGatewayConfig,
): Promise<string> {
  const deterministic = deterministicSummary(toFold, prior);
  const transcript = toFold
    .map((t) => `${t.role === "user" ? "用户" : "顾问"}：${turnText(t).slice(0, 500)}`)
    .join("\n");
  // The gateway degrades to `fallback` when offline, so passing the
  // deterministic summary as the fallback guarantees a good offline result.
  const res = await complete(
    {
      tier: "mini",
      temperature: 0.1,
      maxTokens: 800,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM },
        {
          role: "user",
          content: `${prior ? `已有摘要：\n${prior}\n\n` : ""}请把下面的早期对话压缩为中文要点：\n${transcript}`,
        },
      ],
    },
    { ...cfg, fallback: () => deterministic },
  );
  return res.text.trim() || deterministic;
}

/**
 * Compact a conversation: fold every turn except the most recent
 * COMPACT_KEEP_RECENT into a summary (merging any prior summary), storing it
 * non-destructively in the settings KV. Raw messages are untouched — only the
 * context fed to the model (and the ring) shrinks. Returns the new usage.
 */
export async function compactConversation(
  input: { conversationId: string },
  cfg?: ModelGatewayConfig,
  db: NovaDb = getDb(),
): Promise<{ compacted: boolean; usage: ContextUsage }> {
  const gatewayCfg: ModelGatewayConfig = cfg ?? getActiveModelConfig(db) ?? {};
  const turns = listConversation(db, input.conversationId);
  const existing = readCompactState(db, input.conversationId);

  let startIdx = 0;
  if (existing) {
    const i = turns.findIndex((t) => t.id === existing.throughMessageId);
    if (i >= 0) startIdx = i + 1;
  }
  const foldEnd = turns.length - COMPACT_KEEP_RECENT; // exclusive

  if (foldEnd <= startIdx) {
    // Nothing new to fold (too short, or already compacted up to the tail).
    return { compacted: false, usage: conversationContext(db, input.conversationId) };
  }

  const toFold = turns.slice(startIdx, foldEnd);
  const summary = await summarizeTurns(toFold, existing?.summary ?? null, gatewayCfg);
  writeCompactState(db, input.conversationId, {
    summary,
    throughMessageId: toFold[toFold.length - 1]!.id,
    createdAt: new Date().toISOString(),
  });
  return { compacted: true, usage: conversationContext(db, input.conversationId) };
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "consult"
  );
}
