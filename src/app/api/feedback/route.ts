import { NextResponse } from "next/server";
import { z } from "zod";
import { recordFeedback } from "@/domain/consultation-journey";
import { requireWriteContext } from "../write-context";

const feedbackSchema = z.object({
  projectId: z.string().min(1),
  score: z.number().int().min(1).max(5),
  reason: z.enum(["citation", "incorrect", "unclear", "other"]).optional(),
});

export async function POST(request: Request) {
  const write = requireWriteContext(request);
  if (write.error) return write.error;
  const parsed = feedbackSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_FEEDBACK" }, { status: 400 });
  }
  return NextResponse.json(recordFeedback(parsed.data), {
    headers: { "x-trace-id": write.context.traceId },
  });
}
