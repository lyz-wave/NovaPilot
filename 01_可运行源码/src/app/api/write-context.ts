import { NextResponse } from "next/server";

export interface WriteContext {
  tenantId: string;
  idempotencyKey: string;
  expectedVersion: string;
  traceId: string;
}

export function requireWriteContext(
  request: Request,
): { context: WriteContext; error?: never } | { context?: never; error: NextResponse } {
  const authorization = request.headers.get("authorization");
  if (authorization !== "Bearer demo-research-session") {
    return {
      error: NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 }),
    };
  }

  const tenantId = request.headers.get("x-tenant-id");
  const idempotencyKey = request.headers.get("x-idempotency-key");
  const expectedVersion = request.headers.get("if-match");
  if (!tenantId || !idempotencyKey || !expectedVersion) {
    return {
      error: NextResponse.json(
        { error: "WRITE_CONTEXT_REQUIRED" },
        { status: 428 },
      ),
    };
  }
  if (tenantId !== "novogene-demo" || !/^"v\d+"$/.test(expectedVersion)) {
    return {
      error: NextResponse.json({ error: "INVALID_WRITE_CONTEXT" }, { status: 403 }),
    };
  }
  if (expectedVersion !== '"v3"') {
    return {
      error: NextResponse.json({ error: "VERSION_CONFLICT" }, { status: 412 }),
    };
  }

  return {
    context: {
      tenantId,
      idempotencyKey,
      expectedVersion,
      traceId: crypto.randomUUID(),
    },
  };
}
