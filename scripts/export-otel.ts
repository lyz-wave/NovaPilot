#!/usr/bin/env npx tsx
/**
 * S4-3 OTLP/JSON 导出脚本
 *
 * 将 checkpoints、review_rounds、model_calls 表中的数据转换为
 * OpenTelemetry Trace OTLP/JSON 格式（零外部依赖，只用 node:fs / node:path）。
 *
 * 输出文件：data/otel/traces-<timestamp>.json
 *
 * 用法：
 *   npx tsx scripts/export-otel.ts [--since 2026-09-01] [--out ./data/otel]
 *
 * 格式参考：
 *   https://opentelemetry.io/docs/specs/otlp/#otlpjson
 *   (ExportTraceServiceRequest schema, JSON encoding)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDb, queryAll } from "../src/server/db/client";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argVal(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const since = argVal("--since") ?? null;
const ROOT = resolve(import.meta.dirname, "..");
const outDir = resolve(argVal("--out") ?? join(ROOT, "data", "otel"));
const dbPath = process.env.NOVAPILOT_DB_PATH ?? join(ROOT, "data", "novapilot.db");

// ── OTLP helpers ──────────────────────────────────────────────────────────────

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

function strAttr(key: string, value: string): { key: string; value: AnyValue } {
  return { key, value: { stringValue: value } };
}
function intAttr(key: string, value: number): { key: string; value: AnyValue } {
  return { key, value: { intValue: String(Math.round(value)) } };
}

function isoToNanosHex(iso: string | null | undefined): string {
  if (!iso) return "0";
  const ms = new Date(iso).getTime();
  return (BigInt(ms) * 1_000_000n).toString();
}

// ── Fetch rows ─────────────────────────────────────────────────────────────────

interface CheckpointRow {
  trace_id: string;
  node: string;
  state: string;
  created_at: string;
}

interface ReviewRoundRow {
  id: string;
  trace_id: string;
  round_index: number;
  intercepted: number;
  outcome: string | null;
  created_at: string;
}

interface ModelCallRow {
  id: string;
  trace_id: string | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  latency_ms: number | null;
  degraded: number;
  created_at: string;
}

function buildSpans(
  checkpoints: CheckpointRow[],
  rounds: ReviewRoundRow[],
  calls: ModelCallRow[],
): object[] {
  const spans: object[] = [];

  // One span per checkpoint row
  for (const cp of checkpoints) {
    const traceIdHex = cp.trace_id.replace(/-/g, "").padEnd(32, "0").slice(0, 32);
    const spanIdHex = Buffer.from(`${cp.trace_id}:${cp.node}`).toString("hex").slice(0, 16);
    const startNs = isoToNanosHex(cp.created_at);
    spans.push({
      traceId: traceIdHex,
      spanId: spanIdHex,
      name: `novapilot.checkpoint.${cp.node}`,
      kind: 1, // INTERNAL
      startTimeUnixNano: startNs,
      endTimeUnixNano: startNs,
      attributes: [
        strAttr("novapilot.node", cp.node),
        strAttr("novapilot.trace_id", cp.trace_id),
        strAttr("novapilot.state_json", cp.state.slice(0, 512)),
      ],
      status: { code: 1 }, // OK
    });
  }

  // One span per review round
  for (const rr of rounds) {
    const traceIdHex = rr.trace_id.replace(/-/g, "").padEnd(32, "0").slice(0, 32);
    const spanIdHex = Buffer.from(`round:${rr.id}`).toString("hex").slice(0, 16);
    const startNs = isoToNanosHex(rr.created_at);
    spans.push({
      traceId: traceIdHex,
      spanId: spanIdHex,
      name: "novapilot.review_round",
      kind: 1,
      startTimeUnixNano: startNs,
      endTimeUnixNano: startNs,
      attributes: [
        strAttr("novapilot.trace_id", rr.trace_id),
        intAttr("novapilot.round_index", rr.round_index),
        { key: "novapilot.intercepted", value: { boolValue: rr.intercepted === 1 } },
        strAttr("novapilot.outcome", rr.outcome ?? "pending"),
      ],
      status: { code: 1 },
    });
  }

  // One span per model call
  for (const mc of calls) {
    const rawTrace = mc.trace_id ?? mc.id;
    const traceIdHex = rawTrace.replace(/-/g, "").padEnd(32, "0").slice(0, 32);
    const spanIdHex = Buffer.from(`mc:${mc.id}`).toString("hex").slice(0, 16);
    const startNs = isoToNanosHex(mc.created_at);
    const endNs = mc.latency_ms != null
      ? (BigInt(startNs) + BigInt(Math.round(mc.latency_ms)) * 1_000_000n).toString()
      : startNs;
    spans.push({
      traceId: traceIdHex,
      spanId: spanIdHex,
      name: `novapilot.model_call.${mc.provider}`,
      kind: 3, // CLIENT
      startTimeUnixNano: startNs,
      endTimeUnixNano: endNs,
      attributes: [
        strAttr("novapilot.provider", mc.provider),
        strAttr("novapilot.model", mc.model),
        intAttr("novapilot.input_tokens", mc.input_tokens),
        intAttr("novapilot.output_tokens", mc.output_tokens),
        ...(mc.cost_usd != null ? [{ key: "novapilot.cost_usd", value: { doubleValue: mc.cost_usd } as AnyValue }] : []),
        { key: "novapilot.degraded", value: { boolValue: mc.degraded === 1 } },
      ],
      status: { code: 1 },
    });
  }

  return spans;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(function main() {
  const db = createDb(dbPath);

  const checkpoints = queryAll<CheckpointRow>(
    db,
    `SELECT trace_id, node, state, created_at FROM checkpoints
     WHERE (? IS NULL OR created_at >= ?) ORDER BY created_at`,
    since, since,
  );

  let rounds: ReviewRoundRow[] = [];
  try {
    rounds = queryAll<ReviewRoundRow>(
      db,
      `SELECT id, trace_id, round_index, intercepted, outcome, created_at
       FROM review_rounds WHERE (? IS NULL OR created_at >= ?) ORDER BY created_at`,
      since, since,
    );
  } catch { /* table may not exist in old schemas */ }

  let calls: ModelCallRow[] = [];
  try {
    calls = queryAll<ModelCallRow>(
      db,
      `SELECT id, trace_id, provider, model, input_tokens, output_tokens, cost_usd, latency_ms, degraded, created_at
       FROM model_calls WHERE (? IS NULL OR created_at >= ?) ORDER BY created_at`,
      since, since,
    );
  } catch { /* table may not exist in old schemas */ }

  const spans = buildSpans(checkpoints, rounds, calls);

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            strAttr("service.name", "novapilot"),
            strAttr("service.version", "1.2"),
            strAttr("deployment.environment", process.env.NODE_ENV ?? "development"),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "novapilot.export-otel", version: "1.0" },
            spans,
          },
        ],
      },
    ],
  };

  mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = join(outDir, `traces-${ts}.json`);
  writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");

  console.log(
    `[export-otel] exported ${spans.length} spans ` +
    `(${checkpoints.length} checkpoints, ${rounds.length} rounds, ${calls.length} model_calls) → ${outFile}`,
  );
})();
