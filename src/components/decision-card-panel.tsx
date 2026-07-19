"use client";

import {
  ArrowUpRight,
  BadgeCheck,
  BookMarked,
  Check,
  ChevronRight,
  Clock3,
  FileDown,
  GitCompareArrows,
  LockKeyhole,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";
import { useState } from "react";
import type { ConsultationResult } from "@/domain/consultation-journey";

interface DecisionCardPanelProps {
  result: ConsultationResult;
  onConsent: () => Promise<void>;
  onExpertRequest: () => Promise<void>;
  onFeedback: (score: number) => Promise<void>;
}

type Tab = "decision" | "evidence" | "history";

export function DecisionCardPanel({
  result,
  onConsent,
  onExpertRequest,
  onFeedback,
}: DecisionCardPanelProps) {
  const [tab, setTab] = useState<Tab>("decision");
  const [consentState, setConsentState] = useState<"idle" | "done">("idle");
  const [feedbackDone, setFeedbackDone] = useState(false);
  const [expertRequested, setExpertRequested] = useState(false);
  const risk = result.card.risk;
  const statusText = {
    formal: "正式决策卡",
    "expert-review": "专家待审",
    "needs-conditions": "待补充条件",
    draft: "草稿",
    provisional: "暂行决策卡",
    "pi-approved": "PI 已批准",
  }[result.card.status];

  async function consent() {
    await onConsent();
    setConsentState("done");
  }

  return (
    <aside className="decision-panel">
      <div className="decision-topline">
        <span className="eyebrow">SCIENTIFIC DECISION CARD</span>
        <div className="version-chip">v{result.card.version}.0 <GitCompareArrows size={12} /></div>
      </div>

      <div className="decision-title-row">
        <div>
          <h2>{result.card.title}</h2>
          <p>{result.card.id}</p>
        </div>
        <button className="icon-button" aria-label="导出科研决策卡"><FileDown size={17} /></button>
      </div>

      <div className={`card-status risk-${risk.level}`}>
        <span className="status-glyph">
          {risk.mandatoryEscalation ? <ShieldAlert size={18} /> : <BadgeCheck size={18} />}
        </span>
        <div>
          <strong>{statusText}</strong>
          <small>风险 {risk.score}/100 · {risk.signals.join(" / ")}</small>
        </div>
        <span className="evidence-score">{risk.mandatoryEscalation ? "HOLD" : "A2"}</span>
      </div>

      <div className="decision-tabs" role="tablist">
        {([
          ["decision", "方案"],
          ["evidence", `证据 ${result.evidence.length}`],
          ["history", "版本"],
        ] as const).map(([id, label]) => (
          <button
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            key={id}
            onClick={() => setTab(id)}
            role="tab"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="decision-scroll">
        {tab === "decision" && (
          <div className="tab-content reveal">
            <section className="card-section">
              <span className="section-number">01</span>
              <div>
                <h3>结论摘要</h3>
                <p>{result.card.executiveSummary}</p>
              </div>
            </section>

            {result.card.recommendations.length > 0 ? (
              <section className="card-section">
                <span className="section-number">02</span>
                <div className="section-grow">
                  <h3>主方案</h3>
                  {result.card.recommendations.map((recommendation) => (
                    <article className="recommendation" key={recommendation.id}>
                      <div className="recommendation-title">
                        <strong>{recommendation.title}</strong>
                        <span>{recommendation.evidenceIds.length} 项证据</span>
                      </div>
                      <p>{recommendation.rationale}</p>
                      <small>适用边界：{recommendation.boundary}</small>
                    </article>
                  ))}
                </div>
              </section>
            ) : (
              <section className="card-section blocked-section">
                <span className="section-number">02</span>
                <div>
                  <h3>最终建议已暂停</h3>
                  <p>当前卡片只保留已确认事实、证据状态和待决策项。</p>
                  {risk.level === "medium" && (
                    <button
                      className="text-button"
                      disabled={expertRequested}
                      onClick={async () => {
                        await onExpertRequest();
                        setExpertRequested(true);
                      }}
                    >
                      {expertRequested ? "已请求专家复核" : "请求专家复核"}
                    </button>
                  )}
                </div>
              </section>
            )}

            {result.card.alternatives.length > 0 && result.card.serviceFit && (
              <section className="card-section">
                <span className="section-number">03</span>
                <div>
                  <h3>备选与限制</h3>
                  <p>{result.card.alternatives[0]}</p>
                  <small>{result.card.serviceFit.limitations}</small>
                </div>
              </section>
            )}

            {result.card.serviceFit && (
              <section className="service-fit">
                <span className="service-tag">服务适配说明 · 非科学结论</span>
                <strong>{result.card.serviceFit.title}</strong>
                <p>{result.card.serviceFit.rationale}</p>
                <button onClick={consent} disabled={consentState === "done"}>
                  {consentState === "done" ? <><Check size={14} /> 已授权创建商机</> : <>获取方案报价 <ArrowUpRight size={14} /></>}
                </button>
                <small><LockKeyhole size={11} /> 只有点击后才会写入 CRM</small>
              </section>
            )}

            <section className="card-section">
              <span className="section-number">04</span>
              <div className="section-grow">
                <h3>资源、待办与协作</h3>
                <dl className="decision-meta-list">
                  {result.card.budgetRange && <div><dt>预算区间</dt><dd>{result.card.budgetRange}</dd></div>}
                  {result.card.timelineRange && <div><dt>周期区间</dt><dd>{result.card.timelineRange}</dd></div>}
                  <div><dt>专家状态</dt><dd>{result.card.expertStatus}</dd></div>
                  <div>
                    <dt>待确认项</dt>
                    <dd>{result.card.pendingItems.length > 0 ? result.card.pendingItems.join("；") : "无"}</dd>
                  </div>
                </dl>
              </div>
            </section>
          </div>
        )}

        {tab === "evidence" && (
          <div className="tab-content evidence-list reveal">
            {result.evidence.map((evidence, index) => (
              <article key={evidence.id}>
                <div className="evidence-head">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div className={`validation ${evidence.validation}`}>
                    {evidence.validation === "verified" ? <Check size={12} /> : <RotateCcw size={12} />}
                    {evidence.validation === "verified" ? "已核验" : "存在冲突"}
                  </div>
                </div>
                <span className="source-type">{evidence.source}</span>
                <h3>{evidence.title}</h3>
                <code>{evidence.citation}</code>
                <dl>
                  <div><dt>版本</dt><dd>{evidence.version}</dd></div>
                  <div><dt>适用</dt><dd>{evidence.appliesTo}</dd></div>
                  <div><dt>有效至</dt><dd>{evidence.validUntil}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        )}

        {tab === "history" && (
          <div className="tab-content version-history reveal">
            {[
              ["v3.0", "当前版本", "补充 DV200；Reviewer 通过", "刚刚"],
              ["v2.0", "已替代", "完成证据绑定与风险分级", "12 分钟前"],
              ["v1.0", "已替代", "从客户方案书提取项目事实", "19 分钟前"],
            ].map(([version, state, note, time], index) => (
              <article key={version}>
                <div className={`timeline-dot ${index === 0 ? "current" : ""}`} />
                <div>
                  <div className="version-title"><strong>{version}</strong><span>{state}</span></div>
                  <p>{note}</p>
                  <small><Clock3 size={11} /> {time}</small>
                </div>
                <ChevronRight size={15} />
              </article>
            ))}
          </div>
        )}
      </div>

      <footer className="decision-footer">
        <div>
          <BookMarked size={14} />
          <span>这张决策卡有帮助吗？</span>
        </div>
        <div className="feedback-actions">
          {feedbackDone ? (
            <span className="feedback-thanks"><Check size={12} /> 已记录</span>
          ) : (
            <>
              <button onClick={async () => { await onFeedback(5); setFeedbackDone(true); }}>有帮助</button>
              <button onClick={async () => { await onFeedback(1); setFeedbackDone(true); }}>需改进</button>
            </>
          )}
        </div>
      </footer>
    </aside>
  );
}
