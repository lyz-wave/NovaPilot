/**
 * NovaPilot persistence schema (SQLite / node:sqlite).
 *
 * The proposal calls for PostgreSQL (project memory), OpenSearch (hybrid
 * retrieval) and Neo4j (knowledge graph). For a locally-runnable end-to-end we
 * fold all three into a single SQLite database:
 *   - relational project memory        -> normal tables
 *   - hybrid retrieval index           -> `chunks` (+ inverted index in code)
 *   - knowledge graph                  -> `graph_nodes` / `graph_edges` adjacency
 *
 * The DDL is idempotent (`IF NOT EXISTS`) so `migrate()` is safe to call on
 * every boot.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── Project memory ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  locale      TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_facts (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  field         TEXT NOT NULL,
  value         TEXT NOT NULL,
  source        TEXT NOT NULL,
  extracted_at  TEXT NOT NULL,
  confidence    REAL NOT NULL,
  confirmation  TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  visibility    TEXT NOT NULL DEFAULT 'project-members'
);
CREATE INDEX IF NOT EXISTS idx_facts_project ON project_facts(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_facts_project_field ON project_facts(project_id, field);

-- ── Decision cards (versioned artifact) ────────────────────────
CREATE TABLE IF NOT EXISTS decision_cards (
  id           TEXT NOT NULL,
  version      INTEGER NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  title        TEXT NOT NULL,
  risk_level   TEXT NOT NULL,
  payload      TEXT NOT NULL,           -- full DecisionCard JSON
  trace_id     TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS idx_cards_project ON decision_cards(project_id);

-- ── Knowledge base: documents + chunks (RAG) ───────────────────
CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,           -- SOP | SCI
  title        TEXT NOT NULL,
  citation     TEXT NOT NULL,
  version      TEXT NOT NULL,
  applies_to   TEXT NOT NULL,
  valid_until  TEXT NOT NULL,
  lang         TEXT NOT NULL DEFAULT 'zh',
  validation   TEXT NOT NULL DEFAULT 'verified'
);

CREATE TABLE IF NOT EXISTS chunks (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  text         TEXT NOT NULL,
  tokens       TEXT NOT NULL,           -- JSON string[] normalized terms (BM25)
  embedding    TEXT NOT NULL           -- JSON number[] vector
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

-- ── Knowledge graph (Neo4j replacement) ────────────────────────
CREATE TABLE IF NOT EXISTS graph_nodes (
  id     TEXT PRIMARY KEY,
  kind   TEXT NOT NULL,                 -- species | sample | technique | platform | metric | risk
  label  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_edges (
  src   TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  rel   TEXT NOT NULL,
  dst   TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (src, rel, dst)
);

-- ── Consent / CRM ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consent_events (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  action       TEXT,
  type         TEXT NOT NULL,
  occurred_at  TEXT NOT NULL,
  source       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS active_consents (
  project_id  TEXT NOT NULL,
  action      TEXT NOT NULL,
  PRIMARY KEY (project_id, action)
);

-- ── Idempotency (shared across write endpoints) ────────────────
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  fingerprint  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- ── Feedback & quality events ──────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  score       INTEGER NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quality_events (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  status      TEXT NOT NULL,
  owner       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- ── Candidate knowledge (governed evolution) ───────────────────
CREATE TABLE IF NOT EXISTS candidates (
  id                  TEXT PRIMARY KEY,
  source_case_id      TEXT NOT NULL,
  statement           TEXT NOT NULL,
  evidence_ids        TEXT NOT NULL,   -- JSON string[]
  scope               TEXT NOT NULL,
  counterexample      TEXT NOT NULL,
  owner               TEXT NOT NULL,
  version             INTEGER NOT NULL,
  valid_until         TEXT NOT NULL,
  status              TEXT NOT NULL,
  production_eligible INTEGER NOT NULL,
  audit_trail         TEXT NOT NULL,   -- JSON
  rollback_version    TEXT,
  created_at          TEXT NOT NULL
);

-- ── Expert cases ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expert_cases (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  status       TEXT NOT NULL,
  payload      TEXT NOT NULL,          -- full ExpertCase JSON
  created_at   TEXT NOT NULL
);

-- ── Orchestration checkpoints (LangGraph replacement) ──────────
CREATE TABLE IF NOT EXISTS checkpoints (
  trace_id    TEXT NOT NULL,
  node        TEXT NOT NULL,
  state       TEXT NOT NULL,          -- JSON snapshot
  created_at  TEXT NOT NULL,
  PRIMARY KEY (trace_id, node)
);

-- ── App settings (model gateway config, etc.) ──────────────────
-- Key-value store. The model config lives under key 'model_config' as JSON;
-- persisted to the local DB file so a configured key/model survives restarts.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ── Conversations (multi-thread index) ────────────────────────
-- Each tenant can hold many conversations (like Claude Code's chat history).
-- A conversation is just an id + a human title + timestamps; its turns live in
-- the messages table keyed by the same id. messages.conversation_id stays a
-- plain column (no FK) so historical single-conversation rows remain valid.
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id, updated_at);

-- ── Conversation messages (chat history) ──────────────────────
-- Each row is one turn of a conversation: a user message, an assistant chat
-- reply, or an assistant decision card (full ConsultationResult JSON in
-- card_payload). Ordered by created_at then rowid so same-timestamp turns keep
-- insertion order.
CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  role             TEXT NOT NULL,          -- user | assistant
  kind             TEXT NOT NULL,          -- chat | card
  text             TEXT,                   -- user question or assistant chat reply
  card_payload     TEXT,                   -- full ConsultationResult JSON (card turns)
  trace_id         TEXT,
  created_at       TEXT NOT NULL
);
-- Index on (conversation_id, created_at); rowid is an implicit tiebreaker in the
-- ORDER BY and can't be named in an index expression, so it's omitted here.
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

-- ── Resolved-case memory (similar-case retrieval) ─────────────
-- A compact, deidentified memory of a resolved consultation: the question, a
-- one-line facts digest, the outcome and the recommended route titles, plus a
-- BM25 token list and a dense embedding for retrieval. At inference time the
-- graph retrieves the most similar past cases and feeds them to the Actor as
-- *context only* — they inform prose, never become citable evidence (that stays
-- the exclusive province of SOP/SCI chunks) — similar-case reuse adapted to
-- NovaPilot's evidence-integrity invariant.
CREATE TABLE IF NOT EXISTS case_memory (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  question     TEXT NOT NULL,
  scenario     TEXT NOT NULL,
  facts_digest TEXT NOT NULL,
  status       TEXT NOT NULL,
  outcome      TEXT NOT NULL,          -- one-line recommended route summary
  tokens       TEXT NOT NULL,          -- JSON string[] normalized terms (BM25)
  embedding    TEXT NOT NULL,          -- JSON number[] vector
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_memory_tenant ON case_memory(tenant_id);

-- ── Eval runs (NovaBench) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_runs (
  id          TEXT PRIMARY KEY,
  suite       TEXT NOT NULL,
  metrics     TEXT NOT NULL,          -- JSON
  gate        TEXT NOT NULL,          -- JSON gate decision
  created_at  TEXT NOT NULL
);

-- ── Release-gate events (发布门禁质量事件闭环) ────────────────
-- 与反馈质量事件(quality_events)分开:此处记录门禁退化事件的生命周期。
CREATE TABLE IF NOT EXISTS gate_events (
  id          TEXT PRIMARY KEY,
  gate_key    TEXT NOT NULL,
  label       TEXT NOT NULL,
  value       TEXT NOT NULL,
  owner       TEXT NOT NULL,
  evidence    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',   -- open | resolved
  simulated   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
`;

export const SCHEMA_VERSION = "1";
