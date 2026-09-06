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
import { p2Breaches, retrievalBoard } from "@/server/telemetry/retrieval-log";
import { sessionBoard, wakeupBreaches } from "@/server/telemetry/session-mix";
import { lifecycleBoard } from "@/server/telemetry/lifecycle";
import { degradeMatrixSummary } from "@/server/telemetry/degrade-matrix";
import { defenseLayerBoard } from "@/server/telemetry/defense-layers";
import { citationComplianceBoard } from "@/server/telemetry/citation-compliance";

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
      hitAtK: c.hitAtK,
    })),
  };
  // 运行历史与质量事件同源持久化:刷新后趋势、历史回看与事件闭环不丢失。
  const history = listBenchHistory(db);
  const events = listQualityEvents(db);

  // 护栏对(指标体系第 10 节)。默认按自然周切窗 —— 第 11 节的复盘节奏是周会,
  // 看板窗口和复盘窗口对不上的话,会上讨论的数和板上显示的数不是同一批。
  // 六对共用同一个 sinceIso:护栏侧和激励侧不能来自两个时间窗,否则「成对」只是排版。
  const board = guardrailBoard(db, weekStart(new Date().toISOString()));
  // 检索侧共用同一个窗口:P2 里的「SOP 覆盖率」若和护栏对不同窗,周会上没法对账。
  const retrieval = retrievalBoard(db, weekStart(new Date().toISOString()));
  // §3 / §6 / §7 三节同样共用这个窗口。三张表的分母各不相同(会话 / 工单 / 候选),
  // 但时间窗必须是同一个 —— 不然周会上没法说「这一周」。
  const since = weekStart(new Date().toISOString());
  const session = sessionBoard(db, since);
  const lifecycle = lifecycleBoard(db, since);
  const degrade = degradeMatrixSummary(db, since);
  // §5 三层防线通过率:与其余护栏对共用同一个 sinceIso,周会上才能对齐同一批数。
  const defense = defenseLayerBoard(db, since);
  // §7 引用核实合规率:全库口径(不切窗)——文献一旦入库,合规状态不随周变化,
  // 与「知识入库量」那一行的「全库累计」列是同一种全量口径。
  const citationCompliance = citationComplianceBoard(db);
  const guardrail: GuardrailBoardView = {
    ...board,
    retrieval,
    session,
    lifecycle,
    degrade,
    defense,
    citationCompliance,
    p0: p0Breaches(board),
    p1: p1Breaches(board),
    // 跨周唤醒占比是 v1.1 第 11 节 P2 的第三项,和检索侧两项并进同一条 P2 通道。
    p2: [...p2Breaches(retrieval), ...wakeupBreaches(session)],
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
