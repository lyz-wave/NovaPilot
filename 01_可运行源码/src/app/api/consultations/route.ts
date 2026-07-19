import { NextResponse } from "next/server";
import { z } from "zod";
import {
  inferScenarioFromQuestion,
  runConsultationJourney,
} from "@/domain/consultation-journey";
import { requireWriteContext } from "../write-context";

const requestSchema = z.object({
  question: z.string().min(1).max(4000),
  locale: z.enum(["zh", "en", "ja"]),
  facts: z.object({
    sampleCount: z.number().int().positive().optional(),
    dv200: z.number().min(0).max(100).optional(),
    rnaInputNg: z.number().positive().optional(),
    material: z.string().min(1).optional(),
  }),
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

  const { question, ...consultation } = parsed.data;
  const result = runConsultationJourney({
    ...consultation,
    scenario: inferScenarioFromQuestion(question, consultation.facts),
  });
  return NextResponse.json({ ...result, traceId: write.context.traceId }, {
    headers: {
      "x-trace-id": write.context.traceId,
      "x-tenant-id": write.context.tenantId,
    },
  });
}
