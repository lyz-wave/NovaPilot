"use client";

import {
  ArrowRight,
  BadgeCheck,
  Beaker,
  BookOpenCheck,
  Check,
  CircleDashed,
  FlaskConical,
  GitBranch,
  History,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CandidateKnowledge } from "@/domain/consultation-journey";

// Minimal client-safe view of the NovaBench release report.
interface BenchReport {
  accuracy: number;
  passed: number;
  total: number;
  decision: string;
  cases: Array<{
    id?: string;
    expected: string;
    actual?: string;
    correct: boolean;
    invalidCitations?: string[];
  }>;
}

interface KnowledgeEvolutionProps {
  initial: CandidateKnowledge;
  /** 全部候选(含 initial)。专家多次修订会生成多个候选,页面内可切换。 */
  all?: CandidateKnowledge[];
  /** 最近一次落库的 NovaBench 报告:刷新后「候选影响面」切片不丢失。 */
  initialBench?: BenchReport | null;
}

interface PromotionChecks {
  ownerApproved: boolean;
  novaBenchPassed: boolean;
  grayValidationPassed: boolean;
  humanApproved: boolean;
}

const AUTH = "Bearer demo-research-session";
const WRITE_HEADERS = () => ({
  authorization: AUTH,
  "content-type": "application/json",
  "x-tenant-id": "novapilot-demo",
  "x-idempotency-key": crypto.randomUUID(),
  "if-match": '"v3"',
});

const pct = (value: number) => (value * 100).toFixed(1) + "%";

const SLICES: Array<[string, string]> = [
  ["formal", "标准 / 正式"],
  ["clarify", "需澄清"],
  ["escalate", "强制转接"],
  ["provisional", "暂行方案"],
];

const STATUS_LABEL: Record<CandidateKnowledge["status"], string> = {
  candidate: "候选",
  "owner-approved": "Owner 已批准",
  "gray-active": "灰度生效",
  rejected: "已拒绝",
};

const STAGE_LABEL: Record<string, string> = {
  "candidate-created": "候选生成",
  "owner-approved": "Owner 批准",
  "novabench-passed": "NovaBench 通过",
  "human-approved": "发布经理批准",
  "gray-activated": "灰度激活",
  "rolled-back": "已回滚",
};

/** 从候选的审计轨迹反推当前门禁状态(刷新/切换后不丢失已通过的门)。 */
function checksFrom(c: CandidateKnowledge): PromotionChecks {
  const passed = (stage: string) => c.auditTrail.some((entry) => entry.stage === stage);
  // 回滚使灰度验证失效(其余门禁历史结论保留):重新晋级只需重走灰度。
  const rolledBack = c.auditTrail[c.auditTrail.length - 1]?.stage === "rolled-back";
  return {
    ownerApproved: passed("owner-approved"),
    novaBenchPassed: passed("novabench-passed"),
    grayValidationPassed: passed("gray-activated") && !rolledBack,
    humanApproved: passed("human-approved"),
  };
}

export function KnowledgeEvolution({ initial, all, initialBench }: KnowledgeEvolutionProps) {
  const [candidates, setCandidates] = useState<CandidateKnowledge[]>(
    all && all.length > 0 ? all : [initial],
  );
  const [activeId, setActiveId] = useState<string>(initial.id);
  const [checks, setChecks] = useState<PromotionChecks>(() => checksFrom(initial));
  const [bench, setBench] = useState<BenchReport | null>(initialBench ?? null);
  const [benchBusy, setBenchBusy] = useState(false);
  const [busy, setBusy] = useState<null | keyof PromotionChecks | "rollback">(null);
  const [notice, setNotice] = useState<string | null>(null);

  const candidate = useMemo(
    () => candidates.find((c) => c.id === activeId) ?? candidates[0] ?? initial,
    [candidates, activeId, initial],
  );
  const grayActive = candidate.status === "gray-active" && candidate.productionEligible;
  const lastStage = candidate.auditTrail[candidate.auditTrail.length - 1]?.stage;
  const rolledBack = lastStage === "rolled-back";

  // 挂载时拉取一次全量候选:专家在另一页面刚生成的候选也能出现在切换器里。
  useEffect(() => {
    let cancelled = false;
    fetch("/api/knowledge", { headers: { authorization: AUTH } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data || !Array.isArray(data.candidates)) return;
        setCandidates((prev) => {
          const map = new Map(prev.map((c) => [c.id, c]));
          let changed = false;
          for (const item of data.candidates as CandidateKnowledge[]) {
            if (!map.has(item.id)) {
              map.set(item.id, item);
              changed = true;
            }
          }
          return changed ? [...map.values()] : prev;
        });
      })
      .catch(() => {
        // 离线演示下静默:初始列表已由服务端页面提供。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const stage = useMemo(
    () =>
      checks.grayValidationPassed
        ? 4
        : checks.humanApproved
          ? 3
          : checks.novaBenchPassed
            ? 2
            : checks.ownerApproved
              ? 1
              : 0,
    [checks],
  );

  function upsertCandidate(next: CandidateKnowledge) {
    setCandidates((prev) =>
      prev.some((c) => c.id === next.id)
        ? prev.map((c) => (c.id === next.id ? next : c))
        : [...prev, next],
    );
  }

  function selectCandidate(id: string) {
    const next = candidates.find((c) => c.id === id);
    if (!next || next.id === candidate.id) return;
    setActiveId(id);
    setChecks(checksFrom(next));
    setBench(null);
    setNotice(null);
  }

  /** Persist the given checks through the real promotion pipeline. */
  async function promote(next: PromotionChecks) {
    const res = await fetch("/api/knowledge", {
      method: "POST",
      headers: WRITE_HEADERS(),
      body: JSON.stringify({ action: "promote", candidateId: candidate.id, checks: next }),
    });
    if (!res.ok) throw new Error("晋级失败：" + res.status);
    const data = (await res.json()) as {
      candidate: CandidateKnowledge;
      published: boolean;
      documentId: string | null;
    };
    upsertCandidate(data.candidate);
    return data;
  }

  async function step(key: keyof PromotionChecks) {
    setBusy(key);
    setNotice(null);
    try {
      let next = { ...checks, [key]: true };

      // NovaBench step runs the *real* gold-set evaluation and only passes the
      // gate when the release decision is "proceed".
      if (key === "novaBenchPassed") {
        const res = await fetch("/api/release-gates", {
          method: "POST",
          headers: WRITE_HEADERS(),
          body: JSON.stringify({ mode: "novabench" }),
        });
        if (!res.ok) throw new Error("评测失败：" + res.status);
        const report = (await res.json()) as BenchReport;
        setBench(report);
        next = { ...checks, novaBenchPassed: report.decision === "proceed" };
        if (report.decision !== "proceed") {
          setChecks(next);
          setNotice("NovaBench 未通过发布门禁，候选保持在 Owner 已批准状态。");
          return;
        }
      }

      // 先经真实管线持久化,成功后本地状态才同步,避免失败时 UI 误标"已通过"。
      const result = await promote(next);
      setChecks(checksFrom(result.candidate));
      if (key === "grayValidationPassed" && result.published) {
        setNotice("四道门禁全部通过：候选已作为可引用证据写入知识库。");
      }
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** 一键回滚:灰度知识退出生产,生产索引即时移除。 */
  async function rollback() {
    if (!grayActive) return;
    setBusy("rollback");
    setNotice(null);
    try {
      const res = await fetch("/api/knowledge", {
        method: "POST",
        headers: WRITE_HEADERS(),
        body: JSON.stringify({ action: "rollback", candidateId: candidate.id }),
      });
      if (!res.ok) throw new Error("回滚失败：" + res.status);
      const data = (await res.json()) as { candidate: CandidateKnowledge };
      upsertCandidate(data.candidate);
      setChecks(checksFrom(data.candidate));
      setNotice("已回滚：候选退出生产，知识库索引已移除，状态回到 Owner 已批准，可重新晋级。");
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** 重跑 NovaBench(不触发晋级):刷新后或旧记录缺失时恢复切片表。 */
  async function rerunBench() {
    setBenchBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/release-gates", {
        method: "POST",
        headers: WRITE_HEADERS(),
        body: JSON.stringify({ mode: "novabench" }),
      });
      if (!res.ok) throw new Error("评测失败：" + res.status);
      const report = (await res.json()) as BenchReport;
      setBench(report);
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBenchBusy(false);
    }
  }

  const benchRows = bench
    ? SLICES.map(([key, label]) => {
        const group = bench.cases.filter((c) => c.expected === key);
        const correct = group.filter((c) => c.correct).length;
        return {
          label,
          ratio: correct + " / " + group.length,
          score: group.length ? pct(correct / group.length) : "—",
          gate: group.length === 0 ? "—" : correct === group.length ? "PASS" : "FAIL",
        };
      }).filter((row) => row.ratio !== "0 / 0")
    : [];

  return (
    <main className="knowledge-page page-surface">
      <header className="page-heading">
        <div>
          <span className="eyebrow">GOVERNED EVOLUTION / CANDIDATE {candidate.id}</span>
          <h1>让系统长知识，不让它偷偷改自己。</h1>
          <p>专家经验先成为候选；只有 Owner、NovaBench 与灰度三道门全部通过，才获得生产资格。</p>
        </div>
        <div className="candidate-status">
          <Sparkles size={17} />
          <div>
            <strong>{grayActive ? "灰度知识已激活" : rolledBack ? "灰度知识已回滚" : "候选知识 · 不参与生产"}</strong>
            <small>
              来源 {candidate.sourceCaseId} · {rolledBack ? "已退出生产,可重新晋级" : "可完整回滚"}
            </small>
          </div>
        </div>
      </header>

      {candidates.length > 1 && (
        <nav className="candidate-switcher" aria-label="候选知识切换">
          {candidates.map((c) => {
            const live = c.status === "gray-active" && c.productionEligible;
            return (
              <button
                key={c.id}
                className={c.id === candidate.id ? "active" : ""}
                aria-current={c.id === candidate.id ? "true" : undefined}
                onClick={() => selectCandidate(c.id)}
              >
                <strong>{c.id}</strong>
                <span className={"status-chip" + (live ? " live" : "")}>{STATUS_LABEL[c.status]}</span>
              </button>
            );
          })}
        </nav>
      )}

      <section className="evolution-rail" aria-label="知识晋级状态">
        {[
          ["候选生成", "专家修改提炼"],
          ["Owner 审核", "作用域与反例"],
          ["NovaBench", "金标回归"],
          ["人工批准", "发布经理签署"],
          ["门禁式灰度", "小流量验证"],
        ].map(([title, note], index) => (
          <article className={stage >= index ? "complete" : ""} key={title}>
            <span>{stage > index ? <Check size={14} /> : index + 1}</span>
            <div><strong>{title}</strong><small>{note}</small></div>
            {index < 4 && <ArrowRight size={14} />}
          </article>
        ))}
      </section>

      <div className="knowledge-grid">
        <section className="candidate-card">
          <div className="panel-heading">
            <div><span className="eyebrow">CANDIDATE KNOWLEDGE</span><h2>候选知识卡</h2></div>
            <span className="candidate-id">{candidate.id} · v{candidate.version}</span>
          </div>
          <div className="candidate-statement">
            <GitBranch size={19} />
            <p>{candidate.statement}</p>
          </div>
          <dl className="candidate-fields">
            <div><dt>作用域</dt><dd>{candidate.scope}</dd></div>
            <div><dt>反例</dt><dd>{candidate.counterexample}</dd></div>
            <div><dt>证据</dt><dd>{candidate.evidenceIds.join(" · ")}</dd></div>
            <div><dt>Owner</dt><dd>{candidate.owner}</dd></div>
            <div><dt>有效期</dt><dd>{candidate.validUntil}</dd></div>
          </dl>
          <section className="audit-trail">
            <div className="audit-head">
              <span className="eyebrow">AUDIT TRAIL</span>
              <small>每条状态变更都记录阶段与操作者</small>
            </div>
            <ol>
              {candidate.auditTrail.map((entry, index) => (
                <li
                  key={entry.stage + "-" + index}
                  className={index === candidate.auditTrail.length - 1 ? "latest" : ""}
                >
                  <i>{index + 1}</i>
                  <div>
                    <strong>{STAGE_LABEL[entry.stage] ?? entry.stage}</strong>
                    <code>{entry.actor}</code>
                  </div>
                  {entry.stage === "rolled-back" && (
                    <em>回滚点 {candidate.rollbackVersion ?? "—"}</em>
                  )}
                </li>
              ))}
            </ol>
          </section>
          <div className={"production-lock " + (grayActive ? "unlocked" : rolledBack ? "rolled-back" : "")}>
            <ShieldCheck size={16} />
            <span>
              <strong>{grayActive ? "灰度生效" : rolledBack ? "已回滚" : "生产隔离"}</strong>
              {grayActive
                ? "已在明确作用域内作为可引用证据生效，可即时回滚。"
                : rolledBack
                  ? "已从生产知识库移除索引，候选退回 Owner 已批准，可重新晋级。"
                  : "候选内容当前不能参与客户回答"}
            </span>
          </div>
        </section>

        <section className="review-console">
          <div className="panel-heading">
            <div><span className="eyebrow">RELEASE CONTROLS</span><h2>晋级门禁</h2></div>
            <span className="event-count">{stage}/4 PASSED</span>
          </div>
          {notice && <p className="ops-error" role="status" aria-live="polite"><CircleDashed size={13} /> {notice}</p>}
          <div className="review-step">
            <span className={checks.ownerApproved ? "step-icon done" : "step-icon"}><BookOpenCheck size={15} /></span>
            <div>
              <strong>知识 Owner 审核</strong>
              <p>核对来源、证据、作用域、反例与失效条件。</p>
              <em className="gate-actor">责任人 {candidate.owner}</em>
            </div>
            <button onClick={() => step("ownerApproved")} disabled={busy !== null || checks.ownerApproved}>
              {busy === "ownerApproved" ? <Loader2 size={13} className="spin" /> : checks.ownerApproved ? "已批准" : "批准"}
            </button>
          </div>
          <div className="review-step">
            <span className={checks.novaBenchPassed ? "step-icon done" : "step-icon"}><Beaker size={15} /></span>
            <div>
              <strong>NovaBench 回归</strong>
              <p>运行真实金标集；不得降低转接召回与引用有效率。</p>
              <em className="gate-actor">执行 novabench · 金标集回归</em>
            </div>
            <button onClick={() => step("novaBenchPassed")} disabled={busy !== null || !checks.ownerApproved || checks.novaBenchPassed}>
              {busy === "novaBenchPassed" ? <><Loader2 size={13} className="spin" /> 评测中…</> : checks.novaBenchPassed ? "已通过" : "运行评测"}
            </button>
          </div>
          <div className="review-step">
            <span className={checks.humanApproved ? "step-icon done" : "step-icon"}><ShieldCheck size={15} /></span>
            <div>
              <strong>发布经理人工批准</strong>
              <p>确认评测结果、灰度范围、停止条件与回滚版本。</p>
              <em className="gate-actor">签署人 release-manager</em>
            </div>
            <button onClick={() => step("humanApproved")} disabled={busy !== null || !checks.novaBenchPassed || checks.humanApproved}>
              {busy === "humanApproved" ? <Loader2 size={13} className="spin" /> : checks.humanApproved ? "已签署" : "人工批准"}
            </button>
          </div>
          <div className="review-step">
            <span className={checks.grayValidationPassed ? "step-icon done" : "step-icon"}><FlaskConical size={15} /></span>
            <div>
              <strong>5% 灰度验证</strong>
              <p>仅在明确作用域生效，支持即时停止与版本回滚。</p>
              <em className="gate-actor">执行 release-manager + ops</em>
            </div>
            <button onClick={() => step("grayValidationPassed")} disabled={busy !== null || !checks.humanApproved || checks.grayValidationPassed}>
              {busy === "grayValidationPassed" ? <><Loader2 size={13} className="spin" /> 灰度中…</> : checks.grayValidationPassed ? "已激活" : "开始灰度"}
            </button>
          </div>
          <div className={"evolution-verdict " + (grayActive ? "active" : "")}>
            {grayActive ? <BadgeCheck size={18} /> : <CircleDashed size={18} />}
            <div>
              <strong>{grayActive ? "KNOWLEDGE VERSION ACTIVE" : "PRODUCTION ELIGIBILITY: NO"}</strong>
              <span>
                {grayActive
                  ? "仅 " + candidate.scope + " 作用域可用；回滚点 " + (candidate.rollbackVersion ?? "—") + "。"
                  : rolledBack
                    ? "已回滚至 " + (candidate.rollbackVersion ?? "—") + "；生产索引已移除,可重新晋级。"
                    : "模型权重、智能体代码、工作流和正式 SOP 均未改变。"}
              </span>
            </div>
            {grayActive && (
              <button className="rollback-action" onClick={rollback} disabled={busy !== null}>
                {busy === "rollback" ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}
                {busy === "rollback" ? "回滚中…" : "一键回滚"}
              </button>
            )}
          </div>
        </section>
      </div>

      <section className="benchmark-table">
        <div className="panel-heading">
          <div><span className="eyebrow">NOVABENCH DELTA</span><h2>候选影响面</h2></div>
          <span className="candidate-id">
            <History size={12} /> {bench ? "准确率 " + pct(bench.accuracy) + " · " + bench.passed + "/" + bench.total : "尚未运行评测"}
          </span>
        </div>
        <div className="bench-head"><span>评测切片</span><span>通过</span><span>得分</span><span>门禁</span></div>
        {bench ? (
          benchRows.map((row) => (
            <div className="bench-row" key={row.label}>
              <strong>{row.label}</strong><span>{row.ratio}</span><span>{row.score}</span><em>{row.gate}</em>
            </div>
          ))
        ) : (
          <div className="bench-empty">
            运行上方「NovaBench 回归」后，此处展示真实金标切片得分。
            {checks.novaBenchPassed && (
              <button className="bench-rerun" onClick={rerunBench} disabled={benchBusy}>
                {benchBusy ? <Loader2 size={13} className="spin" /> : <History size={13} />}
                {benchBusy ? "评测中…" : "重跑评测恢复切片"}
              </button>
            )}
          </div>
        )}
        {bench && bench.cases.some((c) => !c.correct) && (
          <div className="bench-failures">
            <span className="eyebrow">FAILING SLICES · 失败切片说明</span>
            {bench.cases
              .filter((c) => !c.correct)
              .map((c) => (
                <p key={(c.id ?? "") + c.expected}>
                  <strong>{c.id || c.expected}</strong> 预期 {c.expected} → 实际 {c.actual ?? "—"}
                  {(c.invalidCitations?.length ?? 0) > 0 && (
                    <em>违规引用 {c.invalidCitations!.join(" / ")}</em>
                  )}
                </p>
              ))}
          </div>
        )}
      </section>
    </main>
  );
}
