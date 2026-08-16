/**
 * Conversational reply agent — the "chat" branch of the intent gate.
 *
 * For greetings, capability questions and general chit-chat we must NOT run the
 * decision-card pipeline. Instead:
 *   - with a real model connected, answer conversationally through the gateway
 *     (concise, friendly, and explicitly told NOT to invent literature/citations);
 *   - offline (deterministic fallback), return a short canned reply that explains
 *     what NovaPilot does and invites a concrete research question.
 *
 * Either way the output is plain prose — never a decision card and never a
 * fabricated reference.
 */
import { complete, MAX_OUTPUT_TOKENS, type ChatMessage, type ModelGatewayConfig } from "./model-gateway";
import type { Locale } from "@/domain/consultation-journey";

const CHAT_SYSTEM: Record<Locale, string> = {
  zh: "你是 NovaPilot 科研咨询助手，语气友好、专业、自然。请结合前面的对话上下文回答当前这条消息——不要每次都重复自我介绍，也不要机械套话；对方闲聊就自然地聊，对方有情绪就先回应情绪。只有当对方明显想了解你能做什么时，才介绍你的定位（把科研/实验设计问题变成可审计的决策卡：证据检索、Actor-Critic 审查、风险分级、必要时转专家）。回答长度按需要来，该展开就展开、能一句话说清就别啰嗦。当对方提出具体的科研/实验设计问题时，引导他们补充样本类型、关键指标（如 DV200、RNA 投入量、样本数）。严禁编造文献、引用或数据，也不要凭空给出参考文献列表。",
  en: "You are NovaPilot, a research consultation assistant — friendly, professional and natural. Answer the current message in light of the conversation so far; do NOT reintroduce yourself every turn or fall back on canned phrasing. If the user is making small talk, chat naturally; if they're frustrated, acknowledge it first. Only explain what you do when they clearly want to know your capabilities (turning research/experimental-design questions into auditable decision cards: evidence retrieval, Actor-Critic review, risk tiering, expert handoff). Use whatever length fits — expand when it helps, stay brief when a sentence suffices. When they raise a concrete research question, invite the sample type and key metrics (DV200, RNA input, sample count). Never fabricate literature, citations or data, and never invent a reference list.",
  ja: "あなたは研究相談アシスタント NovaPilot です。親しみやすく、専門的で自然な口調で。これまでの会話の流れを踏まえて今回のメッセージに答えてください——毎回自己紹介を繰り返したり、決まり文句に頼ったりしないこと。雑談には自然に応じ、相手が苛立っていればまず気持ちを受け止めてください。自分の役割（研究・実験設計の質問を監査可能な意思決定カードに変換：証拠検索、Actor-Critic レビュー、リスク分級、必要に応じ専門家引き継ぎ）を説明するのは、相手が明らかにそれを知りたがっている時だけにしてください。長さは必要に応じて調整。具体的な研究質問には、試料の種類や主要指標（DV200、RNA 投入量、試料数）を尋ねてください。文献・引用・データの捏造は禁止、参考文献リストも勝手に出さないでください。",
};

/** Short, deterministic reply used when no model is connected. No literature. */
const CANNED_REPLY: Record<Locale, string> = {
  zh: "你好，我是 NovaPilot 科研咨询助手。我可以把你的科研/实验设计问题变成一张可审计的决策卡——检索证据、双智能体审查、分级风险，必要时转接专家。\n\n试着这样问我：\n· 24 份 FFPE 肿瘤样本想做 RNA 差异表达，DV200 62%，怎么选建库路线和测序平台？\n· 低质量 RNA（DV200 未知）能不能直接建库？\n· 现有 SOP 和外部文献冲突时怎么办？",
  en: "Hi, I'm NovaPilot, a research consultation assistant. I turn your research / experimental-design questions into an auditable decision card — retrieving evidence, running a dual-agent review, tiering risk and escalating to an expert when needed.\n\nTry asking me:\n· 24 FFPE tumor samples for RNA differential expression, DV200 62% — which library route and platform?\n· Can low-quality RNA (unknown DV200) go straight to library prep?\n· What happens when the SOP conflicts with external literature?",
  ja: "こんにちは、研究相談アシスタントの NovaPilot です。あなたの研究・実験設計の質問を監査可能な意思決定カードに変換します（証拠検索、二重エージェント審査、リスク分級、必要に応じて専門家へ引き継ぎ）。\n\n例えばこう聞いてください：\n· FFPE 腫瘍試料 24 検体で RNA 差次発現、DV200 62%。ライブラリ方式とプラットフォームは？\n· 低品質 RNA（DV200 不明）はそのままライブラリ化できる？\n· SOP と外部文献が矛盾する場合は？",
};

/**
 * Produce a conversational reply for a non-research message. Uses the model
 * gateway when a provider is configured, and degrades to a canned reply offline.
 *
 * `history` carries the recent conversation turns (oldest first) so the model
 * can actually respond in context — without it, every turn is stateless and the
 * assistant just re-introduces itself.
 */
export async function chatReply(
  input: { question: string; locale: Locale; history?: ChatMessage[] },
  cfg: ModelGatewayConfig = {},
): Promise<{ reply: string; provider: string }> {
  const { question, locale, history = [] } = input;
  const res = await complete(
    {
      messages: [
        { role: "system", content: CHAT_SYSTEM[locale] },
        ...history,
        { role: "user", content: question },
      ],
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.5,
    },
    cfg,
  );

  // complete() never throws — it falls back to the deterministic generator when
  // no provider is reachable. That fallback text is not a real answer, so use
  // the curated canned reply instead.
  if (res.provider === "deterministic") {
    return { reply: CANNED_REPLY[locale], provider: "deterministic" };
  }
  const reply = res.text.trim() || CANNED_REPLY[locale];
  return { reply, provider: res.provider };
}
