"use client";

import { type ReactNode } from "react";

/**
 * Lightweight, dependency-free Markdown renderer.
 *
 * The Actor agent (in online mode) returns a richly-formatted answer — headings,
 * bold, bullet/numbered lists, inline code, `[citation]` tokens and the odd
 * inline `$math$` fragment. Rendered into a plain <p> those markers showed up
 * literally ("### 一、…", "**…**"). This component parses the subset the Actor
 * actually emits and renders real HTML, with zero new dependencies (the project
 * ships only lucide-react/next/react/react-dom/zod).
 *
 * It is intentionally forgiving: any input that isn't Markdown (e.g. the offline
 * deterministic summary, or a short escalation notice) simply renders as plain
 * paragraphs.
 */

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "code"; text: string }
  | { type: "p"; text: string }
  | { type: "hr" };

const H_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^\s*[-*•]\s+/;
const OL_RE = /^\s*\d+[.)]\s+/;
const FENCE_RE = /^```/;
const HR_RE = /^\s*([-*_])\1{2,}\s*$/;

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    // fenced code block
    if (FENCE_RE.test(line.trim())) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i]!.trim())) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: "code", text: buf.join("\n") });
      continue;
    }

    const heading = line.match(H_RE);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (UL_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL_RE.test(lines[i]!)) {
        items.push(lines[i]!.replace(UL_RE, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (OL_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL_RE.test(lines[i]!)) {
        items.push(lines[i]!.replace(OL_RE, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // paragraph: gather consecutive lines until a blank line or a new block start
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !H_RE.test(lines[i]!) &&
      !UL_RE.test(lines[i]!) &&
      !OL_RE.test(lines[i]!) &&
      !FENCE_RE.test(lines[i]!.trim())
    ) {
      para.push(lines[i]!);
      i++;
    }
    blocks.push({ type: "p", text: para.join("\n") });
  }

  return blocks;
}

// Inline constructs, tried left-to-right at each position: code, bold, italic,
// inline math, [text](url) links, and [bracketed] citation tokens. Underscore
// emphasis is deliberately unsupported so technical tokens (file_names, PE150)
// never get mangled.
const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\*[^*\n]+?\*)|(\$[^$\n]+?\$)|(\[[^\]]+\]\([^)]+\))|(\[[^\]]+\])/g;

function renderText(text: string, keyPrefix: string): ReactNode[] {
  // Preserve intra-paragraph line breaks.
  return text.split("\n").flatMap((segment, li, arr) => {
    const nodes = renderInline(segment, `${keyPrefix}-l${li}`);
    if (li < arr.length - 1) nodes.push(<br key={`${keyPrefix}-br${li}`} />);
    return nodes;
  });
}

function renderInline(segment: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  // A FRESH regex instance per call: INLINE_RE is a module-level /g regex, and
  // bold/italic recurse into renderInline. Sharing one regex means the inner
  // call resets the outer call's lastIndex, so the outer loop re-matches the
  // same token forever (infinite recursion → heap OOM). A local copy gives each
  // (including recursive) invocation its own lastIndex state.
  const re = new RegExp(INLINE_RE.source, INLINE_RE.flags);
  let n = 0;

  while ((m = re.exec(segment))) {
    if (m.index > last) out.push(segment.slice(last, m.index));
    const key = `${keyPrefix}-i${n++}`;
    const [full, code, bold, italic, math, link, cite] = m;

    if (code) {
      out.push(<code className="md-code" key={key}>{code.slice(1, -1)}</code>);
    } else if (bold) {
      out.push(<strong key={key}>{renderInline(bold.slice(2, -2), key)}</strong>);
    } else if (italic) {
      out.push(<em key={key}>{renderInline(italic.slice(1, -1), key)}</em>);
    } else if (math) {
      out.push(<span className="md-math" key={key}>{math.slice(1, -1)}</span>);
    } else if (link) {
      const lm = link.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      out.push(
        <a className="md-link" href={lm[2]} key={key} rel="noreferrer" target="_blank">
          {lm[1]}
        </a>,
      );
    } else if (cite) {
      out.push(<span className="md-cite" key={key}>{cite}</span>);
    }

    last = m.index + full.length;
  }

  if (last < segment.length) out.push(segment.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const blocks = parseBlocks(trimmed);

  return (
    <div className={className ? `md ${className}` : "md"}>
      {blocks.map((block, bi) => {
        const key = `b${bi}`;
        switch (block.type) {
          case "heading": {
            const level = Math.min(block.level + 2, 6); // map md h1→h3 inside the card
            const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
            return <Tag key={key}>{renderText(block.text, key)}</Tag>;
          }
          case "ul":
            return (
              <ul key={key}>
                {block.items.map((it, ii) => (
                  <li key={`${key}-${ii}`}>{renderText(it, `${key}-${ii}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key}>
                {block.items.map((it, ii) => (
                  <li key={`${key}-${ii}`}>{renderText(it, `${key}-${ii}`)}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <pre className="md-pre" key={key}>
                <code>{block.text}</code>
              </pre>
            );
          case "hr":
            return <hr key={key} />;
          case "p":
          default:
            return <p key={key}>{renderText((block as { text: string }).text, key)}</p>;
        }
      })}
    </div>
  );
}
