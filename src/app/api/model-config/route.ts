import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteContext } from "../write-context";
import { getDb } from "@/server/db/client";
import {
  listModelProfiles,
  getActiveProfileId,
  setActiveProfile,
  upsertModelProfile,
  deleteModelProfile,
  type ModelProfile,
  type StoredModelConfig,
} from "@/server/db/repositories";
import { complete } from "@/server/agents/model-gateway";

// Node runtime required for node:sqlite (not available on the edge runtime).
export const runtime = "nodejs";

const BEARER = "Bearer demo-research-session";

const saveSchema = z.object({
  action: z.literal("save"),
  id: z.string().optional(), // present ⇒ edit existing profile
  label: z.string().max(60).optional(),
  provider: z.enum(["anthropic", "openai"]).optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).optional(),
});
const activateSchema = z.object({ action: z.literal("activate"), id: z.string() });
const deleteSchema = z.object({ action: z.literal("delete"), id: z.string() });
const offSchema = z.object({ action: z.literal("off") });
const bodySchema = z.union([saveSchema, activateSchema, deleteSchema, offSchema]);

function inferProvider(input: z.infer<typeof saveSchema>): "anthropic" | "openai" {
  if (input.provider) return input.provider;
  if (input.baseUrl) return "openai"; // OpenAI-compatible self-hosted endpoint
  if (input.apiKey?.startsWith("sk-ant")) return "anthropic";
  return "openai";
}

function defaultModel(provider: string): string {
  return provider === "anthropic" ? "claude-sonnet-5" : "gpt-4o-mini";
}

const PROVIDER_LABEL: Record<string, string> = { anthropic: "Claude", openai: "OpenAI" };

/** Never return raw keys to the browser — show a masked hint only. */
function maskKey(key?: string): string | null {
  if (!key) return null;
  if (key.length <= 12) return "••••";
  return `${key.slice(0, 6)}••••${key.slice(-4)}`;
}

/** Full state the frontend renders: profile list (masked) + active id. */
function state() {
  const db = getDb();
  const activeId = getActiveProfileId(db);
  const profiles = listModelProfiles(db).map((p) => ({
    id: p.id,
    label: p.label,
    provider: p.provider,
    model: p.model,
    baseUrl: p.baseUrl ?? null,
    apiKeyMasked: maskKey(p.apiKey),
  }));
  return { activeId, profiles };
}

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== BEARER) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  return NextResponse.json(state());
}

export async function POST(request: Request) {
  const write = requireWriteContext(request);
  if (write.error) return write.error;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_MODEL_CONFIG", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const db = getDb();
  const now = new Date().toISOString();
  const body = parsed.data;
  const headers = { "x-trace-id": write.context.traceId };

  // ── select which saved profile is active (offline = none) ──
  if (body.action === "off") {
    setActiveProfile(db, null, now);
    return NextResponse.json({ ...state() }, { headers });
  }
  if (body.action === "activate") {
    const exists = listModelProfiles(db).some((p) => p.id === body.id);
    if (!exists) return NextResponse.json({ error: "PROFILE_NOT_FOUND" }, { status: 404 });
    setActiveProfile(db, body.id, now);
    return NextResponse.json({ ...state() }, { headers });
  }
  if (body.action === "delete") {
    deleteModelProfile(db, body.id, now);
    return NextResponse.json({ ...state() }, { headers });
  }

  // ── save: infer provider, live-test, persist, then activate ──
  if (!body.apiKey && !body.baseUrl) {
    return NextResponse.json({ error: "API_KEY_OR_BASEURL_REQUIRED" }, { status: 400 });
  }
  const provider = inferProvider(body);
  const model = body.model ?? defaultModel(provider);
  const cfg: StoredModelConfig = { provider, apiKey: body.apiKey, baseUrl: body.baseUrl, model };

  // complete() degrades to the deterministic generator on any failure, so a
  // non-deterministic provider proves the key/endpoint actually works. Only a
  // reachable config is persisted, so a saved profile is always usable.
  let connected = false;
  let testError: string | null = null;
  try {
    const res = await complete(
      { messages: [{ role: "user", content: "ping" }], maxTokens: 8, temperature: 0 },
      cfg,
    );
    connected = res.provider !== "deterministic";
    if (!connected) testError = "凭证无效或无法连接，未保存。";
  } catch (e) {
    testError = (e as Error).message;
  }

  if (!connected) {
    return NextResponse.json({ connected, saved: false, testError, ...state() }, { headers });
  }

  const profile: ModelProfile = {
    id: body.id ?? crypto.randomUUID(),
    label: body.label?.trim() || `${PROVIDER_LABEL[provider]} · ${model}`,
    ...cfg,
  };
  upsertModelProfile(db, profile, now);
  setActiveProfile(db, profile.id, now); // saving a working profile activates it
  return NextResponse.json(
    { connected: true, saved: true, testError: null, savedId: profile.id, ...state() },
    { headers },
  );
}
