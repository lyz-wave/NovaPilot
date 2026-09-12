/**
 * 看板指标 key 清单（唯一来源）。
 *
 * operations-dashboard.tsx 从此处导入并 re-export。
 * evidence-probes.ts 从此处导入，判定「看板可见」（onDashboard 探针）。
 *
 * 新增指标格子时：先在此处加 key，再实现 JSX 渲染。
 * 删除格子时：先删 JSX，再删此处的 key —— 删了 key 而 probeExpectation.onDashboard
 * 仍为 true 会导致 scorecard.test.ts 断言 5 变红，这正是想要的效果。
 */
export const DASHBOARD_METRIC_KEYS = [
  // §3 流量与会话
  "session.volume",
  "session.effectiveRate",
  "session.lensMix",
  "session.wakeup",
  // §4 知识检索与评测
  "guardrail.directResolutionRate",
  "novabench.hitRate",
  "binding.bindingRate",
  "retrieval.shortQueryRate",
  "retrieval.elapsed",
  "retrieval.sopCoverage",
  "retrieval.blindSpots",
  "knowledge.documents",
  "novabench.score",
  "novabench.escalationRecall",
  "feedback.negativeRate",
  "adoption.adoptionRate",
  // §5 防线与拦截
  "defense.layers",
  "guardrail.interceptionRate",
  "review.falseInterception",
  "novabench.hallucinationLeaks",
  "interceptResolution.rate",
  "review.judgeAgreement",
  // §6 专家协同
  "lifecycle.expert.claim",
  "review.missedEscalation",
  "handoffCompleteness.rate",
  "inflow.inflowRate",
  // §7 知识演化
  "lifecycle.knowledge.timeToPublishHours",
  "lifecycle.knowledge.gatePassRate",
  "lifecycle.knowledge.rolledBack",
  "lifecycle.knowledge.grayWindowIncidents",
  "citationCompliance.rate",
  // §8 可靠性
  "latency.firstToken",
  "latency.stream",
  "degrade.runtimeTriggers",
  "degrade.testGreenRate",
  // §9 演示就绪度
  "demo.successRate",
  "faultInjection.successRate",
  "pkg.coldStartTime",
] as const;

export type DashboardMetricKey = (typeof DASHBOARD_METRIC_KEYS)[number];
