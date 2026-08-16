"use client";

import {
  CircleAlert,
  CircleCheck,
  Cpu,
  LoaderCircle,
  Plus,
  Power,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

interface Profile {
  id: string;
  label: string;
  provider: "anthropic" | "openai";
  model: string;
  baseUrl: string | null;
  apiKeyMasked: string | null;
}
interface State {
  activeId: string | null;
  profiles: Profile[];
}
interface PostResult extends State {
  connected?: boolean;
  saved?: boolean;
  testError?: string | null;
}

const PROVIDER_LABEL: Record<Profile["provider"], string> = {
  anthropic: "Claude",
  openai: "OpenAI",
};

const AUTH = "Bearer demo-research-session";
const writeHeaders = () => ({
  authorization: AUTH,
  "content-type": "application/json",
  "x-tenant-id": "novapilot-demo",
  "x-idempotency-key": crypto.randomUUID(),
  "if-match": '"v3"',
});

export function ModelSettings() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ activeId: null, profiles: [] });
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const modalTitleId = useId();
  const badgeRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 弹窗打开时:锁定背景滚动、焦点移入弹窗;关闭/Escape 时归还焦点。
  useEffect(() => {
    if (!open) return;
    const previousActive = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
      previousActive?.focus?.();
    };
  }, [open]);

  async function loadState() {
    try {
      const res = await fetch("/api/model-config", { headers: { authorization: AUTH } });
      if (res.ok) setState((await res.json()) as State);
    } catch {
      /* leave empty; badge reads offline */
    }
  }
  useEffect(() => {
    void loadState();
  }, []);

  async function post(body: Record<string, unknown>): Promise<PostResult | null> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/model-config", {
        method: "POST",
        headers: writeHeaders(),
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as PostResult | { error: string };
      if (!res.ok || "error" in data) {
        setMessage({ ok: false, text: "操作失败：" + ("error" in data ? data.error : res.status) });
        return null;
      }
      setState({ activeId: data.activeId, profiles: data.profiles });
      return data;
    } catch (e) {
      setMessage({ ok: false, text: "请求出错：" + (e as Error).message });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveNew() {
    if (!apiKey.trim() && !baseUrl.trim()) {
      setMessage({ ok: false, text: "请至少填入 API Key（或自建端点 URL）。" });
      return;
    }
    const data = await post({
      action: "save",
      label: label.trim() || undefined,
      apiKey: apiKey.trim() || undefined,
      model: model.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
    });
    if (!data) return;
    if (data.connected) {
      setLabel("");
      setApiKey("");
      setModel("");
      setBaseUrl("");
      setShowForm(false);
      setMessage({ ok: true, text: "已连接并保存，已设为当前模型 ✓" });
    } else {
      setMessage({ ok: false, text: data.testError ?? "连接失败，未保存。" });
    }
  }

  const active = state.profiles.find((p) => p.id === state.activeId) ?? null;

  return (
    <>
      <button
        ref={badgeRef}
        className={`model-badge ${active ? "online" : "offline"}`}
        onClick={() => setOpen(true)}
        aria-label="模型设置"
        aria-haspopup="dialog"
      >
        <Cpu size={13} />
        <span>{active ? PROVIDER_LABEL[active.provider] : "离线模式"}</span>
        {active && <small>{active.model}</small>}
      </button>

      {open && (
        <div className="model-modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="model-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={modalTitleId}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <Cpu size={16} />
                <strong id={modalTitleId}>模型接入</strong>
              </div>
              <button ref={closeRef} aria-label="关闭" onClick={() => setOpen(false)}>
                <X size={16} />
              </button>
            </header>

            <p className="model-modal-hint">
              选择当前使用的模型。可保存多个（Claude / OpenAI / 自建端点），点一下即切换；
              Key 存在本地、重启保持，页面只显示打码后的 Key。
            </p>

            {/* profile picker */}
            <div className="model-list">
              <button
                className={`model-row ${!state.activeId ? "active" : ""}`}
                disabled={busy}
                onClick={() => void post({ action: "off" })}
              >
                <Power size={15} />
                <div className="model-row-main">
                  <b>离线模式</b>
                  <small>不接大模型，用确定性兜底</small>
                </div>
                {!state.activeId && <span className="model-dot" />}
              </button>

              {state.profiles.map((p) => (
                <div key={p.id} className={`model-row selectable ${p.id === state.activeId ? "active" : ""}`}>
                  <button
                    className="model-row-select"
                    disabled={busy}
                    onClick={() => void post({ action: "activate", id: p.id })}
                  >
                    <Cpu size={15} />
                    <div className="model-row-main">
                      <b>{p.label}</b>
                      <small>
                        {PROVIDER_LABEL[p.provider]} · {p.model}
                        {p.apiKeyMasked ? ` · ${p.apiKeyMasked}` : ""}
                      </small>
                    </div>
                    {p.id === state.activeId && <span className="model-dot" />}
                  </button>
                  <button
                    className="model-row-del"
                    aria-label="删除"
                    disabled={busy}
                    onClick={() => void post({ action: "delete", id: p.id })}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            {/* add new profile */}
            {showForm ? (
              <div className="model-addform">
                <label className="model-field">
                  <span>名称（可选）</span>
                  <input
                    type="text"
                    placeholder="例如：Claude 生产 / 本地 vLLM"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </label>
                <label className="model-field">
                  <span>API Key</span>
                  <input
                    type="password"
                    placeholder="sk-ant-... 或 sk-...（sk-ant 前缀自动识别为 Claude）"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label className="model-field">
                  <span>模型（可留空用默认）</span>
                  <input
                    type="text"
                    placeholder="claude-sonnet-5 / gpt-4o-mini …"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  />
                </label>
                <label className="model-field">
                  <span>自建端点 Base URL（可选 · vLLM 等）</span>
                  <input
                    type="text"
                    placeholder="http://localhost:8000/v1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </label>

                {message && (
                  <div className={`model-message ${message.ok ? "ok" : "err"}`} role="status" aria-live="polite">
                    {message.ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
                    <span>{message.text}</span>
                  </div>
                )}

                <div className="model-actions">
                  <button className="ghost" disabled={busy} onClick={() => setShowForm(false)}>
                    取消
                  </button>
                  <button className="primary" disabled={busy} onClick={saveNew}>
                    {busy ? <LoaderCircle className="spin" size={15} /> : "测试并保存"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {message && (
                  <div className={`model-message ${message.ok ? "ok" : "err"}`} role="status" aria-live="polite">
                    {message.ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
                    <span>{message.text}</span>
                  </div>
                )}
                <button className="model-add-btn" disabled={busy} onClick={() => setShowForm(true)}>
                  <Plus size={15} /> 新增模型
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
