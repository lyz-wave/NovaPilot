import { NextResponse } from "next/server";

export interface WriteContext {
  tenantId: string;
  idempotencyKey: string;
  expectedVersion: string;
  traceId: string;
}

const DEMO_BEARER = "Bearer demo-research-session";

/**
 * 仅校验调用方身份,不要求写上下文头(If-Match / 幂等键 / 租户)。
 * 给飞书等集成入口用:它们有自己的租户,但同样不能匿名触发管线与落库。
 */
export function requireBearer(request: Request): NextResponse | null {
  if (request.headers.get("authorization") !== DEMO_BEARER) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  return null;
}

export function requireWriteContext(
  request: Request,
): { context: WriteContext; error?: never } | { context?: never; error: NextResponse } {
  const authorization = request.headers.get("authorization");
  if (authorization !== DEMO_BEARER) {
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
  if (tenantId !== "novapilot-demo" || !/^"v\d+"$/.test(expectedVersion)) {
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
