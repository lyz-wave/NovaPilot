/**
 * Unified model gateway (OpenAI-compatible / Anthropic Messages).
 *
 * Mirrors the proposal's "统一 OpenAI-compatible 模型网关 + 动态路由":
 *   - route by data sensitivity (private vs external), latency and complexity
 *   - fall back to a deterministic local generator when no API key is set, so
 *     the whole system runs offline and tests are stable
 *
 * Env:
 *   NOVAPILOT_LLM_PROVIDER = "anthropic" | "openai" | "off" (default: auto)
 *   ANTHROPIC_API_KEY / NOVAPILOT_LLM_API_KEY
 *   NOVAPILOT_LLM_BASE_URL   (OpenAI-compatible endpoint, e.g. vLLM)
 *   NOVAPILOT_LLM_MODEL
 */

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
   * summarization) — a cheap-model-for-bounded-subtasks tier. Falls back to the
   * main model when no mini model is configured.
   */
  tier?: "mini" | "main";
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
  /**
   * Token accounting reported by the provider, when available. Used to drive
   * the context-usage ring with an authoritative input-token count (the local
   * estimator is the offline fallback). Absent for the deterministic path and
   * for providers that don't return a usage block.
   */
  usage?: TokenUsage;
}

/**
 * Context-window size (in tokens) for a model id — the denominator of the
 * context-usage ring. These are the published context lengths; unknown models
 * fall back to a safe 128K. Distinct from MAX_OUTPUT_TOKENS, which caps only
 * the generated reply.
 */
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

export interface ModelGatewayConfig {
  provider?: "anthropic" | "openai" | "off";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Cheaper/faster model for `tier: "mini"` subtasks (env: NOVAPILOT_LLM_MINI_MODEL). */
  miniModel?: string;
  /** Injected for tests: a deterministic generator used as fallback. */
  fallback?: (req: CompletionRequest) => string;
}

/**
 * Default output ceiling — GLM-4.x's official max output length (128K). This is
 * only a ceiling: providers bill by tokens actually generated, so a large cap
 * costs nothing extra when the model stops early. Callers may pass a smaller
 * `maxTokens` when they genuinely want a bounded reply.
 */
export const MAX_OUTPUT_TOKENS = 131072;

/**
 * Conservative retry ceiling. Some providers reject an over-large `max_tokens`
 * (or an over-long context) with a 4xx; we retry once at this smaller ceiling
 * before falling back to the offline generator — a shorter real answer beats
 * degrading to the deterministic canned text.
 */
const RETRY_MAX_TOKENS = 16384;

function resolveConfig(cfg: ModelGatewayConfig = {}): Required<
  Pick<ModelGatewayConfig, "provider" | "model" | "miniModel">
> & { apiKey?: string; baseUrl?: string; fallback?: ModelGatewayConfig["fallback"] } {
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
    // Mini tier: an explicit config/env override, else the provider's cheap
    // default; when neither exists it degrades to the main model (never fails).
    miniModel:
      cfg.miniModel ??
      env.NOVAPILOT_LLM_MINI_MODEL ??
      (provider === "anthropic" ? "claude-haiku-4-5-20251001" : "gpt-4o-mini"),
    fallback: cfg.fallback,
  };
}

/**
 * Complete a chat request. Never throws on missing credentials — it degrades
 * to the deterministic fallback so callers always get a usable result.
 */
export async function complete(
  req: CompletionRequest,
  cfg: ModelGatewayConfig = {},
): Promise<CompletionResult> {
  const resolved = resolveConfig(cfg);
  // Route to the mini model for bounded subtasks; otherwise the main model.
  const c =
    req.tier === "mini" ? { ...resolved, model: resolved.miniModel } : resolved;

  // Sensitive data may not leave for an external model unless a private
  // (self-hosted, OpenAI-compatible) base URL is configured.
  const externalAllowed = !req.sensitive || !!c.baseUrl;

  if (c.provider !== "off" && c.apiKey && externalAllowed) {
    const requested = req.maxTokens ?? MAX_OUTPUT_TOKENS;
    const call = (maxTokens: number) =>
      c.provider === "anthropic" && !c.baseUrl
        ? callAnthropic({ ...req, maxTokens }, c)
        : callOpenAICompatible({ ...req, maxTokens }, c);
    try {
      return await call(requested);
    } catch {
      // A provider may reject an over-large max_tokens (or context) with a 4xx.
      // Retry once at a conservative ceiling before giving up to the offline
      // fallback — never let a too-high ceiling degrade us to canned text.
      if (requested > RETRY_MAX_TOKENS) {
        try {
          return await call(RETRY_MAX_TOKENS);
        } catch {
          // fall through to deterministic
        }
      }
    }
  }

  const text = (c.fallback ?? deterministicFallback)(req);
  return {
    text,
    provider: "deterministic",
    model: "novapilot-deterministic-v1",
    route: req.sensitive ? "private-model" : "external-model",
  };
}

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
      ? {
          inputTokens: data.usage.input_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? 0,
        }
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
      ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}

/**
 * Deterministic offline generator. Echoes a compact, structured answer built
 * from the last user message — enough for the orchestrator's fallback path and
 * for reproducible tests.
 */
function deterministicFallback(req: CompletionRequest): string {
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  return `[[deterministic]] ${lastUser?.content.slice(0, 400) ?? ""}`;
}
