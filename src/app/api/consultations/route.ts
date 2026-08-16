import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteContext } from "../write-context";
import { respond, conversationContext } from "@/server/service";
import { getDb } from "@/server/db/client";
import { getCheckpoints } from "@/server/orchestration/graph";

// Node runtime required for node:sqlite (not available on the edge runtime).
export const runtime = "nodejs";

const requestSchema = z.object({
  question: z.string().min(1).max(4000),
  locale: z.enum(["zh", "en", "ja"]),
  facts: z.object({
    sampleCount: z.number().int().positive().optional(),
    dv200: z.number().min(0).max(100).optional(),
    rnaInputNg: z.number().positive().optional(),
    material: z.string().min(1).optional(),
    species: z.string().min(1).max(80).optional(),
    goal: z.string().min(1).max(120).optional(),
  }),
  stream: z.boolean().optional(),
  // Which conversation thread this turn belongs to. Carried in the body (never
  // the tenant header) so the write contract is untouched; omitted ⇒ tenantId.
  conversationId: z.string().min(1).max(200).optional(),
});

export async function POST(request: Request) {
  const write = requireWriteContext(request);
  if (write.error) return write.error;
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_CONSULTATION", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { question, locale, facts, stream, conversationId } = parsed.data;

  // ── Streaming (SSE): emit each orchestration checkpoint as it is reached ──
  if (stream) {
    return streamConsultation({
      question,
      locale,
      facts,
      tenantId: write.context.tenantId,
      traceId: write.context.traceId,
      conversationId,
    });
  }

  const outcome = await respond({
    question,
    locale,
    facts,
    tenantId: write.context.tenantId,
    traceId: write.context.traceId,
    conversationId,
  });

  const contextUsage = conversationContext(
    getDb(),
    conversationId ?? write.context.tenantId,
  );

  return NextResponse.json(
    { ...outcome, contextUsage },
    {
      headers: {
        "x-trace-id": write.context.traceId,
        "x-tenant-id": write.context.tenantId,
      },
    },
  );
}

function streamConsultation(input: {
  question: string;
  locale: "zh" | "en" | "ja";
  facts: z.infer<typeof requestSchema>["facts"];
  tenantId: string;
  traceId: string;
  conversationId?: string;
}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      try {
        send("start", { traceId: input.traceId });
        // Classify + run. Chat turns skip the graph entirely (no checkpoints);
        // research turns run the graph and we replay its persisted checkpoints.
        const outcome = await respond(input);
        const contextUsage = conversationContext(
          getDb(),
          input.conversationId ?? input.tenantId,
        );
        if (outcome.kind === "chat") {
          send("node", { node: "chat", state: null });
          send("result", { ...outcome, contextUsage });
        } else {
          const trail = getCheckpoints(getDb(), input.traceId);
          for (const step of trail) {
            send("node", { node: step.node, state: step.state });
          }
          send("result", { ...outcome, contextUsage });
        }
        send("done", { traceId: input.traceId });
      } catch (err) {
        send("error", { message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-trace-id": input.traceId,
    },
  });
}
