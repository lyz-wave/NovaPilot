/**
 * S4-2 Prompt 版本化存储
 *
 * - 从 data/prompts/*.md 读取种子 prompt（frontmatter 含 id/version）
 * - 写入 prompt_templates 表，hash 为内容 SHA-256 前 16 位
 * - renderPrompt(db, id, vars) 取当前 active 版本渲染 {{var}} 占位符
 */
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { queryAll, type NovaDb } from "../db/client";

const PROMPTS_DIR = join(process.cwd(), "data", "prompts");

interface PromptRow {
  id: string;
  version: string;
  content: string;
  hash: string;
  active: number;
  created_at: string;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    meta[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { meta, body: match[2] };
}

/** Upsert seed prompt files into the prompt_templates table. Idempotent. */
export function seedPromptTemplates(db: NovaDb): void {
  let files: string[];
  try {
    files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }

  const now = new Date().toISOString();
  for (const file of files) {
    const raw = readFileSync(join(PROMPTS_DIR, file), "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const { id, version } = meta;
    if (!id || !version) continue;
    const hash = contentHash(body);
    db.prepare(
      `INSERT OR IGNORE INTO prompt_templates (id, version, content, hash, active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).run(id, version, body, hash, now);
    // If row already exists with same id+version, ensure it's marked active.
    db.prepare(
      `UPDATE prompt_templates SET active = 1 WHERE id = ? AND version = ? AND hash = ?`,
    ).run(id, version, hash);
  }
}

/** Get the active prompt row for a given id. Returns null if not found. */
function getActiveTemplate(db: NovaDb, id: string): PromptRow | null {
  const rows = queryAll<PromptRow>(
    db,
    `SELECT id, version, content, hash, active, created_at
     FROM prompt_templates
     WHERE id = ? AND active = 1
     LIMIT 1`,
    id,
  );
  return rows[0] ?? null;
}

/**
 * Render the active prompt for `id`, substituting `{{varName}}` placeholders
 * with values from `vars`. Returns null when no active template is found.
 */
export function renderPrompt(
  db: NovaDb,
  id: string,
  vars: Record<string, string> = {},
): string | null {
  const template = getActiveTemplate(db, id);
  if (!template) return null;
  return template.content.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

/** Return the hash of the currently active prompt (for writing into checkpoints). */
export function activePromptHash(db: NovaDb, id: string): string | null {
  return getActiveTemplate(db, id)?.hash ?? null;
}
