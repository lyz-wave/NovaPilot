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
  ScanSearch,
  UserRoundCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  // 埋点 C:不勾「生成候选知识」时的必填原因。
  const [noCandidateReason, setNoCandidateReason] = useState("");
  const [busy, setBusy] = useState<null | "claim" | "return" | "approve">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queueFilter, setQueueFilter] = useState<"all" | "awaiting" | "mine" | "resolved">("all");
  const [excludedEvidence, setExcludedEvidence] = useState<Set<string>>(new Set());
  const [resolvedDecisions, setResolvedDecisions] = useState<Set<number>>(new Set());
  const [noticeLink, setNoticeLink] = useState(false);

  const active = cases.find((c) => c.expertCase.id === activeId) ?? cases[0] ?? null;

  // 切换案例必须清空编辑态:修订文本、待决策项勾选(按数组下标存)与证据排除都是
  // “这一个案例”的编辑结果。不清空时,在 A 案勾了第 1、2 项再切到 B 案批准,
  // 提交的会是 A 案的修订文本 + B 案里同下标的待决策项,专家从未审过。
  useEffect(() => {
    setAmendment(DEFAULT_AMENDMENT);
    setResolvedDecisions(new Set());
    setExcludedEvidence(new Set());
    // A 案填的「无候选原因」跟着切到 B 案,就是把 A 案的理由记在 B 案头上。
    setNoCandidateReason("");
    setNotice(null);
    setNoticeLink(false);
  }, [activeId]);
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
              {/*
                埋点 C:不生成候选时必须写一句原因。这不是为了给专家添麻烦 ——
                「本次无可沉淀知识」勾起来零成本,不问原因这一格会被无脑勾满,
                修订回流率就永远是 0%,而看板会以为知识库真的没东西可长。
                写了理由之后,「客户样本类型报错、无方法学结论」和「太忙了」
                在事后是能分开的。
              */}
              {!makeCandidate && !resolved && (
                <label className="no-candidate-reason">
                  <span>未产出候选知识的原因（必填）</span>
                  <input
                    type="text"
                    value={noCandidateReason}
                    maxLength={500}
                    placeholder="例：本单是样本类型填报错误，无可复用的方法学结论"
                    onChange={(event) => setNoCandidateReason(event.target.value)}
                  />
                </label>
              )}
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
                  disabled={
                    busy !== null ||
                    !claimed ||
                    resolved ||
                    !amendment.trim() ||
                    // 埋点 C 的必填项:前端先挡一次,后端(400
                    // NO_CANDIDATE_REASON_REQUIRED)是真正的守门人。
                    (!makeCandidate && !noCandidateReason.trim())
                  }
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
                      noCandidateReason: makeCandidate
                        ? undefined
                        : noCandidateReason.trim(),
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
          <ReviewSampleQueue />
        </section>
      </div>
    </main>
  );
}

// ── 埋点 B · 抽样复核面板 ──────────────────────────────────────────
// 放在专家台而不是运营看板:填这两个判定的人必须是有资格说「这一单本来就能直接答」
// 的人。放到看板上,填的人就会变成看指标的人 —— 那是让被考核者自己打分。

interface ReviewSampleView {
  id: string;
  kind: "intercepted" | "not-escalated";
  projectId: string;
  traceId: string;
  systemAction: string;
  context: Record<string, unknown>;
  judgeVerdict: string | null;
  judgeConfidence: number | null;
  createdAt: string;
}

interface ReviewRateView {
  reviewed: number;
  wrong: number;
  rate: number | null;
  pending: number;
}

interface ReviewSummaryView {
  falseInterception: ReviewRateView;
  missedEscalation: ReviewRateView;
  judgeAgreement: { compared: number; agreed: number; rate: number | null };
}

const KIND_LABEL: Record<ReviewSampleView["kind"], string> = {
  intercepted: "被拦(转了专家)",
  "not-escalated": "未转(直接给了结论)",
};

/** 每种样本类型的两个终审选项。文案用「应…」而不是枚举值,减少误点。 */
const VERDICT_CHOICES: Record<ReviewSampleView["kind"], { value: string; label: string; wrong: boolean }[]> = {
  intercepted: [
    { value: "should-block", label: "确实该转专家", wrong: false },
    { value: "should-pass", label: "本可直接答（误拦）", wrong: true },
  ],
  "not-escalated": [
    { value: "should-not-escalate", label: "直接答是对的", wrong: false },
    { value: "should-escalate", label: "本该转专家（漏转）", wrong: true },
  ],
};

const VERDICT_LABEL: Record<string, string> = {
  "should-block": "该转",
  "should-pass": "误拦",
  "should-escalate": "漏转",
  "should-not-escalate": "无需转",
};

function pct(rate: number | null): string {
  // null 是「还没人复核过」,和 0%(复核了都对)必须显示成不同的东西 —— 一个
  // 写着 0% 误拦率的空队列会让人以为系统已经被验证过了。
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

function ReviewSampleQueue() {
  const [samples, setSamples] = useState<ReviewSampleView[]>([]);
  const [summary, setSummary] = useState<ReviewSummaryView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/review-samples", { headers: { authorization: AUTH } });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { pending: ReviewSampleView[]; summary: ReviewSummaryView };
      setSamples(data.pending);
      setSummary(data.summary);
      setError(null);
    } catch {
      setError("复核队列读取失败");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function judge(sample: ReviewSampleView, verdict: string) {
    setBusyId(sample.id);
    try {
      const res = await fetch("/api/review-samples", {
        method: "POST",
        headers: WRITE_HEADERS(),
        body: JSON.stringify({ id: sample.id, verdict, note: notes[sample.id] ?? "" }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // 判完就从待复核列表里移除,并重取汇总 —— 率是即时变的,不重取会让专家
      // 觉得自己刚填的判定没生效。
      setSamples((prev) => prev.filter((s) => s.id !== sample.id));
      await load();
    } catch {
      setError("判定提交失败，请重试");
    } finally {
      setBusyId(null);
    }
  }

  const pendingCount = samples.length;

  return (
    <section className="review-queue">
      <button
        className="review-queue-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ScanSearch size={15} aria-hidden="true" />
        <strong>抽样复核</strong>
        <span>{pendingCount} 待判</span>
        <em>
          误拦 {pct(summary?.falseInterception.rate ?? null)} · 漏转{" "}
          {pct(summary?.missedEscalation.rate ?? null)} · judge 一致{" "}
          {pct(summary?.judgeAgreement.rate ?? null)}
        </em>
      </button>

      {open && (
        <div className="review-queue-body">
          <p className="review-queue-note">
            这两个率没有自动真值来源，只能靠抽样人工判定。judge 的预审判定只是参考，
            终审在你手里 —— 不同意就直接选另一个。
          </p>
          {error && <p className="review-queue-error"><CircleAlert size={12} /> {error}</p>}
          {samples.map((s) => {
            const choices = VERDICT_CHOICES[s.kind];
            const signals = Array.isArray(s.context.riskSignals) ? s.context.riskSignals : [];
            return (
              <article key={s.id} className={`review-sample kind-${s.kind}`}>
                <header>
                  <span className="review-kind">{KIND_LABEL[s.kind]}</span>
                  <code>{s.projectId}</code>
                  {s.judgeVerdict && (
                    <em className="judge-hint">
                      judge：{VERDICT_LABEL[s.judgeVerdict] ?? s.judgeVerdict}
                      {s.judgeConfidence != null && ` (${(s.judgeConfidence * 100).toFixed(0)}%)`}
                    </em>
                  )}
                </header>
                <p className="review-question">{String(s.context.question ?? "(问题缺失)")}</p>
                <small className="review-meta">
                  {s.systemAction}
                  {signals.length > 0 && ` · ${signals.map(String).join(" / ")}`}
                </small>
                <input
                  type="text"
                  className="review-note"
                  placeholder="判定依据（选填，但分歧样本强烈建议写）"
                  value={notes[s.id] ?? ""}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [s.id]: e.target.value }))}
                />
                <div className="review-actions">
                  {choices.map((c) => (
                    <button
                      key={c.value}
                      className={c.wrong ? "verdict-wrong" : "verdict-ok"}
                      disabled={busyId !== null}
                      onClick={() => void judge(s, c.value)}
                    >
                      {busyId === s.id ? <Loader2 size={13} className="spin" /> : null} {c.label}
                    </button>
                  ))}
                </div>
              </article>
            );
          })}
          {samples.length === 0 && !error && (
            <p className="queue-empty">
              没有待复核样本。真实用户会话产生正式结论或转专家时会自动入队。
            </p>
          )}
          {summary && (
            <dl className="review-summary">
              <div>
                <dt>误拦截率</dt>
                <dd>
                  {pct(summary.falseInterception.rate)}
                  <small>
                    已复核 {summary.falseInterception.reviewed} · 欠复核{" "}
                    {summary.falseInterception.pending}
                  </small>
                </dd>
              </div>
              <div>
                <dt>该转未转率</dt>
                <dd>
                  {pct(summary.missedEscalation.rate)}
                  <small>
                    已复核 {summary.missedEscalation.reviewed} · 欠复核{" "}
                    {summary.missedEscalation.pending}
                  </small>
                </dd>
              </div>
              <div>
                <dt>judge–专家一致率</dt>
                <dd>
                  {pct(summary.judgeAgreement.rate)}
                  <small>可比样本 {summary.judgeAgreement.compared} 条</small>
                </dd>
              </div>
            </dl>
          )}
        </div>
      )}
    </section>
  );
}
