/**
 * LangGraph 编排适配器(可选路径)。
 *
 * 用真实的 `@langchain/langgraph` `StateGraph` 把接地循环表达成一张**带环的
 * 有状态图**:
 *
 *        START ──▶ retrieve ──▶ draft ──▶ review ──┬── done ──▶ END
 *                     ▲                            │
 *                     └──────── 加深一轮 ◀──────────┘
 *
 * 三个节点体直接复用 `grounding-loop.ts` 里的同一组函数 —— 这里**没有第二份
 * 业务逻辑**,只有第二种「把节点连起来」的方式。切换编排器改变不了答案,这一点
 * 由 `langgraph-adapter.test.ts` 的对拍测试钉死。
 *
 * ── 为什么它是可选依赖而不是默认路径 ──
 *
 * NovaPilot 的硬不变式是**离线确定性**:免安装包里连 Node 运行时都是内置的,
 * 装不了包的机器上也必须能跑。`@langchain/langgraph` 是纯 JS(无原生二进制),
 * 但它仍然是一个外部依赖,所以放在 `optionalDependencies` 里,并且只在
 * `NP_ORCHESTRATOR=langgraph` 时被 `import()` 动态加载 —— 包不在,自动回退原生
 * 实现(见 grounding-loop.ts 的 `runGroundingLoop`),咨询不会因此失败。
 *
 * 换句话说:**有它更好,没它照跑**。这也是为什么 README 里那句
 * 「参考 LangGraph 有状态图模型的零依赖实现,不依赖该框架」依然成立 —— 默认
 * 路径确实不依赖它。
 *
 * 打开方式:`NP_ORCHESTRATOR=langgraph npm start`(或 `npm test`)。
 */
import { END, START, StateGraph, Annotation } from "@langchain/langgraph";
import type { RetrievalDiagnostics, RetrievedChunk } from "../rag/retrieval";
import {
  MAX_ROUNDS,
  draftNode,
  initialLoopState,
  retrieveNode,
  reviewNode,
  shouldContinue,
  type ActorResult,
  type CriticResult,
  type GroundingLoopResult,
  type LoopContext,
  type LoopState,
  type LoopTraceEntry,
} from "./grounding-loop";

/**
 * 状态通道定义。
 *
 * 每个 channel 的 reducer 一律取「后写覆盖」(`(_, next) => next`),**包括
 * loopTrace**。这一点必须刻意:LangGraph 的常见写法是给数组 channel 配一个
 * 追加型 reducer,但 `reviewNode` 返回的已经是**完整的新数组**(它自己做了
 * `[...state.loopTrace, entry]`)。再叠一层追加会让轨迹每轮翻倍 —— 而
 * loopTrace 正是「三轮加深检索」在专家交接包里的证据链,重复条目会让专家以为
 * 系统检索了六轮。
 *
 * 换句话说:节点函数是两条路径共用的,那么 reducer 的语义就必须和原生 for
 * 循环里的 `{...state, ...patch}` 完全一致,而不是 LangGraph 的惯例写法。
 */
const last = <T>() => ({ reducer: (_prev: T, next: T) => next });

const LoopAnnotation = Annotation.Root({
  round: Annotation<number>(last<number>()),
  hint: Annotation<string | undefined>(last<string | undefined>()),
  topK: Annotation<number>(last<number>()),
  chunks: Annotation<RetrievedChunk[]>(last<RetrievedChunk[]>()),
  diagnostics: Annotation<RetrievalDiagnostics | null>(last<RetrievalDiagnostics | null>()),
  actor: Annotation<ActorResult | null>(last<ActorResult | null>()),
  critic: Annotation<CriticResult | null>(last<CriticResult | null>()),
  loopTrace: Annotation<LoopTraceEntry[]>(last<LoopTraceEntry[]>()),
  done: Annotation<boolean>(last<boolean>()),
});

/**
 * 用 LangGraph 跑接地循环。
 *
 * `recursionLimit` 取 `MAX_ROUNDS * 3 + 2`:三个节点 × 最多三轮,再留两步给
 * START/END。不设它的话 LangGraph 用默认值 25,环一旦因为 bug 停不下来,报出来
 * 的是「递归超限」而不是「第 4 轮不该存在」—— 预算写死才能让越界立刻可见。
 */
export async function runGroundingLoopLangGraph(ctx: LoopContext): Promise<GroundingLoopResult> {
  const graph = new StateGraph(LoopAnnotation)
    .addNode("retrieve", (s) => retrieveNode(ctx, s as LoopState))
    .addNode("draft", (s) => draftNode(ctx, s as LoopState))
    .addNode("review", (s) => reviewNode(ctx, s as LoopState))
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "draft")
    .addEdge("draft", "review")
    // 环在这里:review 之后要么收工,要么带着 round+1 回到 retrieve 加深一轮。
    .addConditionalEdges("review", (s) => shouldContinue(s as LoopState), {
      retrieve: "retrieve",
      done: END,
    })
    .compile();

  const final = (await graph.invoke(initialLoopState(), {
    recursionLimit: MAX_ROUNDS * 3 + 2,
  })) as LoopState;

  return {
    chunks: final.chunks,
    actor: final.actor!,
    critic: final.critic!,
    loopTrace: final.loopTrace,
    rounds: final.round,
  };
}
