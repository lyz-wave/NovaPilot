"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronsLeft,
  CircleHelp,
  Database,
  FileText,
  Orbit,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { ConversationMeta, ProjectFacts } from "@/domain/consultation-journey";

interface ProjectRailProps {
  facts: ProjectFacts;
  confirmed: boolean;
  onFactsChange: (facts: ProjectFacts) => void;
  onConfirm: () => void;
  /** 点击“待客户确认”chips 时,发送对应追问。 */
  onAsk?: (question: string, label: string) => void;
  /** 侧栏收起状态与切换。 */
  collapsed: boolean;
  onToggleCollapse: () => void;
  conversations: ConversationMeta[];
  activeConversationId: string;
  onNewConversation: () => void;
  onSwitchConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  onDeleteConversation: (id: string) => void;
}

/** 待客户确认的灰区事项:点击即发送对应追问(演示“最小必要追问”的剩余空间)。 */
const PENDING_ASKS = [
  {
    key: "paired",
    label: "配对设计",
    question: "这批样本是否为肿瘤-癌旁配对设计?请评估配对对差异分析统计功效的影响。",
  },
  {
    key: "batch",
    label: "批次信息",
    question: "样本分几个批次提取与建库?请评估批次效应对差异分析的影响。",
  },
  {
    key: "tissue",
    label: "组织量",
    question: "各样本的组织量与提取 RNA 量是否一致?请给出送样建议。",
  },
];

const SPECIES_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "Homo sapiens", label: "人 · Homo sapiens" },
  { value: "Mus musculus", label: "小鼠 · Mus musculus" },
  { value: "其他", label: "其他" },
];
const GOAL_OPTIONS = ["差异表达 · 通路富集", "肿瘤微环境与免疫", "其他"];

/** Two-character monogram for a conversation title (CJK-friendly). */
function monogram(title: string | undefined): string {
  const t = (title ?? "").trim();
  if (!t) return "NP";
  return t.slice(0, 2);
}

export function ProjectRail({
  facts,
  confirmed,
  onFactsChange,
  onConfirm,
  onAsk,
  collapsed,
  onToggleCollapse,
  conversations,
  activeConversationId,
  onNewConversation,
  onSwitchConversation,
  onRenameConversation,
  onDeleteConversation,
}: ProjectRailProps) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [askedKeys, setAskedKeys] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const switcherWrapRef = useRef<HTMLDivElement>(null);
  const switcherButtonRef = useRef<HTMLButtonElement>(null);

  // Escape 关闭下拉并把焦点还给切换按钮;点击下拉外部同样关闭。
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        switcherButtonRef.current?.focus();
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (
        switcherWrapRef.current &&
        !switcherWrapRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const active =
    conversations.find((c) => c.id === activeConversationId) ?? conversations[0] ?? null;

  function beginRename(c: ConversationMeta) {
    setRenamingId(c.id);
    setDraftTitle(c.title);
  }

  function commitRename() {
    if (renamingId) onRenameConversation(renamingId, draftTitle);
    setRenamingId(null);
    setDraftTitle("");
  }

  if (collapsed) {
    const filtered = conversations.filter((c) =>
      c.title.toLowerCase().includes(searchQuery.trim().toLowerCase()),
    );
    return (
      <aside className="project-rail rail-collapsed" aria-label="项目侧栏(已收起)">
        <button
          className="rail-logo"
          aria-label="展开项目侧栏"
          title="展开项目侧栏"
          onClick={onToggleCollapse}
          onMouseEnter={onToggleCollapse}
        >
          <span className="rail-logo-mark"><Orbit size={18} strokeWidth={1.7} aria-hidden="true" /></span>
        </button>
        <button className="rail-strip-btn" aria-label="新建会话" title="新建会话" onClick={onNewConversation}>
          <Plus size={16} />
        </button>
        <button
          className="rail-strip-btn"
          aria-label="搜索会话"
          title="搜索会话"
          aria-expanded={searchOpen}
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Search size={15} />
        </button>
        {searchOpen && (
          <div className="rail-search-pop">
            <input
              autoFocus
              aria-label="搜索会话"
              placeholder="搜索会话…"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            <ul>
              {filtered.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => {
                      onSwitchConversation(c.id);
                      setSearchOpen(false);
                      setSearchQuery("");
                    }}
                  >
                    <span className="conversation-title">{c.title}</span>
                    <small>{c.messageCount} 条</small>
                  </button>
                </li>
              ))}
            </ul>
            {filtered.length === 0 && <p className="rail-search-empty">无匹配会话</p>}
          </div>
        )}
      </aside>
    );
  }

  return (
    <aside className="project-rail">
      <div className="rail-heading">
        <span className="eyebrow">ACTIVE PROJECT</span>
        <div className="rail-heading-tools">
          <button className="icon-button" aria-label="新建会话" title="新建会话" onClick={onNewConversation}>
            <Plus size={16} />
          </button>
          <button className="icon-button" aria-label="收起项目侧栏" title="收起项目侧栏" onClick={onToggleCollapse}>
            <ChevronsLeft size={16} />
          </button>
        </div>
      </div>

      <div className="conversation-switcher-wrap" ref={switcherWrapRef}>
        <button
          ref={switcherButtonRef}
          className="project-switcher"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="true"
          aria-label="切换会话"
        >
          <span className="project-monogram">{monogram(active?.title)}</span>
          <span className="project-switcher-label">
            <strong>{active?.title ?? "新对话"}</strong>
            <small>{active ? `${active.messageCount} 条消息` : "尚无消息"}</small>
          </span>
          <ChevronDown size={15} className={`chevron ${open ? "rotated" : ""}`} />
        </button>

        {open && (
          <div className="conversation-menu" aria-label="历史会话">
            <div className="conversation-menu-head">
              <span>历史会话</span>
              <span>{conversations.length}</span>
            </div>
            <ul>
              {conversations.map((c) => (
                <li key={c.id} className={c.id === activeConversationId ? "active" : ""}>
                  {renamingId === c.id ? (
                    <input
                      className="conversation-rename"
                      value={draftTitle}
                      autoFocus
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === "Escape") {
                          setRenamingId(null);
                          setDraftTitle("");
                        }
                      }}
                      onBlur={commitRename}
                    />
                  ) : (
                    <button
                      className="conversation-item"
                      onClick={() => {
                        onSwitchConversation(c.id);
                        setOpen(false);
                      }}
                    >
                      <span className="conversation-title">{c.title}</span>
                      <small>{c.messageCount} 条</small>
                    </button>
                  )}
                  {renamingId !== c.id && (
                    <span className="conversation-actions">
                      <button aria-label="重命名会话" title="重命名" onClick={() => beginRename(c)}>
                        <Pencil size={13} />
                      </button>
                      <button
                        aria-label="删除会话"
                        title="删除"
                        onClick={() => onDeleteConversation(c.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <button
              className="conversation-new"
              onClick={() => {
                onNewConversation();
                setOpen(false);
              }}
            >
              <Plus size={14} /> 新建会话
            </button>
          </div>
        )}
      </div>

      <section className="fact-section">
        <div className="section-label">
          <span>项目事实</span>
          <span className={confirmed ? "verified-label" : "pending-label"}>
            {confirmed ? <><Check size={11} /> 已确认</> : "修改待确认"}
          </span>
        </div>
        <div className="fact-grid fact-grid-top">
          <label className="fact-field">
            <span>物种</span>
            <select
              value={facts.species ?? "Homo sapiens"}
              onChange={(event) => onFactsChange({ ...facts, species: event.target.value })}
            >
              {SPECIES_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <small><FileText size={11} /> 客户方案书 · v1</small>
          </label>
          <label className="fact-field">
            <span>研究目标</span>
            <select
              value={facts.goal ?? "差异表达 · 通路富集"}
              onChange={(event) => onFactsChange({ ...facts, goal: event.target.value })}
            >
              {GOAL_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
            <small><FileText size={11} /> 客户方案书 · v1</small>
          </label>
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
            <small><FileText size={11} /> 客户方案书 · v1</small>
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
            <small><FileText size={11} /> 客户方案书 · v1</small>
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
            <small><FileText size={11} /> 客户方案书 · v1</small>
          </label>
        </div>
        {PENDING_ASKS.map((ask) => {
          const asked = askedKeys.includes(ask.key);
          return (
            <button
              key={ask.key}
              className={`pending-ask ${asked ? "asked" : ""}`}
              disabled={asked}
              title={ask.question}
              onClick={() => {
                setAskedKeys((prev) => [...prev, ask.key]);
                onAsk?.(ask.question, ask.label);
              }}
            >
              {asked ? <Check size={11} /> : <CircleHelp size={11} />}
              {ask.label}
              <small>{asked ? "已追问" : "待确认"}</small>
            </button>
          );
        })}
        {!confirmed && (
          <button className="confirm-facts" onClick={onConfirm}>
            确认本次项目事实
          </button>
        )}
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
