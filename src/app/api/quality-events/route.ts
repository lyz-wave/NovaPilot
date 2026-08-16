import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteContext } from "../write-context";
import { getDb } from "@/server/db/client";
import {
  findOpenQualityEvent,
  listQualityEvents,
  resolveQualityEvent,
  saveQualityEvent,
} from "@/server/db/repositories";
import { syncQualityEvent } from "@/server/feishu/bitable";

// Node runtime required for node:sqlite (not available on the edge runtime).
export const runtime = "nodejs";

const BEARER = "Bearer demo-research-session";

// Quality-event lifecycle: a degraded gate opens an event (idempotent per
// gate), a human closes it with mandatory evidence. Pure SQLite — offline.
const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open"),
    gateKey: z.string().min(1),
    label: z.string().min(1),
    value: z.string().min(1),
    owner: z.string().min(1),
    simulated: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("resolve"),
    id: z.string().min(1),
    evidence: z.string().min(1),
  }),
]);

/** GET /api/quality-events → { events: QualityEventRecord[] } (bearer). */
export async function GET(request: Request) {
  if (request.headers.get("authorization") !== BEARER) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  return NextResponse.json({ events: listQualityEvents(getDb()) });
}

/** POST /api/quality-events (write contract) — open / resolve an event. */
export async function POST(request: Request) {
  const write = requireWriteContext(request);
  if (write.error) return write.error;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_EVENT_INPUT" }, { status: 400 });
  }

  const db = getDb();
  const now = new Date().toISOString();
  const body = parsed.data;
  const headers = { "x-trace-id": write.context.traceId };

  if (body.action === "open") {
    // Idempotent: a gate that keeps failing doesn't stack duplicate events.
    const existing = findOpenQualityEvent(db, body.gateKey);
    if (existing) return NextResponse.json({ event: existing }, { headers });
    const event = {
      id: `QE-${body.gateKey}-${Date.now().toString(36).toUpperCase()}`,
      gateKey: body.gateKey,
      label: body.label,
      value: body.value,
      owner: body.owner,
      evidence: "",
      status: "open" as const,
      simulated: body.simulated ?? false,
      createdAt: now,
      resolvedAt: null,
    };
    saveQualityEvent(db, event);
    // 飞书多维表格双写(凭证缺失时 no-op)。
    void syncQualityEvent(event).catch(() => {});
    return NextResponse.json({ event }, { headers });
  }

  // action === "resolve"
  const resolved = resolveQualityEvent(db, body.id, body.evidence.trim(), now);
  if (!resolved) {
    return NextResponse.json({ error: "EVENT_NOT_FOUND" }, { status: 404 });
  }
  void syncQualityEvent(resolved).catch(() => {});
  return NextResponse.json({ event: resolved }, { headers });
}
