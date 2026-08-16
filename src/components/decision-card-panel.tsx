"use client";

import {
  ArrowUpRight,
  BadgeCheck,
  BookMarked,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileDown,
  FileText,
  GitCompareArrows,
  GraduationCap,
  Headset,
  LockKeyhole,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { CardVersionMeta, ClientRole, ConsultationResult } from "@/domain/consultation-journey";
import { Markdown } from "./markdown";

const STATUS_LABELS: Record<string, string> = {
  formal: "正式决策卡",
  "expert-review": "专家待审",
  "needs-conditions": "待补充条件",
  draft: "草稿",
  provisional: "暂行决策卡",
  "pi-approved": "PI 已批准",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** Format an ISO timestamp for the version timeline (empty → ""). */
function formatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("zh-CN", { hour12: false });
}

/** Trigger a client-side file download (offline-safe; no server round-trip). */
function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Render a decision card as a human-readable Markdown doc with a JSON appendix. */
function cardToMarkdown(result: ConsultationResult): string {
  const c = result.card;
  const lines: string[] = [];
  lines.push(`# ${c.title}`);
  lines.push(`> ${c.id} · v${c.version}.0 · ${statusLabel(c.status)} · trace ${result.traceId}`);
  lines.push("");
  lines.push("## 结论摘要");
  lines.push(c.executiveSummary);
  lines.push("");
  if (c.recommendations.length > 0) {
    lines.push("## 主方案");
    for (const r of c.recommendations) {
      lines.push(`### ${r.title}（${r.evidenceIds.length} 项证据）`);
      lines.push(r.rationale);
      lines.push(`- 适用边界：${r.boundary}`);
      lines.push("");
    }
  }
  if (c.alternatives.length > 0) {
    lines.push("## 备选与限制");
    for (const alt of c.alternatives) lines.push(`- ${alt}`);
    if (c.serviceFit) lines.push(`- 限制：${c.serviceFit.limitations}`);
    lines.push("");
  }
  lines.push("## 风险分级");
  lines.push(`风险 ${c.risk.score}/100 · ${c.risk.level} · ${c.risk.signals.join(" / ")}`);
  lines.push("");
  lines.push(`## 证据（${result.evidence.length} 条）`);
  result.evidence.forEach((e, i) => {
    const mark = e.validation === "verified" ? "已核验" : "存在冲突";
    lines.push(`${i + 1}. [${mark}] ${e.title} — ${e.citation}（${e.appliesTo}，有效至 ${e.validUntil}）`);
  });
  lines.push("");
  lines.push("## 资源、待办与协作");
  if (c.budgetRange) lines.push(`- 预算区间：${c.budgetRange}`);
  if (c.timelineRange) lines.push(`- 周期区间：${c.timelineRange}`);
  lines.push(`- 专家状态：${c.expertStatus}`);
  lines.push(`- 待确认项：${c.pendingItems.length > 0 ? c.pendingItems.join("；") : "无"}`);
  lines.push("");
  lines.push("---");
  lines.push("```json");
  lines.push(JSON.stringify(result, null, 2));
  lines.push("```");
  return lines.join("\n");
}

interface DecisionCardPanelProps {
  result: ConsultationResult | null;
  /** 客户角色:博士后视角的新决策卡默认打开“证据”标签页(文献对比优先)。 */
  role?: ClientRole;
  /** 面板收起状态与切换(收起为细条,给咨询区留空间)。 */
  collapsed: boolean;
  onToggleCollapse: () => void;
  onConsent: () => Promise<void>;
  onExpertRequest: () => Promise<void>;
  onFeedback: (score: number) => Promise<void>;
}

type Tab = "decision" | "evidence" | "history";

export function DecisionCardPanel({
  result,
  role,
  collapsed,
  onToggleCollapse,
  onConsent,
  onExpertRequest,
  onFeedback,
}: DecisionCardPanelProps) {
  const [tab, setTab] = useState<Tab>("decision");
  const [consentState, setConsentState] = useState<"idle" | "done">("idle");
  const [feedbackDone, setFeedbackDone] = useState(false);
  const [expertRequested, setExpertRequested] = useState(false);
  const [versions, setVersions] = useState<CardVersionMeta[]>([]);
  const [exported, setExported] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [highlightedEvidence, setHighlightedEvidence] = useState<string | null>(null);
  const tabsId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /** 决策卡 Tab:方向键在 tab 间移动焦点(roving tabindex)。 */
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = tabRefs.current.length;
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % count;
    else if (event.key === "ArrowLeft") next = (index - 1 + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    if (next === -1) return;
    event.preventDefault();
    tabRefs.current[next]?.focus();
    setTab(tabRefs.current[next]?.dataset.tab as Tab);
  }

  // Load the real persisted version history for this card's project. Falls back
  // to a single row synthesized from the live card when offline or empty, so the
  // version tab always shows real card data (never a hardcoded timeline).
  useEffect(() => {
    // 新卡片 = 新的交互周期:导出/授权/反馈/专家请求状态全部复位。
    setExported(false);
    setConsentState("idle");
    setFeedbackDone(false);
    setExpertRequested(false);
    setGlossaryOpen(false);
    // 角色视角:博士后默认落在“证据”标签页(文献对比优先)。
    setTab(role === "postdoc" ? "evidence" : "decision");
    if (!result) {
      setVersions([]);
      return;
    }
    const projectId = result.project.id;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/cards?projectId=${encodeURIComponent(projectId)}`, {
          headers: { authorization: "Bearer demo-research-session" },
        });
        if (res.ok) {
          const data = (await res.json()) as { versions: CardVersionMeta[] };
          if (!cancelled && data.versions.length > 0) {
            setVersions(data.versions);
            return;
          }
        }
      } catch {
        /* fall through to the local fallback */
      }
      if (!cancelled) {
        setVersions([
          {
            version: result.card.version,
            status: result.card.status,
            title: result.card.title,
            traceId: result.traceId,
            createdAt: "",
          },
        ]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [result]);

  // 高亮定位:证据 Tab 渲染后把目标证据卡滚入可视区。(必须在提前返回之前,保证 hook 数量稳定)
  useEffect(() => {
    if (tab !== "evidence" || !highlightedEvidence) return;
    const timer = window.setTimeout(() => {
      document
        .querySelector(".evidence-list article.highlighted")
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [tab, highlightedEvidence]);

  // 收起态:细条 + 展开按钮。
  if (collapsed) {
    return (
      <aside className="decision-panel panel-collapsed" aria-label="决策卡面板(已收起)">
        <button className="panel-expand" aria-label="展开决策卡" title="展开决策卡" onClick={onToggleCollapse}>
          <FileText size={16} aria-hidden="true" />
          <span className="vertical-label">决策卡</span>
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
      </aside>
    );
  }

  // No card yet (fresh conversation, or only chit-chat so far).
  if (!result) {
    return (
      <aside className="decision-panel decision-panel-empty">
        <div className="decision-topline">
          <span className="eyebrow">SCIENTIFIC DECISION CARD</span>
        </div>
        <div className="decision-empty">
          <span className="decision-empty-icon"><FileText size={22} /></span>
          <strong>还没有决策卡</strong>
          <p>
            提出一个具体的科研问题（例如 FFPE RNA 建库路线与测序平台选择），
            NovaPilot 会在这里生成一张带证据链、风险分级与服务适配说明的可审计决策卡。
          </p>
          <div className="decision-empty-card" aria-hidden="true">
            <span>AWAITING EVIDENCE · 等待证据</span>
            <i />
            <i className="short" />
          </div>
        </div>
      </aside>
    );
  }

  const risk = result.card.risk;
  const statusText = statusLabel(result.card.status);

  /** 证据芯片跳转:切到“证据”Tab,高亮并滚动定位到对应证据卡。 */
  function jumpToEvidence(id: string) {
    setTab("evidence");
    setHighlightedEvidence(id);
  }

  /** 导出决策卡(Markdown + JSON),图标按钮与博后视角动作共用。 */
  function handleExport() {
    downloadFile(
      `${result!.card.id}.md`,
      cardToMarkdown(result!),
      "text/markdown;charset=utf-8",
    );
    setExported(true);
  }

  async function consent() {
    await onConsent();
    setConsentState("done");
  }

  return (
    <aside className="decision-panel">
      <button
        className="panel-collapse-btn"
        aria-label="收起决策卡"
        title="收起决策卡"
        onClick={onToggleCollapse}
      >
        <ChevronRight size={14} aria-hidden="true" />
      </button>
      <div className="decision-topline">
        <span className="eyebrow">SCIENTIFIC DECISION CARD</span>
        <div className="version-chip">v{result.card.version}.0 <GitCompareArrows size={12} /></div>
      </div>

      <div className="decision-title-row">
        <div>
          <h2>{result.card.title}</h2>
          <p>{result.card.id}</p>
        </div>
        <button
          className="icon-button"
          aria-label="导出科研决策卡"
          title="导出决策卡（Markdown + JSON）"
          onClick={handleExport}
        >
          {exported ? <Check size={17} /> : <FileDown size={17} />}
        </button>
      </div>

      <div className={`card-status risk-${risk.level}`}>
        <span className="status-glyph">
          {risk.mandatoryEscalation ? <ShieldAlert size={18} /> : <BadgeCheck size={18} />}
        </span>
        <div className="status-main">
          <strong>{statusText}</strong>
          <small>风险 {risk.score}/100 · {risk.signals.join(" / ")}</small>
          <span className="risk-gauge" aria-label={`风险分数 ${risk.score}/100`}>
            <i style={{ width: `${Math.max(4, Math.min(100, risk.score))}%` }} />
          </span>
        </div>
        <span className="evidence-score">{risk.mandatoryEscalation ? "HOLD" : "A2"}</span>
      </div>

      <div className="decision-tabs" role="tablist" aria-label="决策卡分区">
        {([
          ["decision", "方案"],
          ["evidence", `证据 ${result.evidence.length}`],
          ["history", "版本"],
        ] as const).map(([id, label], index) => (
          <button
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            role="tab"
            id={`${tabsId}-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`${tabsId}-panel-${id}`}
            className={tab === id ? "active" : ""}
            data-tab={id}
            key={id}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => {
              setTab(id);
              setHighlightedEvidence(null); // 手动切换时清除证据高亮
            }}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="decision-scroll">
        {tab === "decision" && (
          <div
            className="tab-content reveal"
            role="tabpanel"
            id={`${tabsId}-panel-decision`}
            aria-labelledby={`${tabsId}-tab-decision`}
            tabIndex={0}
          >
            <section className="card-section">
              <span className="section-number">01</span>
              <div>
                <h3>结论摘要</h3>
                <Markdown text={result.card.executiveSummary} />
              </div>
            </section>

            {result.card.recommendations.length > 0 ? (
              <section className="card-section">
                <span className="section-number">02</span>
                <div className="section-grow">
                  <h3>主方案</h3>
                  {result.card.recommendations.map((recommendation, recIndex) => (
                    <article className="recommendation" key={recommendation.id}>
                      <div className="recommendation-title">
                        <span className="recommendation-num">{String(recIndex + 1).padStart(2, "0")}</span>
                        <strong>{recommendation.title}</strong>
                        <span>{recommendation.evidenceIds.length} 项证据</span>
                      </div>
                      <Markdown text={recommendation.rationale} />
                      <small>适用边界：{recommendation.boundary}</small>
                      <div className="recommendation-evidence">
                        {recommendation.evidenceIds.map((evidenceId) => {
                          const target = result.evidence.find(
                            (item) => item.id === evidenceId || item.citation === evidenceId,
                          );
                          return (
                            <button
                              type="button"
                              key={evidenceId}
                              className="evidence-chip"
                              title={target ? `查看证据:${target.title}` : evidenceId}
                              onClick={() => jumpToEvidence(evidenceId)}
                            >
                              {evidenceId}
                            </button>
                          );
                        })}
                      </div>
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

            {result.card.advisoryConfirmations && result.card.advisoryConfirmations.length > 0 && (
              <section className="card-section">
                <span className="section-number">2b</span>
                <div className="section-grow">
                  <h3>下一步需客户确认的事项</h3>
                  <ul className="confirm-list">
                    {result.card.advisoryConfirmations.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                  <small>以下为围绕推荐路线的适用边界所需的补充确认项，不影响当前结论成立。</small>
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
          <div
            className="tab-content evidence-list reveal"
            role="tabpanel"
            id={`${tabsId}-panel-evidence`}
            aria-labelledby={`${tabsId}-tab-evidence`}
            tabIndex={0}
          >
            {result.evidence.map((evidence, index) => (
              <article
                key={evidence.id}
                id={`evidence-${evidence.id}`}
                className={
                  highlightedEvidence &&
                  (highlightedEvidence === evidence.id || highlightedEvidence === evidence.citation)
                    ? "highlighted"
                    : ""
                }
              >
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
          <div
            className="tab-content version-history reveal"
            role="tabpanel"
            id={`${tabsId}-panel-history`}
            aria-labelledby={`${tabsId}-tab-history`}
            tabIndex={0}
          >
            {versions.map((entry, index) => (
              <article key={entry.version}>
                <div className={`timeline-dot ${index === 0 ? "current" : ""}`} />
                <div>
                  <div className="version-title">
                    <strong>v{entry.version}.0</strong>
                    <span>{index === 0 ? "当前版本" : "已替代"}</span>
                  </div>
                  <p>{entry.title} · {statusLabel(entry.status)}</p>
                  <small>
                    <Clock3 size={11} />{" "}
                    {formatTime(entry.createdAt) || `trace ${entry.traceId.slice(-7)}`}
                  </small>
                </div>
              </article>
            ))}
            {versions.length === 0 && <p className="version-empty">暂无版本记录。</p>}
          </div>
        )}
      </div>

      {/* 角色化动作区:同一张卡,四个角色的主动作不同(结论不变) */}
      {role === "pi" && (
        <div className="role-actions">
          <button
            disabled={expertRequested}
            onClick={async () => {
              await onExpertRequest();
              setExpertRequested(true);
            }}
          >
            <Headset size={14} aria-hidden="true" /> {expertRequested ? "已预约专家复核" : "预约专家复核"}
          </button>
        </div>
      )}

      {role === "postdoc" && (
        <div className="role-actions">
          <button onClick={handleExport}>
            <FileDown size={14} aria-hidden="true" /> 导出决策卡(复现)
          </button>
        </div>
      )}

      {role === "student" && (
        <div className="role-actions">
          <button aria-expanded={glossaryOpen} onClick={() => setGlossaryOpen((v) => !v)}>
            <GraduationCap size={14} aria-hidden="true" /> 术语卡
          </button>
          {glossaryOpen && (
            <dl className="glossary">
              <div><dt>DV200</dt><dd>片段长度超过 200nt 的 RNA 占比,衡量 FFPE RNA 完整性。</dd></div>
              <div><dt>链特异性建库</dt><dd>保留转录本方向信息,适合降解样本的差异表达研究。</dd></div>
              <div><dt>PE150</dt><dd>双端 150bp 读长,支持基因与转录本层级定量。</dd></div>
            </dl>
          )}
        </div>
      )}

      {role === "rnd" && (
        <div className="sla-note">
          <ShieldCheck size={13} aria-hidden="true" /> SLA:18 天 · 4h 响应 · 数据不出域 · 报价需授权进入 CRM
        </div>
      )}

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
