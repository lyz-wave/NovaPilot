import { NextResponse } from "next/server";
import { z } from "zod";
import { evaluateReleaseGate } from "@/domain/consultation-journey";
import { requireWriteContext } from "../write-context";

const gateSchema = z.object({
  citationValidity: z.number().min(0).max(1),
  escalationRecall: z.number().min(0).max(1),
  confidentWrongDelta: z.number(),
  p0Defects: z.number().int().min(0),
  dataBoundaryIncidents: z.number().int().min(0),
});

export async function POST(request: Request) {
  const write = requireWriteContext(request);
  if (write.error) return write.error;
  const parsed = gateSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_GATE_INPUT" }, { status: 400 });
  }
  return NextResponse.json(evaluateReleaseGate(parsed.data), {
    headers: { "x-trace-id": write.context.traceId },
  });
}
