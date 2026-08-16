import { NovaWorkspace } from "@/components/nova-workspace";
import { getDb } from "@/server/db/client";
import { conversationContext, ensureSeeded } from "@/server/service";
import {
  createConversation,
  listConversation,
  listConversations,
  titleFromFirstMessage,
} from "@/server/db/repositories";
import type { ConsultationResult } from "@/domain/consultation-journey";

// node:sqlite requires the Node runtime; render per request against the live DB.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TENANT = "novapilot-demo";

export default async function ConsultationPage() {
  const db = getDb();
  ensureSeeded(db);

  // Multi-conversation: load the thread list. On a fresh (or pre-multi) database
  // there is no `conversations` row yet — seed the default thread, whose id is
  // the tenant id so it adopts any history persisted before multi-conversation
  // existed (respond() defaults conversationId to tenantId).
  let conversations = listConversations(db, TENANT);
  if (conversations.length === 0) {
    const now = new Date().toISOString();
    createConversation(db, { id: TENANT, tenantId: TENANT, now });
    const existing = listConversation(db, TENANT);
    const firstUser = existing.find((t) => t.role === "user" && t.text);
    if (firstUser?.text) titleFromFirstMessage(db, { id: TENANT, text: firstUser.text, now });
    conversations = listConversations(db, TENANT);
  }

  const active = conversations[0]!;
  const initialTurns = listConversation(db, active.id);

  // The decision-card panel tracks the latest card produced in the conversation.
  const initialCard: ConsultationResult | null =
    [...initialTurns].reverse().find((t) => t.kind === "card")?.result ?? null;

  return (
    <NovaWorkspace
      conversations={conversations}
      activeConversationId={active.id}
      initialTurns={initialTurns}
      initialCard={initialCard}
      initialContextUsage={conversationContext(db, active.id)}
    />
  );
}
