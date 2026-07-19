"use client";

import { ArrowUp, BookOpen, Braces, CircleAlert, Languages, LoaderCircle, Paperclip, Sparkles } from "lucide-react";
import { FormEvent, useState } from "react";
import {
  inferScenarioFromQuestion,
  type ConsultationResult,
  type Locale,
  type Scenario,
} from "@/domain/consultation-journey";

interface ConsultationThreadProps {
  result: ConsultationResult;
  locale: Locale;
  scenario: Scenario;
  isPending: boolean;
  onRun: (scenario: Scenario, prompt?: string) => void;
  onLocaleChange: (locale: Locale) => void;
}

const scenarios: Array<{ id: Scenario; label: string; hint: string }> = [
  { id: "standard", label: "标准方案", hint: "DV200 充足" },
  { id: "missing-dv200", label: "条件缺失", hint: "触发追问" },
  { id: "evidence-conflict", label: "证据冲突", hint: "强制转接" },
];

export function ConsultationThread({
  result,
  locale,
  scenario,
  isPending,
  onRun,
  onLocaleChange,
}: ConsultationThreadProps) {
  const [prompt, setPrompt] = useState("");
  const statusLabel =
    result.card.status === "formal"
      ? "可形成正式决策卡"
      : result.card.status === "expert-review"
        ? "已进入专家待审"
        : "需要补充条件";

  function submit(event: FormEvent) {
    event.preventDefault();
    const inferred = inferScenarioFromQuestion(prompt, result.project.facts);
    onRun(inferred, prompt);
    setPrompt("");
  }

  return (
    <main className="consultation-column">
      <div className="consultation-head">
        <div>
          <span className="eyebrow">CONSULTATION / FFPE-RNA-042</span>
          <h1>把科研问题，变成可审计的决定。</h1>
        </div>
        <div className="language-switcher" aria-label="咨询语言">
          <Languages size={14} />
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
      </div>

      <div className="scenario-strip" aria-label="演示场景">
        {scenarios.map((item) => (
          <button
            className={scenario === item.id ? "active" : ""}
            key={item.id}
            onClick={() => onRun(item.id)}
          >
            <span>{item.label}</span>
            <small>{item.hint}</small>
          </button>
        ))}
      </div>

      <section className="thread" aria-live="polite">
        <article className="message user-message reveal">
          <div className="message-index">01</div>
          <div>
            <span className="message-role">你 · 研究生</span>
            <p>
              我们有 24 份 FFPE 肿瘤样本，想做 RNA 表达谱和差异分析。
              当前 DV200 为 {result.project.facts.dv200 ?? "未知"}%，请帮我比较建库路线和测序平台。
            </p>
          </div>
        </article>

        <article className="message agent-message reveal delay-1">
          <div className="agent-seal"><Sparkles size={17} /></div>
          <div className="message-body">
            <div className="message-meta">
              <span className="message-role">NovaPilot · 科研咨询编排</span>
              <span className={`assurance ${result.card.risk.level}`}>
                {result.card.risk.mandatoryEscalation ? <CircleAlert size={12} /> : <BookOpen size={12} />}
                {statusLabel}
              </span>
            </div>
            <p className="agent-summary">{result.card.executiveSummary}</p>

            {result.clarifyingQuestions.length > 0 && (
              <div className="clarification-block">
                <span className="block-kicker">最小必要追问 · 1 / 1</span>
                <strong>{result.clarifyingQuestions[0].prompt}</strong>
                <p>{result.clarifyingQuestions[0].reason}</p>
                <div className="inline-actions">
                  <button onClick={() => onRun("standard")}>补充 DV200 = 62%</button>
                  <button className="ghost">暂时不知道</button>
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
        </article>
      </section>

      <form className="composer" onSubmit={submit}>
        <div className="composer-tools">
          <button type="button" aria-label="添加附件"><Paperclip size={17} /></button>
          <span>敏感内容将在私有环境处理</span>
        </div>
        <textarea
          aria-label="科研问题"
          placeholder="继续追问，或输入“证据冲突”体验强制转接…"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button className="send-button" aria-label="发送" disabled={isPending}>
          {isPending ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={18} />}
        </button>
      </form>
    </main>
  );
}
