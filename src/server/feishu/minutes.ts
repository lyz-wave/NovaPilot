/**
 * 智能纪要 (Minutes/妙记) import — 会议纪要 → 咨询入口。
 * 凭证缺失时返回 null;调用方应视为功能未启用。
 */
import { feishuEnabled, feishuRequest } from "./client";

export interface MinutesContent {
  title: string;
  text: string;
}

interface TranscriptParagraph {
  speaker_name?: string;
  elements?: Array<{ text_content?: { text?: string } }>;
}

/** Pull a minute's metadata + transcript and flatten it to plain text. */
export async function fetchMinutes(minuteToken: string): Promise<MinutesContent | null> {
  if (!feishuEnabled()) return null;
  const meta = await feishuRequest<{ topic?: string; title?: string; name?: string }>(
    "GET",
    "/minutes/v1/minutes/" + minuteToken,
  );
  const transcript = await feishuRequest<{
    transcript?: { paragraphs?: TranscriptParagraph[] };
  }>("GET", "/minutes/v1/minutes/" + minuteToken + "/transcript?list=true");
  const paragraphs = transcript?.data?.transcript?.paragraphs ?? [];
  const lines = paragraphs.map((p) => {
    const text = (p.elements ?? []).map((e) => e.text_content?.text ?? "").join("");
    const speaker = p.speaker_name ? p.speaker_name + ":" : "";
    return speaker + text;
  });
  const text = lines.filter((l) => l.trim()).join("\n");
  if (!text) return null;
  return {
    title: meta?.data?.title ?? meta?.data?.topic ?? meta?.data?.name ?? "会议纪要",
    text,
  };
}

export interface ExtractedMeetingFacts {
  dv200?: number;
  sampleCount?: number;
  rnaInputNg?: number;
  material?: string;
  species?: string;
  goal?: string;
  suggestedQuestion: string;
}

/** Deterministic fact extraction from meeting text (offline-safe, tolerant). */
export function extractFactsFromText(text: string): ExtractedMeetingFacts {
  const dv200 = text.match(/dv200[^\d]{0,8}(\d{1,3})/i)?.[1];
  const sampleCount = text.match(/(\d+)\s*(?:份|个|例)\s*(?:样本|样品)/)?.[1];
  const rnaInputNg = text.match(/(?:投入量|rna投入|input)[^\d]{0,10}(\d+(?:\.\d+)?)\s*ng/i)?.[1];
  const material = /石蜡|ffpe/i.test(text)
    ? "FFPE RNA"
    : /新鲜|冷冻|frozen/i.test(text)
      ? "新鲜冷冻组织"
      : undefined;
  const species = /人|human/i.test(text)
    ? "人(Homo sapiens)"
    : /小鼠|mouse|mus/i.test(text)
      ? "小鼠(Mus musculus)"
      : /大鼠|rat/i.test(text)
        ? "大鼠(Rattus norvegicus)"
        : undefined;
  const goal = /差异表达|转录组|表达谱|建库|测序|分析/i.exec(text)?.[0];
  const firstLine = text.split("\n").filter((l) => l.trim())[0] ?? "";
  const suggestedQuestion =
    firstLine.trim().slice(0, 80) ||
    "根据会议纪要内容生成科研方案建议(请补充样本类型与质量指标)";
  return {
    dv200: dv200 ? Number(dv200) : undefined,
    sampleCount: sampleCount ? Number(sampleCount) : undefined,
    rnaInputNg: rnaInputNg ? Number(rnaInputNg) : undefined,
    material,
    species,
    goal,
    suggestedQuestion,
  };
}
