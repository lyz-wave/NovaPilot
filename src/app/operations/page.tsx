import {
  OperationsDashboard,
  type GateReport,
  type GuardrailBoardView,
} from "@/components/operations-dashboard";
import { getDb } from "@/server/db/client";
import { listBenchHistory, listQualityEvents } from "@/server/db/repositories";
import { runNovaBench } from "@/server/eval/novabench";
import {
  guardrailBoard,
  p0Breaches,
  p1Breaches,
  pendingReviewLoad,
  weekStart,
} from "@/server/telemetry/guardrail-board";

// Node runtime (node:sqlite) + always run the gold set at request time so the
// dashboard opens on the real, current release-gate state.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  const db = getDb();
  // 每次访问以真实时间运行:同一套金标,不同 run id,历史可累积回看。
  const report = await runNovaBench(db, { provider: "off" }, new Date().toISOString());
  const initialReport: GateReport = {
    suite: report.suite,
    accuracy: report.accuracy,
    passed: report.passed,
    total: report.total,
    metrics: report.metrics,
    decision: report.gate.decision,
    failed: report.gate.failed,
    maxTrafficPercent: report.gate.maxTrafficPercent,
    cases: report.cases.map((c) => ({
      id: c.id,
      expected: c.expected,
      actual: c.actual,
      correct: c.correct,
      status: c.status,
      recommendations: c.recommendations,
      citations: c.citations,
      invalidCitations: c.invalidCitations,
      provider: c.provider,
      error: c.error,
    })),
  };
  // 运行历史与质量事件同源持久化:刷新后趋势、历史回看与事件闭环不丢失。
  const history = listBenchHistory(db);
  const events = listQualityEvents(db);

  // 护栏对(指标体系第 10 节)。默认按自然周切窗 —— 第 11 节的复盘节奏是周会,
  // 看板窗口和复盘窗口对不上的话,会上讨论的数和板上显示的数不是同一批。
  // 六对共用同一个 sinceIso:护栏侧和激励侧不能来自两个时间窗,否则「成对」只是排版。
  const board = guardrailBoard(db, weekStart(new Date().toISOString()));
  const guardrail: GuardrailBoardView = {
    ...board,
    p0: p0Breaches(board),
    p1: p1Breaches(board),
    pendingReview: pendingReviewLoad(board),
  };
  return (
    <OperationsDashboard
      initialReport={initialReport}
      initialHistory={history}
      initialEvents={events}
      guardrail={guardrail}
    />
  );
}
