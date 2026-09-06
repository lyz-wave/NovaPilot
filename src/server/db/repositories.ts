/**
 * Repository layer: typed persistence operations over the SQLite schema.
 * Keeps SQL out of domain/orchestration code and centralises the
 * optimistic-concurrency (version) checks the API contract requires.
 */
import { queryAll, queryOne, type NovaDb } from "./client";
import type {
  CandidateKnowledge,
  CardVersionMeta,
  ConsultationResult,
  ConversationMeta,
  ConversationTurn,
  DecisionCard,
  ExpertCase,
  Locale,
  ProjectFactRecord,
} from "@/domain/consultation-journey";

export class VersionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`VERSION_CONFLICT expected v${expected} actual v${actual}`);
    this.name = "VersionConflictError";
  }
}

export interface ProjectRow {
  id: string;
  tenantId: string;
  name: string;
  locale: Locale;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ── Projects ─────────────────────────────────────────────────────
export function upsertProject(
  db: NovaDb,
  input: { id: string; tenantId: string; name: string; locale: Locale; now: string },
): ProjectRow {
  db.prepare(
    `INSERT INTO projects(id, tenant_id, name, locale, version, created_at, updated_at)
     VALUES(?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       locale = excluded.locale,
       updated_at = excluded.updated_at`,
  ).run(input.id, input.tenantId, input.name, input.locale, input.now, input.now);
  return getProject(db, input.id)!;
}

export function getProject(db: NovaDb, id: string): ProjectRow | null {
  return queryOne<ProjectRow>(
    db,
    `SELECT id, tenant_id AS tenantId, name, locale, version,
            created_at AS createdAt, updated_at AS updatedAt
     FROM projects WHERE id = ?`,
    id,
  );
}

/**
 * Bump a project's version, enforcing optimistic concurrency.
 * Throws VersionConflictError when `expectedVersion` !== the stored version.
 */
export function bumpProjectVersion(
  db: NovaDb,
  id: string,
  expectedVersion: number,
  now: string,
): number {
  const current = getProject(db, id);
  if (!current) throw new Error(`project ${id} not found`);
  if (current.version !== expectedVersion) {
    throw new VersionConflictError(expectedVersion, current.version);
  }
  const next = expectedVersion + 1;
  db.prepare("UPDATE projects SET version = ?, updated_at = ? WHERE id = ?").run(
    next,
    now,
    id,
  );
  return next;
}

// ── Project facts ────────────────────────────────────────────────
export function saveFacts(
  db: NovaDb,
  projectId: string,
  records: ProjectFactRecord[],
): void {
  const stmt = db.prepare(
    `INSERT INTO project_facts(id, project_id, field, value, source, extracted_at,
        confidence, confirmation, version, visibility)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, field) DO UPDATE SET
       value = excluded.value,
       source = excluded.source,
       extracted_at = excluded.extracted_at,
       confidence = excluded.confidence,
       confirmation = excluded.confirmation,
       version = project_facts.version + 1`,
  );
  const tx = db.prepare("SELECT 1"); // placeholder to keep transaction shape explicit
  void tx;
  for (const r of records) {
    stmt.run(
      `${projectId}:${r.field}`,
      projectId,
      r.field,
      String(r.value),
      r.source,
      r.extractedAt,
      r.confidence,
      r.confirmation,
      r.version,
      r.visibility,
    );
  }
}

export function listFacts(db: NovaDb, projectId: string): ProjectFactRecord[] {
  const rows = queryAll<Record<string, unknown>>(
    db,
    `SELECT field, value, source, extracted_at AS extractedAt, confidence,
            confirmation, version, visibility
     FROM project_facts WHERE project_id = ? ORDER BY field`,
    projectId,
  );
  return rows.map((r) => ({
    field: r.field as ProjectFactRecord["field"],
    value: coerceValue(r.value as string),
    source: r.source as ProjectFactRecord["source"],
    extractedAt: r.extractedAt as string,
    confidence: r.confidence as number,
    confirmation: r.confirmation as ProjectFactRecord["confirmation"],
    version: r.version as number,
    visibility: "project-members",
  }));
}

function coerceValue(raw: string): string | number {
  const n = Number(raw);
  return raw.trim() !== "" && !Number.isNaN(n) ? n : raw;
}

// ── Decision cards ───────────────────────────────────────────────
export function saveDecisionCard(
  db: NovaDb,
  projectId: string,
  card: DecisionCard,
  traceId: string,
  now: string,
): void {
  db.prepare(
    `INSERT INTO decision_cards(id, version, project_id, status, title, risk_level, payload, trace_id, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id, version) DO UPDATE SET
       status = excluded.status,
       payload = excluded.payload`,
  ).run(
    card.id,
    card.version,
    projectId,
    card.status,
    card.title,
    card.risk.level,
    JSON.stringify(card),
    traceId,
    now,
  );
}

export function getLatestCard(db: NovaDb, projectId: string): DecisionCard | null {
  const row = queryOne<{ payload: string }>(
    db,
    `SELECT payload FROM decision_cards WHERE project_id = ?
     ORDER BY version DESC LIMIT 1`,
    projectId,
  );
  return row ? (JSON.parse(row.payload) as DecisionCard) : null;
}

/**
 * All persisted revisions of a project's decision card, newest first. Backs the
 * decision-card panel's real version-history tab. Pure read — works offline.
 */
export function listCardVersions(db: NovaDb, projectId: string): CardVersionMeta[] {
  return queryAll<{
    version: number;
    status: string;
    title: string;
    trace_id: string;
    created_at: string;
  }>(
    db,
    `SELECT version, status, title, trace_id, created_at
       FROM decision_cards WHERE project_id = ?
      ORDER BY version DESC`,
    projectId,
  ).map((row) => ({
    version: row.version,
    status: row.status,
    title: row.title,
    traceId: row.trace_id,
    createdAt: row.created_at,
  }));
}

// ── Expert cases ─────────────────────────────────────────────────
export function saveExpertCase(
  db: NovaDb,
  projectId: string,
  expertCase: ExpertCase,
  now: string,
): void {
  db.prepare(
    `INSERT INTO expert_cases(id, project_id, status, payload, created_at, claimed_at, resolved_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       payload = excluded.payload,
       claimed_at = excluded.claimed_at,
       -- 办结时刻**一旦写入就不再变**:退回队列再办结,记的仍是第一次办结的时刻。
       -- 用 COALESCE(旧, 新) 而不是反过来 —— 否则「4h 实质响应」可以靠反复
       -- 退回-重办把时钟重置,SLA 达标率就成了一个可以刷的数。
       resolved_at = COALESCE(expert_cases.resolved_at, excluded.resolved_at)`,
  ).run(
    expertCase.id,
    projectId,
    expertCase.status,
    JSON.stringify(expertCase),
    now,
    expertCase.claimedAt ?? null,
    // 「已办结」的判据是状态,不是 resolution 文本有没有填 —— 文本可以为空,
    // 状态是流程事实。
    expertCase.status === "resolved" ? now : null,
  );
}

/** One persisted expert case plus its owning project and creation time. */
export interface ExpertCaseRecord {
  projectId: string;
  createdAt: string;
  expertCase: ExpertCase;
}

function mapExpertCaseRow(row: {
  project_id: string;
  payload: string;
  created_at: string;
}): ExpertCaseRecord {
  return {
    projectId: row.project_id,
    createdAt: row.created_at,
    // Rebuild as a plain object literal (parsed JSON is already plain, but this
    // keeps the record RSC-serialisable when passed to client components).
    expertCase: JSON.parse(row.payload) as ExpertCase,
  };
}

/** All escalated expert cases, newest first. Pure read — works offline. */
export function listExpertCases(db: NovaDb): ExpertCaseRecord[] {
  return queryAll<{ project_id: string; payload: string; created_at: string }>(
    db,
    "SELECT project_id, payload, created_at FROM expert_cases ORDER BY created_at DESC",
  ).map(mapExpertCaseRow);
}

export function getExpertCaseRecord(db: NovaDb, id: string): ExpertCaseRecord | null {
  const row = queryOne<{ project_id: string; payload: string; created_at: string }>(
    db,
    "SELECT project_id, payload, created_at FROM expert_cases WHERE id = ?",
    id,
  );
  return row ? mapExpertCaseRow(row) : null;
}

/**
 * Transition a case (claim / return / resolve) and persist the mutated payload.
 * Returns the updated record, or null when the case doesn't exist.
 */
export function updateExpertCase(
  db: NovaDb,
  input: {
    id: string;
    status?: ExpertCase["status"];
    returnNote?: string;
    resolution?: string;
    /** ISO 认领时间;传 null 清除(退回队列)。 */
    claimedAt?: string | null;
    now: string;
  },
): ExpertCaseRecord | null {
  const record = getExpertCaseRecord(db, input.id);
  if (!record) return null;
  const next: ExpertCase = {
    ...record.expertCase,
    status: input.status ?? record.expertCase.status,
    ...(input.returnNote !== undefined ? { returnNote: input.returnNote } : {}),
    ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
    ...(input.claimedAt !== undefined
      ? input.claimedAt === null
        ? { claimedAt: undefined }
        : { claimedAt: input.claimedAt }
      : {}),
  };
  saveExpertCase(db, record.projectId, next, input.now);
  return { projectId: record.projectId, createdAt: record.createdAt, expertCase: next };
}

// ── Candidate knowledge (governed evolution) ─────────────────────
export function saveCandidate(
  db: NovaDb,
  candidate: CandidateKnowledge,
  now: string,
): void {
  // 「已发布」的判据是 status = 'gray-active'。本系统里灰度生效**就是**终态
  // 生产可用状态,没有单独的「全量」状态 —— 所以第 7 节的「候选→全量周期」在
  // 这里的如实口径是「候选→灰度生效周期」,聚合侧按这个名字出数,不冒充全量。
  const live = candidate.status === "gray-active";
  db.prepare(
    `INSERT INTO candidates(id, source_case_id, statement, evidence_ids, scope,
        counterexample, owner, version, valid_until, status, production_eligible,
        audit_trail, rollback_version, created_at, published_at, gray_started_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       statement = excluded.statement,
       scope = excluded.scope,
       status = excluded.status,
       production_eligible = excluded.production_eligible,
       audit_trail = excluded.audit_trail,
       rollback_version = excluded.rollback_version,
       -- 首次发布时刻只写一次:回滚不清空(那次发布真实发生过,抹掉等于篡改历史),
       -- 二次发布也不覆盖(周期指标问的是「多久才第一次上线」)。
       published_at = COALESCE(candidates.published_at, excluded.published_at),
       -- 灰度窗口左端相反,**每次进灰度都重置**:回滚后再灰度是两个窗口,
       -- 沿用旧窗口会把上一轮的质量事件算进这一轮的灰度期问题率。
       -- 退出灰度时置回 NULL —— 窗口已关闭,再往里归因就是错配。
       gray_started_at = excluded.gray_started_at`,
  ).run(
    candidate.id,
    candidate.sourceCaseId,
    candidate.statement,
    JSON.stringify(candidate.evidenceIds),
    candidate.scope,
    candidate.counterexample,
    candidate.owner,
    candidate.version,
    candidate.validUntil,
    candidate.status,
    candidate.productionEligible ? 1 : 0,
    JSON.stringify(candidate.auditTrail),
    candidate.rollbackVersion,
    now,
    live ? now : null,
    live ? now : null,
  );
}

function mapCandidateRow(row: Record<string, unknown>): CandidateKnowledge {
  return {
    id: row.id as string,
    sourceCaseId: row.source_case_id as string,
    statement: row.statement as string,
    evidenceIds: JSON.parse(row.evidence_ids as string) as string[],
    scope: row.scope as string,
    counterexample: row.counterexample as string,
    owner: row.owner as string,
    version: row.version as number,
    validUntil: row.valid_until as string,
    status: row.status as CandidateKnowledge["status"],
    productionEligible: (row.production_eligible as number) === 1,
    auditTrail: JSON.parse(row.audit_trail as string) as CandidateKnowledge["auditTrail"],
    rollbackVersion: (row.rollback_version as string | null) ?? null,
  };
}

export function getCandidate(db: NovaDb, id: string): CandidateKnowledge | null {
  const row = queryOne<Record<string, unknown>>(
    db,
    "SELECT * FROM candidates WHERE id = ?",
    id,
  );
  return row ? mapCandidateRow(row) : null;
}

/** All candidate knowledge entries, newest first. Pure read — works offline. */
export function listCandidates(db: NovaDb): CandidateKnowledge[] {
  return queryAll<Record<string, unknown>>(
    db,
    "SELECT * FROM candidates ORDER BY created_at DESC",
  ).map(mapCandidateRow);
}

// ── Eval runs (NovaBench) ────────────────────────────────────────
export function saveEvalRun(
  db: NovaDb,
  input: {
    id: string;
    suite: string;
    metrics: unknown;
    gate: unknown;
    /** 完整评测报告(含逐切片结果);缺省时退化为仅存 metrics(兼容旧记录)。 */
    report?: unknown;
    now: string;
  },
): void {
  // Re-running the same suite at the same logical timestamp overwrites the
  // prior record instead of failing on the primary key — release gates are
  // meant to be re-run.
  db.prepare(
    `INSERT INTO eval_runs(id, suite, metrics, gate, created_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       suite = excluded.suite,
       metrics = excluded.metrics,
       gate = excluded.gate,
       created_at = excluded.created_at`,
  ).run(
    input.id,
    input.suite,
    JSON.stringify(input.report ?? input.metrics),
    JSON.stringify(input.gate),
    input.now,
  );
}

/** 最近一次 NovaBench 报告的完整切片视图(用于候选影响面表格)。 */
export interface StoredBenchCase {
  id: string;
  expected: string;
  actual: string;
  correct: boolean;
  invalidCitations: string[];
  /** Hit Rate@5 逐条结果。历史记录里没有这个字段时为 undefined。 */
  hitAtK?: boolean | null;
}

export interface StoredBenchReport {
  suite: string;
  accuracy: number;
  passed: number;
  total: number;
  decision: string;
  failed: string[];
  maxTrafficPercent: number;
  cases: StoredBenchCase[];
  createdAt: string;
}

function parseStoredBenchRow(row: {
  metrics: string;
  gate: string;
  suite: string;
  created_at: string;
}): StoredBenchReport | null {
  try {
    const payload = JSON.parse(row.metrics) as {
      accuracy?: number;
      passed?: number;
      total?: number;
      decision?: string;
      cases?: Array<{
        id?: string;
        expected?: string;
        actual?: string;
        correct?: boolean;
        invalidCitations?: string[];
        hitAtK?: boolean | null;
      }>;
    };
    if (!Array.isArray(payload.cases) || payload.cases.length === 0) return null;
    const gate = JSON.parse(row.gate) as {
      decision?: string;
      failed?: string[];
      maxTrafficPercent?: number;
    };
    return {
      suite: row.suite,
      accuracy: typeof payload.accuracy === "number" ? payload.accuracy : 0,
      passed: typeof payload.passed === "number" ? payload.passed : 0,
      total: typeof payload.total === "number" ? payload.total : 0,
      decision: payload.decision ?? gate.decision ?? "stop",
      failed: Array.isArray(gate.failed) ? gate.failed : [],
      maxTrafficPercent: typeof gate.maxTrafficPercent === "number" ? gate.maxTrafficPercent : 0,
      cases: payload.cases.map((c) => ({
        id: c.id ?? "",
        expected: c.expected ?? "",
        actual: c.actual ?? "",
        correct: c.correct ?? false,
        invalidCitations: c.invalidCitations ?? [],
        hitAtK: (c as { hitAtK?: boolean | null }).hitAtK,
      })),
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

/**
 * Latest persisted NovaBench report, or null when none exists (or the row is
 * a legacy metrics-only record from before report persistence).
 */
export function getLatestBenchReport(db: NovaDb): StoredBenchReport | null {
  const row = queryOne<{ suite: string; metrics: string; gate: string; created_at: string }>(
    db,
    "SELECT suite, metrics, gate, created_at FROM eval_runs ORDER BY created_at DESC LIMIT 1",
  );
  return row ? parseStoredBenchRow(row) : null;
}

/** 单次运行的历史条目(含门禁结果;用于趋势与运行历史回看)。 */
export interface BenchHistoryEntry {
  createdAt: string;
  accuracy: number;
  passed: number;
  total: number;
  decision: string;
  metrics: {
    citationValidity: number;
    escalationRecall: number;
    confidentWrongDelta: number;
    p0Defects: number;
    dataBoundaryIncidents: number;
    // 可选:漏放率是后加的门禁项,历史 run 的 JSON 里没有这两个字段。
    // 读到 undefined 表示「那次运行还没有这个指标」,不是「漏放 0」—— 看板必须
    // 按前者显示（"—"），把缺失当 0 就是把假安全写进趋势图。
    hallucinationLeaks?: number;
    hallucinationTotal?: number;
    // 可选:Hit Rate@5 是后加的,历史 run 无此字段 → undefined 表示未采集。
    hitRateAtK?: number | null;
    hitRateTotal?: number;
  } | null;
  report: StoredBenchReport | null;
}

/** All persisted NovaBench runs, newest first (legacy rows skipped). */
export function listBenchHistory(db: NovaDb, limit = 12): BenchHistoryEntry[] {
  const rows = queryAll<{ suite: string; metrics: string; gate: string; created_at: string }>(
    db,
    "SELECT suite, metrics, gate, created_at FROM eval_runs ORDER BY created_at DESC LIMIT ?",
    limit,
  );
  const out: BenchHistoryEntry[] = [];
  for (const row of rows) {
    const report = parseStoredBenchRow(row);
    if (!report) continue; // legacy metrics-only row
    let metrics: BenchHistoryEntry["metrics"] = null;
    try {
      const payload = JSON.parse(row.metrics) as { metrics?: BenchHistoryEntry["metrics"] };
      if (payload.metrics) metrics = payload.metrics;
    } catch {
      metrics = null;
    }
    out.push({
      createdAt: row.created_at,
      accuracy: report.accuracy,
      passed: report.passed,
      total: report.total,
      decision: report.decision,
      metrics,
      report,
    });
  }
  return out;
}

// ── Quality events (发布门禁质量事件闭环) ───────────────────────
export interface QualityEventRecord {
  id: string;
  gateKey: string;
  label: string;
  value: string;
  owner: string;
  evidence: string;
  status: "open" | "resolved";
  simulated: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

function mapQualityEventRow(row: {
  id: string;
  gate_key: string;
  label: string;
  value: string;
  owner: string;
  evidence: string;
  status: string;
  simulated: number;
  created_at: string;
  resolved_at: string | null;
}): QualityEventRecord {
  return {
    id: row.id,
    gateKey: row.gate_key,
    label: row.label,
    value: row.value,
    owner: row.owner,
    evidence: row.evidence,
    status: row.status === "resolved" ? "resolved" : "open",
    simulated: row.simulated === 1,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function saveQualityEvent(db: NovaDb, event: QualityEventRecord): void {
  db.prepare(
    `INSERT INTO gate_events(id, gate_key, label, value, owner, evidence, status, simulated, created_at, resolved_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label,
       value = excluded.value,
       owner = excluded.owner,
       evidence = excluded.evidence,
       status = excluded.status,
       simulated = excluded.simulated,
       resolved_at = excluded.resolved_at`,
  ).run(
    event.id,
    event.gateKey,
    event.label,
    event.value,
    event.owner,
    event.evidence,
    event.status,
    event.simulated ? 1 : 0,
    event.createdAt,
    event.resolvedAt,
  );
}

export function getQualityEvent(db: NovaDb, id: string): QualityEventRecord | null {
  const row = queryOne<{
    id: string; gate_key: string; label: string; value: string; owner: string;
    evidence: string; status: string; simulated: number; created_at: string; resolved_at: string | null;
  }>(db, "SELECT * FROM gate_events WHERE id = ?", id);
  return row ? mapQualityEventRow(row) : null;
}

/** All quality events, newest first. */
export function listQualityEvents(db: NovaDb): QualityEventRecord[] {
  return queryAll<{
    id: string; gate_key: string; label: string; value: string; owner: string;
    evidence: string; status: string; simulated: number; created_at: string; resolved_at: string | null;
  }>(db, "SELECT * FROM gate_events ORDER BY created_at DESC").map(mapQualityEventRow);
}

/** An open event for the given gate (idempotent open). */
export function findOpenQualityEvent(db: NovaDb, gateKey: string): QualityEventRecord | null {
  return listQualityEvents(db).find((e) => e.gateKey === gateKey && e.status === "open") ?? null;
}

/** Resolve an open event with mandatory closing evidence. */
export function resolveQualityEvent(
  db: NovaDb,
  id: string,
  evidence: string,
  now: string,
): QualityEventRecord | null {
  const current = getQualityEvent(db, id);
  if (!current) return null;
  const resolved: QualityEventRecord = {
    ...current,
    evidence,
    status: "resolved",
    resolvedAt: now,
  };
  saveQualityEvent(db, resolved);
  return resolved;
}

// ── App settings: model gateway config (multi-profile) ───────────
// The frontend stores several model "profiles" (Claude / OpenAI / self-hosted)
// and picks which one is active — like Claude Code's model picker. Both the
// profile list and the active-id pointer live in the settings KV table, so a
// configured set of keys/models survives restarts.

export interface StoredModelConfig {
  provider: "anthropic" | "openai";
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

export interface ModelProfile extends StoredModelConfig {
  id: string;
  label: string;
}

const PROFILES_KEY = "model_profiles";
const ACTIVE_KEY = "model_active";

function readKV(db: NovaDb, key: string): string | null {
  return queryOne<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", key)?.value ?? null;
}

function writeKV(db: NovaDb, key: string, value: string, now: string): void {
  db.prepare(
    `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

/** All saved model profiles (empty array if none). */
export function listModelProfiles(db: NovaDb): ModelProfile[] {
  const raw = readKV(db, PROFILES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ModelProfile[]) : [];
  } catch {
    return [];
  }
}

/** The id of the active profile, or null when offline. */
export function getActiveProfileId(db: NovaDb): string | null {
  return readKV(db, ACTIVE_KEY) || null;
}

/** Set the active profile (null / "" ⇒ offline). */
export function setActiveProfile(db: NovaDb, id: string | null, now: string): void {
  writeKV(db, ACTIVE_KEY, id ?? "", now);
}

/** Add or update a profile by id. */
export function upsertModelProfile(db: NovaDb, profile: ModelProfile, now: string): void {
  const profiles = listModelProfiles(db);
  const idx = profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) profiles[idx] = profile;
  else profiles.push(profile);
  writeKV(db, PROFILES_KEY, JSON.stringify(profiles), now);
}

/** Delete a profile; clears the active pointer if it referenced this profile. */
export function deleteModelProfile(db: NovaDb, id: string, now: string): void {
  const profiles = listModelProfiles(db).filter((p) => p.id !== id);
  writeKV(db, PROFILES_KEY, JSON.stringify(profiles), now);
  if (getActiveProfileId(db) === id) setActiveProfile(db, null, now);
}

/** Resolve the active profile to a gateway config, or null when offline. */
export function getActiveModelConfig(db: NovaDb): StoredModelConfig | null {
  const id = getActiveProfileId(db);
  if (!id) return null;
  const profile = listModelProfiles(db).find((p) => p.id === id);
  if (!profile) return null;
  return { provider: profile.provider, apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.model };
}

// ── Conversation messages (chat history) ─────────────────────────
// The ongoing consultation is one persistent conversation per tenant. Every
// turn (user message, assistant chat reply, assistant decision card) is stored
// so the thread survives reloads and restarts.

export interface AppendMessageInput {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  kind: "chat" | "card";
  text?: string | null;
  /** Full ConsultationResult for a card turn; serialized to card_payload. */
  result?: ConsultationResult | null;
  traceId?: string | null;
  now: string;
}

export function appendMessage(db: NovaDb, input: AppendMessageInput): void {
  db.prepare(
    `INSERT INTO messages(id, conversation_id, role, kind, text, card_payload, trace_id, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.conversationId,
    input.role,
    input.kind,
    input.text ?? null,
    input.result ? JSON.stringify(input.result) : null,
    input.traceId ?? null,
    input.now,
  );
}

/** Full ordered conversation for a tenant (oldest first). */
export function listConversation(db: NovaDb, conversationId: string): ConversationTurn[] {
  const rows = queryAll<{
    id: string;
    role: string;
    kind: string;
    text: string | null;
    card_payload: string | null;
    created_at: string;
  }>(
    db,
    `SELECT id, role, kind, text, card_payload, created_at
     FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`,
    conversationId,
  );
  return rows.map((r) => ({
    id: r.id,
    role: r.role as ConversationTurn["role"],
    kind: r.kind as ConversationTurn["kind"],
    text: r.text,
    result: r.card_payload ? (JSON.parse(r.card_payload) as ConsultationResult) : null,
    createdAt: r.created_at,
  }));
}

/** Delete a conversation's history (the "清空对话" action). */
export function clearConversation(db: NovaDb, conversationId: string): void {
  db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
  // Clearing the history also resets any compaction summary for that thread.
  clearCompactState(db, conversationId);
}

// ── Conversation compaction state (context "compact") ────────────
// A non-destructive compaction: the raw messages are always kept (the UI still
// shows the full thread); we only store a summary of the *older* turns so the
// context actually fed to the model shrinks — exactly like Claude Code's
// /compact. Stored in the settings KV under `compact:<conversationId>`.

export interface CompactState {
  /** Chinese summary of the folded (older) turns. */
  summary: string;
  /** Id of the last message covered by `summary`; turns after it stay raw. */
  throughMessageId: string;
  createdAt: string;
}

function compactKey(conversationId: string): string {
  return `compact:${conversationId}`;
}

export function readCompactState(db: NovaDb, conversationId: string): CompactState | null {
  const raw = readKV(db, compactKey(conversationId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CompactState;
  } catch {
    return null;
  }
}

export function writeCompactState(
  db: NovaDb,
  conversationId: string,
  state: CompactState,
): void {
  writeKV(db, compactKey(conversationId), JSON.stringify(state), state.createdAt);
}

export function clearCompactState(db: NovaDb, conversationId: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(compactKey(conversationId));
}

// ── Conversations (multi-thread index) ───────────────────────────
// A tenant holds many conversations. The turns live in `messages` keyed by the
// conversation id; this index tracks title + timestamps so the UI can list,
// switch, rename and delete threads (like Claude Code's chat history).

export const DEFAULT_CONVERSATION_TITLE = "新对话";

/** Short human title from the first user message (single line, ~24 chars). */
export function deriveConversationTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return DEFAULT_CONVERSATION_TITLE;
  return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean;
}

/** Create a conversation row (no-op if the id already exists). */
export function createConversation(
  db: NovaDb,
  input: { id: string; tenantId: string; title?: string; role?: string | null; now: string },
): void {
  db.prepare(
    `INSERT INTO conversations(id, tenant_id, title, created_at, updated_at, role)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    input.id,
    input.tenantId,
    input.title ?? DEFAULT_CONVERSATION_TITLE,
    input.now,
    input.now,
    input.role ?? null,
  );
}

/**
 * 记录本轮的咨询者视角。每轮都覆盖 —— 用户中途从「研究生」切到「PI」,
 * 会话的当前画像就是 PI。传 undefined 时**不动**已有值(前端没送角色的老客户端
 * 不应该把已记录的画像抹成 NULL)。
 */
export function setConversationRole(
  db: NovaDb,
  input: { id: string; role?: string | null },
): void {
  if (input.role == null) return;
  db.prepare("UPDATE conversations SET role = ? WHERE id = ?").run(input.role, input.id);
}

/**
 * 会话闭环状态(第 3 节跨周唤醒占比)。
 *
 * `closedAt` 非空 = 这一轮把问题答完了(产出 formal 卡);null = 会话仍开着。
 * 每轮都写,所以再次提问会自动把它清回 null —— 这一列表达的是**当前状态**,
 * 不是只增不减的墓碑。墓碑式的写法会让「被唤醒的存量会话」永远算不出来,
 * 而那恰好是这个指标要看的东西(指标体系 1.4 节)。
 */
export function setConversationClosure(
  db: NovaDb,
  input: { id: string; closedAt: string | null },
): void {
  db.prepare("UPDATE conversations SET closed_at = ? WHERE id = ?").run(
    input.closedAt,
    input.id,
  );
}

/** Ensure a conversation exists (used when a message lands on a fresh id). */
export function ensureConversation(
  db: NovaDb,
  input: { id: string; tenantId: string; now: string },
): void {
  createConversation(db, input);
}

/** One conversation's metadata, or null when it doesn't belong to the tenant. */
export function getConversation(
  db: NovaDb,
  input: { id: string; tenantId: string },
): ConversationMeta | null {
  const rows = listConversations(db, input.tenantId);
  return rows.find((c) => c.id === input.id) ?? null;
}

/** All conversations for a tenant, newest activity first, with message counts. */
export function listConversations(db: NovaDb, tenantId: string): ConversationMeta[] {
  const rows = queryAll<{
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    lastMessageAt: string | null;
  }>(
    db,
    `SELECT c.id AS id, c.title AS title, c.created_at AS createdAt,
            c.updated_at AS updatedAt,
            COUNT(m.id) AS messageCount, MAX(m.created_at) AS lastMessageAt
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE c.tenant_id = ?
     GROUP BY c.id
     ORDER BY c.updated_at DESC, c.created_at DESC`,
    tenantId,
  );
  // node:sqlite rows have a null prototype; RSC can only pass plain objects to
  // client components, so rebuild each row as an object literal.
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    messageCount: Number(r.messageCount),
    lastMessageAt: r.lastMessageAt ?? null,
  }));
}

/** Rename a conversation (tenant-scoped). */
export function renameConversation(
  db: NovaDb,
  input: { id: string; tenantId: string; title: string; now: string },
): void {
  db.prepare(
    "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
  ).run(input.title, input.now, input.id, input.tenantId);
}

/** Delete a conversation and all its messages (tenant-scoped). */
export function deleteConversation(
  db: NovaDb,
  input: { id: string; tenantId: string },
): void {
  db.prepare("DELETE FROM conversations WHERE id = ? AND tenant_id = ?").run(
    input.id,
    input.tenantId,
  );
  clearConversation(db, input.id);
}

/** Bump updated_at so the thread floats to the top of the list. */
export function touchConversation(db: NovaDb, input: { id: string; now: string }): void {
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(input.now, input.id);
}

/**
 * Set the title from the first user message, but only while the conversation
 * still carries the default placeholder — so later messages never clobber a
 * title the user set (or the auto-title from the very first question).
 */
export function titleFromFirstMessage(
  db: NovaDb,
  input: { id: string; text: string; now: string },
): void {
  db.prepare(
    `UPDATE conversations SET title = ?, updated_at = ?
     WHERE id = ? AND title = ?`,
  ).run(deriveConversationTitle(input.text), input.now, input.id, DEFAULT_CONVERSATION_TITLE);
}

// ── Idempotency ──────────────────────────────────────────────────
export type IdempotencyResult =
  | { state: "fresh" }
  | { state: "replay" }
  | { state: "conflict" };

export function checkIdempotency(
  db: NovaDb,
  key: string,
  fingerprint: string,
  now: string,
): IdempotencyResult {
  const prev = queryOne<{ fingerprint: string }>(
    db,
    "SELECT fingerprint FROM idempotency_keys WHERE key = ?",
    key,
  );
  if (!prev) {
    db.prepare(
      "INSERT INTO idempotency_keys(key, fingerprint, created_at) VALUES(?, ?, ?)",
    ).run(key, fingerprint, now);
    return { state: "fresh" };
  }
  return prev.fingerprint === fingerprint ? { state: "replay" } : { state: "conflict" };
}
