"use client";

import {
  ArrowRight,
  BadgeCheck,
  BookOpenCheck,
  Check,
  CircleAlert,
  Clock3,
  FileDiff,
  FlaskConical,
  Inbox,
  MessageSquareText,
  UserRoundCheck,
} from "lucide-react";
import { useState } from "react";

const queue = [
  { id: "CASE-2407", title: "FFPE RNA · SOP 与文献冲突", risk: "高", time: "07:42", active: true },
  { id: "CASE-2406", title: "极低输入 RNA · 试建库评估", risk: "高", time: "18:19" },
  { id: "CASE-2405", title: "单细胞建库 · 活率不足", risk: "中", time: "24:08" },
];

export function ExpertWorkbench() {
  const [claimed, setClaimed] = useState(false);
  const [approved, setApproved] = useState(false);

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
          <div><strong>转录组专家组</strong><small>在线 4 人 · 队列 7</small></div>
        </div>
      </header>

      <div className="expert-layout">
        <aside className="case-queue">
          <div className="queue-head"><Inbox size={15} /><strong>待认领队列</strong><span>7</span></div>
          {queue.map((item) => (
            <button className={item.active ? "active" : ""} key={item.id}>
              <div><span>{item.id}</span><em>风险 {item.risk}</em></div>
              <strong>{item.title}</strong>
              <small><Clock3 size={11} /> 距 SLA {item.time}</small>
            </button>
          ))}
        </aside>

        <section className="case-canvas">
          <div className="case-topline">
            <div>
              <span className="case-id">CASE-2407 · 强制转接</span>
              <h2>FFPE RNA 灰区样本建库路线确认</h2>
            </div>
            <button className={claimed ? "claimed primary-action" : "primary-action"} onClick={() => setClaimed(true)}>
              {claimed ? <><Check size={15} /> 已由你认领</> : <><UserRoundCheck size={15} /> 认领案例</>}
            </button>
          </div>

          <div className="handoff-grid">
            <article>
              <span className="card-kicker"><FlaskConical size={13} /> 客户目标</span>
              <strong>24 份 FFPE 肿瘤样本 RNA 表达谱与差异分析</strong>
              <p>希望比较链特异性总 RNA 与低输入捕获方案，周期 6–8 周。</p>
            </article>
            <article>
              <span className="card-kicker"><CircleAlert size={13} /> 转接原因</span>
              <strong>DV200 38% 处于当前 SOP 与外部证据的冲突区间</strong>
              <p>AI 已停止最终建议，未展示可执行 CTA。</p>
            </article>
            <article>
              <span className="card-kicker"><MessageSquareText size={13} /> AI 已尝试</span>
              <strong>混合检索 23 条 · 重排保留 3 条 · Reviewer 阻断</strong>
              <p>结论级证据覆盖 67%，未达到正式卡门禁。</p>
            </article>
            <article>
              <span className="card-kicker"><BookOpenCheck size={13} /> 待决策项</span>
              <strong>是否先做 2 份试建库，再决定主路线？</strong>
              <p>需明确额外质控、最低投入量与失败止损条件。</p>
            </article>
          </div>

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

          <section className="expert-decision">
            <div>
              <span className="eyebrow">EXPERT AMENDMENT</span>
              <h3>专家修订</h3>
            </div>
            <textarea
              aria-label="专家修订内容"
              defaultValue="建议先选择 2 份代表性样本进行试建库；若文库复杂度与插入片段分布达到门槛，再批量进入链特异性总 RNA 路线。其余样本保留低输入捕获作为备选。"
            />
            <div className="decision-controls">
              <label><input type="checkbox" defaultChecked /> 生成候选知识（不自动进入生产）</label>
              <div>
                <button className="secondary-action">退回补充条件</button>
                <button className="primary-action" disabled={!claimed || approved} onClick={() => setApproved(true)}>
                  {approved ? <><BadgeCheck size={15} /> 已批准 v4.0</> : <>批准正式决策卡 <ArrowRight size={15} /></>}
                </button>
              </div>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
