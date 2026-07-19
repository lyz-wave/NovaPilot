import { NextResponse } from "next/server";
import { z } from "zod";
import { recordConsent } from "@/domain/consultation-journey";
import { requireWriteContext } from "../write-context";

const consentSchema = z.object({
  projectId: z.string().min(1),
  granted: z.boolean(),
  action: z.enum(["request-quote", "book-expert", "allow-contact"]).optional(),
  idempotencyKey: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  const write = requireWriteContext(request);
  if (write.error) return write.error;
  const parsed = consentSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_CONSENT" }, { status: 400 });
  }
  const result = recordConsent({
    ...parsed.data,
    idempotencyKey: write.context.idempotencyKey,
  });
  return NextResponse.json(
    result,
    { status: result.conflict ? 409 : 200,
      headers: { "x-trace-id": write.context.traceId } },
  );
}
