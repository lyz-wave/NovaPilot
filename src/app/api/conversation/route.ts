import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteContext } from "../write-context";
import { getDb } from "@/server/db/client";
import { compactConversation, conversationContext } from "@/server/service";
import {
  clearConversation,
  createConversation,
  deleteConversation,
  getConversation,
  listConversation,
  listConversations,
  renameConversation,
} from "@/server/db/repositories";

// Node runtime required for node:sqlite (not available on the edge runtime).
export const runtime = "nodejs";

const BEARER = "Bearer demo-research-session";
// The demo tenant. Multi-conversation threads all live under this tenant; the
// individual thread is selected by `conversationId` in the body/query, never by
// changing the tenant header (that would break the 403/412 write contract).
const TENANT = "novapilot-demo";

/**
 * Read endpoint (bearer auth):
 *   - no query           → { conversations: ConversationMeta[] } (the thread list)
 *   - ?conversationId=id → { turns } (that thread's full history)
 */
export async function GET(request: Request) {
  if (request.headers.get("authorization") !== BEARER) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const db = getDb();
  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (conversationId) {
    return NextResponse.json({
      turns: listConversation(db, conversationId),
      contextUsage: conversationContext(db, conversationId),
    });
  }
  return NextResponse.json({ conversations: listConversations(db, TENANT) });
}

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), title: z.string().min(1).max(120).optional() }),
  z.object({
    action: z.literal("rename"),
    conversationId: z.string().min(1).max(200),
    title: z.string().min(1).max(120),
  }),
  z.object({ action: z.literal("delete"), conversationId: z.string().min(1).max(200) }),
  // Clearing keeps the thread itself; conversationId optional ⇒ the tenant thread.
  z.object({ action: z.literal("clear"), conversationId: z.string().min(1).max(200).optional() }),
  // Compact folds older turns into a summary (CC-style /compact).
  z.object({ action: z.literal("compact"), conversationId: z.string().min(1).max(200).optional() }),
]);

/**
 * Write endpoint (full write contract): create / rename / delete / clear a
 * conversation thread. All operations are pure SQLite so they work offline with
 * no model — the multi-conversation UI is fully demonstrable without a key.
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
  const { tenantId, traceId } = write.context;
  const headers = { "x-trace-id": traceId };
  const body = parsed.data;

  switch (body.action) {
    case "create": {
      const id = crypto.randomUUID();
      createConversation(db, { id, tenantId, title: body.title, now });
      return NextResponse.json({ conversation: getConversation(db, { id, tenantId }) }, { headers });
    }
    case "rename": {
      if (!getConversation(db, { id: body.conversationId, tenantId })) {
        return NextResponse.json({ error: "NOT_FOUND" }, { status: 404, headers });
      }
      renameConversation(db, { id: body.conversationId, tenantId, title: body.title, now });
      return NextResponse.json(
        { conversation: getConversation(db, { id: body.conversationId, tenantId }) },
        { headers },
      );
    }
    case "delete": {
      deleteConversation(db, { id: body.conversationId, tenantId });
      return NextResponse.json(
        { conversations: listConversations(db, tenantId) },
        { headers },
      );
    }
    case "clear": {
      clearConversation(db, body.conversationId ?? tenantId);
      return NextResponse.json(
        { turns: [], contextUsage: conversationContext(db, body.conversationId ?? tenantId) },
        { headers },
      );
    }
    case "compact": {
      const result = await compactConversation({
        conversationId: body.conversationId ?? tenantId,
      });
      return NextResponse.json(result, { headers });
    }
  }
}
