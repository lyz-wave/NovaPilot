"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  Gauge,
  History,
  Loader2,
  Radar,
  RotateCcw,
  ShieldCheck,
  Siren,
} from "lucide-react";
import { useMemo, useState } from "react";

// Client-safe mirror of the NovaBench release report (no server-eval imports).
interface GateMetrics {
  citationValidity: number;
  escalationRecall: number;
  confidentWrongDelta: number;
  p0Defects: number;
  dataBoundaryIncidents: number;
}
interface GateCase {
  id: string;
  expected: string;
  actual: string;
  correct: boolean;
  status: string;
  recommendations: number;
  citations: number;
  invalidCitations: string[];
  provider: string;
  error: string | null;
}
export interface GateReport {
  suite: string;
  accuracy: number;
  passed: number;
  total: number;
  metrics: GateMetrics;
  decision: string;
  failed: string[];
  maxTrafficPercent: number;
  cases: GateCase[];
}

/** 落库历史条目(客户端镜像,与 repositories.listBenchHistory 对齐)。 */
export interface BenchHistoryEntry {
  createdAt: string;
  accuracy: number;
  passed: number;
  total: number;
  decision: string;
  metrics: GateMetrics | null;
  report: {
    suite: string;
    accuracy: number;
    passed: number;
    total: number;
    decision: string;
    failed: string[];
    maxTrafficPercent: number;
    cases: Array<{
      id: string;
      expected: string;
      actual: string;
      correct: boolean;
      invalidCitations: string[];
    }>;
  } | null;
}

/** 质量事件(客户端镜像,与 repositories.QualityEventRecord 对齐)。 */
export interface QualityEvent {
  id: string;
  gateKey: string;
  label: string;
  value: string;
  owner: string;
  evidence: string;
  status: "open" | "resolved";
  simulated: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

const AUTH = "Bearer demo-research-session";
const WRITE_HEADERS = {
  authorization: AUTH,
  "content-type": "application/json",
  "x-tenant-id": "novapilot-demo",
  "x-idempotency-key": "",
  "if-match": '"v3"',
};

const pct = (value: number) => (value * 100).toFixed(1) + "%";
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });

interface GateRow {
  key: string;
  label: string;
  value: string;
  pass: boolean;
  owner: string;
  evidence: string;
  simulated: boolean;
}

/** 五道可注入退化的硬门禁定义(演示门禁失守→质量事件→关闭证据的闭环)。 */
const DEGRADE_OPTIONS: Array<{
  key: string;
  label: string;
  shortLabel: string;
  injectValue: string;
  owner: string;
  evidence: string;
}> = [
  {
    key: "escalation-recall",
    label: "高风险转接召回",
    shortLabel: "转接漏判",
    injectValue: "93.3%",
    owner: "安全运营组 · 转接负责人",
    evidence: "门禁 ≥ 95%：应转接金标必须全部命中。",
  },
  {
    key: "citation-validity",
    label: "引用有效率",
    shortLabel: "引用失效",
    injectValue: "96.9%",
    owner: "证据治理组 · 引用负责人",
    evidence: "门禁 ≥ 98%：失效引用必须清零。",
  },
  {
    key: "confident-wrong",
    label: "自信错答变化",
    shortLabel: "自信错答",
    injectValue: "+2",
    owner: "科研 Reviewer 组",
    evidence: "必须为 0：不得在应澄清/转接时给出自信正式结论。",
  },
  {
    key: "p0-defects",
    label: "P0 阻断缺陷",
    shortLabel: "P0 缺陷",
    injectValue: "+1",
    owner: "平台工程组",
    evidence: "必须为 0：崩溃、正式卡无建议、越界引用。",
  },
  {
    key: "data-boundary",
    label: "数据出域事件",
    shortLabel: "数据出域",
    injectValue: "+1",
    owner: "数据合规组",
    evidence: "必须为 0：敏感载荷不得路由至外部模型。",
  },
];

/** 从真实指标推导六道门禁(五道硬门禁 + NovaGuard 聚合);degraded 为前端展示层注入。 */
function deriveGates(report: GateReport, degraded: Set<string>): GateRow[] {
  const m = report.metrics;
  const base: Record<string, { value: string; pass: boolean }> = {
    "escalation-recall": { value: pct(m.escalationRecall), pass: m.escalationRecall >= 0.95 },
    "citation-validity": { value: pct(m.citationValidity), pass: m.citationValidity >= 0.98 },
    "confident-wrong": { value: String(m.confidentWrongDelta), pass: m.confidentWrongDelta === 0 },
    "p0-defects": { value: String(m.p0Defects), pass: m.p0Defects === 0 },
    "data-boundary": { value: String(m.dataBoundaryIncidents), pass: m.dataBoundaryIncidents === 0 },
  };
  const gates: GateRow[] = DEGRADE_OPTIONS.map((opt) => {
    const injected = degraded.has(opt.key);
    return {
      key: opt.key,
      label: opt.label,
      value: injected ? opt.injectValue : base[opt.key].value,
      pass: injected ? false : base[opt.key].pass,
      owner: opt.owner,
      evidence: injected
        ? "模拟退化：" + opt.injectValue + "，跌破硬门禁(展示层注入,真实评测结果不受影响)。"
        : opt.evidence,
      simulated: injected,
    };
  });
  gates.push({
    key: "nova-guard",
    label: "NovaGuard 可信控制",
    value: "evidence-bound / risk-tier / write-contract",
    pass: gates.every((g) => g.pass),
    owner: "可信控制层 · NovaGuard",
    evidence:
      "聚合门禁：引用白名单(有据才答)、风险分级审批(该转就转)、写契约(401/403/412/428)。任一子门禁失守即拦截上线。",
    simulated: degraded.size > 0,
  });
  return gates;
}

/** 从历史条目抽取真实趋势序列(不足 2 点返回 null)。 */
function trendSeries(
  history: BenchHistoryEntry[],
  pick: (h: BenchHistoryEntry) => number | null,
): number[] | null {
  const values = history
    .slice()
    .reverse()
    .map(pick)
    .filter((v): v is number => v != null);
  return values.length >= 2 ? values : null;
}

/** 落库报告 → 面板报告(补齐历史记录未冗余存储的展示字段)。 */
function storedToGateReport(entry: BenchHistoryEntry): GateReport | null {
  if (!entry.report || !entry.metrics) return null;
  return {
    suite: entry.report.suite,
    accuracy: entry.report.accuracy,
    passed: entry.report.passed,
    total: entry.report.total,
    metrics: entry.metrics,
    decision: entry.report.decision,
    failed: entry.report.failed,
    maxTrafficPercent: entry.report.maxTrafficPercent,
    cases: entry.report.cases.map((c) => ({
      id: c.id,
      expected: c.expected,
      actual: c.actual,
      correct: c.correct,
      status: "",
      recommendations: 0,
      citations: 0,
      invalidCitations: c.invalidCitations,
      provider: "",
      error: null,
    })),
  };
}

export function OperationsDashboard({
  initialReport,
  initialHistory,
  initialEvents,
}: {
  initialReport: GateReport;
  initialHistory: BenchHistoryEntry[];
  initialEvents: QualityEvent[];
}) {
  const [report, setReport] = useState<GateReport>(initialReport);
  const [latestReport, setLatestReport] = useState<GateReport>(initialReport);
  const [viewingAt, setViewingAt] = useState<string | null>(null);
  const [history, setHistory] = useState<BenchHistoryEntry[]>(initialHistory);
  const [events, setEvents] = useState<QualityEvent[]>(initialEvents);
  const [degraded, setDegraded] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [showCases, setShowCases] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [closeEvidence, setCloseEvidence] = useState("");
  const [busyEvent, setBusyEvent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gates = useMemo(() => deriveGates(report, degraded), [report, degraded]);
  const openEvents = events.filter((e) => e.status === "open");
  const resolvedEvents = events.filter((e) => e.status === "resolved");
  const blocked = degraded.size > 0 || report.decision !== "proceed";

  async function runBench() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/release-gates", {
        method: "POST",
        headers: { ...WRITE_HEADERS, "x-idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ mode: "novabench" }),
      });
      if (!res.ok) throw new Error("评测失败：" + res.status);
      const data = (await res.json()) as GateReport;
      setReport(data);
      setLatestReport(data);
      setViewingAt(null);
      setHistory((prev) =>
        [
          {
            createdAt: new Date().toISOString(),
            accuracy: data.accuracy,
            passed: data.passed,
            total: data.total,
            decision: data.decision,
            metrics: data.metrics,
            report: {
              suite: data.suite,
              accuracy: data.accuracy,
              passed: data.passed,
              total: data.total,
              decision: data.decision,
              failed: data.failed,
              maxTrafficPercent: data.maxTrafficPercent,
              cases: data.cases.map((c) => ({
                id: c.id,
                expected: c.expected,
                actual: c.actual,
                correct: c.correct,
                invalidCitations: c.invalidCitations,
              })),
            },
          },
          ...prev,
        ].slice(0, 12),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  function viewHistory(createdAt: string) {
    const entry = history.find((h) => h.createdAt === createdAt);
    const gate = entry ? storedToGateReport(entry) : null;
    if (!gate) return;
    setReport(gate);
    setViewingAt(createdAt);
  }

  function backToLatest() {
    setReport(latestReport);
    setViewingAt(null);
  }

  async function openEvent(key: string) {
    const opt = DEGRADE_OPTIONS.find((o) => o.key === key);
    if (!opt) return;
    try {
      const res = await fetch("/api/quality-events", {
        method: "POST",
        headers: { ...WRITE_HEADERS, "x-idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          action: "open",
          gateKey: opt.key,
          label: opt.label,
          value: opt.injectValue,
          owner: opt.owner,
          simulated: true,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { event: QualityEvent };
        setEvents((prev) => (prev.some((e) => e.id === data.event.id) ? prev : [...prev, data.event]));
      }
    } catch {
      // 事件以持久化状态为准,失败静默。
    }
  }

  function toggleDegrade(key: string) {
    if (degraded.has(key)) {
      setDegraded((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    setDegraded((prev) => new Set(prev).add(key));
    void openEvent(key);
  }

  async function resolveEvent(id: string) {
    const evidence = closeEvidence.trim();
    if (!evidence) return;
    setBusyEvent(true);
    setError(null);
    try {
      const res = await fetch("/api/quality-events", {
        method: "POST",
        headers: { ...WRITE_HEADERS, "x-idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ action: "resolve", id, evidence }),
      });
      if (!res.ok) throw new Error("关闭失败：" + res.status);
      const data = (await res.json()) as { event: QualityEvent };
      setEvents((prev) => prev.map((e) => (e.id === data.event.id ? data.event : e)));
      setResolvingId(null);
      setCloseEvidence("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyEvent(false);
    }
  }

  const metricCards = [
    {
      label: "金标准确率",
      value: pct(report.accuracy),
      delta: report.passed + "/" + report.total,
      good: report.accuracy >= 0.9,
      note: "NovaBench 金标集通过率",
      simulated: false,
      trend: trendSeries(history, (h) => h.accuracy),
    },
    {
      label: "高风险转接召回",
      value: degraded.has("escalation-recall") ? "93.3%" : pct(report.metrics.escalationRecall),
      delta: degraded.has("escalation-recall")
        ? "FAIL"
        : report.metrics.escalationRecall >= 0.95
          ? "PASS"
          : "FAIL",
      good: !degraded.has("escalation-recall") && report.metrics.escalationRecall >= 0.95,
      note: "门禁 ≥ 95%",
      simulated: degraded.has("escalation-recall"),
      trend: trendSeries(history, (h) => (h.metrics ? h.metrics.escalationRecall : null)),
    },
    {
      label: "引用有效率",
      value: degraded.has("citation-validity") ? "96.9%" : pct(report.metrics.citationValidity),
      delta: degraded.has("citation-validity")
        ? "FAIL"
        : report.metrics.citationValidity >= 0.98
          ? "PASS"
          : "FAIL",
      good: !degraded.has("citation-validity") && report.metrics.citationValidity >= 0.98,
      note: "门禁 ≥ 98%",
      simulated: degraded.has("citation-validity"),
      trend: trendSeries(history, (h) => (h.metrics ? h.metrics.citationValidity : null)),
    },
    {
      label: "P0 阻断缺陷",
      value: degraded.has("p0-defects") ? "1" : String(report.metrics.p0Defects),
      delta: degraded.has("p0-defects")
        ? "+1"
        : report.metrics.p0Defects === 0
          ? "0"
          : "+" + report.metrics.p0Defects,
      good: !degraded.has("p0-defects") && report.metrics.p0Defects === 0,
      note: "目标 = 0",
      simulated: degraded.has("p0-defects"),
      trend: trendSeries(history, (h) => (h.metrics ? h.metrics.p0Defects : null)),
    },
  ];

  return (
    <main className="operations-page page-surface">
      <header className="page-heading ops-heading">
        <div>
          <span className="eyebrow">NOVABENCH / RELEASE CONTROL</span>
          <h1>业务可以慢一点，安全门禁不能松。</h1>
          <p>下方数字来自真实 NovaBench 金标评测（{report.total} 条），任一门禁退化，真实流量自动停止。</p>
        </div>
        <div className={"release-state " + (blocked ? "blocked" : "")}>
          {blocked ? <Siren size={18} /> : <ShieldCheck size={18} />}
          <div>
            <strong>{blocked ? "灰度已停止" : report.maxTrafficPercent + "% 灰度运行中"}</strong>
            <small>{viewingAt ? "历史回看 · " + fmtTime(viewingAt) : "影子 → 专家内测 → 邀请客户"}</small>
          </div>
        </div>
      </header>

      <section className="metric-grid">
        {metricCards.map((metric, index) => (
          <article key={metric.label} className="metric-card">
            <div className="metric-label"><span>0{index + 1}</span>{metric.label}</div>
            <div className="metric-value">
              <strong>{metric.value}</strong>
              <em className={metric.good ? "" : "bad"}>
                {metric.good ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                {metric.delta}
              </em>
            </div>
            <p>{metric.note}{metric.simulated && <b className="sim-tag">模拟</b>}</p>
            {metric.trend ? (
              <div className="sparkline" aria-hidden="true">
                {metric.trend.map((height, barIndex) => (
                  <i key={barIndex} style={{ height: Math.max(4, Math.min(100, height * 100)) + "%" }} />
                ))}
              </div>
            ) : (
              <div className="sparkline-empty">运行 ≥ 2 次后出现真实趋势</div>
            )}
          </article>
        ))}
      </section>

      <section className="bench-history">
        <div className="panel-heading">
          <div><span className="eyebrow">RUN HISTORY</span><h2>运行历史</h2></div>
          <span className="candidate-id">与知识进化页共用同一份评测记录 · {history.length} 次</span>
        </div>
        {history.length === 0 ? (
          <p className="history-empty">暂无历史运行。</p>
        ) : (
          <ol className="history-strip">
            {history.map((h) => (
              <li key={h.createdAt}>
                <button
                  className={h.createdAt === viewingAt ? "active" : ""}
                  aria-current={h.createdAt === viewingAt ? "true" : undefined}
                  onClick={() => viewHistory(h.createdAt)}
                >
                  <span>{fmtTime(h.createdAt)}</span>
                  <strong>{pct(h.accuracy)}</strong>
                  <em className={h.decision === "proceed" ? "ok" : "stop"}>{h.decision === "proceed" ? "PASS" : "STOP"}</em>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="ops-grid">
        <section className="gate-board">
          <div className="panel-heading">
            <div><span className="eyebrow">SAFETY GATES</span><h2>发布门禁</h2></div>
            <div className="mode-toggle">
              <button className="run-bench" onClick={runBench} disabled={running}>
                {running ? <><Loader2 size={13} className="spin" /> 评测中…</> : <><Radar size={13} /> 运行 NovaBench</>}
              </button>
              {DEGRADE_OPTIONS.map((opt) => {
                const active = degraded.has(opt.key);
                return (
                  <button
                    key={opt.key}
                    className={"degrade-switch" + (active ? " active danger" : "")}
                    aria-pressed={active}
                    onClick={() => toggleDegrade(opt.key)}
                  >
                    {opt.shortLabel}
                  </button>
                );
              })}
            </div>
          </div>
          {viewingAt && (
            <p className="history-viewing">
              <History size={13} /> 正在回看 {fmtTime(viewingAt)} 的历史报告{" "}
              <button onClick={backToLatest}><RotateCcw size={12} /> 回到最新</button>
            </p>
          )}
          {error && <p className="ops-error" role="status" aria-live="polite"><CircleAlert size={13} /> {error}</p>}
          <div className="gate-list">
            {gates.map((gate) => (
              <div key={gate.key} className={gate.simulated ? "simulated" : ""}>
                <span className={gate.pass ? "gate-pass" : "gate-fail"}>
                  {gate.pass ? <Check size={12} /> : <CircleAlert size={12} />}
                </span>
                <strong>{gate.label}</strong>
                <em>{gate.value}</em>
                {gate.simulated && <b className="sim-tag">模拟</b>}
              </div>
            ))}
          </div>
          <div className={"gate-verdict " + (blocked ? "blocked" : "")}>
            {blocked ? <CircleAlert size={18} /> : <Gauge size={18} />}
            <div>
              <strong>{blocked ? "STOP · 禁止扩大真实流量" : "PROCEED · 当前可维持 " + report.maxTrafficPercent + "% 灰度"}</strong>
              <span>
                {blocked
                  ? gates.filter((g) => !g.pass).map((g) => g.label).join("、") + " 未达硬门禁，已生成质量事件。"
                  : "全部五项安全门禁通过 · 金标 " + report.passed + "/" + report.total + " 正确。"}
              </span>
            </div>
          </div>
          <div className="case-drilldown">
            <button className="case-toggle" aria-expanded={showCases} onClick={() => setShowCases((v) => !v)}>
              {showCases ? "收起金标明细" : "查看金标明细（" + report.cases.length + " 条）"}
            </button>
            {showCases && (
              <div className="case-table">
                <div className="case-head"><span>金标案例</span><span>预期</span><span>实际</span><span>结果</span><span>违规引用</span></div>
                {report.cases.map((c) => (
                  <div key={c.id} className={"case-row" + (c.correct ? "" : " fail")}>
                    <strong>{c.id}</strong>
                    <span>{c.expected}</span>
                    <span>{c.actual}</span>
                    <em>{c.correct ? "PASS" : "FAIL"}</em>
                    <small>{c.invalidCitations.length > 0 ? c.invalidCitations.join(" / ") : "—"}</small>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="quality-board">
          <div className="panel-heading">
            <div><span className="eyebrow">QUALITY EVENTS</span><h2>质量事件</h2></div>
            <span className="event-count">{openEvents.length} OPEN</span>
          </div>
          <div className="quality-list">
            {openEvents.length === 0 ? (
              <article className="quality-clear">
                <span className="severity ok"><Check size={12} /></span>
                <div>
                  <strong>无未关闭质量事件</strong>
                  <span>全部安全门禁通过，无需人工介入。</span>
                </div>
              </article>
            ) : (
              openEvents.map((event) => (
                <article key={event.id} className="event-open">
                  <span className="severity p1">P1</span>
                  <div>
                    <strong>门禁退化 · {event.label}</strong>
                    <span>{event.id} · {event.value}{event.simulated && <b className="sim-tag">模拟</b>}</span>
                  </div>
                  <div className="event-owner"><small>{event.owner}</small><em>OPEN</em></div>
                  <button
                    className="resolve-event"
                    onClick={() => {
                      setResolvingId(resolvingId === event.id ? null : event.id);
                      setCloseEvidence("");
                    }}
                  >
                    {resolvingId === event.id ? "取消" : "关闭事件"}
                  </button>
                  {resolvingId === event.id && (
                    <div className="resolve-form">
                      <textarea
                        aria-label="关闭证据"
                        placeholder="关闭证据（必填）：例如已恢复门禁并通过复测…"
                        value={closeEvidence}
                        onChange={(e) => setCloseEvidence(e.target.value)}
                      />
                      <button
                        className="primary-action"
                        disabled={busyEvent || closeEvidence.trim().length === 0}
                        onClick={() => resolveEvent(event.id)}
                      >
                        {busyEvent ? <><Loader2 size={13} className="spin" /> 提交中…</> : "提交关闭"}
                      </button>
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
          {resolvedEvents.length > 0 && (
            <div className="resolved-list">
              <div className="resolved-head">已关闭 · {resolvedEvents.length}</div>
              {resolvedEvents.map((event) => (
                <article key={event.id}>
                  <span className="severity ok"><Check size={12} /></span>
                  <div>
                    <strong>{event.label}</strong>
                    <span>关闭证据：{event.evidence}{event.resolvedAt ? " · " + fmtTime(event.resolvedAt) : ""}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
          <button className="board-link" aria-expanded={showEvidence} onClick={() => setShowEvidence((v) => !v)}>
            <Activity size={14} /> {showEvidence ? "收起责任人与关闭证据" : "查看责任人与关闭证据"}{" "}
            <ArrowUpRight size={14} />
          </button>
          {showEvidence && (
            <div className="evidence-drawer">
              {gates.map((gate) => (
                <div key={gate.key} className={"evidence-item " + (gate.pass ? "pass" : "fail")}>
                  <div className="evidence-item-head">
                    <span className={gate.pass ? "gate-pass" : "gate-fail"}>
                      {gate.pass ? <Check size={11} /> : <CircleAlert size={11} />}
                    </span>
                    <strong>{gate.label}</strong>
                    <em>{gate.value}</em>
                  </div>
                  <small>责任人：{gate.owner}</small>
                  <small>关闭证据：{gate.evidence}</small>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* 命题要求(5)效果评估:业务 KPI 预期(竞赛目标区间,上线前经基线校准) */}
      <section className="kpi-board">
        <div className="panel-heading">
          <div><span className="eyebrow">BUSINESS KPI TARGETS</span><h2>业务指标预期</h2></div>
          <span className="candidate-id">竞赛目标区间 · 上线前经基线测量与试点校准</span>
        </div>
        <div className="kpi-grid">
          {[
            ["AI 安全自助解决率", "55–65%", "12 个月挑战 70%"],
            ["首次响应时间", "缩短 ≥90%", "相对人工基线"],
            ["人工平均处理时长", "下降 35–45%", "专家效率提升"],
            ["七日内重复开单率", "下降 ≥25%", "一次性解决"],
            ["引用有效率", "≥98%", "硬门禁"],
            ["高风险转接召回率", "≥95%", "硬门禁"],
            ["客户满意度", "+8–12 pp", "评分 / NPS"],
            ["新客户有效触达", "增长 30–50%", "AI 入口贡献"],
          ].map(([label, value, note]) => (
            <article className="kpi-card" key={label}>
              <span className="kpi-label">{label}</span>
              <strong className="kpi-value">{value}</strong>
              <small>{note}</small>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
