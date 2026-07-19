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
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { CandidateKnowledge } from "@/domain/consultation-journey";

interface KnowledgeEvolutionProps {
  initial: CandidateKnowledge;
}

const benchmarkRows = [
  ["标准 FFPE", "148 / 148", "100%", "PASS"],
  ["灰区样本", "76 / 78", "97.4%", "PASS"],
  ["证据冲突", "61 / 63", "96.8%", "PASS"],
  ["跨语言一致", "54 / 54", "100%", "PASS"],
];

export function KnowledgeEvolution({ initial }: KnowledgeEvolutionProps) {
  const [ownerApproved, setOwnerApproved] = useState(false);
  const [benchPassed, setBenchPassed] = useState(false);
  const [humanApproved, setHumanApproved] = useState(false);
  const [grayPassed, setGrayPassed] = useState(false);
  const stage = useMemo(
    () => (grayPassed ? 4 : humanApproved ? 3 : benchPassed ? 2 : ownerApproved ? 1 : 0),
    [ownerApproved, benchPassed, humanApproved, grayPassed],
  );

  return (
    <main className="knowledge-page page-surface">
      <header className="page-heading">
        <div>
          <span className="eyebrow">GOVERNED EVOLUTION / CANDIDATE CK-017</span>
          <h1>让系统长知识，不让它偷偷改自己。</h1>
          <p>专家经验先成为候选；只有 Owner、NovaBench 与灰度三道门全部通过，才获得生产资格。</p>
        </div>
        <div className="candidate-status">
          <Sparkles size={17} />
          <div><strong>{stage === 3 ? "灰度知识已激活" : "候选知识 · 不参与生产"}</strong><small>来源 CASE-2407 · 可完整回滚</small></div>
        </div>
      </header>

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
            <span className="candidate-id">{initial.id} · v{initial.version}</span>
          </div>
          <div className="candidate-statement">
            <GitBranch size={19} />
            <p>{initial.statement}</p>
          </div>
          <dl className="candidate-fields">
            <div><dt>作用域</dt><dd>{initial.scope}</dd></div>
            <div><dt>反例</dt><dd>{initial.counterexample}</dd></div>
            <div><dt>证据</dt><dd>{initial.evidenceIds.join(" · ")}</dd></div>
            <div><dt>Owner</dt><dd>{initial.owner}</dd></div>
            <div><dt>有效期</dt><dd>{initial.validUntil}</dd></div>
          </dl>
          <div className="production-lock">
            <ShieldCheck size={16} />
            <span><strong>生产隔离</strong>候选内容当前不能参与客户回答</span>
          </div>
        </section>

        <section className="review-console">
          <div className="panel-heading">
            <div><span className="eyebrow">RELEASE CONTROLS</span><h2>晋级门禁</h2></div>
            <span className="event-count">{stage}/4 PASSED</span>
          </div>
          <div className="review-step">
            <span className={ownerApproved ? "step-icon done" : "step-icon"}><BookOpenCheck size={15} /></span>
            <div><strong>知识 Owner 审核</strong><p>核对来源、证据、作用域、反例与失效条件。</p></div>
            <button onClick={() => setOwnerApproved(true)} disabled={ownerApproved}>
              {ownerApproved ? "已批准" : "批准"}
            </button>
          </div>
          <div className="review-step">
            <span className={benchPassed ? "step-icon done" : "step-icon"}><Beaker size={15} /></span>
            <div><strong>NovaBench 回归</strong><p>341 条相关金标；不得降低转接召回与引用有效率。</p></div>
            <button onClick={() => setBenchPassed(true)} disabled={!ownerApproved || benchPassed}>
              {benchPassed ? "已通过" : "运行评测"}
            </button>
          </div>
          <div className="review-step">
            <span className={humanApproved ? "step-icon done" : "step-icon"}><ShieldCheck size={15} /></span>
            <div><strong>发布经理人工批准</strong><p>确认评测结果、灰度范围、停止条件与回滚版本。</p></div>
            <button onClick={() => setHumanApproved(true)} disabled={!benchPassed || humanApproved}>
              {humanApproved ? "已签署" : "人工批准"}
            </button>
          </div>
          <div className="review-step">
            <span className={grayPassed ? "step-icon done" : "step-icon"}><FlaskConical size={15} /></span>
            <div><strong>5% 灰度验证</strong><p>仅在明确作用域生效，支持即时停止与版本回滚。</p></div>
            <button onClick={() => setGrayPassed(true)} disabled={!humanApproved || grayPassed}>
              {grayPassed ? "已激活" : "开始灰度"}
            </button>
          </div>
          <div className={`evolution-verdict ${grayPassed ? "active" : ""}`}>
            {grayPassed ? <BadgeCheck size={18} /> : <CircleDashed size={18} />}
            <div>
              <strong>{grayPassed ? "KNOWLEDGE VERSION ACTIVE" : "PRODUCTION ELIGIBILITY: NO"}</strong>
              <span>{grayPassed ? "仅 FFPE RNA 灰区样本作用域可用；回滚点 KV-2026.07.18。" : "模型权重、智能体代码、工作流和正式 SOP 均未改变。"}</span>
            </div>
          </div>
        </section>
      </div>

      <section className="benchmark-table">
        <div className="panel-heading">
          <div><span className="eyebrow">NOVABENCH DELTA</span><h2>候选影响面</h2></div>
          <span className="candidate-id"><History size={12} /> BASELINE v2026.07.18</span>
        </div>
        <div className="bench-head"><span>评测切片</span><span>通过</span><span>得分</span><span>门禁</span></div>
        {benchmarkRows.map((row) => (
          <div className="bench-row" key={row[0]}>
            <strong>{row[0]}</strong><span>{row[1]}</span><span>{row[2]}</span><em>{row[3]}</em>
          </div>
        ))}
      </section>
    </main>
  );
}
