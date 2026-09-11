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
import { DASHBOARD_METRIC_KEYS } from "../lib/dashboard-metric-keys";

/**
 * 本看板实际渲染的指标 key 清单，唯一来源在 `src/lib/dashboard-metric-keys.ts`。
 * 此处 re-export 保持既有 `from "@/components/operations-dashboard"` 的导入路径可用。
 * evidence-probes 用它判定「看板可见」——删格子而不删 key 会让 scorecard.test.ts 红，
 * 这正是想要的。
 */
export { DASHBOARD_METRIC_KEYS };
export type { DashboardMetricKey } from "../lib/dashboard-metric-keys";

// Client-safe mirror of the NovaBench release report (no server-eval imports).
interface GateMetrics {
  citationValidity: number;
  escalationRecall: number;
  confidentWrongDelta: number;
  p0Defects: number;
  dataBoundaryIncidents: number;
  /** 漏放数与分母。历史 run 无此字段 → undefined 表示未评测，不表示 0。 */
  hallucinationLeaks?: number;
  hallucinationTotal?: number;
  /**
   * Hit Rate@5（指标体系 v1.1 第 4 节）。
   * 历史 run 无此字段 → undefined 表示未采集，不表示 0。
   */
  hitRateAtK?: number | null;
  hitRateTotal?: number;
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
  hitAtK?: boolean | null;
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
      hitAtK?: boolean | null;
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
  latency: {
    overall: LatencyStatsView;
    byStatus: Array<{ status: string; stats: LatencyStatsView }>;
    /** 流式收场分布(§8)。分母是**开过的流**,不是跑完的流。 */
    stream: {
      streams: number;
      completed: number;
      aborted: number;
      failed: number;
      inflight: number;
      successRate: number | null;
    };
    /** 首 token P95 按 provider 分组(仅 NP_STREAM_TOKENS=true 时有非空行)。 */
    firstToken: Array<{ provider: string; stats: LatencyStatsView }>;
  };
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
    /** 语义聚类盲区（由 blindspot:clusters 脚本生成，文件不存在时为空）。 */
    blindspotClusters: Array<{ cluster: number; size: number; weeksUnhit: number; sampleQueries: string[] }>;
  };
  p0: string[];
  p1: string[];
  /** P2 · 一周内处理(第 11 节)。样本不足时为空 —— 小样本告警会被训练成噪声。 */
  p2: string[];
  pendingReview: number;
  /**
   * 流量与会话(§3)。分母是**当周有活动的会话**,含跨周被唤醒的存量会话 ——
   * 用「当周新建」当分母会把这些会话排除在外,而它们的解决又算进分子。
   */
  session: {
    volume: {
      active: number;
      created: number;
      effective: number;
      effectiveRate: number | null;
      excludedTestSessions: number;
    };
    lensMix: Array<{ role: string; sessions: number; share: number }>;
    roleActivity: Array<{ role: string; actions: number; source: string }>;
    wakeup: { closed: number; crossWeek: number; rate: number | null };
  };
  /** 专家协同(§6)与知识演化(§7)的周期口径。 */
  lifecycle: {
    expert: {
      cases: number;
      claim: SlaView;
      substantive: SlaView;
      byStatus: Array<{ status: string; count: number }>;
    };
    knowledge: {
      candidates: number;
      published: number;
      grayActive: number;
      timeToPublishHours: DurationView;
      publishRate: number | null;
      rolledBack: number;
      ingestRollbacks: number;
      grayWindowIncidents: number;
    };
  };
  /** 降级矩阵触发次数(§8「五开关各自触发次数」)。只追加,不去重。 */
  degrade: {
    gates: Array<{
      gateKey: string;
      label: string;
      triggers: number;
      console: number;
      runtime: number;
      deduped: number;
      lastAt: string | null;
    }>;
    triggers: number;
    runtimeTriggers: number;
  };
  /**
   * §5 三层防线各层通过率(规则校验 / 语义复核 / NovaGuard)。规则校验与
   * 语义复核是建议粒度,NovaGuard 是答案粒度 —— 三行分母不同,不能横向比。
   */
  defense: {
    layers: Array<{
      layer: "规则校验" | "语义复核" | "scope-contract" | "NovaGuard";
      measured: number;
      passed: number;
      rate: number | null;
    }>;
    traces: number;
  };
  /**
   * §7 引用核实合规率（硬性铁律）。口径是「入库文献（PMID/DOI）经官网核实并
   * 留痕的比例」—— 与 `binding`（证据绑定率，运行时防编造）是两个不同的指标,
   * 不能互相顶替：binding 答的是「这次出卡引用的证据在不在本轮检索集里」,
   * 这里答的是「入库文献的 PMID/DOI 有没有经官网核实」。
   */
  citationCompliance: {
    total: number;
    verified: number;
    rate: number | null;
    violations: Array<{ docId: string; citation: string; reason: string }>;
  };
  /** §4.3 Critic 拦截→解决转化率。分母是有至少一轮 blocked 的 trace 数。 */
  interceptResolution: {
    intercepted: number;
    resolved: number;
    rate: number | null;
  };
  /** §4.7 交接包完整度。分子是 defenseTrail 非空的转专家案例数。 */
  handoffCompleteness: {
    total: number;
    complete: number;
    rate: number | null;
  };
}

export interface DurationView {
  samples: number;
  p50: number | null;
  p90: number | null;
  max: number | null;
  mean: number | null;
}

export interface SlaView {
  measured: number;
  met: number;
  rate: number | null;
  /** 未走到这一步的案子。既不进分子也不进分母 —— 见 lifecycle.ts 的口径注释。 */
  pending: number;
  duration: DurationView;
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
/** 咨询者视角的中文名。未记录单独成档,不并进四档里。 */
const LENS_LABEL: Record<string, string> = {
  pi: "PI",
  postdoc: "博士后",
  student: "研究生",
  rnd: "企业研发",
  未记录: "未记录",
};

const hoursOrDash = (value: number | null) =>
  value == null ? "—" : value < 1 ? `${Math.round(value * 60)} 分钟` : `${value.toFixed(1)} 小时`;
const minutesOrDash = (value: number | null) =>
  value == null ? "—" : value < 60 ? `${Math.round(value)} 分钟` : `${(value / 60).toFixed(1)} 小时`;

/**
 * §3 / §6 / §7 三节逐行构造。
 *
 * 与检索那张表一样,每行都写清楚分母是什么 —— 这一段里同时存在会话、工单、
 * 候选三种分母,不写明的话横向读一定读错。
 */
function lifecycleRows(g: GuardrailBoardView): RetrievalRow[] {
  const s = g.session;
  const e = g.lifecycle.expert;
  const k = g.lifecycle.knowledge;
  return [
    {
      metric: "周会话总量",
      basis: "当周有活动的会话（含跨周唤醒），剔除测试账号",
      value: `${s.volume.active} 个`,
      reading:
        s.volume.active === 0
          ? "本周尚无活动会话。"
          : `其中新建 ${s.volume.created} 个，被唤醒的存量会话 ${Math.max(0, s.volume.active - s.volume.created)} 个。`,
    },
    {
      metric: "有效会话占比",
      basis: "用户消息 ≥2 轮且非空 / 当周活动会话",
      value: pctOrDash(s.volume.effectiveRate),
      reading:
        s.volume.effectiveRate == null
          ? "无样本。判据只数用户消息 —— 助手的回复撑不起「有效」。"
          : `${s.volume.effective}/${s.volume.active}。一问一答就走的会话不算有效。`,
    },
    {
      metric: "跨周唤醒会话占比",
      basis: "本窗口前建、本窗口内闭环 / 当周闭环会话",
      value: pctOrDash(s.wakeup.rate),
      reading:
        s.wakeup.rate == null
          ? "尚无闭环会话。闭环判据是产出正式卡，再次提问会自动解除闭环。"
          : `${s.wakeup.crossWeek}/${s.wakeup.closed}。持续走高说明追问-补充链路过长（§11 P2）。`,
    },
    {
      metric: "30 分钟认领率",
      basis: "认领耗时 ≤ 案子自身 sla.claimMinutes / 已认领工单",
      value: pctOrDash(e.claim.rate),
      reading:
        e.claim.rate == null
          ? `无已认领工单（待认领 ${e.claim.pending} 单）。`
          : `${e.claim.met}/${e.claim.measured}，P50 ${minutesOrDash(e.claim.duration.p50)} · P90 ${minutesOrDash(e.claim.duration.p90)}。`,
    },
    {
      metric: "4 小时实质响应率",
      basis: "办结耗时 ≤ sla.substantiveResponseHours / 已办结工单",
      value: pctOrDash(e.substantive.rate),
      reading:
        e.substantive.rate == null
          ? `无已办结工单（在办 ${e.substantive.pending} 单）。`
          : `${e.substantive.met}/${e.substantive.measured}，P50 ${minutesOrDash(e.substantive.duration.p50)} · 最长 ${minutesOrDash(e.substantive.duration.max)}。办结时刻只写一次，退回重办不重置时钟。`,
    },
    {
      metric: "候选 → 灰度生效周期",
      basis: "首次 gray-active 时刻 − 建候选时刻",
      value: hoursOrDash(k.timeToPublishHours.p50),
      reading:
        k.timeToPublishHours.samples === 0
          ? `尚无候选上线（当前候选 ${k.candidates} 条）。`
          : `P50 ${hoursOrDash(k.timeToPublishHours.p50)} · P90 ${hoursOrDash(k.timeToPublishHours.p90)}，样本 ${k.timeToPublishHours.samples} 条。`,
    },
    {
      metric: "候选上线率",
      basis: "曾上线候选 / 窗口内候选总数",
      value: pctOrDash(k.publishRate),
      reading:
        k.publishRate == null
          ? "窗口内无候选。"
          : `${k.published}/${k.candidates} 曾上线，当前在灰度 ${k.grayActive} 条。回滚不减分子 —— 那次发布真实发生过。`,
    },
    {
      metric: "流式会话成功率",
      basis: "completed / 开过的流（§8）",
      value: pctOrDash(g.latency.stream.successRate),
      reading:
        g.latency.stream.streams === 0
          ? "本窗口无流式会话。"
          : `中断 ${g.latency.stream.aborted} · 失败 ${g.latency.stream.failed} · 仍在途 ${g.latency.stream.inflight}。分母是开流那一刻落的行，不是跑完的流 —— 否则成功率恒为 100%。`,
    },
  ];
}

/**
 * §5 三层防线通过率逐行构造。
 *
 * 规则校验、语义复核算的是**建议粒度**(一次咨询里的候选建议各自过关或
 * 被拦);NovaGuard 算的是**答案粒度**(这张卡最终放不放行)。三行分母不
 * 同,横向比百分比没有意义,各自只跟自己的历史值比才有意义 —— basis 列
 * 把分母写清楚就是为了防止这种误读。
 */
function defenseLayerRows(g: GuardrailBoardView): RetrievalRow[] {
  const basisByLayer: Record<string, string> = {
    规则校验: "引用有效且在适用范围内的建议 / Critic 过手的建议数",
    语义复核: "语义复核判定证据支撑结论的建议 / 规则校验放行的建议数",
    "scope-contract": "scope-contract check 单独通过的答案 / 做出最终判定的答案数",
    NovaGuard: "四项 checks 全部合规的答案 / 做出最终判定的答案数",
  };
  return g.defense.layers.map((l) => ({
    metric: l.layer,
    basis: basisByLayer[l.layer] ?? "",
    value: pctOrDash(l.rate),
    reading: l.rate == null ? "无样本。" : `${l.passed}/${l.measured}。`,
  }));
}

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
      basis: r.blindspotClusters.length > 0
        ? "语义聚类口径：连续 ≥2 周未命中 + ≥3 次的簇数（npm run blindspot:clusters）"
        : "末轮检索证据零核验的会话，按 scope hint 归组（运行 blindspot:clusters 升级为语义聚类口径）",
      value: r.blindspotClusters.length > 0
        ? String(r.blindspotClusters.filter((c) => c.weeksUnhit >= 2).length)
        : String(r.blindSpots.length),
      reading: r.blindspotClusters.length > 0
        ? `聚类阈值 0.75 · 全部 ${r.blindspotClusters.length} 个有效簇`
        : "不用检索分值判定：rerank 在查询内部做了归一化，拿它设阈值恒为真",
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
      guardrailValue: `${pct(report.accuracy)} / ${pctOrDash(board.citationCompliance.rate)}`,
      verdict: "门禁制，非 KPI",
      state:
        report.accuracy < 0.9
          ? "breach"
          : board.citationCompliance.rate == null
            ? "watch"
            : board.citationCompliance.rate >= 1
              ? "ok"
              : "breach",
      basis:
        `全库 ${board.knowledge.documentsTotal} 篇 / ${board.knowledge.chunksTotal} 段 · ` +
        `本周门禁回滚 ${board.knowledge.rolledBackRuns} 批 · ` +
        `候选已批 ${board.knowledge.candidatesApproved} 条、待审 ${board.knowledge.candidatesPending} 条 · ` +
        `NovaBench ${report.passed}/${report.total} · ` +
        `文献 ${board.citationCompliance.verified}/${board.citationCompliance.total} 经官网核实`,
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

/** 从真实指标推导七道门禁(五道可注入硬门禁 + 幻觉漏放 + NovaGuard 聚合);degraded 仅前端注入。 */
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
  // 漏放率(指标体系 v1.1 第 5 节)。**不做退化注入开关** —— 它的值来自一次真实的
  // 对抗子集运行,伪造一个漏放数就失去了这道门禁的全部意义。
  // 展示上分子分母必须同格显示:「0 / 8」。第 13-5 条反思项明确警告过,库太小的时候
  // 单独一个 0 是假安全,所以这里刻意不给「0%」这种把分母藏起来的写法。
  const hlTotal = m.hallucinationTotal;
  const hlLeaks = m.hallucinationLeaks;
  const hlMeasured = hlTotal != null && hlTotal > 0 && hlLeaks != null;
  gates.push({
    key: "hallucination-leak",
    label: "幻觉漏放(对抗子集)",
    // 未评测时显示「—」而不是 0:历史 run 里没有这个字段,把缺失渲染成 0
    // 等于把假安全写进趋势。
    value: hlMeasured ? `${hlLeaks} / ${hlTotal}` : "—",
    pass: hlMeasured ? hlLeaks === 0 : true,
    owner: "可信控制层 · NovaGuard",
    evidence: hlMeasured
      ? `必须为 0：${hlTotal} 条对抗样例(库外领域 / 虚构引用 / 未载明数值 / 用途越界)全部未被自信放行。N=${hlTotal} 偏小,该 0 值只覆盖已建样例,不构成整体安全证明。`
      : "该次运行早于本门禁上线，未采集漏放数据（缺失按未评测显示，不按 0 计）。",
    simulated: false,
  });
  gates.push({
    key: "nova-guard",
    label: "NovaGuard 可信控制",
    value: "evidence-bound / risk-tier / scope-contract / write-contract",
    pass: gates.every((g) => g.pass),
    owner: "可信控制层 · NovaGuard",
    evidence:
      "聚合门禁：引用白名单(有据才答)、风险分级审批(该转就转)、适用范围契约(物种/检测类型/能力边界越界即转专家)、写契约(401/403/412/428)。任一子门禁失守即拦截上线。",
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
                hitAtK: c.hitAtK,
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
    {
      label: "Hit Rate@5",
      // hitRateAtK 与 hitRateTotal 是新字段,历史 run 可能没有 → 渲染「—」而非 0%
      value:
        report.metrics.hitRateAtK == null
          ? "—"
          : pct(report.metrics.hitRateAtK),
      delta:
        report.metrics.hitRateTotal == null
          ? "N/A"
          : String(report.cases.filter((c) => c.hitAtK === true).length) +
            "/" +
            String(report.metrics.hitRateTotal),
      good: report.metrics.hitRateAtK == null ? true : report.metrics.hitRateAtK >= 0.8,
      note: "期望文档在前 5 条检索结果内",
      simulated: false,
      trend: trendSeries(history, (h) =>
        h.metrics?.hitRateAtK != null ? h.metrics.hitRateAtK : null,
      ),
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
            <b>引用核实合规率 ≠ 证据绑定率：</b>
            {guardrail.citationCompliance.total === 0
              ? "库内暂无 SCI 文献（PMID/DOI），这一格没有分母。"
              : `${guardrail.citationCompliance.verified}/${guardrail.citationCompliance.total} 篇文献已经官网核实并留痕（npm run kb:verify-citations，见 data/knowledge/citation-provenance.json）。`}
            这一格答的是「入库文献的 PMID/DOI 有没有经官网核实」，与前面 <b>可信解决率</b> 一行的
            证据绑定率（答「出卡引用是否在本轮检索集内」，防运行时编造）是两个不同的指标，
            此前曾被前者的数字借用充数，这里已改回各自的真实口径。
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
          {guardrail.latency.firstToken.length > 0 && (
            <p>
              <b>首 token P95（按 provider）：</b>
              {guardrail.latency.firstToken
                .map((g) => `${g.provider} ${msOrDash(g.stats.p95)}（${g.stats.samples} 条）`)
                .join(" · ")}
              。首 token 延迟需 NP_STREAM_TOKENS=true 才采集；无数据时本行不显示。
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
          {guardrail.retrieval.blindspotClusters.length > 0 ? (
            <p>
              <b>语义聚类盲区（{guardrail.retrieval.blindspotClusters.length} 簇，阈值 0.75）：</b>
              {guardrail.retrieval.blindspotClusters
                .filter((c) => c.weeksUnhit >= 2)
                .slice(0, 5)
                .map((c) => `簇 ${c.cluster}（${c.size} 次 · 连续 ${c.weeksUnhit} 周未命中 · 例：${c.sampleQueries[0] ?? ""}）`)
                .join("；")}
              。口径：连续 ≥2 周且 ≥3 次；聚类由 <code>npm run blindspot:clusters</code> 离线生成。
            </p>
          ) : guardrail.retrieval.blindSpots.length > 0 ? (
            <p>
              <b>知识盲区（{guardrail.retrieval.blindSpots.length} 个主题）：</b>
              {guardrail.retrieval.blindSpots
                .map((s) => `${s.topic}（${s.sessions} 次，例：${s.sampleQuery}）`)
                .join("；")}
              。口径是<b>末轮</b>检索出的证据一条都没撑住核验 —— 前几轮检索不到是设计意图
              （所以才加深），末轮还是零核验才叫盲区。运行 <code>npm run blindspot:clusters</code> 升级为语义聚类口径。
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

      {/* 流量与会话(§3)+ 专家协同(§6)+ 知识演化(§7)。
          这三节此前一格数据都没有,不是因为没做聚合,是因为**表里没有列** ——
          会话没有角色和闭环时刻,工单没有办结时刻,候选没有上线时刻。
          v9 迁移把五个时刻/枚举列补齐,这一段是它们的第一次出数。 */}
      <section className="guardrail-board lifecycle-board">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">LIFECYCLE · 指标体系 v1.1 §3 / §6 / §7</span>
            <h2>流量、协同与知识演化周期</h2>
          </div>
          <span className="candidate-id">
            当周活动会话 {guardrail.session.volume.active} 个 · 专家工单{" "}
            {guardrail.lifecycle.expert.cases} 单
          </span>
        </div>

        <p className="guardrail-intro">
          这一段的分母是<b>当周有活动的会话</b>（含跨周被唤醒的存量会话），不是当周新建的会话。
          后者会把被唤醒的老会话排除在分母外，而它们的解决又算进分子 —— 解决率就虚高了。
          时长一律用 <b>nearest-rank 分位</b>，不用平均：一两条拖了三天的疑难案例会把均值拉到没法看。
        </p>

        <div className="pair-table" role="table" aria-label="流量与会话">
          <div className="pair-row pair-head" role="row">
            <span role="columnheader">指标</span>
            <span role="columnheader">口径</span>
            <span role="columnheader">当前值</span>
            <span role="columnheader">读法</span>
          </div>
          {lifecycleRows(guardrail).map((r) => (
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
          <p>
            <b>两份「角色」不是同一个口径，不能加总：</b>
            咨询者视角分布（
            {guardrail.session.lensMix.length === 0
              ? "暂无数据"
              : guardrail.session.lensMix
                  .map((r) => `${LENS_LABEL[r.role] ?? r.role} ${r.sessions}（${pct(r.share)}）`)
                  .join("、")}
            ）数的是<b>会话</b>，是用户在工作台自己选的身份，四档都落在「咨询者」这一个系统角色内部；
            系统四角色（
            {guardrail.session.roleActivity
              .map((r) => `${r.role} ${r.actions}`)
              .join("、")}
            ）数的是<b>动作</b>，来自各自的表（{guardrail.session.roleActivity
              .map((r) => r.source)
              .join(" / ")}），因为只有咨询者会产生会话行。
            单位不同，把两张表并起来算占比一定错。
          </p>
          <p>
            <b>灰度期问题率的归因边界：</b>
            <code>quality_events</code> 记的是 <code>project_id</code>，没有候选 id，
            所以这里用「最早的灰度窗口左端」当下界统计窗口内新增事件（当前{" "}
            {guardrail.lifecycle.knowledge.grayWindowIncidents} 起），
            <b>不</b>逐个候选归因 —— 那样做出来的归因是编的。
          </p>
          <p>
            <b>「候选 → 灰度生效周期」不是「候选 → 全量周期」：</b>
            本系统里 <code>gray-active</code> 就是终态的生产可用状态，没有单独的「全量」状态。
            文档第 7 节写的是全量周期，这里如实按灰度生效出数，不冒充。
            回滚 {guardrail.lifecycle.knowledge.rolledBack} 条（曾上线、现已退出灰度）与
            入库门禁整批回滚 {guardrail.lifecycle.knowledge.ingestRollbacks} 次是两件事，分列不合并。
          </p>
          <p>
            <b>SLA 的「待办」既不进分子也不进分母：</b>
            未认领 {guardrail.lifecycle.expert.claim.pending} 单、未办结{" "}
            {guardrail.lifecycle.expert.substantive.pending} 单。
            算进分母等于说「还没到期就算违约」，算进分子等于说「没办的都合规」——
            两种都会让这一格失真，所以它自己占一格。
            阈值取自每个案子自己的 <code>sla</code>，不是全局常量。
          </p>
          {guardrail.session.volume.excludedTestSessions > 0 && (
            <p>
              <b>已剔除测试账号会话 {guardrail.session.volume.excludedTestSessions} 个</b>
              （租户 id 以 <code>test-</code> 开头）。剔除量必须显示出来 ——
              否则分母是怎么变小的没有人知道。<code>novapilot-demo</code> 不算测试账号：
              它产生的是真实的完整链路会话。
            </p>
          )}
          <p>
            <b>降级矩阵触发次数（§8 五开关）：</b>
            {guardrail.degrade.gates
              .map((g) => `${g.label} ${g.triggers}${g.runtime > 0 ? `（真实 ${g.runtime}）` : ""}`)
              .join("、")}
            。本窗口共 {guardrail.degrade.triggers} 次，其中系统自身降级{" "}
            {guardrail.degrade.runtimeTriggers} 次、运营台演练{" "}
            {guardrail.degrade.triggers - guardrail.degrade.runtimeTriggers} 次。
            <b>这个数不等于未闭质量事件数</b>：开事件是按闸门去重的，
            一道反复抖动的闸门只会挂一条待办。触发次数看抖动频次，未闭事件数看待办积压，
            两者不能互相顶替。检索侧的两个环境开关（<code>NP_DISABLE_FTS</code> /{" "}
            <code>NP_DISABLE_SEMANTIC</code>）不在这五开关里，它们按<b>检索轮次</b>
            记在上一段，单位不同，不能加总。
          </p>
        </div>
      </section>

      <section className="guardrail-board defense-board">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">DEFENSE · 指标体系 v1.2 §5</span>
            <h2>四层防线各层通过率</h2>
          </div>
          <span className="candidate-id">规则校验 → 语义复核 → scope-contract → NovaGuard · {guardrail.defense.traces} 次咨询</span>
        </div>

        <p className="guardrail-intro">
          四层各按各的自然分母计:规则校验、语义复核数的是<b>建议</b>(一次咨询可能有好几条候选建议),
          scope-contract 与 NovaGuard 数的是<b>答案</b>(它审的是这张卡最终放不放行)。硬凑成同一个分母,
          会把「20 条建议全过关」和「1 条建议过关」记成同一个 100%。
        </p>

        <div className="pair-table" role="table" aria-label="三层防线各层通过率">
          <div className="pair-row pair-head" role="row">
            <span role="columnheader">防线层</span>
            <span role="columnheader">口径</span>
            <span role="columnheader">当前值</span>
            <span role="columnheader">读法</span>
          </div>
          {defenseLayerRows(guardrail).map((r) => (
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
          <p>
            <b>规则校验全拦时,语义复核没有分母:</b>
            某次咨询的建议在规则层就被全部拦下(引用无效或越出适用范围),
            语义复核根本收不到任何建议去审 —— 这不该被记成语义层的「0% 通过」,
            那本该是规则层的问题。
          </p>
          <p>
            <b>NovaGuard 把「正确转专家」也算通过:</b>
            风险分级审批与适用范围契约两项检查,对「正确识别风险 / 越界并转专家」
            同样记为合规。所以这一行读的是「NovaGuard 全程没有发现任何异常」,
            不是「答案没被转专家」——转了专家但四项检查都合规的咨询同样计入分子。
          </p>
          <p>
            单层通过率突变(相对自身历史)是信号:该层可能失效,或者上游的问题分布变了。
            这一段与 5.1 节的<b>误拦截率</b>互补 —— 那边看「拦得对不对」,这里看「各层各自放行了多少」。
          </p>
        </div>
      </section>

      <section className="guardrail-board citation-compliance-board">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">CITATION · 指标体系 v1.1 §7（硬性铁律）</span>
            <h2>引用核实合规率</h2>
          </div>
          <span className="candidate-id">
            {guardrail.citationCompliance.total === 0
              ? "库内暂无 SCI 文献"
              : `${guardrail.citationCompliance.verified}/${guardrail.citationCompliance.total} 已核实`}
          </span>
        </div>

        <p className="guardrail-intro">
          口径:入库文献（source = SCI）中 PMID/DOI <b>经官网核实并留痕</b>的比例,目标 100%。
          核实动作要联网,与「离线可运行」的硬不变式冲突,所以拆成两步:
          <code>npm run kb:verify-citations</code> 是唯一允许联网的维护脚本,把结果写进
          <code>data/knowledge/citation-provenance.json</code> 台账;摄取(<code>kb:ingest</code>)、
          种子路径与本看板都只读这个台账,不发起任何网络请求。台账里没有 verified 记录的
          文献,摄取时会被直接拒收(与 frontmatter 校验同等严格)。
        </p>

        <div className="pair-table" role="table" aria-label="引用核实合规率">
          <div className="pair-row pair-head" role="row">
            <span role="columnheader">口径</span>
            <span role="columnheader">当前值</span>
            <span role="columnheader">读法</span>
          </div>
          <div className="pair-row" role="row">
            <span className="pair-cell incentive" role="cell">
              <em>入库文献 PMID/DOI 核实率</em>
            </span>
            <span className="pair-cell guardrail" role="cell">
              <strong>{pctOrDash(guardrail.citationCompliance.rate)}</strong>
            </span>
            <span className="pair-cell verdict" role="cell">
              {guardrail.citationCompliance.total === 0
                ? "库内还没有 SCI 文献,没有分母。"
                : `${guardrail.citationCompliance.verified}/${guardrail.citationCompliance.total} 篇。`}
            </span>
          </div>
        </div>

        {guardrail.citationCompliance.violations.length > 0 && (
          <div className="pair-footnotes">
            <p>
              <b>未达标明细：</b>
              {guardrail.citationCompliance.violations
                .map((v) => `${v.docId}(${v.citation}) · ${v.reason}`)
                .join("；")}
              。<code>not-in-ledger</code> 是台账里压根没有这条记录,<code>unverified</code> 是
              联网核实过但没通过(比如官网找不到该 PMID/DOI),<code>unparseable</code> 是
              citation 字符串里抽不出标识符——这三种失败原因分列而不是合并成一个「不合规」,
              是因为处置方式完全不同:前两种要跑一次
              <code>npm run kb:verify-citations</code>,最后一种要先修 frontmatter。
            </p>
          </div>
        )}
      </section>

      <section className="guardrail-board interception-board">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">INTERCEPTION · 指标体系 v1.1 §4.3</span>
            <h2>拦截→解决转化率 / 交接包完整度</h2>
          </div>
        </div>
        <div className="pair-table" role="table" aria-label="拦截与交接指标">
          <div className="pair-row pair-head" role="row">
            <span role="columnheader">指标</span>
            <span role="columnheader">当前值</span>
            <span role="columnheader">分子/分母</span>
          </div>
          <div className="pair-row" role="row">
            <span className="pair-cell incentive" role="cell">
              <em>Critic 拦截→解决转化率</em>
            </span>
            <span className="pair-cell guardrail" role="cell">
              <strong>{pctOrDash(guardrail.interceptResolution.rate)}</strong>
            </span>
            <span className="pair-cell verdict" role="cell">
              {guardrail.interceptResolution.intercepted === 0
                ? "窗口内暂无拦截记录。"
                : `${guardrail.interceptResolution.resolved} / ${guardrail.interceptResolution.intercepted} 次被拦截后转为正式卡。`}
            </span>
          </div>
          <div className="pair-row" role="row">
            <span className="pair-cell incentive" role="cell">
              <em>交接包完整度（防线摘要）</em>
            </span>
            <span className="pair-cell guardrail" role="cell">
              <strong>{pctOrDash(guardrail.handoffCompleteness.rate)}</strong>
            </span>
            <span className="pair-cell verdict" role="cell">
              {guardrail.handoffCompleteness.total === 0
                ? "暂无转专家案例。"
                : `${guardrail.handoffCompleteness.complete} / ${guardrail.handoffCompleteness.total} 个交接包带防线摘要。`}
            </span>
          </div>
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
                <div className="case-head"><span>金标案例</span><span>预期</span><span>实际</span><span>结果</span><span>Hit@5</span><span>违规引用</span></div>
                {report.cases.map((c) => (
                  <div key={c.id} className={"case-row" + (c.correct ? "" : " fail")}>
                    <strong>{c.id}</strong>
                    <span>{c.expected}</span>
                    <span>{c.actual}</span>
                    <em>{c.correct ? "PASS" : "FAIL"}</em>
                    <span>
                      {c.hitAtK == null ? "—" : c.hitAtK ? "✓" : "✗"}
                    </span>
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
