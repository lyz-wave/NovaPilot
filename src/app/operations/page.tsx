import { OperationsDashboard, type GateReport } from "@/components/operations-dashboard";
import { getDb } from "@/server/db/client";
import { listBenchHistory, listQualityEvents } from "@/server/db/repositories";
import { runNovaBench } from "@/server/eval/novabench";

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
  return (
    <OperationsDashboard
      initialReport={initialReport}
      initialHistory={history}
      initialEvents={events}
    />
  );
}
