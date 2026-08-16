"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "./markdown";

const TICK_MS = 20; // 推进间隔
const CHUNK = 2; // 每次字符数(CJK 友好)→ 约 100 字符/秒,便于边读边生成

interface StreamingTextProps {
  /** 完整文本;组件负责从 0 渐进渲染到完整。 */
  text: string;
  /** 传给 Markdown 的类名(agent-summary 等),布局与静态渲染完全一致。 */
  className?: string;
  /** 渐进渲染结束(或瞬间完成)时回调一次。 */
  onDone?: () => void;
  /** 每次推进时回调(用于跟随滚动)。 */
  onTick?: () => void;
}

/**
 * 流式输出渲染器:把“一次性到达的完整回复”以打字机效果渐进展示,
 * 尾部带闪烁光标。对 prefers-reduced-motion 用户直接显示全文。
 *
 * 为什么不是后端逐 token 推送:科研咨询经过 Actor→Critic 双智能体
 * 证据审查后才允许输出,逐 token 流式会泄露未经审查的文本;这里在
 * 客户端做渐进渲染,离线(确定性)与在线(真实 LLM)模式行为一致。
 */
export function StreamingText({ text, className, onDone, onTick }: StreamingTextProps) {
  const [count, setCount] = useState(0);
  const doneRef = useRef(false);
  // 回调存 ref,避免回调身份变化导致动画重启。
  const cbRef = useRef({ onDone, onTick });
  cbRef.current = { onDone, onTick };

  useEffect(() => {
    const total = text.length;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (total === 0 || reduced) {
      setCount(total);
      if (!doneRef.current) {
        doneRef.current = true;
        cbRef.current.onDone?.();
      }
      return;
    }
    setCount(0);
    doneRef.current = false;
    const id = window.setInterval(() => {
      setCount((prev) => {
        const next = Math.min(prev + CHUNK, total);
        if (next >= total) {
          window.clearInterval(id);
          if (!doneRef.current) {
            doneRef.current = true;
            cbRef.current.onDone?.();
          }
        }
        return next;
      });
      cbRef.current.onTick?.();
    }, TICK_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const finished = count >= text.length;
  return (
    <span className="streaming-wrap">
      <Markdown className={className} text={text.slice(0, count)} />
      {!finished && <span className="stream-caret" aria-hidden="true" />}
    </span>
  );
}
