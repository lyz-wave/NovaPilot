"use client";

import {
  ArrowUp,
  BookOpen,
  Braces,
  BrainCircuit,
  ChevronDown,
  CircleAlert,
  Eraser,
  FilePlus2,
  Languages,
  Lightbulb,
  LoaderCircle,
  Sparkles,
  Zap,
} from "lucide-react";
import { FormEvent, KeyboardEvent, ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  buildScenarioPrompt,
  CLIENT_ROLES,
  inferScenarioFromQuestion,
  type ClientRole,
  type ConsultationResult,
  type ConversationTurn,
  type Locale,
  type ProjectFacts,
  type Scenario,
} from "@/domain/consultation-journey";
import { Markdown } from "./markdown";
import { StreamingText } from "./streaming-text";

interface ConsultationThreadProps {
  turns: ConversationTurn[];
  latestCard: ConsultationResult | null;
  locale: Locale;
  scenario: Scenario;
  isPending: boolean;
  progress: string[];
  onRun: (scenario: Scenario, prompt?: string, quickLabel?: string) => void;
  onLocaleChange: (locale: Locale) => void;
  onClear: () => void;
  /** 渲染在头部工具区的节点(上下文环 + 模型徽章)。 */
  headTools?: ReactNode;
  /** 正在流式渲染的助手回合 id(null = 全部为静态渲染)。 */
  streamingTurnId: string | null;
  /** 某回合流式渲染结束后回调,用于清除 streamingTurnId。 */
  onStreamDone: (turnId: string) => void;
  /** 当前客户角色(四角色差异化工作台)。 */
  role: ClientRole;
  onRoleChange: (role: ClientRole) => void;
  /** 项目事实是否已确认(研究生三步引导的动态打勾用)。 */
  factsConfirmed: boolean;
  /** 当前(可编辑)项目事实:场景条回填模板问题用。 */
  facts: ProjectFacts;
}

const scenarios: Array<{ id: Scenario; label: string; hint: string; demo?: boolean }> = [
  { id: "standard", label: "方案设计", hint: "建库路线" },
  { id: "platform-selection", label: "平台选择", hint: "读长与数据量" },
  { id: "analysis-method", label: "数据分析", hint: "方法与软件" },
  { id: "paper-support", label: "论文支持", hint: "解读与图表" },
  { id: "missing-dv200", label: "追问演示", hint: "缺少质控指标", demo: true },
  { id: "evidence-conflict", label: "转接演示", hint: "证据冲突", demo: true },
];

/** 欢迎态四张主场景卡:对齐命题“四大核心场景”(方案/平台/分析/论文)。 */
const SCENE_CARDS: Array<{ id: Scenario; title: string; desc: string }> = [
  { id: "standard", title: "实验方案设计", desc: "FFPE RNA 建库路线怎么选" },
  { id: "platform-selection", title: "测序平台选择", desc: "推荐平台、读长与数据量" },
  { id: "analysis-method", title: "数据分析方法", desc: "差异表达用什么软件、如何富集" },
  { id: "paper-support", title: "论文写作支持", desc: "结果怎么解读、图表与方法学怎么写" },
];

/** Human-readable labels for the orchestration graph's checkpoint nodes. */
const NODE_LABELS: Record<string, string> = {
  ingest: "接收事实",
  "infer-scenario": "场景判定",
  risk: "风险评估",
  clarify: "追问澄清",
  retrieve: "证据检索",
  draft: "草拟建议",
  review: "证据审查",
  "risk-gate": "风险门",
  escalate: "转交专家",
  finalize: "形成决策卡",
  chat: "对话理解",
};

const EXAMPLE_PROMPTS = [
  "24 份 FFPE 肿瘤样本做 RNA 差异表达，DV200 62%，怎么选建库路线和测序平台？",
  "低质量 RNA（DV200 未知）能不能直接建库？",
  "请核对当前 SOP 与外部文献是否冲突。",
];

/** 四角色差异化欢迎文案(同一套事实与证据链,不同对话策略)。 */
const ROLE_WELCOME: Record<ClientRole, string> = {
  pi: "作为项目负责人，我会先给你决策摘要与风险判断，再展开技术依据；所有结论都绑定证据、可审计可回看。",
  postdoc: "你可以调整实验参数、对比文献证据，我会记录每一步的可复现版本，方便深入追问与方案迭代。",
  student: "我会用三步引导你（研究问题 → 样本条件 → 方案清单），术语随时解释；拿不准的条件可以先空着，我会主动追问。",
  rnd: "我会优先确认批次、SLA 与数据合规边界，再给出标准化方案；所有交互保留审计记录。",
};

/** 四角色镜头:同一张决策卡的四套解读开篇(侧重点不同,科学结论不变)。 */
const ROLE_LENS: Record<ClientRole, string> = {
  pi: "结论先行:先看风险分级、预算与 18 天周期,再展开技术依据。",
  postdoc: "参数与证据优先:DV200、投入量与文献对比在证据 Tab,方案可复现导出。",
  student: "先记一个概念:DV200 是片段大于 200nt 的 RNA 占比;按步骤对照你的样本条件即可。",
  rnd: "SLA 与合规优先:周期 18 天、批次与数据边界见左栏,报价需授权后进入 CRM。",
};

function statusLabelOf(result: ConsultationResult): string {
  return result.card.status === "formal"
    ? "可形成正式决策卡"
    : result.card.status === "expert-review"
      ? "已进入专家待审"
      : "需要补充条件";
}

/**
 * “思考中 / 已思考 N 步”折叠条。默认折叠,点击箭头展开编排思考过程
 * (接收事实 → 场景判定 → … → 形成决策卡)。进行中带转圈,完成后带步数。
 */
function ThinkingBlock({ checkpoints, done }: { checkpoints: string[]; done: boolean }) {
  const [open, setOpen] = useState(false);
  const trailId = useId();
  if (done && checkpoints.length === 0) return null;
  return (
    <div className={`thinking-block ${done ? "thinking-done" : ""}`}>
      <button
        type="button"
        className="thinking-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={trailId}
      >
        <span className="thinking-status">
          {done ? (
            <>
              <BrainCircuit size={13} aria-hidden="true" />
              已思考 {checkpoints.length} 步
            </>
          ) : (
            <>
              <LoaderCircle className="spin" size={13} aria-hidden="true" />
              思考中
            </>
          )}
        </span>
        <ChevronDown size={14} aria-hidden="true" className={open ? "rotated" : ""} />
      </button>
      {open && (
        <div id={trailId} className="thinking-trail" aria-label="思考过程">
          {checkpoints.map((node, index) => (
            <span
              key={`${node}-${index}`}
              className={`trail-node ${
                !done && index === checkpoints.length - 1 ? "active" : "done"
              }`}
            >
              {NODE_LABELS[node] ?? node}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Assistant bubble for a research decision-card turn. */
function CardBubble({
  result,
  onRun,
  streaming = false,
  onStreamDone,
  onTick,
  checkpoints,
  lensLabel,
  lensText,
}: {
  result: ConsultationResult;
  onRun: (scenario: Scenario, prompt?: string) => void;
  streaming?: boolean;
  onStreamDone?: () => void;
  onTick?: () => void;
  checkpoints?: string[];
  lensLabel?: string;
  lensText?: string;
}) {
  return (
    <div className="message-body">
      <ThinkingBlock checkpoints={checkpoints ?? []} done />
      {lensLabel && lensText && (
        <div className="role-lens">
          <span className="lens-chip">{lensLabel} 视角</span>
          <p>{lensText}</p>
        </div>
      )}
      <div className="message-meta">
        <span className="message-role">NovaPilot · 科研咨询编排</span>
        <span className={`assurance ${result.card.risk.level}`}>
          {result.card.risk.mandatoryEscalation ? <CircleAlert size={12} /> : <BookOpen size={12} />}
          {statusLabelOf(result)}
        </span>
      </div>

      {streaming ? (
        <StreamingText
          className="agent-summary"
          text={result.card.executiveSummary}
          onDone={onStreamDone}
          onTick={onTick}
        />
      ) : (
        <Markdown className="agent-summary" text={result.card.executiveSummary} />
      )}

      {result.clarifyingQuestions.length > 0 && (
        <div className="clarification-block">
          <span className="block-kicker">最小必要追问 · 1 / 1</span>
          <strong>{result.clarifyingQuestions[0].prompt}</strong>
          <p>{result.clarifyingQuestions[0].reason}</p>
          <div className="inline-actions">
            <button onClick={() => onRun("standard")}>补充 DV200 = 62%</button>
            <button
              className="ghost"
              onClick={() => onRun("missing-dv200", "我暂时不知道 DV200，请给出条件性路径与后续检测建议。")}
            >
              暂时不知道
            </button>
          </div>
        </div>
      )}

      {result.expertCase && (
        <div className="handoff-block">
          <span className="block-kicker">MANDATORY ESCALATION</span>
          <strong>AI 已停止输出可执行最终方案</strong>
          <p>{result.expertCase.handoff.reason}</p>
          <div className="handoff-route">
            <span>一次性交接包</span>
            <i />
            <span>转录组解决方案专家</span>
            <em>预计 30 分钟内认领</em>
          </div>
        </div>
      )}

      <div className="evidence-inline">
        <Braces size={14} />
        <span>已核对 {result.evidence.length} 条证据</span>
        <span>·</span>
        <span>结论覆盖 {result.card.recommendations.length ? "100%" : "待专家确认"}</span>
        <span>·</span>
        <code>{result.traceId.slice(-7)}</code>
      </div>
    </div>
  );
}

export function ConsultationThread({
  turns,
  latestCard,
  locale,
  scenario,
  isPending,
  progress,
  onRun,
  onLocaleChange,
  onClear,
  headTools,
  streamingTurnId,
  onStreamDone,
  role,
  onRoleChange,
  factsConfirmed,
  facts,
}: ConsultationThreadProps) {
  const [prompt, setPrompt] = useState("");
  const [exampleIdx, setExampleIdx] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const lastScrollRef = useRef(0);
  // 角色面板:默认展开,选定角色后自动收起;会话开始后若从未选过也自动收起。
  const [roleBarOpen, setRoleBarOpen] = useState(true);
  const [roleTouched, setRoleTouched] = useState(false);
  const wasEmptyRef = useRef(true);

  function pickRole(next: ClientRole) {
    onRoleChange(next);
    setRoleTouched(true);
    setRoleBarOpen(false);
  }

  useEffect(() => {
    const empty = turns.length === 0 && !isPending;
    if (!empty && !roleTouched) setRoleBarOpen(false); // 会话开始后自动收起
    // 仅在“清空对话回到欢迎态”这一边沿重开引导面板,不与选角收起互搏。
    if (empty && !wasEmptyRef.current) setRoleBarOpen(true);
    wasEmptyRef.current = empty;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length, isPending, roleTouched]);

  /** 仅当用户停在底部附近时才跟随滚动,避免打断回看历史。 */
  function scrollToBottomIfNear() {
    const now = performance.now();
    if (now - lastScrollRef.current < 100) return;
    lastScrollRef.current = now;
    const col = document.querySelector<HTMLElement>(".consultation-column");
    if (col && col.scrollHeight > col.clientHeight + 40) {
      if (col.scrollHeight - col.scrollTop - col.clientHeight > 160) return;
    } else if (
      window.innerHeight + window.scrollY <
      document.documentElement.scrollHeight - 160
    ) {
      return;
    }
    document
      .querySelector<HTMLElement>(".thread-end")
      ?.scrollIntoView({ block: "end" });
  }

  useEffect(() => {
    if (turns.length > 0 || isPending) scrollToBottomIfNear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length, isPending, progress.length]);

  /** 随内容自动增高输入框(上限 190px),清空后复位。 */
  function autosize() {
    const ta = composerRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 190) + "px";
  }

  /** 场景条点击:把与当前事实拼装的模板问题回填输入框,用户确认后回车发送。 */
  function fillPrompt(nextScenario: Scenario) {
    setPrompt(buildScenarioPrompt(nextScenario, facts));
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      autosize();
    });
  }

  /** Actually dispatch the current prompt (guarded); shared by form + Enter. */
  function send() {
    const text = prompt.trim();
    if (!text || isPending) return;
    const inferred = inferScenarioFromQuestion(text, latestCard?.project.facts ?? {});
    onRun(inferred, text);
    setPrompt("");
    requestAnimationFrame(() => {
      if (composerRef.current) composerRef.current.style.height = "";
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    send();
  }

  /**
   * Enter sends; Ctrl/Cmd+Enter (and Shift+Enter) insert a newline. Keeps the
   * caret just after the inserted break so multi-line prompts stay editable.
   */
  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const ta = event.currentTarget;
      const start = ta.selectionStart ?? prompt.length;
      const end = ta.selectionEnd ?? prompt.length;
      const next = `${prompt.slice(0, start)}\n${prompt.slice(end)}`;
      setPrompt(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 1;
      });
      return;
    }
    if (event.shiftKey) return; // default behaviour: newline
    event.preventDefault();
    send();
  }

  /** Fill the composer with a rotating example question (offline-safe demo). */
  function insertExample() {
    setPrompt(EXAMPLE_PROMPTS[exampleIdx % EXAMPLE_PROMPTS.length]!);
    setExampleIdx((i) => (i + 1) % EXAMPLE_PROMPTS.length);
  }

  let userIndex = 0;
  const isEmpty = turns.length === 0 && !isPending;
  // 角色镜头只显示在最新一条助手消息上(它是“当前答案”的镜头,不是历史注记)。
  const lastAssistantIdx = turns.reduce((acc, turn, index) => (turn.role === "assistant" ? index : acc), -1);
  const roleLabel = CLIENT_ROLES.find((item) => item.id === role)?.label ?? role;

  return (
    <main className="consultation-column">
      <div className="consultation-head">
        <div>
          <span className="eyebrow">CONSULTATION / FFPE-RNA-042</span>
          <h1>把科研问题，变成可审计的决定。</h1>
        </div>
        <div className="head-tools">
          {headTools}
          <div className="language-switcher" role="group" aria-label="咨询语言">
            <Languages size={14} aria-hidden="true" />
            {([["zh", "中"], ["en", "EN"], ["ja", "日"]] as const).map(([id, label]) => (
              <button
                aria-pressed={locale === id}
                className={locale === id ? "active" : ""}
                key={id}
                onClick={() => onLocaleChange(id)}
              >
                {label}
              </button>
            ))}
            <span>实体一致</span>
          </div>
          {turns.length > 0 && (
            <button className="clear-conversation" onClick={onClear} aria-label="清空对话">
              <Eraser size={14} /> 清空对话
            </button>
          )}
        </div>
      </div>

      {/* 四角色工作台:选定角色后自动收起为一行,点击箭头可重新展开 */}
      <div className={`role-bar ${roleBarOpen ? "" : "collapsed"}`}>
        <div className="role-switcher" role="tablist" aria-label="客户角色工作台">
          {CLIENT_ROLES.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={role === item.id}
              className={role === item.id ? "active" : ""}
              onClick={() => pickRole(item.id)}
            >
              {roleBarOpen ? item.label : item.short}
            </button>
          ))}
        </div>
        {!roleBarOpen && (
          <p className="role-mini-note">
            {CLIENT_ROLES.find((item) => item.id === role)?.label} ·{" "}
            {CLIENT_ROLES.find((item) => item.id === role)?.note}
          </p>
        )}
        <button
          type="button"
          className="role-collapse"
          aria-expanded={roleBarOpen}
          aria-controls="role-panel-region"
          aria-label={roleBarOpen ? "收起角色面板" : "展开角色面板"}
          onClick={() => setRoleBarOpen((v) => !v)}
        >
          <ChevronDown size={15} aria-hidden="true" />
        </button>
        {roleBarOpen && (
        <div className="role-panel" id="role-panel-region">
          {role === "pi" && (
            <ul className="role-chips" aria-label="决策约束">
              {[
                ["研究目标", facts.goal ?? "差异表达 · 通路富集"],
                ["物种", facts.species ?? "Homo sapiens"],
                ["预算", "中等 · 待报价"],
                ["周期", "18 天 · ≤30 样本"],
              ].map(([label, value]) => (
                <li key={label}><b>{label}</b>{value}</li>
              ))}
            </ul>
          )}
          {role === "postdoc" && (
            <ul className="role-chips" aria-label="参数与文献">
              {[
                ["参数面板", "DV200 / 投入量 · 可编辑"],
                ["文献对比", "SOP + SCI · 证据 Tab"],
                ["复现记录", "版本化 · 可导出 .md"],
              ].map(([label, value]) => (
                <li key={label}><b>{label}</b>{value}</li>
              ))}
            </ul>
          )}
          {role === "student" && (
            <ol className="role-steps" aria-label="三步引导">
              <li className="done"><i>1</i>研究问题 · 差异表达</li>
              <li className={factsConfirmed ? "done" : ""}><i>2</i>样本条件 · {factsConfirmed ? "已确认" : "待确认"}</li>
              <li><i>3</i>方案清单 · 随决策卡生成</li>
            </ol>
          )}
          {role === "rnd" && (
            <ul className="role-chips" aria-label="批次与 SLA">
              {[
                ["批次", "B-2026-FFPE-01"],
                ["SLA", "18 天 · 4h 响应"],
                ["权限", "项目级 · 审计日志"],
                ["数据边界", "私有部署 · 不出域"],
              ].map(([label, value]) => (
                <li key={label}><b>{label}</b>{value}</li>
              ))}
            </ul>
          )}
          <p className="role-note">
            {CLIENT_ROLES.find((item) => item.id === role)?.note} · 四角色共享同一项目事实与证据链
          </p>
        </div>
        )}
      </div>

      {/* 场景条:会话开始后才出现;点击把模板问题回填到输入框,用户确认后回车发送(教提问) */}
      {!isEmpty && (
        <div className="scenario-strip" aria-label="核心场景与机制演示">
          {scenarios.filter((item) => !item.demo).map((item) => (
            <button
              className={scenario === item.id ? "active" : ""}
              key={item.id}
              aria-pressed={scenario === item.id}
              title="点击填入提问,回车发送"
              onClick={() => fillPrompt(item.id)}
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
          <span className="scenario-divider" aria-hidden="true">机制演示</span>
          {scenarios.filter((item) => item.demo).map((item) => (
            <button
              className={`demo ${scenario === item.id ? "active" : ""}`}
              key={item.id}
              aria-pressed={scenario === item.id}
              title="点击填入提问,回车发送"
              onClick={() => fillPrompt(item.id)}
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
        </div>
      )}

      {/* 注意:流式渲染逐字更新,aria-live 会让读屏高频播报,故不放在线程容器上;
          编排进度有独立 role="status" 播报,最终文本由读屏用户按需浏览。 */}
      <section className="thread">
        {isEmpty ? (
          <div className="thread-welcome reveal">
            <div className="agent-seal"><Sparkles size={18} /></div>
            <h2>你好，我是 NovaPilot 科研咨询助手</h2>
            <p>{ROLE_WELCOME[role]}</p>

            {/* 新手三步引导:点开页面就知道怎么操作 */}
            <ol className="howto-steps">
              <li><i>1</i>选择你的角色</li>
              <li><i>2</i>点一张场景卡或直接提问</li>
              <li><i>3</i>在右侧查看可审计的决策卡</li>
            </ol>

            <div className="welcome-scenes" aria-label="核心场景">
              {SCENE_CARDS.map((scene) => (
                <button key={scene.id} onClick={() => onRun(scene.id, undefined, scene.title)}>
                  <span className="welcome-scene-title">{scene.title}</span>
                  <small>{scene.desc}</small>
                  <ArrowUp size={15} className="scene-arrow" aria-hidden="true" />
                </button>
              ))}
            </div>

            <div className="welcome-demos">
              <span className="welcome-demos-label">机制演示</span>
              <button onClick={() => onRun("missing-dv200", undefined, "追问演示")}>追问 · 缺少 DV200</button>
              <button onClick={() => onRun("evidence-conflict", undefined, "转接演示")}>转接 · 证据冲突</button>
            </div>
          </div>
        ) : (
          turns.map((turn, turnIndex) => {
            if (turn.role === "user") {
              userIndex += 1;
              return (
                <article className="message user-message reveal" key={turn.id}>
                  <div className="message-index">{String(userIndex).padStart(2, "0")}</div>
                  <div>
                    <div className="user-meta">
                      <span className="message-role">你 · 研究者</span>
                      {turn.source === "quick" && (
                        <span className="quick-badge" title="由快捷场景注入的模板提问">
                          <Zap size={10} aria-hidden="true" /> 快捷提问
                        </span>
                      )}
                    </div>
                    <p>{turn.text}</p>
                  </div>
                </article>
              );
            }
            const isStreaming = streamingTurnId === turn.id;
            const showLens = turnIndex === lastAssistantIdx;
            return (
              <article className="message agent-message reveal" key={turn.id}>
                <div className="agent-seal"><Sparkles size={17} /></div>
                {turn.kind === "card" && turn.result ? (
                  <CardBubble
                    result={turn.result}
                    onRun={onRun}
                    streaming={isStreaming}
                    onStreamDone={() => onStreamDone(turn.id)}
                    onTick={scrollToBottomIfNear}
                    checkpoints={turn.checkpoints}
                    lensLabel={showLens ? roleLabel : undefined}
                    lensText={showLens ? ROLE_LENS[role] : undefined}
                  />
                ) : (
                  <div className="message-body">
                    <ThinkingBlock checkpoints={turn.checkpoints ?? []} done />
                    {showLens && (
                      <div className="role-lens">
                        <span className="lens-chip">{roleLabel} 视角</span>
                        <p>{ROLE_LENS[role]}</p>
                      </div>
                    )}
                    <div className="message-meta">
                      <span className="message-role">NovaPilot · 科研咨询助手</span>
                    </div>
                    {isStreaming ? (
                      <StreamingText
                        className="agent-summary chat-reply"
                        text={turn.text ?? ""}
                        onDone={() => onStreamDone(turn.id)}
                        onTick={scrollToBottomIfNear}
                      />
                    ) : (
                      <Markdown className="agent-summary chat-reply" text={turn.text ?? ""} />
                    )}
                    {/* 聊天型回复不自动落卡;由用户判断是否正式化(研究问题仍自动落卡) */}
                    {showLens && !isPending && (
                      <button
                        type="button"
                        className="formalize-btn"
                        onClick={() => onRun("standard", "请基于已确认项目事实生成正式决策卡。", "生成决策卡")}
                      >
                        <FilePlus2 size={13} aria-hidden="true" /> 生成决策卡
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })
        )}

        {isPending && (
          <article className="message agent-message reveal" key="pending">
            <div className="agent-seal"><Sparkles size={17} /></div>
            <div className="message-body">
              {/* 思考中折叠条:默认收起,点击箭头展开编排思考过程 */}
              <div role="status" aria-live="polite">
                <ThinkingBlock checkpoints={progress} done={false} />
              </div>
            </div>
          </article>
        )}
        <div className="thread-end" aria-hidden="true" />
      </section>

      <form className="composer" onSubmit={submit}>
        <div className="composer-tools">
          <button type="button" aria-label="插入示例问题" title="插入示例问题" onClick={insertExample}>
            <Lightbulb size={17} />
          </button>
          <span>Enter 发送 · Ctrl+Enter 换行 · 敏感内容在私有环境处理</span>
        </div>
        <textarea
          ref={composerRef}
          aria-label="科研问题"
          placeholder="提出科研问题，或输入“证据冲突”体验强制转接；打招呼也没问题…（Enter 发送，Ctrl+Enter 换行）"
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            autosize();
          }}
          onKeyDown={onComposerKeyDown}
        />
        <button
          type="submit"
          className="send-button"
          aria-label="发送"
          disabled={isPending || !prompt.trim()}
        >
          {isPending ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={18} />}
        </button>
      </form>
    </main>
  );
}
