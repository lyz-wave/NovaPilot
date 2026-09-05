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

/**
 * 护栏对看板载荷(客户端镜像,与 server/telemetry/guardrail-board.ts 对齐)。
 *
 * 指标体系 v1.1 第 10 节的整张表在这里落成 UI:每个激励指标必须与它的护栏指标
 * 同框渲染。这不是排版偏好 —— 只有激励指标有数、护栏指标没数的看板,比没有看板
 * 更危险,因为它会让人以为自己在被约束。所以下面的 `PairRow` 结构里护栏侧是
 * 必填字段:想在这张板上加一个激励指标,就必须同时写出它的护栏。
 */
interface RateLike {
  reviewed: number;
  wrong: number;
  rate: number | null;
  pending: number;
}
interface LatencyStatsView {
  samples: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}
export interface GuardrailBoardView {
  since: string | null;
  sessions: {
    sessions: number;
    formal: number;
    expertReview: number;
    needsConditions: number;
    other: number;
  };
  directResolutionRate: number | null;
  interceptionRate: number | null;
  trustedResolutionRate: number | null;
  binding: {
    cards: number;
    citations: number;
    bound: number;
    bindingRate: number;
    violatingCards: number;
  };
  review: {
    falseInterception: RateLike;
    missedEscalation: RateLike;
    judgeAgreement: { compared: number; agreed: number; rate: number | null };
  };
  inflow: {
    closures: number;
    withCandidate: number;
    inflowRate: number;
    noCandidateReasons: Array<{ reason: string; count: number }>;
  };
  adoption: {
    cards: number;
    adoptedCards: number;
    adoptionRate: number;
    events: number;
    byAction: { copy: number; export: number; sync: number };
  };
  latency: { overall: LatencyStatsView; byStatus: Array<{ status: string; stats: LatencyStatsView }> };
  knowledge: {
    documents: number;
    chunks: number;
    rolledBackRuns: number;
    candidatesApproved: number;
    candidatesPending: number;
    documentsTotal: number;
    chunksTotal: number;
  };
  feedback: { total: number; negative: number; negativeRate: number | null };
  /**
   * 检索侧(指标体系 §6)。分母是**检索轮次**而不是会话 —— 一次咨询最多三轮
   * 加深检索,按会话算会把回退率稀释到看不见。
   */
  retrieval: {
    channels: {
      rounds: number;
      fts: number;
      fallback: number;
      fallbackReasons: Array<{ reason: string; rounds: number }>;
      shortQueryRate: number | null;
    };
    vectorSpaces: {
      rounds: number;
      semantic: number;
      hash: number;
      semanticRate: number | null;
      reasons: Array<{ reason: string; rounds: number }>;
    };
    elapsed: { rounds: number; p50: number | null; p95: number | null; max: number | null };
    sopCoverage: { total: number; covered: number; rate: number | null };
    neverHit: Array<{ documentId: string; title: string; source: string }>;
    blindSpots: Array<{ topic: string; sessions: number; sampleQuery: string; lastAt: string }>;
  };
  p0: string[];
  p1: string[];
  /** P2 · 一周内处理(第 11 节)。样本不足时为空 —— 小样本告警会被训练成噪声。 */
  p2: string[];
  pendingReview: number;
}

const AUTH = "Bearer demo-research-session";const WRITE_HEADERS = {
  authorization: AUTH,
  "content-type": "application/json",
  "x-tenant-id": "novapilot-demo",
  "x-idempotency-key": "",
  "if-match": '"v3"',
};

const pct = (value: number) => (value * 100).toFixed(1) + "%";
/**
 * 可空率的渲染。null → 「—」,不是 0%。
 *
 * 一个写着 0% 误拦率的空队列会让人以为系统已经被验证过了。这一个字符的差别
 * 是「这项还没人验证」和「验证过,没问题」之间的全部差别。
 */
const pctOrDash = (value: number | null) => (value == null ? "—" : pct(value));
const msOrDash = (value: number | null) => (value == null ? "—" : Math.round(value) + " ms");
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });

/** 护栏对的一行。护栏侧是必填 —— 结构上不允许一个激励指标单独出现在板上。 */
interface PairRow {
  /** 激励指标名 */
  incentive: string;
  /** 激励指标当前值 */
  incentiveValue: string;
  /** 第 10 节原文的「游戏化路径」:不写出来,读数的人就不知道该防什么。 */
  gaming: string;
  /** 护栏指标名(可为「A + B」的复合护栏) */
  guardrail: string;
  /** 护栏指标当前值 */
  guardrailValue: string;
  /** 第 10 节原文的「判定」 */
  verdict: string;
  /** 护栏状态:breach 破口 / watch 欠观测 / ok 成对有数且未破 */
  state: "breach" | "watch" | "ok";
  /** 样本量说明。看板上必须写:样本量不明的率不能当结论用。 */
  basis: string;
}

/**
 * 第 10 节六对护栏,逐行构造。
 *
 * 顺序与文档表格一致,方便对照核验。`state` 的判定规则:
 *  - breach:护栏指标已破口(有数且超阈/非零)
 *  - watch:护栏指标没有样本(rate === null)—— 激励指标的数此刻不该被当成结论
 *  - ok:成对有数且未破
 */
interface RetrievalRow {
  metric: string;
  basis: string;
  value: string;
  reading: string;
}

/**
 * 检索侧四项 + 两项通道口径,逐行构造。
 *
 * 每行都写清楚**分母是什么**:这一段的分母是检索轮次,和护栏对那张表的会话
 * 分母不同。没有样本一律显示 —— 与全板一致,「没测过」不能长得像「测过没问题」。
 */
function retrievalRows(r: GuardrailBoardView["retrieval"]): RetrievalRow[] {
  const fallbackDetail = r.channels.fallbackReasons.length
    ? r.channels.fallbackReasons.map((x) => `${x.reason}×${x.rounds}`).join("、")
    : "无回退";
  return [
    {
      metric: "短查询回退触发率",
      basis: `fallbackReason = short-query 的轮次 / ${r.channels.rounds} 轮`,
      value: pctOrDash(r.channels.shortQueryRate),
      reading: "trigram 索引查不到 <3 字词元，回退全量扫描；持续偏高说明召回结构性变差",
    },
    {
      metric: "回退通道分布",
      basis: `FTS ${r.channels.fts} 轮 / 回退 ${r.channels.fallback} 轮`,
      value: fallbackDetail,
      reading: "「候选不足」和「查询太短」是两种病，合并计数就没法对症",
    },
    {
      metric: "语义向量空间占比",
      basis: `semantic ${r.vectorSpaces.semantic} / hash ${r.vectorSpaces.hash} 轮`,
      value: pctOrDash(r.vectorSpaces.semanticRate),
      reading:
        r.vectorSpaces.reasons.length > 0
          ? "降级原因：" + r.vectorSpaces.reasons.map((x) => `${x.reason}×${x.rounds}`).join("、")
          : "语义模型缺失时整体降级到哈希向量，功能不断但召回下降",
    },
    {
      metric: "SOP 覆盖率",
      basis: `被命中过的 SOP ${r.sopCoverage.covered} / 库内 SOP ${r.sopCoverage.total} 篇`,
      value: pctOrDash(r.sopCoverage.rate),
      reading: "分母是知识库存量，不是检索轮次；从未命中的篇目要么冗余要么召回偏窄",
    },
    {
      metric: "知识盲区主题数",
      basis: "末轮检索证据零核验的会话，按 scope hint 归组",
      value: String(r.blindSpots.length),
      reading: "不用检索分值判定：rerank 在查询内部做了归一化，拿它设阈值恒为真",
    },
    {
      metric: "检索段耗时 P95",
      basis: `最近邻分位，不插值 · ${r.elapsed.rounds} 轮样本`,
      value: msOrDash(r.elapsed.p95),
      reading: "只覆盖检索一段，不能冒充端到端 P95",
    },
  ];
}

function guardrailPairs(board: GuardrailBoardView, report: GateReport): PairRow[] {
  const r = board.review;
  const defenceStructure =
    `formal ${board.sessions.formal} / 转专家 ${board.sessions.expertReview} / ` +
    `待澄清 ${board.sessions.needsConditions}`;
  return [
    {
      incentive: "直接解决率",
      incentiveValue: pctOrDash(board.directResolutionRate),
      gaming: "硬答不该答的",
      guardrail: "该转未转率",
      guardrailValue: pctOrDash(r.missedEscalation.rate),
      verdict: "任一超阈即冻结「解决率」评比",
      state:
        r.missedEscalation.rate == null
          ? "watch"
          : r.missedEscalation.rate > 0.05
            ? "breach"
            : "ok",
      basis: `复核 ${r.missedEscalation.reviewed} 条 / 待复核 ${r.missedEscalation.pending} 条`,
    },
    {
      incentive: "Critic 拦截率",
      incentiveValue: pctOrDash(board.interceptionRate),
      gaming: "宁可全拦",
      guardrail: "误拦截率",
      guardrailValue: pctOrDash(r.falseInterception.rate),
      verdict: "成对观察，不设单向 KPI",
      state:
        r.falseInterception.rate == null
          ? "watch"
          : r.falseInterception.rate > 0.1
            ? "breach"
            : "ok",
      basis: `复核 ${r.falseInterception.reviewed} 条 / 待复核 ${r.falseInterception.pending} 条`,
    },
    {
      incentive: "可信解决率",
      incentiveValue: pctOrDash(board.trustedResolutionRate),
      gaming: "放松防线",
      guardrail: "漏放率（幻觉样例穿防）",
      guardrailValue:
        board.binding.cards === 0 ? "—" : board.binding.violatingCards + " 张破口卡",
      verdict: "漏放 > 0 即 P0",
      state:
        board.binding.cards === 0
          ? "watch"
          : board.binding.violatingCards > 0
            ? "breach"
            : "ok",
      basis: `审计 ${board.binding.cards} 张卡 / ${board.binding.citations} 个引用号，绑定率 ${pct(board.binding.bindingRate)}`,
    },
    {
      incentive: "知识入库量",
      // 「本周新增」和「全库累计」必须同时给:单看 +0 会被读成「知识库空了」。
      incentiveValue: `本周 +${board.knowledge.documents} 篇`,
      gaming: "灌水入库",
      guardrail: "金标回归通过率 + 引用核实合规率",
      guardrailValue: `${pct(report.accuracy)} / ${pct(board.binding.bindingRate)}`,
      verdict: "门禁制，非 KPI",
      state: report.accuracy >= 0.9 && board.binding.bindingRate >= 1 ? "ok" : "breach",
      basis:
        `全库 ${board.knowledge.documentsTotal} 篇 / ${board.knowledge.chunksTotal} 段 · ` +
        `本周门禁回滚 ${board.knowledge.rolledBackRuns} 批 · ` +
        `候选已批 ${board.knowledge.candidatesApproved} 条、待审 ${board.knowledge.candidatesPending} 条 · ` +
        `NovaBench ${report.passed}/${report.total}`,
    },
    {
      incentive: "P95 延迟",
      incentiveValue: msOrDash(board.latency.overall.p95),
      gaming: "省防线 / 降模型",
      guardrail: "防线通过率结构 + NovaBench 得分",
      guardrailValue: `${defenceStructure} · ${pct(report.accuracy)}`,
      verdict: "优化延迟不得以防线为代价",
      state:
        board.latency.overall.samples === 0
          ? "watch"
          : report.accuracy >= 0.9
            ? "ok"
            : "breach",
      basis:
        board.latency.overall.samples === 0
          ? "尚无延迟样本（发起一次咨询即开始采样）"
          : `${board.latency.overall.samples} 条样本 · P50 ${msOrDash(board.latency.overall.p50)}`,
    },
    {
      incentive: "用户负反馈率",
      incentiveValue: pctOrDash(board.feedback.negativeRate),
      gaming: "负向选择偏误致系统性高估不满",
      guardrail: "隐式采纳率",
      guardrailValue:
        board.adoption.cards === 0 ? "—" : pct(board.adoption.adoptionRate),
      verdict: "成对解读，不单独设 KPI",
      state: board.adoption.cards === 0 ? "watch" : "ok",
      basis:
        `显式反馈 ${board.feedback.total} 条 · 采纳 ${board.adoption.adoptedCards}/${board.adoption.cards} 张卡` +
        `（复制 ${board.adoption.byAction.copy} / 导出 ${board.adoption.byAction.export} / 同步 ${board.adoption.byAction.sync}）`,
    },
  ];
}

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
  guardrail,
}: {
  initialReport: GateReport;
  initialHistory: BenchHistoryEntry[];
  initialEvents: QualityEvent[];
  guardrail: GuardrailBoardView;
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
  const pairs = useMemo(() => guardrailPairs(guardrail, report), [guardrail, report]);

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

      {/* ══ 指标体系 v1.1 第 10 节:护栏对看板 ═══════════════════════════
          每个激励指标与它的护栏指标同框。上面那一排 metric-card 是门禁快照,
          这一段才是「这些数字可不可以当结论用」的判定依据。 */}
      <section className="guardrail-board">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">GUARDRAIL PAIRS · 指标体系 v1.1 §10</span>
            <h2>激励指标与护栏指标成对</h2>
          </div>
          <span className="candidate-id">
            {guardrail.since ? "本自然周 · " + guardrail.since.slice(0, 10) : "全量窗口"} ·
            会话 {guardrail.sessions.sessions} 次
          </span>
        </div>

        <p className="guardrail-intro">
          单独看激励指标可以被优化出好看的数字，所以这张板上没有任何一个激励指标是单独出现的。
          护栏侧显示 <b>—</b> 表示该护栏还没有样本 —— 此时左边那个数<b>不能当结论用</b>。
        </p>

        {guardrail.p0.length > 0 && (
          <div className="guardrail-alert p0">
            <Siren size={14} />
            <div>
              <strong>P0 · 质量事件 + 冻结发版（第 11 节）</strong>
              {guardrail.p0.map((r) => (
                <small key={r}>{r}</small>
              ))}
            </div>
          </div>
        )}
        {guardrail.p1.length > 0 && (
          <div className="guardrail-alert p1">
            <CircleAlert size={14} />
            <div>
              <strong>P1 · 纳入周会复盘（第 11 节）</strong>
              {guardrail.p1.map((r) => (
                <small key={r}>{r}</small>
              ))}
            </div>
          </div>
        )}
        {guardrail.pendingReview > 0 && (
          <div className="guardrail-alert watch">
            <Activity size={14} />
            <div>
              <strong>欠复核 {guardrail.pendingReview} 条</strong>
              <small>
                误拦截率 / 该转未转率的唯一真值来源是专家复核。队列积压时这两格显示 —— 而不是
                0%：还没人复核过，和复核了都对，是两件事。
              </small>
            </div>
          </div>
        )}

        <div className="pair-table" role="table" aria-label="激励指标与护栏指标对照">
          <div className="pair-row pair-head" role="row">
            <span role="columnheader">激励指标</span>
            <span role="columnheader">游戏化路径</span>
            <span role="columnheader">护栏指标</span>
            <span role="columnheader">判定</span>
          </div>
          {pairs.map((p) => (
            <div key={p.incentive} className={"pair-row state-" + p.state} role="row">
              <span className="pair-cell incentive" role="cell">
                <em>{p.incentive}</em>
                <strong>{p.incentiveValue}</strong>
              </span>
              <span className="pair-cell gaming" role="cell">
                <ArrowDownRight size={12} />
                {p.gaming}
              </span>
              <span className="pair-cell guardrail" role="cell">
                <em>
                  {p.state === "breach" ? (
                    <CircleAlert size={11} className="pair-icon breach" />
                  ) : p.state === "watch" ? (
                    <Activity size={11} className="pair-icon watch" />
                  ) : (
                    <Check size={11} className="pair-icon ok" />
                  )}
                  {p.guardrail}
                </em>
                <strong>{p.guardrailValue}</strong>
                <small>{p.basis}</small>
              </span>
              <span className="pair-cell verdict" role="cell">
                {p.verdict}
              </span>
            </div>
          ))}
        </div>

        <div className="pair-footnotes">
          <p>
            <b>隐式采纳率口径边界（第 4.4 节）：</b>
            复制也可能是「复制去质疑」，所以它<b>只做体验对冲指标，不进可信解决率计算链</b>。
            代码层面也是这样落的：可信解决率的分子只认独立引用审计，与 adoption_events 无关。
          </p>
          <p>
            <b>judge–专家一致率（第 5.1 节）：</b>
            {guardrail.review.judgeAgreement.rate == null
              ? "尚无两侧都判过的样本（judge 由离线任务 npm run review:judge 写入）。"
              : pct(guardrail.review.judgeAgreement.rate) +
                `（比对 ${guardrail.review.judgeAgreement.compared} 条）`}
            {" "}judge 只做预筛，终审权在专家；judge 判定一条都不进误拦截率与该转未转率。
          </p>
          <p>
            <b>修订回流率（埋点 C）：</b>
            {pct(guardrail.inflow.inflowRate)}（办结 {guardrail.inflow.closures} 单，产出候选{" "}
            {guardrail.inflow.withCandidate} 条）。
            {guardrail.inflow.noCandidateReasons.length > 0 && (
              <>
                {" "}未产出理由：
                {guardrail.inflow.noCandidateReasons
                  .map((x) => `${x.reason}×${x.count}`)
                  .join("、")}
                。回流率低本身不是问题，理由清一色是「没时间」才是问题。
              </>
            )}
          </p>
          {guardrail.latency.byStatus.length > 0 && (
            <p>
              <b>延迟按处置分组：</b>
              {guardrail.latency.byStatus
                .map(
                  (g) =>
                    `${g.status} P95 ${msOrDash(g.stats.p95)}（${g.stats.samples} 条）`,
                )
                .join(" · ")}
              。只看全局 P95 分不出「真的变快了」和「把该转专家的直接答掉了」。
            </p>
          )}
        </div>
      </section>

      {/* 检索侧口径(指标体系 §6)+ P2 告警路径(§11)。
          单开一段而不是并进护栏对表:这里的分母是**检索轮次**,护栏对那张表的
          分母是会话。两个分母混排在同一张表里,读表的人一定会横向比出错误结论。 */}
      <section className="guardrail-board retrieval-board">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">RETRIEVAL · 指标体系 v1.1 §6 / §11 P2</span>
            <h2>检索侧口径与知识盲区</h2>
          </div>
          <span className="candidate-id">
            检索轮次 {guardrail.retrieval.channels.rounds} 轮 · 一次咨询最多 3 轮
          </span>
        </div>

        <p className="guardrail-intro">
          这一段的分母是<b>检索轮次</b>，不是会话。数据来自 <code>retrieval_logs</code>：
          编排 checkpoint 的主键是 <code>(trace_id, node)</code>，三轮加深检索会互相覆盖，
          按轮次的回退率在那边取不出来。
        </p>

        {guardrail.p2.length > 0 && (
          <div className="guardrail-alert watch">
            <Activity size={14} />
            <div>
              <strong>P2 · 一周内处理（第 11 节）</strong>
              {guardrail.p2.map((r) => (
                <small key={r}>{r}</small>
              ))}
            </div>
          </div>
        )}

        <div className="pair-table" role="table" aria-label="检索侧口径">
          <div className="pair-row pair-head" role="row">
            <span role="columnheader">指标</span>
            <span role="columnheader">口径</span>
            <span role="columnheader">当前值</span>
            <span role="columnheader">读法</span>
          </div>
          {retrievalRows(guardrail.retrieval).map((r) => (
            <div key={r.metric} className="pair-row" role="row">
              <span className="pair-cell incentive" role="cell">
                <em>{r.metric}</em>
              </span>
              <span className="pair-cell gaming" role="cell">{r.basis}</span>
              <span className="pair-cell guardrail" role="cell">
                <strong>{r.value}</strong>
              </span>
              <span className="pair-cell verdict" role="cell">{r.reading}</span>
            </div>
          ))}
        </div>

        <div className="pair-footnotes">
          {guardrail.retrieval.blindSpots.length > 0 ? (
            <p>
              <b>知识盲区（{guardrail.retrieval.blindSpots.length} 个主题）：</b>
              {guardrail.retrieval.blindSpots
                .map((s) => `${s.topic}（${s.sessions} 次，例：${s.sampleQuery}）`)
                .join("；")}
              。口径是<b>末轮</b>检索出的证据一条都没撑住核验 —— 前几轮检索不到是设计意图
              （所以才加深），末轮还是零核验才叫盲区。
            </p>
          ) : (
            <p>
              <b>知识盲区：</b>暂无。注意这不等于「知识库很全」：判定只覆盖<b>已经有人问过</b>的
              主题，没人问过的空白区这张表看不见。
            </p>
          )}
          {guardrail.retrieval.neverHit.length > 0 && (
            <p>
              <b>从未被命中的文档（{guardrail.retrieval.neverHit.length} 篇）：</b>
              {guardrail.retrieval.neverHit.slice(0, 6).map((d) => d.documentId).join("、")}
              {guardrail.retrieval.neverHit.length > 6 && " …"}
              。要么是冗余知识，要么是检索召回面偏窄 —— 这两种病的处理方式相反，需要人来判。
            </p>
          )}
          <p>
            <b>检索耗时口径：</b>这里的 P95 只覆盖<b>检索这一段</b>，
            {guardrail.retrieval.elapsed.p95 == null
              ? "尚无样本。"
              : `当前 ${msOrDash(guardrail.retrieval.elapsed.p95)}。`}
            端到端 P95 在上一段护栏对里，两者不能互相顶替 —— 用检索耗时冒充端到端是偷换口径。
          </p>
        </div>
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
