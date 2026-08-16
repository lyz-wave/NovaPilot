"use client";

import { useEffect, useRef, useState } from "react";
import {
  buildScenarioPrompt,
  type ClientRole,
  type ContextUsage,
  type ConsultationResult,
  type ConversationMeta,
  type ConversationTurn,
  type Locale,
  type ProjectFacts,
  type Scenario,
} from "@/domain/consultation-journey";
import { ConsultationThread } from "./consultation-thread";
import { ContextUsageRing } from "./context-usage-ring";
import { DecisionCardPanel } from "./decision-card-panel";
import { ModelSettings } from "./model-settings";
import { ProjectRail } from "./project-rail";

interface NovaWorkspaceProps {
  conversations: ConversationMeta[];
  activeConversationId: string;
  initialTurns: ConversationTurn[];
  initialCard: ConsultationResult | null;
  initialContextUsage: ContextUsage;
}

/** One conversation turn as returned by /api/consultations (SSE result frame). */
type Outcome =
  | { kind: "chat"; reply: string; provider: string; traceId: string }
  | (ConsultationResult & { kind: "card" });

/** The SSE `result` frame carries the outcome plus the refreshed context usage. */
type ResultFrame = Outcome & { contextUsage?: ContextUsage };

/** Default project facts for the rail before any card exists (24-FFPE demo). */
const DEFAULT_FACTS: ProjectFacts = {
  sampleCount: 24,
  dv200: 62,
  rnaInputNg: 20,
  material: "FFPE RNA",
  species: "Homo sapiens",
  goal: "差异表达 · 通路富集",
};

const AUTH = "Bearer demo-research-session";
// Conversation-management writes are independent of the card; the write
// contract pins If-Match to "v3", so these always use version 3.
const CONTRACT_VERSION = 3;
const AUTO_COMPACT_KEY = "novapilot-auto-compact";
const RAIL_COLLAPSED_KEY = "novapilot-rail-collapsed";
const PANEL_COLLAPSED_KEY = "novapilot-panel-collapsed";
const AUTO_COMPACT_THRESHOLD = 0.8;

const WRITE_HEADERS = (version: number, idempotencyKey: string) => ({
  authorization: AUTH,
  "content-type": "application/json",
  "x-tenant-id": "novapilot-demo",
  "x-idempotency-key": idempotencyKey,
  "if-match": `"v${version}"`,
});

async function postJson<T>(
  url: string,
  body: unknown,
  version: number,
  idempotencyKey = crypto.randomUUID(),
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: WRITE_HEADERS(version, idempotencyKey),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  return (await response.json()) as T;
}

/** Parse one SSE frame ("event: x\ndata: {...}") into its type + payload. */
function parseSseFrame(frame: string): { event: string; data: unknown } | null {
  let event = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!event || !data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

function newTurn(turn: Omit<ConversationTurn, "id" | "createdAt">): ConversationTurn {
  return { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...turn };
}

function lastCardOf(turns: ConversationTurn[]): ConsultationResult | null {
  return [...turns].reverse().find((t) => t.kind === "card")?.result ?? null;
}

export function NovaWorkspace({
  conversations: initialConversations,
  activeConversationId: initialActiveId,
  initialTurns,
  initialCard,
  initialContextUsage,
}: NovaWorkspaceProps) {
  const [turns, setTurns] = useState<ConversationTurn[]>(initialTurns);
  const [latestCard, setLatestCard] = useState<ConsultationResult | null>(initialCard);
  const [facts, setFacts] = useState<ProjectFacts>(initialCard?.project.facts ?? DEFAULT_FACTS);
  const [confirmedFacts, setConfirmedFacts] = useState<ProjectFacts>(
    initialCard?.project.facts ?? DEFAULT_FACTS,
  );
  const [scenario, setScenario] = useState<Scenario>("standard");
  const [locale, setLocale] = useState<Locale>("zh");
  // 四角色差异化工作台(命题要求 1):PI / 博士后 / 研究生 / 企业研发。
  const [role, setRole] = useState<ClientRole>("pi");
  const [isPending, setIsPending] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);

  // Multi-conversation state.
  const [conversations, setConversations] = useState<ConversationMeta[]>(initialConversations);
  const [activeConversationId, setActiveConversationId] = useState(initialActiveId);

  // Context ring + compaction state.
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(initialContextUsage);
  const [autoCompact, setAutoCompact] = useState(false);
  const [compacting, setCompacting] = useState(false);

  // 正在进行的流所属的会话 id:切换会话/清空/新建后,旧流的结果不再写入当前视图。
  const streamConvRef = useRef<string | null>(null);
  // 正在做“打字机”流式渲染的助手回合 id(null = 无)。
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);
  // 思考过程检查点的最新快照(闭包中的 progress 是旧值,这里用 ref 作为事实来源)。
  const progressRef = useRef<string[]>([]);
  // 双栏可收起:左侧项目栏 / 右侧决策卡,收起后给咨询区留出空间。
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  useEffect(() => {
    try {
      setAutoCompact(localStorage.getItem(AUTO_COMPACT_KEY) === "1");
      setRailCollapsed(localStorage.getItem(RAIL_COLLAPSED_KEY) === "1");
      setPanelCollapsed(localStorage.getItem(PANEL_COLLAPSED_KEY) === "1");
    } catch {
      /* localStorage may be unavailable; default off */
    }
  }, []);

  function toggleRail() {
    setRailCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(RAIL_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function togglePanel() {
    setPanelCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PANEL_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  // Version pinned by the write-context contract (see api/write-context.ts).
  const cardVersion = latestCard?.card.version ?? 3;

  /** 场景模板问题:由“当前界面事实”拼装(与用户所见参数一致,不再写死)。 */
  function scenarioQuestion(nextScenario: Scenario): string {
    return buildScenarioPrompt(nextScenario, facts);
  }

  /** Reload the conversation list (titles + ordering) after a change. */
  async function refreshConversations() {
    try {
      const res = await fetch("/api/conversation", { headers: { authorization: AUTH } });
      if (!res.ok) return;
      const data = (await res.json()) as { conversations: ConversationMeta[] };
      setConversations(data.conversations);
    } catch {
      /* keep the current list on failure */
    }
  }

  /**
   * Stream a consultation over SSE, surfacing each orchestration checkpoint as
   * it is reached, and resolve with the turn outcome (chat reply or card).
   */
  async function streamConsultation(
    question: string,
    nextLocale: Locale,
    nextFacts: ProjectFacts,
  ): Promise<ResultFrame> {
    const response = await fetch("/api/consultations", {
      method: "POST",
      headers: WRITE_HEADERS(cardVersion, crypto.randomUUID()),
      body: JSON.stringify({
        question,
        locale: nextLocale,
        facts: nextFacts,
        stream: true,
        conversationId: activeConversationId,
      }),
    });
    if (!response.ok || !response.body) throw new Error(`请求失败：${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let outcome: ResultFrame | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const parsed = parseSseFrame(frame);
        if (!parsed) continue;
        if (parsed.event === "node") {
          const node = (parsed.data as { node: string }).node;
          progressRef.current = [...progressRef.current, node];
          setProgress(progressRef.current);
        } else if (parsed.event === "result") {
          outcome = parsed.data as ResultFrame;
        } else if (parsed.event === "error") {
          throw new Error((parsed.data as { message: string }).message);
        }
      }
    }
    if (!outcome) throw new Error("流式响应未返回结果");
    return outcome;
  }

  /** Run a streamed turn: append the user message, then the assistant reply. */
  async function runStreamed(
    nextLocale: Locale,
    nextFacts: ProjectFacts,
    question: string,
    onSuccess?: () => void,
    quickLabel?: string,
  ) {
    const streamConvId = activeConversationId;
    streamConvRef.current = streamConvId;
    // quickLabel 存在 ⇒ 快捷场景注入(带“快捷提问”徽标),否则为用户手输。
    setTurns((prev) => [
      ...prev,
      newTurn({
        role: "user",
        kind: "chat",
        text: question,
        result: null,
        source: quickLabel ? "quick" : "typed",
      }),
    ]);
    setIsPending(true);
    setProgress([]);
    progressRef.current = [];
    try {
      const outcome = await streamConsultation(question, nextLocale, nextFacts);
      // 流返回时若已切走,结果仍持久化在原会话,但不写入当前视图。
      if (streamConvRef.current !== streamConvId) return;
      const checkpoints = [...progressRef.current]; // 本轮完整的思考过程
      if (outcome.kind === "chat") {
        const turn = newTurn({ role: "assistant", kind: "chat", text: outcome.reply, result: null, checkpoints });
        setTurns((prev) => [...prev, turn]);
        setStreamingTurnId(turn.id); // 渐进流式渲染回复正文
      } else {
        const turn = newTurn({ role: "assistant", kind: "card", text: null, result: outcome, checkpoints });
        setTurns((prev) => [...prev, turn]);
        setLatestCard(outcome);
        setStreamingTurnId(turn.id); // 决策卡摘要同样渐进渲染
      }
      if (outcome.contextUsage) setContextUsage(outcome.contextUsage);
      onSuccess?.();
      void refreshConversations();
      // Auto-compact once the window crosses the threshold (if enabled).
      if (autoCompact && outcome.contextUsage && outcome.contextUsage.ratio >= AUTO_COMPACT_THRESHOLD) {
        void compact();
      }
    } catch {
      setTurns((prev) => [
        ...prev,
        newTurn({
          role: "assistant",
          kind: "chat",
          text: "抱歉，处理这条消息时出错了，请稍后重试。",
          result: null,
        }),
      ]);
    } finally {
      setIsPending(false);
    }
  }

  function run(nextScenario: Scenario, prompt?: string, quickLabel?: string) {
    if (isPending) return; // 进行中不再并发启动新一轮(场景条/示例/追问按钮)
    setScenario(nextScenario);
    // 以当前界面事实为准:用户刚改完参数就提问,视为对本次修改的确认。
    const effectiveFacts = facts;
    const nextFacts =
      nextScenario === "missing-dv200"
        ? { ...effectiveFacts, dv200: undefined }
        : effectiveFacts;
    const needsConfirm =
      JSON.stringify(effectiveFacts) !== JSON.stringify(confirmedFacts);
    void runStreamed(
      locale,
      nextFacts,
      prompt ?? scenarioQuestion(nextScenario),
      needsConfirm ? () => setConfirmedFacts(effectiveFacts) : undefined,
      quickLabel,
    );
  }

  function changeLocale(nextLocale: Locale) {
    setLocale(nextLocale);
  }

  /** 左侧“待客户确认”chips:点击即发送对应追问(带快捷提问徽标)。 */
  function askFollowUp(question: string, label: string) {
    run("standard", question, label);
  }

  /** 某个回合的渐进渲染结束,清除流式标记(避免再次挂载时重播)。 */
  function onStreamDone(turnId: string) {
    setStreamingTurnId((current) => (current === turnId ? null : current));
  }

  async function clearConversation() {
    try {
      const data = await postJson<{ contextUsage: ContextUsage }>(
        "/api/conversation",
        { action: "clear", conversationId: activeConversationId },
        CONTRACT_VERSION,
      );
      setContextUsage(data.contextUsage);
    } catch {
      /* even if the request fails, clear the local view */
    }
    streamConvRef.current = null;
    setStreamingTurnId(null);
    setTurns([]);
    setLatestCard(null);
    setProgress([]);
    void refreshConversations();
  }

  // ── Multi-conversation actions ──────────────────────────────────

  async function newConversation() {
    try {
      const data = await postJson<{ conversation: ConversationMeta }>(
        "/api/conversation",
        { action: "create" },
        CONTRACT_VERSION,
      );
      setConversations((prev) => [data.conversation, ...prev]);
      setActiveConversationId(data.conversation.id);
    } catch {
      /* offline: still reset to a blank thread */
    }
    streamConvRef.current = null;
    setStreamingTurnId(null);
    setTurns([]);
    setLatestCard(null);
    setProgress([]);
    setContextUsage(null);
  }

  async function switchConversation(id: string) {
    if (id === activeConversationId) return;
    streamConvRef.current = null; // 旧流结果不再写入任何视图
    setStreamingTurnId(null);
    setActiveConversationId(id);
    setProgress([]);
    setIsPending(false);
    try {
      const res = await fetch(`/api/conversation?conversationId=${encodeURIComponent(id)}`, {
        headers: { authorization: AUTH },
      });
      if (res.ok) {
        const data = (await res.json()) as { turns: ConversationTurn[]; contextUsage: ContextUsage };
        setTurns(data.turns);
        setLatestCard(lastCardOf(data.turns));
        setContextUsage(data.contextUsage);
      }
    } catch {
      setTurns([]);
      setLatestCard(null);
      setContextUsage(null);
    }
  }

  async function renameConversation(id: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    // Optimistic update, then persist.
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
    try {
      await postJson("/api/conversation", { action: "rename", conversationId: id, title: trimmed }, CONTRACT_VERSION);
    } catch {
      void refreshConversations();
    }
  }

  async function deleteConversation(id: string) {
    let remaining = conversations.filter((c) => c.id !== id);
    try {
      const data = await postJson<{ conversations: ConversationMeta[] }>(
        "/api/conversation",
        { action: "delete", conversationId: id },
        CONTRACT_VERSION,
      );
      remaining = data.conversations;
    } catch {
      /* fall back to the optimistic local list */
    }
    setConversations(remaining);
    if (id === activeConversationId) {
      if (remaining.length > 0) {
        await switchConversation(remaining[0]!.id);
      } else {
        await newConversation();
      }
    }
  }

  async function compact() {
    if (compacting) return;
    setCompacting(true);
    try {
      const data = await postJson<{ compacted: boolean; usage: ContextUsage }>(
        "/api/conversation",
        { action: "compact", conversationId: activeConversationId },
        CONTRACT_VERSION,
      );
      setContextUsage(data.usage);
      if (data.compacted) {
        setTurns((prev) => [
          ...prev,
          {
            id: `compact-${crypto.randomUUID()}`,
            role: "assistant",
            kind: "chat",
            text: "已将较早的对话压缩为摘要，上下文占用已下降（原始消息仍完整保留）。",
            result: null,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    } catch {
      /* leave usage as-is on failure */
    } finally {
      setCompacting(false);
    }
  }

  function toggleAutoCompact() {
    setAutoCompact((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(AUTO_COMPACT_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  async function consent() {
    if (!latestCard) return;
    await postJson(
      "/api/consent",
      { projectId: latestCard.project.id, granted: true, action: "request-quote" },
      latestCard.card.version,
      `consent:${latestCard.project.id}:request-quote:v${latestCard.card.version}`,
    );
  }

  async function feedback(score: number) {
    if (!latestCard) return;
    await postJson(
      "/api/feedback",
      { projectId: latestCard.project.id, score, reason: score <= 2 ? "citation" : undefined },
      latestCard.card.version,
      `feedback:${latestCard.project.id}:${score}:v${latestCard.card.version}`,
    );
  }

  async function requestExpertReview() {
    if (!latestCard) return;
    await postJson(
      "/api/consent",
      { projectId: latestCard.project.id, granted: true, action: "book-expert" },
      latestCard.card.version,
      `consent:${latestCard.project.id}:book-expert:v${latestCard.card.version}`,
    );
  }

  function confirmFacts() {
    if (isPending) return;
    const nextScenario =
      scenario === "evidence-conflict" || scenario === "manual-escalation"
        ? scenario
        : "standard";
    setScenario(nextScenario);
    void runStreamed(locale, facts, scenarioQuestion(nextScenario), () =>
      setConfirmedFacts(facts),
    );
  }

  // 上下文环 + 模型徽章作为头部工具渲染在咨询页头部(替代原 fixed 定位 hack)。
  const headTools = (
    <div className="workspace-badges">
      <ContextUsageRing
        usage={contextUsage}
        auto={autoCompact}
        busy={compacting}
        onCompact={compact}
        onToggleAuto={toggleAutoCompact}
      />
      <ModelSettings />
    </div>
  );

  return (
    <div
      className={`workspace ${railCollapsed ? "rail-collapsed" : ""} ${
        panelCollapsed ? "panel-collapsed" : ""
      }`}
    >
      <ProjectRail
        facts={facts}
        collapsed={railCollapsed}
        onToggleCollapse={toggleRail}
        confirmed={JSON.stringify(facts) === JSON.stringify(confirmedFacts)}
        onFactsChange={setFacts}
        onConfirm={confirmFacts}
        onAsk={askFollowUp}
        conversations={conversations}
        activeConversationId={activeConversationId}
        onNewConversation={newConversation}
        onSwitchConversation={switchConversation}
        onRenameConversation={renameConversation}
        onDeleteConversation={deleteConversation}
      />
      <ConsultationThread
        turns={turns}
        latestCard={latestCard}
        locale={locale}
        scenario={scenario}
        isPending={isPending}
        progress={progress}
        onRun={run}
        onLocaleChange={changeLocale}
        onClear={clearConversation}
        headTools={headTools}
        role={role}
        onRoleChange={setRole}
        facts={facts}
        factsConfirmed={JSON.stringify(facts) === JSON.stringify(confirmedFacts)}
        streamingTurnId={streamingTurnId}
        onStreamDone={onStreamDone}
      />
      <DecisionCardPanel
        result={latestCard}
        role={role}
        collapsed={panelCollapsed}
        onToggleCollapse={togglePanel}
        onConsent={consent}
        onExpertRequest={requestExpertReview}
        onFeedback={feedback}
      />
    </div>
  );
}
