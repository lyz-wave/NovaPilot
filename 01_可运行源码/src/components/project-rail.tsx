"use client";

import { Check, ChevronDown, Database, FileText, Plus, ShieldCheck } from "lucide-react";
import type { ProjectFacts } from "@/domain/consultation-journey";

interface ProjectRailProps {
  facts: ProjectFacts;
  confirmed: boolean;
  onFactsChange: (facts: ProjectFacts) => void;
  onConfirm: () => void;
}

export function ProjectRail({ facts, confirmed, onFactsChange, onConfirm }: ProjectRailProps) {
  return (
    <aside className="project-rail">
      <div className="rail-heading">
        <span className="eyebrow">ACTIVE PROJECT</span>
        <button className="icon-button" aria-label="新建项目"><Plus size={16} /></button>
      </div>

      <button className="project-switcher">
        <span className="project-monogram">FR</span>
        <span>
          <strong>FFPE RNA 表达谱</strong>
          <small>NP-260719 · v3</small>
        </span>
        <ChevronDown size={15} />
      </button>

      <section className="fact-section">
        <div className="section-label">
          <span>项目事实</span>
          <span className={confirmed ? "verified-label" : "pending-label"}>
            {confirmed ? <><Check size={11} /> 已确认</> : "修改待确认"}
          </span>
        </div>
        <label className="fact-field">
          <span>样本材料</span>
          <input
            value={facts.material ?? ""}
            onChange={(event) => onFactsChange({ ...facts, material: event.target.value })}
          />
          <small><FileText size={11} /> 客户方案书 · 第 2 页</small>
        </label>
        <div className="fact-grid">
          <label className="fact-field">
            <span>样本数</span>
            <input
              type="number"
              value={facts.sampleCount ?? ""}
              onChange={(event) =>
                onFactsChange({
                  ...facts,
                  sampleCount:
                    event.target.value === "" ? undefined : Number(event.target.value),
                })
              }
            />
          </label>
          <label className="fact-field">
            <span>DV200</span>
            <div className="unit-input">
              <input
                type="number"
                value={facts.dv200 ?? ""}
                onChange={(event) =>
                  onFactsChange({
                    ...facts,
                    dv200: event.target.value === "" ? undefined : Number(event.target.value),
                  })
                }
              />
              <em>%</em>
            </div>
          </label>
          <label className="fact-field">
            <span>RNA 投入量</span>
            <div className="unit-input">
              <input
                type="number"
                value={facts.rnaInputNg ?? ""}
                onChange={(event) =>
                  onFactsChange({
                    ...facts,
                    rnaInputNg:
                      event.target.value === "" ? undefined : Number(event.target.value),
                  })
                }
              />
              <em>ng</em>
            </div>
          </label>
        </div>
        {!confirmed && (
          <button className="confirm-facts" onClick={onConfirm}>
            确认本次项目事实
          </button>
        )}
      </section>

      <section className="rail-stack">
        <div className="section-label"><span>研究约束</span><span>3 / 4</span></div>
        {[
          ["研究目标", "差异表达 · 通路富集"],
          ["物种", "Homo sapiens"],
          ["预算", "中等 · 待报价"],
          ["周期", "6–8 周"],
        ].map(([label, value], index) => (
          <div className={`constraint-row ${index === 2 ? "pending" : ""}`} key={label}>
            <span>{label}</span><strong>{value}</strong>
          </div>
        ))}
      </section>

      <div className="privacy-card">
        <ShieldCheck size={17} />
        <div>
          <strong>私有数据边界已启用</strong>
          <span>客户文件与内部 SOP 不出域</span>
        </div>
      </div>

      <div className="rail-footnote">
        <Database size={13} />
        项目事实是后续咨询的唯一主记录
      </div>
    </aside>
  );
}
