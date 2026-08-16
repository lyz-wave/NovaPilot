"use client";

import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  BookOpenCheck,
  Braces,
  Check,
  CircleAlert,
  Clock3,
  FileDiff,
  FlaskConical,
  Inbox,
  Loader2,
  MessageSquareText,
  RotateCcw,
  UserRoundCheck,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ExpertCase, ProjectFacts } from "@/domain/consultation-journey";

/** One persisted expert case with its project + creation time (client-safe). */
export interface ExpertCaseRecord {
  projectId: string;
  createdAt: string;
  expertCase: ExpertCase;
}

interface ExpertWorkbenchProps {
  initialCases: ExpertCaseRecord[];
}

const AUTH = "Bearer demo-research-session";
const WRITE_HEADERS = () => ({
  authorization: AUTH,
  "content-type": "application/json",
  "x-tenant-id": "novapilot-demo",
  "x-idempotency-key": crypto.randomUUID(),
  "if-match": '"v3"',
});

const STATUS_LABEL: Record<ExpertCase["status"], string> = {
  "awaiting-claim": "待认领",
  claimed: "已认领",
  resolved: "已解决",
};
const RISK_LABEL: Record<string, string> = { high: "高", medium: "中", low: "低" };

const DEFAULT_AMENDMENT =
  "建议先选择 2 份代表性样本进行试建库；若文库复杂度与插入片段分布达到门槛，再批量进入链特异性总 RNA 路线。其余样本保留低输入捕获作为备选。";

/** SLA 剩余分钟数(自认领起算;未认领返回 null)。 */
function slaRemaining(claimedAt: string | undefined, claimMinutes: number): number | null {
  if (!claimedAt) return null;
  const left = new Date(claimedAt).getTime() + claimMinutes * 60000 - Date.now();
  return Math.max(0, Math.round(left / 60000));
}

/** 队列按风险排序:高 > 中 > 低。 */
const RISK_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** 批准后四道门禁预览(与知识进化页一致)。 */
const GATE_STEPS = ["生成候选知识", "Owner 审核", "NovaBench", "人工批准", "5% 灰度"];

function factChips(facts: ProjectFacts): string[] {
  const chips: string[] = [];
  if (facts.sampleCount != null) chips.push(`样本 ${facts.sampleCount} 份`);
  if (facts.dv200 != null) chips.push(`DV200 ${facts.dv200}%`);
  if (facts.rnaInputNg != null) chips.push(`RNA 投入 ${facts.rnaInputNg} ng`);
  if (facts.material) chips.push(facts.material);
  if (facts.species) chips.push(facts.species);
  if (facts.goal) chips.push(facts.goal);
  return chips;
}

export function ExpertWorkbench({ initialCases }: ExpertWorkbenchProps) {
  const [cases, setCases] = useState<ExpertCaseRecord[]>(initialCases);
  const [activeId, setActiveId] = useState<string>(initialCases[0]?.expertCase.id ?? "");
  const [amendment, setAmendment] = useState(DEFAULT_AMENDMENT);
  const [makeCandidate, setMakeCandidate] = useState(true);
  const [busy, setBusy] = useState<null | "claim" | "return" | "approve">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queueFilter, setQueueFilter] = useState<"all" | "awaiting" | "mine" | "resolved">("all");
  const [excludedEvidence, setExcludedEvidence] = useState<Set<string>>(new Set());
  const [resolvedDecisions, setResolvedDecisions] = useState<Set<number>>(new Set());
  const [noticeLink, setNoticeLink] = useState(false);

  const active = cases.find((c) => c.expertCase.id === activeId) ?? cases[0] ?? null;
  // 队列分组与排序(风险优先)
  const queueCases = useMemo(() => {
    const filtered = cases.filter((c) => {
      if (queueFilter === "all") return true;
      if (queueFilter === "awaiting") return c.expertCase.status === "awaiting-claim";
      if (queueFilter === "mine") return c.expertCase.status === "claimed";
      return c.expertCase.status === "resolved";
    });
    return [...filtered].sort(
      (a, b) =>
        (RISK_ORDER[a.expertCase.handoff.riskLevel] ?? 9) -
        (RISK_ORDER[b.expertCase.handoff.riskLevel] ?? 9),
    );
  }, [cases, queueFilter]);
  const awaitingCount = cases.filter((c) => c.expertCase.status === "awaiting-claim").length;
  const claimed = active?.expertCase.status === "claimed";
  const resolved = active?.expertCase.status === "resolved";

  function replaceCase(next: ExpertCaseRecord | null) {
    if (!next) return;
    setCases((prev) =>
      prev.map((c) => (c.expertCase.id === next.expertCase.id ? next : c)),
    );
  }

  async function act(
    action: "claim" | "return" | "approve",
    extra: Record<string, unknown> = {},
  ) {
    if (!active) return;
    setBusy(action);
    setNotice(null);
    setNoticeLink(false);
    try {
      const res = await fetch("/api/expert-cases", {
        method: "POST",
        headers: WRITE_HEADERS(),
        body: JSON.stringify({ action, caseId: active.expertCase.id, ...extra }),
      });
      if (!res.ok) throw new Error(`操作失败：${res.status}`);
      const data = (await res.json()) as {
        case: ExpertCaseRecord | null;
        candidate?: { id: string } | null;
      };
      replaceCase(data.case);
      if (action === "claim") setNotice("已认领本案例，可以开始修订与批准。");
      else if (action === "return") setNotice("已退回队列，附上补充条件说明。");
      else {
        setNotice(
          data.candidate
            ? `已批准并生成候选知识 ${data.candidate.id},进入门禁流程。`
            : "已批准为正式决策卡。",
        );
        setNoticeLink(Boolean(data.candidate));
      }
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Empty queue (shouldn't happen — the page seeds one — but stay graceful).
  if (!active) {
    return (
      <main className="expert-page page-surface">
        <header className="page-heading">
          <div>
            <span className="eyebrow">EXPERT RESOLUTION DESK</span>
            <h1>队列暂无待处理案例。</h1>
            <p>当主台出现强制转接时，交接包会自动出现在这里。</p>
          </div>
        </header>
      </main>
    );
  }

  const handoff = active.expertCase.handoff;

  return (
    <main className="expert-page page-surface">
      <header className="page-heading">
        <div>
          <span className="eyebrow">EXPERT RESOLUTION DESK</span>
          <h1>接手判断，不必重问一遍。</h1>
          <p>一次性交接包把客户目标、项目事实、证据冲突与待决策项放在同一张桌面上。</p>
        </div>
        <div className="shift-card">
          <span className="signal-dot" />
          <div><strong>转录组专家组</strong><small>队列 {cases.length} · 待认领 {awaitingCount} · 已解决 {cases.length - awaitingCount - cases.filter((c) => c.expertCase.status === "claimed").length}</small></div>
        </div>
      </header>

      <div className="expert-layout">
        <aside className="case-queue">
          <div className="queue-head"><Inbox size={15} /><strong>转接队列</strong><span>{cases.length}</span></div>
          <div className="queue-filters" role="group" aria-label="队列过滤">
            {([
              ["all", "全部"],
              ["awaiting", "待认领"],
              ["mine", "我的待办"],
              ["resolved", "已解决"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                className={queueFilter === key ? "active" : ""}
                aria-pressed={queueFilter === key}
                onClick={() => setQueueFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {queueCases.map((item) => {
            const remaining = slaRemaining(item.expertCase.claimedAt, item.expertCase.sla.claimMinutes);
            return (
              <button
                className={item.expertCase.id === active.expertCase.id ? "active" : ""}
                key={item.expertCase.id}
                aria-current={item.expertCase.id === active.expertCase.id ? "true" : undefined}
                onClick={() => setActiveId(item.expertCase.id)}
              >
                <div>
                  <span>{item.expertCase.id}</span>
                  <em>风险 {RISK_LABEL[item.expertCase.handoff.riskLevel] ?? item.expertCase.handoff.riskLevel}</em>
                </div>
                <strong>{item.expertCase.handoff.objective}</strong>
                <small>
                  <Clock3 size={11} /> {STATUS_LABEL[item.expertCase.status]}
                  {item.expertCase.status === "claimed" && remaining !== null && (
                    <em className="sla-left">SLA 剩余 {remaining} 分钟</em>
                  )}
                </small>
              </button>
            );
          })}
          {queueCases.length === 0 && <p className="queue-empty">该分组暂无案例。</p>}
        </aside>

        <section className="case-canvas">
          <div className="case-topline">
            <div>
              <span className="case-id">
                {active.expertCase.id} · {STATUS_LABEL[active.expertCase.status]}
                {active.expertCase.claimedAt && (
                  <> · 认领 {new Date(active.expertCase.claimedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</>
                )}
              </span>
              <h2>{handoff.objective}</h2>
            </div>
            <button
              className={claimed || resolved ? "claimed primary-action" : "primary-action"}
              disabled={busy !== null || claimed || resolved}
              onClick={() => act("claim")}
            >
              {busy === "claim" ? (
                <><Loader2 size={15} className="spin" /> 认领中…</>
              ) : claimed || resolved ? (
                <><Check size={15} /> 已由你认领</>
              ) : (
                <><UserRoundCheck size={15} /> 认领案例</>
              )}
            </button>
          </div>

          <p className="edit-scope-note">
            可编辑:待决策项勾选 · 证据采用/排除 · 专家修订文本;交接包为 AI 审计记录,保持只读。
          </p>
          {notice && (
            <p className="case-notice" role="status" aria-live="polite">
              <CircleAlert size={13} /> {notice}
              {noticeLink && (
                <Link className="notice-link" href="/knowledge">前往知识进化推进晋级 →</Link>
              )}
            </p>
          )}
          {active.expertCase.returnNote && (
            <p className="case-notice returned"><RotateCcw size={13} /> 上次退回：{active.expertCase.returnNote}</p>
          )}

          <div className="handoff-grid">
            <article>
              <span className="card-kicker"><FlaskConical size={13} /> 客户目标</span>
              <strong>{handoff.objective}</strong>
              <p className="fact-chips">
                {factChips(handoff.confirmedFacts).map((chip) => (
                  <span key={chip}>{chip}</span>
                ))}
              </p>
            </article>
            <article>
              <span className="card-kicker"><CircleAlert size={13} /> 转接原因</span>
              <strong>{handoff.reason}</strong>
              <p>风险等级 {RISK_LABEL[handoff.riskLevel] ?? handoff.riskLevel}；AI 已停止最终建议。</p>
            </article>
            <article>
              <span className="card-kicker"><MessageSquareText size={13} /> AI 已尝试</span>
              <strong>{handoff.attemptedAction}</strong>
              <p>结论级证据未达到正式卡门禁，转交专家判断。</p>
            </article>
            <article>
              <span className="card-kicker"><BookOpenCheck size={13} /> 待决策项 · 可勾选</span>
              {handoff.decisionsNeeded.length > 0 ? (
                <>
                  <ul className="decision-checklist">
                    {handoff.decisionsNeeded.map((decision, index) => (
                      <li key={decision}>
                        <label>
                          <input
                            type="checkbox"
                            checked={resolvedDecisions.has(index)}
                            disabled={resolved}
                            onChange={() =>
                              setResolvedDecisions((prev) => {
                                const next = new Set(prev);
                                if (next.has(index)) next.delete(index);
                                else next.add(index);
                                return next;
                              })
                            }
                          />
                          <span className={resolvedDecisions.has(index) ? "done" : ""}>{decision}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <p>
                    {resolvedDecisions.size}/{handoff.decisionsNeeded.length} 项已解决
                    {resolvedDecisions.size === handoff.decisionsNeeded.length && " · 可批准"}
                  </p>
                </>
              ) : (
                <p>无待决策项。</p>
              )}
            </article>
          </div>

          {handoff.evidenceConflict && (
            <section className="conflict-board">
              <div className="conflict-column">
                <span className="source-type">INTERNAL SOP · v6.2</span>
                <h3>DV200 &lt; 40% 建议进入试建库路径</h3>
                <p>正式项目启动前以 2 份代表样本验证文库复杂度和插入片段分布。</p>
                <small>NV-SOP-RNA-042 · 有效至 2027-03-31</small>
              </div>
              <div className="conflict-axis">
                <FileDiff size={20} />
                <span>适用边界冲突</span>
              </div>
              <div className="conflict-column external">
                <span className="source-type">SCI · PMID 35361992</span>
                <h3>部分 DV200 30–40% 样本可直接进入捕获路线</h3>
                <p>但研究条件未覆盖当前固定方式与 RNA 投入量组合。</p>
                <small>外部方法证据 · DOI/PMID 已核验</small>
              </div>
            </section>
          )}

          {(handoff.evidence?.length ?? 0) > 0 && (
            <section className="evidence-review">
              <div className="review-head">
                <span className="card-kicker"><Braces size={13} /> 证据审查</span>
                <small>默认全部采用 · 可排除不适用的证据(排除项将不进入候选知识)</small>
              </div>
              {handoff.evidence!.map((ev) => {
                const excluded = excludedEvidence.has(ev.id);
                return (
                  <label key={ev.id} className={"evidence-check-row " + (excluded ? "excluded" : "")}>
                    <input
                      type="checkbox"
                      checked={!excluded}
                      onChange={() =>
                        setExcludedEvidence((prev) => {
                          const next = new Set(prev);
                          if (next.has(ev.id)) next.delete(ev.id);
                          else next.add(ev.id);
                          return next;
                        })
                      }
                    />
                    <div>
                      <strong>{ev.title}</strong>
                      <code>{ev.citation} · v{ev.version}</code>
                      <small>
                        适用 {ev.appliesTo} · 有效至 {ev.validUntil} ·{" "}
                        {ev.validation === "verified" ? "已核验" : "存在冲突"}
                      </small>
                    </div>
                  </label>
                );
              })}
            </section>
          )}

          <section className="expert-decision">
            <div>
              <span className="eyebrow">EXPERT AMENDMENT</span>
              <h3>专家修订</h3>
            </div>
            <ol className="gate-preview" aria-label="批准后门禁流程">
              {GATE_STEPS.map((step, index) => (
                <li key={step} className={index === 0 ? "current" : ""}>
                  <i>{index + 1}</i>
                  {step}
                </li>
              ))}
            </ol>
            <p className="gate-preview-note">
              专家批准只生成候选知识;进入生产须通过 Owner、NovaBench、人工批准与 5% 灰度全部门禁。
            </p>
            <textarea
              aria-label="专家修订内容"
              value={amendment}
              onChange={(event) => setAmendment(event.target.value)}
              disabled={resolved}
            />
            <div className="decision-controls">
              <label>
                <input
                  type="checkbox"
                  checked={makeCandidate}
                  onChange={(event) => setMakeCandidate(event.target.checked)}
                  disabled={resolved}
                />{" "}
                生成候选知识（不自动进入生产）
              </label>
              <div>
                <button
                  className="secondary-action"
                  disabled={busy !== null || resolved}
                  onClick={() => act("return", { note: amendment })}
                >
                  {busy === "return" ? <><Loader2 size={14} className="spin" /> 退回中…</> : "退回补充条件"}
                </button>
                <button
                  className="primary-action"
                  disabled={busy !== null || !claimed || resolved || !amendment.trim()}
                  onClick={() => {
                    const decided = handoff.decisionsNeeded.filter((_, index) =>
                      resolvedDecisions.has(index),
                    );
                    const finalAmendment =
                      decided.length > 0
                        ? `${amendment}\n已解决待决策项:${decided.join("、")}`
                        : amendment;
                    // 候选证据 = 交接包证据 - 专家在证据审查中排除的条目,按引文去重。
                    const approvedEvidence = Array.from(
                      new Set(
                        (handoff.evidence ?? [])
                          .filter((ev) => !excludedEvidence.has(ev.id))
                          .map((ev) => ev.citation),
                      ),
                    );
                    act("approve", {
                      amendment: finalAmendment,
                      createCandidate: makeCandidate,
                      evidenceIds: approvedEvidence,
                    });
                  }}
                >
                  {busy === "approve" ? (
                    <><Loader2 size={15} className="spin" /> 批准中…</>
                  ) : resolved ? (
                    <><BadgeCheck size={15} /> 已批准</>
                  ) : (
                    <>批准正式决策卡 <ArrowRight size={15} /></>
                  )}
                </button>
              </div>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
