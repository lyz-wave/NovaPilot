/**
 * 接地循环(retrieve → draft → review,失败即加深重来)。
 *
 * 从 graph.ts 里抽出来的**唯一目的**是让它能被两种编排方式共用:
 *
 *   1. `runGroundingLoopNative` —— 原有的确定性 for 循环,零依赖,默认路径。
 *   2. `langgraph-adapter.ts`  —— 真实的 LangGraph `StateGraph`,同样的三个
 *      节点函数 + 一条条件边构成环,靠 `NP_ORCHESTRATOR=langgraph` 打开。
 *
 * 关键约束:**业务逻辑只有一份**。两条路径调用的是本文件里同一组
 * `retrieveNode` / `draftNode` / `reviewNode`,LangGraph 那边只负责「怎么把这
 * 三个节点连成一个带环的图」。所以切换编排器不可能改变答案 —— 这一点由
 * `langgraph-adapter.test.ts` 的对拍测试钉死,而不是靠约定。
 *
 * 为什么偏偏是这一段值得上 LangGraph:三轮加深检索是一个**带条件边的环**,
 * 正是有状态图模型的主场。而环外的风险门禁、卡片组装、落库是直线流程,套图
 * 只会增加间接层,所以它们留在 graph.ts 原地不动 —— 没有第二份实现,也就没有
 * 漂移的可能。
 */
import type { Locale, ProjectFacts } from "@/domain/consultation-journey";
import type { NovaDb } from "../db/client";
import {
  searchWithDiagnostics,
  type RetrievalDiagnostics,
  type RetrievedChunk,
} from "../rag/retrieval";
import type { SimilarCase } from "../rag/case-memory";
import { runActor, runCritic, broadenHint, verifyGrounding } from "../agents/actor-critic";
import type { ChatMessage, ModelGatewayConfig } from "../agents/model-gateway";
import { noteRoundVerified, recordRetrievalRound } from "../telemetry/retrieval-log";

/** 接地循环的轮次预算。每轮失败就放宽 hint、翻倍 topK 再来一次。 */
export const MAX_ROUNDS = 3;

export type ActorResult = Awaited<ReturnType<typeof runActor>>;
export type CriticResult = ReturnType<typeof runCritic>;

export interface LoopTraceEntry {
  round: number;
  hint: string | undefined;
  topK: number;
  drafted: number;
  verified: number;
  grounding: string;
  dropped: number;
  /** 本轮检索走的通道与向量空间(量化指标的检索侧数据源)。 */
  retrieval: RetrievalDiagnostics;
}

/** 循环期间不变的东西。节点函数是纯函数式的:上下文进,状态补丁出。 */
export interface LoopContext {
  db: NovaDb;
  traceId: string;
  projectId: string;
  question: string;
  locale: Locale;
  facts: ProjectFacts;
  history?: ChatMessage[];
  now: string;
  baseHint: string;
  /** 还在等客户补条件 —— 此时不该空转三轮。 */
  blockedByConditions: boolean;
  sensitive: boolean;
  similarCases: SimilarCase[];
  /** 三轮共用同一句查询文本,变的只有 hint 与 topK。 */
  retrievalQuery: string;
  /** 查询侧语义向量,只算一次;模型不可用时为 null,检索自动退回哈希空间。 */
  semanticQueryVector: number[] | null;
  cfg: ModelGatewayConfig;
  /** 落 checkpoint。两条编排路径写的是同一份轨迹。 */
  visit: (node: "retrieve" | "draft" | "review", state: unknown) => void;
}

/** 循环的可变状态。LangGraph 侧把它当成 channel 的合集,原生侧当成闭包变量。 */
export interface LoopState {
  round: number;
  hint: string | undefined;
  topK: number;
  chunks: RetrievedChunk[];
  diagnostics: RetrievalDiagnostics | null;
  actor: ActorResult | null;
  critic: CriticResult | null;
  loopTrace: LoopTraceEntry[];
  /** review 节点算出来的「还要不要再来一轮」。条件边只读它,不重算。 */
  done: boolean;
}

export function initialLoopState(): LoopState {
  return {
    round: 0,
    hint: undefined,
    topK: 5,
    chunks: [],
    diagnostics: null,
    actor: null,
    critic: null,
    loopTrace: [],
    done: false,
  };
}

// ── 三个节点 ────────────────────────────────────────────────────────

export function retrieveNode(ctx: LoopContext, state: LoopState): Partial<LoopState> {
  const hint = broadenHint(ctx.baseHint, state.round);
  const topK = 5 * 2 ** state.round; // 5 → 10 → 20

  const retrieved = searchWithDiagnostics(ctx.db, ctx.retrievalQuery, {
    appliesToHint: hint,
    topK,
    semanticQueryVector: ctx.semanticQueryVector,
  });
  // 落检索日志:按 (traceId, round) 寻址,三轮各留一行。checkpoint 里那份
  // 会被下一轮覆盖,统计不出「轮次」口径的回退率,见 retrieval-log.ts。
  recordRetrievalRound(ctx.db, {
    traceId: ctx.traceId,
    projectId: ctx.projectId,
    round: state.round,
    query: ctx.retrievalQuery,
    scopeHint: hint,
    topK,
    diagnostics: retrieved.diagnostics,
    hitDocumentIds: retrieved.hits.map((c) => c.documentId),
    now: ctx.now,
  });
  ctx.visit("retrieve", {
    round: state.round,
    hint,
    topK,
    chunks: retrieved.hits.map((c) => c.chunkId),
    similarCases: ctx.similarCases.map((c) => c.projectId),
    retrieval: retrieved.diagnostics,
  });
  return { hint, topK, chunks: retrieved.hits, diagnostics: retrieved.diagnostics };
}

export async function draftNode(ctx: LoopContext, state: LoopState): Promise<Partial<LoopState>> {
  const actor = await runActor(
    {
      question: ctx.question,
      locale: ctx.locale,
      chunks: state.chunks,
      appliesToHint: state.hint,
      sensitive: ctx.sensitive,
      facts: ctx.facts,
      history: ctx.history,
      similarCases: ctx.similarCases,
    },
    ctx.cfg,
  );
  ctx.visit("draft", { round: state.round, recommendations: actor.recommendations.map((r) => r.id) });
  return { actor };
}

export async function reviewNode(ctx: LoopContext, state: LoopState): Promise<Partial<LoopState>> {
  const actor = state.actor!;
  let critic = runCritic({
    recommendations: actor.recommendations,
    chunks: state.chunks,
    appliesToHint: state.hint,
    now: ctx.now,
  });

  // Semantic re-grounding (no-op offline): drop any rule-verified recommendation
  // whose evidence the model judges does not actually support the claim.
  const grounding = await verifyGrounding(
    { recommendations: critic.verified, chunks: state.chunks, question: ctx.question, locale: ctx.locale },
    ctx.cfg,
  );
  critic = {
    ...critic,
    verified: grounding.verified,
    approved: grounding.verified.length > 0 && grounding.dropped.length === 0 && critic.approved,
  };

  const loopTrace = [
    ...state.loopTrace,
    {
      round: state.round,
      hint: state.hint,
      topK: state.topK,
      drafted: actor.recommendations.length,
      verified: critic.verified.length,
      grounding: grounding.provider,
      dropped: grounding.dropped.length,
      retrieval: state.diagnostics!,
    },
  ];
  ctx.visit("review", {
    round: state.round,
    approved: critic.approved,
    verified: critic.verified.length,
    findings: critic.findings,
    loopTrace,
  });
  // 回填本轮检索日志:这一轮取回的证据到底有没有撑住核验。
  // 「知识盲区」只认这个信号 —— 检索分值在查询内部做了归一化,拿它设阈值
  // 得到的是恒真判定(见 retrieval-log.ts 的口径说明)。
  noteRoundVerified(ctx.db, ctx.traceId, state.round, critic.verified.length);

  const done =
    critic.verified.length > 0 || // grounded → stop
    ctx.blockedByConditions || // waiting on the customer → don't spin the loop
    state.round + 1 >= MAX_ROUNDS; // 轮次预算耗尽
  return { critic, loopTrace, done, round: state.round + 1 };
}

/** 条件边的判定。两条编排路径共用,保证「什么时候停」只有一份定义。 */
export function shouldContinue(state: LoopState): "retrieve" | "done" {
  return state.done ? "done" : "retrieve";
}

export interface GroundingLoopResult {
  chunks: RetrievedChunk[];
  actor: ActorResult;
  critic: CriticResult;
  loopTrace: LoopTraceEntry[];
  /** 实际跑了几轮。对拍测试用它验证两条路径的环行为一致。 */
  rounds: number;
}

/** 原生实现:一个 for 循环。零依赖,默认路径。 */
export async function runGroundingLoopNative(ctx: LoopContext): Promise<GroundingLoopResult> {
  let state = initialLoopState();
  for (;;) {
    state = { ...state, ...retrieveNode(ctx, state) };
    state = { ...state, ...(await draftNode(ctx, state)) };
    state = { ...state, ...(await reviewNode(ctx, state)) };
    if (shouldContinue(state) === "done") break;
  }
  return {
    chunks: state.chunks,
    actor: state.actor!,
    critic: state.critic!,
    loopTrace: state.loopTrace,
    rounds: state.round,
  };
}

/**
 * 按 `NP_ORCHESTRATOR` 选编排器。
 *
 * 默认 native。选 langgraph 时用动态 import 加载适配器 —— 这样
 * `@langchain/langgraph` 是**可选依赖**:免安装包里不装它、离线机器上装不上,
 * 都只是自动回退到原生实现,不会让咨询失败。这是「可以有可以没有」的落实方式。
 */
export async function runGroundingLoop(ctx: LoopContext): Promise<GroundingLoopResult> {
  if (process.env.NP_ORCHESTRATOR !== "langgraph") return runGroundingLoopNative(ctx);
  try {
    const mod = await import("./langgraph-adapter");
    return await mod.runGroundingLoopLangGraph(ctx);
  } catch (err) {
    console.warn(
      `[orchestration] LangGraph 编排不可用,回退原生实现: ${(err as Error).message}`,
    );
    return runGroundingLoopNative(ctx);
  }
}
