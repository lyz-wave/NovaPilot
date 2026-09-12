/**
 * Unified model gateway (OpenAI-compatible / Anthropic Messages).
 *
 * Mirrors the proposal's "统一 OpenAI-compatible 模型网关 + 动态路由":
 *   - route by data sensitivity (private vs external), latency and complexity
 *   - fall back to a deterministic local generator when no API key is set, so
 *     the whole system runs offline and tests are stable
 *
 * S4-2 additions:
 *   - Exponential backoff with FNV-1a jitter (up to 3 retries)
 *   - Multi-provider failover (sequential provider list)
 *   - In-process token bucket rate limiter (maxConcurrent + perMinute)
 *   - model_calls logging to the NovaDb (optional, pass `db`)
 *
 * Env:
 *   NOVAPILOT_LLM_PROVIDER = "anthropic" | "openai" | "off" (default: auto)
 *   ANTHROPIC_API_KEY / NOVAPILOT_LLM_API_KEY
 *   NOVAPILOT_LLM_BASE_URL   (OpenAI-compatible endpoint, e.g. vLLM)
 *   NOVAPILOT_LLM_MODEL
 *   NP_MAX_CONCURRENT        (default 4)
 *   NP_PER_MINUTE            (default 60)
 */

import type { NovaDb } from "../db/client";
import pricingRaw from "../../../data/pricing.json";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** true when the payload contains sensitive research data → must stay local. */
  sensitive?: boolean;
  temperature?: number;
  maxTokens?: number;
  /**
   * Model tier. "main" (default) uses the primary model; "mini" routes to a
   * cheaper, faster model for bounded subtasks (yes/no grounding checks,
   * summarization). Falls back to the main model when no mini model is configured.
   */
  tier?: "mini" | "main";
  /** Trace ID — used for jitter seed and model_calls logging. */
  traceId?: string;
  /** If provided, log this call to model_calls table. */
  db?: NovaDb;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResult {
  text: string;
  provider: "anthropic" | "openai" | "deterministic";
  model: string;
  route: "external-model" | "private-model";
  usage?: TokenUsage;
}

// ── Pricing ────────────────────────────────────────────────────────────────────

interface PricingEntry { inputPer1M: number; outputPer1M: number }
const PRICING = (pricingRaw as { models: Record<string, PricingEntry> }).models;

function computeCostUsd(model: string, usage: TokenUsage | undefined): number | null {
  if (!usage) return null;
  const p = PRICING[model];
  if (!p) return null;
  return (usage.inputTokens * p.inputPer1M + usage.outputTokens * p.outputPer1M) / 1_000_000;
}

// ── Context window ─────────────────────────────────────────────────────────────

export function contextWindowFor(model: string | undefined): number {
  const m = (model ?? "").toLowerCase();
  if (m.startsWith("glm")) return 200000;
  if (m.startsWith("claude")) return 200000;
  if (m.startsWith("gpt-4o") || m.startsWith("gpt-4.1") || m.startsWith("o1") || m.startsWith("o3"))
    return 128000;
  if (m.startsWith("gpt-4-turbo")) return 128000;
  if (m.startsWith("gpt-4")) return 8192;
  if (m.startsWith("gpt-3.5")) return 16385;
  return 128000;
}

// ── Config ─────────────────────────────────────────────────────────────────────

export interface ModelGatewayConfig {
  provider?: "anthropic" | "openai" | "off";
  /** Ordered list of providers to try on failure (multi-provider failover). */
  providerFallbackChain?: Array<"anthropic" | "openai">;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  miniModel?: string;
  fallback?: (req: CompletionRequest) => string;
  onDegrade?: (reason: string) => void;
}

export const MAX_OUTPUT_TOKENS = 131072;
const RETRY_MAX_TOKENS = 16384;
const MODEL_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;

// ── FNV-1a jitter ──────────────────────────────────────────────────────────────

function fnv1a32(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

function backoffMs(attempt: number, traceId?: string): number {
  const jitter = traceId ? fnv1a32(traceId + attempt) % 500 : Math.random() * 500;
  return Math.min(1000 * Math.pow(2, attempt) + jitter, 8000);
}

// ── Token bucket rate limiter ──────────────────────────────────────────────────

const maxConcurrent = Number(process.env.NP_MAX_CONCURRENT ?? 4);
const perMinute = Number(process.env.NP_PER_MINUTE ?? 60);

let _concurrent = 0;
let _callsThisMinute = 0;
let _minuteWindowStart = Date.now();

function resetMinuteWindow(): void {
  const now = Date.now();
  if (now - _minuteWindowStart >= 60_000) {
    _callsThisMinute = 0;
    _minuteWindowStart = now;
  }
}

async function acquireSlot(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    resetMinuteWindow();
    if (_concurrent < maxConcurrent && _callsThisMinute < perMinute) {
      _concurrent++;
      _callsThisMinute++;
      return;
    }
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  throw new Error("rate-limit: slot acquisition timeout");
}

function releaseSlot(): void {
  if (_concurrent > 0) _concurrent--;
}

// ── Config resolution ──────────────────────────────────────────────────────────

export function resolveConfig(cfg: ModelGatewayConfig = {}): Required<
  Pick<ModelGatewayConfig, "provider" | "model" | "miniModel">
> & {
  apiKey?: string;
  baseUrl?: string;
  fallback?: ModelGatewayConfig["fallback"];
  onDegrade?: ModelGatewayConfig["onDegrade"];
  providerFallbackChain?: Array<"anthropic" | "openai">;
} {
  const env = process.env;
  const apiKey =
    cfg.apiKey ?? env.NOVAPILOT_LLM_API_KEY ?? env.ANTHROPIC_API_KEY ?? env.OPENAI_API_KEY;
  let provider = cfg.provider ?? (env.NOVAPILOT_LLM_PROVIDER as ModelGatewayConfig["provider"]);
  if (!provider) {
    if (env.ANTHROPIC_API_KEY) provider = "anthropic";
    else if (env.OPENAI_API_KEY || env.NOVAPILOT_LLM_BASE_URL) provider = "openai";
    else provider = "off";
  }
  const model =
    cfg.model ??
    env.NOVAPILOT_LLM_MODEL ??
    (provider === "anthropic" ? "claude-sonnet-5" : "gpt-4o-mini");
  return {
    provider: provider ?? "off",
    apiKey,
    baseUrl: cfg.baseUrl ?? env.NOVAPILOT_LLM_BASE_URL,
    model,
    miniModel:
      cfg.miniModel ??
      env.NOVAPILOT_LLM_MINI_MODEL ??
      (provider === "anthropic" ? "claude-haiku-4-5-20251001" : "gpt-4o-mini"),
    fallback: cfg.fallback,
    onDegrade: cfg.onDegrade,
    providerFallbackChain: cfg.providerFallbackChain,
  };
}

// ── model_calls logging ────────────────────────────────────────────────────────

function logModelCall(
  db: NovaDb | undefined,
  opts: {
    traceId?: string;
    provider: string;
    model: string;
    usage?: TokenUsage;
    latencyMs: number;
    degraded: boolean;
  },
): void {
  if (!db) return;
  const ts = Date.now();
  const id = `mc-${opts.traceId ?? "anon"}-${ts}`;
  const costUsd = computeCostUsd(opts.model, opts.usage);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO model_calls
         (id, trace_id, provider, model, input_tokens, output_tokens, cost_usd, latency_ms, degraded, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.traceId ?? null,
      opts.provider,
      opts.model,
      opts.usage?.inputTokens ?? 0,
      opts.usage?.outputTokens ?? 0,
      costUsd,
      opts.latencyMs,
      opts.degraded ? 1 : 0,
      new Date(ts).toISOString(),
    );
  } catch { /* logging must never throw */ }
}

// ── Single-provider call: max_tokens retry ────────────────────────────────────
// First try with the requested ceiling; if the provider rejects it (4xx
// max_tokens too large) retry once at the conservative cap before giving up.
// This is a distinct retry from the multi-provider exponential backoff below.

async function callSingleProvider(
  callFn: (maxTokens: number) => Promise<CompletionResult>,
  req: CompletionRequest,
): Promise<CompletionResult> {
  const requested = req.maxTokens ?? MAX_OUTPUT_TOKENS;
  try {
    return await callFn(requested);
  } catch {
    if (requested > RETRY_MAX_TOKENS) {
      return await callFn(RETRY_MAX_TOKENS);
    }
    throw new Error("provider-failed");
  }
}

// ── complete() ────────────────────────────────────────────────────────────────

export async function complete(
  req: CompletionRequest,
  cfg: ModelGatewayConfig = {},
): Promise<CompletionResult> {
  const resolved = resolveConfig(cfg);
  const c = req.tier === "mini" ? { ...resolved, model: resolved.miniModel } : resolved;
  const externalAllowed = !req.sensitive || !!c.baseUrl;
  const t0 = Date.now();

  if (c.provider !== "off" && c.apiKey && externalAllowed) {
    const makeCall = (prov: "anthropic" | "openai") => (maxTokens: number) =>
      prov === "anthropic" && !c.baseUrl
        ? callAnthropic({ ...req, maxTokens }, c)
        : callOpenAICompatible({ ...req, maxTokens }, c);

    const chain: Array<"anthropic" | "openai"> = [
      c.provider as "anthropic" | "openai",
      ...(c.providerFallbackChain ?? []),
    ].filter((p, i, arr) => arr.indexOf(p) === i); // unique, preserve order

    let lastErr: unknown;
    for (let pi = 0; pi < chain.length; pi++) {
      if (pi > 0) {
        // Exponential backoff between provider attempts (S4-2 spec: max 3 retries)
        await new Promise<void>((r) => setTimeout(r, backoffMs(pi - 1, req.traceId)));
      }
      const prov = chain[pi];
      try {
        await acquireSlot();
        try {
          const result = await callSingleProvider(makeCall(prov), req);
          logModelCall(req.db, {
            traceId: req.traceId,
            provider: result.provider,
            model: result.model,
            usage: result.usage,
            latencyMs: Date.now() - t0,
            degraded: false,
          });
          return result;
        } finally {
          releaseSlot();
        }
      } catch (err) {
        lastErr = err;
        releaseSlot();
      }
    }
    void lastErr; // all providers failed → fall through to deterministic
  }

  try { c.onDegrade?.("provider-off"); } catch {}
  const text = (c.fallback ?? deterministicFallback)(req);
  logModelCall(req.db, {
    traceId: req.traceId,
    provider: "deterministic",
    model: "novapilot-deterministic-v1",
    latencyMs: Date.now() - t0,
    degraded: true,
  });
  return {
    text,
    provider: "deterministic",
    model: "novapilot-deterministic-v1",
    route: req.sensitive ? "private-model" : "external-model",
  };
}

// ── streamText() ──────────────────────────────────────────────────────────────

export async function streamText(
  req: CompletionRequest,
  cfg: ModelGatewayConfig = {},
  onToken: (delta: string) => void,
): Promise<CompletionResult & { firstTokenMs: number }> {
  const resolved = resolveConfig(cfg);
  const c = req.tier === "mini" ? { ...resolved, model: resolved.miniModel } : resolved;
  const externalAllowed = !req.sensitive || !!c.baseUrl;
  const t0 = Date.now();

  if (c.provider !== "off" && c.apiKey && externalAllowed) {
    try {
      await acquireSlot();
      try {
        const result = c.provider === "anthropic" && !c.baseUrl
          ? await streamAnthropic(req, c, onToken)
          : await streamOpenAICompatible(req, c, onToken);
        logModelCall(req.db, {
          traceId: req.traceId,
          provider: result.provider,
          model: result.model,
          usage: result.usage,
          latencyMs: Date.now() - t0,
          degraded: false,
        });
        return result;
      } finally {
        releaseSlot();
      }
    } catch {
      releaseSlot();
      // fall through to deterministic
    }
  }

  try { c.onDegrade?.("provider-off"); } catch {}
  const dt0 = Date.now();
  const text = (c.fallback ?? deterministicFallback)(req);
  const firstTokenMs = Date.now() - dt0;
  try { onToken(text); } catch {}
  logModelCall(req.db, {
    traceId: req.traceId,
    provider: "deterministic",
    model: "novapilot-deterministic-v1",
    latencyMs: Date.now() - t0,
    degraded: true,
  });
  return {
    text,
    provider: "deterministic",
    model: "novapilot-deterministic-v1",
    route: req.sensitive ? "private-model" : "external-model",
    firstTokenMs,
  };
}

// ── Provider implementations ───────────────────────────────────────────────────

async function callAnthropic(
  req: CompletionRequest,
  c: ReturnType<typeof resolveConfig>,
): Promise<CompletionResult> {
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": c.apiKey!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: c.model,
      system,
      messages,
      max_tokens: req.maxTokens ?? MAX_OUTPUT_TOKENS,
      temperature: req.temperature ?? 0.2,
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = (await res.json()) as {
    content: Array<{ text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    text: data.content.map((b) => b.text ?? "").join(""),
    provider: "anthropic",
    model: c.model,
    route: req.sensitive ? "private-model" : "external-model",
    usage: data.usage
      ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
      : undefined,
  };
}

async function callOpenAICompatible(
  req: CompletionRequest,
  c: ReturnType<typeof resolveConfig>,
): Promise<CompletionResult> {
  const base = c.baseUrl ?? "https://api.openai.com/v1";
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${c.apiKey}`,
    },
    body: JSON.stringify({
      model: c.model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? MAX_OUTPUT_TOKENS,
      temperature: req.temperature ?? 0.2,
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: data.choices[0]?.message.content ?? "",
    provider: "openai",
    model: c.model,
    route: c.baseUrl ? "private-model" : "external-model",
    usage: data.usage
      ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
      : undefined,
  };
}

async function streamAnthropic(
  req: CompletionRequest,
  c: ReturnType<typeof resolveConfig>,
  onToken: (delta: string) => void,
): Promise<CompletionResult & { firstTokenMs: number }> {
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const t0 = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": c.apiKey!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: c.model,
      system,
      messages,
      max_tokens: req.maxTokens ?? MAX_OUTPUT_TOKENS,
      temperature: req.temperature ?? 0.2,
      stream: true,
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);

  let fullText = "";
  let firstTokenMs = -1;
  let inputTokens = 0;
  let outputTokens = 0;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") continue;
      try {
        const ev = JSON.parse(raw) as {
          type: string;
          delta?: { type: string; text?: string };
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          if (firstTokenMs < 0) firstTokenMs = Date.now() - t0;
          fullText += ev.delta.text;
          try { onToken(ev.delta.text); } catch {}
        } else if (ev.type === "message_delta" && ev.usage) {
          outputTokens = ev.usage.output_tokens ?? outputTokens;
        } else if (ev.type === "message_start" && ev.message?.usage) {
          inputTokens = ev.message.usage.input_tokens ?? inputTokens;
        }
      } catch { /* skip malformed */ }
    }
  }
  return {
    text: fullText,
    provider: "anthropic",
    model: c.model,
    route: req.sensitive ? "private-model" : "external-model",
    usage: { inputTokens, outputTokens },
    firstTokenMs: firstTokenMs >= 0 ? firstTokenMs : Date.now() - t0,
  };
}

async function streamOpenAICompatible(
  req: CompletionRequest,
  c: ReturnType<typeof resolveConfig>,
  onToken: (delta: string) => void,
): Promise<CompletionResult & { firstTokenMs: number }> {
  const base = c.baseUrl ?? "https://api.openai.com/v1";
  const t0 = Date.now();
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${c.apiKey}`,
    },
    body: JSON.stringify({
      model: c.model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? MAX_OUTPUT_TOKENS,
      temperature: req.temperature ?? 0.2,
      stream: true,
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);

  let fullText = "";
  let firstTokenMs = -1;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") continue;
      try {
        const ev = JSON.parse(raw) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = ev.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          if (firstTokenMs < 0) firstTokenMs = Date.now() - t0;
          fullText += delta;
          try { onToken(delta); } catch {}
        }
      } catch { /* skip malformed */ }
    }
  }
  return {
    text: fullText,
    provider: "openai",
    model: c.model,
    route: c.baseUrl ? "private-model" : "external-model",
    firstTokenMs: firstTokenMs >= 0 ? firstTokenMs : Date.now() - t0,
  };
}

function deterministicFallback(req: CompletionRequest): string {
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  return `[[deterministic]] ${lastUser?.content.slice(0, 400) ?? ""}`;
}

// ── Rate limiter inspection (test helpers) ─────────────────────────────────────

export function _rateLimiterState() {
  return { concurrent: _concurrent, callsThisMinute: _callsThisMinute };
}
