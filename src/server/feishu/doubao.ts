/**
 * 企业豆包(火山方舟)模型接入 — Ark 提供 OpenAI 兼容协议,复用现有
 * 模型网关(provider=openai + baseUrl 指向 Ark)即可,零模型层改动。
 * 这里只做:环境变量自动注册 + 无活跃配置时自动启用。
 */
import type { NovaDb } from "../db/client";
import {
  getActiveProfileId,
  listModelProfiles,
  setActiveProfile,
  upsertModelProfile,
} from "../db/repositories";

export const DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DOUBAO_DEFAULT_MODEL = "doubao-1-5-pro-32k-250115";

/** Register a 豆包/火山方舟 profile from env; auto-activate when nothing is active. */
export function applyDoubaoEnvProfile(db: NovaDb): void {
  const key = process.env.FEISHU_DOUBAO_API_KEY;
  if (!key) return;
  const now = new Date().toISOString();
  const profiles = listModelProfiles(db);
  const existing = profiles.find((p) => (p.baseUrl ?? "").includes("volces"));
  if (!existing) {
    upsertModelProfile(
      db,
      {
        id: "doubao-env",
        label: "豆包·火山方舟",
        provider: "openai",
        baseUrl: DOUBAO_BASE_URL,
        apiKey: key,
        model: process.env.FEISHU_DOUBAO_MODEL ?? DOUBAO_DEFAULT_MODEL,
      },
      now,
    );
    if (!getActiveProfileId(db)) setActiveProfile(db, "doubao-env", now);
    return;
  }
  if (!getActiveProfileId(db)) setActiveProfile(db, existing.id, now);
}
