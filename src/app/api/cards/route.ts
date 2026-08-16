import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { listCardVersions } from "@/server/db/repositories";

// Node runtime required for node:sqlite (not available on the edge runtime).
export const runtime = "nodejs";

const BEARER = "Bearer demo-research-session";

/**
 * Read endpoint (bearer auth): the real persisted version history of a
 * project's decision card. Pure SQLite read, so the version tab is fully
 * demonstrable offline with no model or key.
 *
 *   GET /api/cards?projectId=<id> → { versions: CardVersionMeta[] }
 */
export async function GET(request: Request) {
  if (request.headers.get("authorization") !== BEARER) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "MISSING_PROJECT_ID" }, { status: 400 });
  }
  return NextResponse.json({ versions: listCardVersions(getDb(), projectId) });
}
