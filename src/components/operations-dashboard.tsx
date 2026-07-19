"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  Gauge,
  Radar,
  ShieldCheck,
  Siren,
} from "lucide-react";
import { useState } from "react";

const metrics = [
  { label: "安全自助解决率", value: "61.8%", delta: "+6.2", good: true, note: "已通过抽审与回访验证" },
  { label: "高风险转接召回", value: "96.4%", delta: "+1.1", good: true, note: "门禁 ≥ 95%" },
  { label: "引用有效率", value: "98.7%", delta: "+0.3", good: true, note: "门禁 ≥ 98%" },
  { label: "专家首次实质回复", value: "2h 18m", delta: "-42m", good: true, note: "目标 ≤ 4 工作小时" },
];

const qualityEvents = [
  { id: "QE-0942", type: "引用失效", project: "FFPE-RNA-117", owner: "李敏", age: "18m", severity: "P1" },
  { id: "QE-0941", type: "客户纠错", project: "WGS-082", owner: "陈屿", age: "43m", severity: "P1" },
  { id: "QE-0938", type: "重复开单", project: "scRNA-209", owner: "服务运营", age: "2h", severity: "P2" },
];

export function OperationsDashboard() {
  const [gateMode, setGateMode] = useState<"healthy" | "blocked">("healthy");
  const blocked = gateMode === "blocked";

  return (
    <main className="operations-page page-surface">
      <header className="page-heading ops-heading">
        <div>
          <span className="eyebrow">NOVABENCH / RELEASE CONTROL</span>
          <h1>业务可以慢一点，安全门禁不能松。</h1>
          <p>实时观察可信服务表现；任一门禁退化，真实流量自动停止。</p>
        </div>
        <div className={`release-state ${blocked ? "blocked" : ""}`}>
          {blocked ? <Siren size={18} /> : <ShieldCheck size={18} />}
          <div><strong>{blocked ? "灰度已停止" : "10% 灰度运行中"}</strong><small>影子 → 专家内测 → 邀请客户</small></div>
        </div>
      </header>

      <section className="metric-grid">
        {metrics.map((metric, index) => (
          <article key={metric.label} className="metric-card">
            <div className="metric-label"><span>0{index + 1}</span>{metric.label}</div>
            <div className="metric-value">
              <strong>{blocked && index === 2 ? "96.9%" : metric.value}</strong>
              <em className={blocked && index === 2 ? "bad" : ""}>
                {blocked && index === 2 ? <ArrowDownRight size={13} /> : <ArrowUpRight size={13} />}
                {blocked && index === 2 ? "-1.8" : metric.delta}
              </em>
            </div>
            <p>{metric.note}</p>
            <div className="sparkline" aria-hidden="true">
              {[34, 42, 39, 55, 51, 66, 72, 69, 79, 84].map((height, barIndex) => (
                <i key={barIndex} style={{ height: `${height}%` }} />
              ))}
            </div>
          </article>
        ))}
      </section>

      <div className="ops-grid">
        <section className="gate-board">
          <div className="panel-heading">
            <div><span className="eyebrow">SAFETY GATES</span><h2>发布门禁</h2></div>
            <div className="mode-toggle">
              <button className={!blocked ? "active" : ""} onClick={() => setGateMode("healthy")}>健康</button>
              <button className={blocked ? "active danger" : ""} onClick={() => setGateMode("blocked")}>模拟退化</button>
            </div>
          </div>
          <div className="gate-radar">
            <div className="radar-visual">
              <div className="radar-ring ring-1" />
              <div className="radar-ring ring-2" />
              <div className="radar-ring ring-3" />
              <div className={`radar-shape ${blocked ? "contracted" : ""}`} />
              <Radar size={22} />
            </div>
            <div className="gate-list">
              {[
                ["高风险转接召回", "96.4%", true],
                ["引用有效率", blocked ? "96.9%" : "98.7%", !blocked],
                ["自信错答变化", "0.0pp", true],
                ["P0 阻断缺陷", "0", true],
                ["数据出域事件", "0", true],
              ].map(([label, value, pass]) => (
                <div key={String(label)}>
                  <span className={pass ? "gate-pass" : "gate-fail"}>{pass ? <Check size={12} /> : <CircleAlert size={12} />}</span>
                  <strong>{label}</strong>
                  <em>{value}</em>
                </div>
              ))}
            </div>
          </div>
          <div className={`gate-verdict ${blocked ? "blocked" : ""}`}>
            {blocked ? <CircleAlert size={18} /> : <Gauge size={18} />}
            <div>
              <strong>{blocked ? "STOP · 禁止扩大真实流量" : "PROCEED · 当前可维持 10% 灰度"}</strong>
              <span>{blocked ? "引用有效率低于 98% 硬门禁，已创建质量事件。" : "全部五项安全门禁通过，下一次评审在 18 小时后。"}</span>
            </div>
          </div>
        </section>

        <section className="quality-board">
          <div className="panel-heading">
            <div><span className="eyebrow">QUALITY EVENTS</span><h2>质量事件</h2></div>
            <span className="event-count">3 OPEN</span>
          </div>
          <div className="quality-list">
            {qualityEvents.map((event) => (
              <article key={event.id}>
                <span className={`severity ${event.severity.toLowerCase()}`}>{event.severity}</span>
                <div>
                  <strong>{event.type}</strong>
                  <span>{event.id} · {event.project}</span>
                </div>
                <div className="event-owner"><small>{event.owner}</small><em>{event.age}</em></div>
              </article>
            ))}
          </div>
          <button className="board-link"><Activity size={14} /> 查看责任人与关闭证据 <ArrowUpRight size={14} /></button>
        </section>
      </div>
    </main>
  );
}
