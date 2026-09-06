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

-- embedding_semantic 是 B2 新增的真实语义向量(bge-small-zh-v1.5,512 维)。
-- 它可以为 NULL —— 模型缺失时入库仍要成功,只是这一列空着,检索整体降级到
-- embedding 那一列的确定性哈希向量。两个向量空间维度和量纲都不同,绝不能混算,
-- 空间选择由 retrieval.ts 统一裁决(见那里的 vectorSpace 诊断)。
CREATE TABLE IF NOT EXISTS chunks (
  id                 TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal            INTEGER NOT NULL,
  text               TEXT NOT NULL,
  tokens             TEXT NOT NULL,      -- JSON string[] normalized terms (BM25)
  embedding          TEXT NOT NULL,      -- JSON number[] 确定性哈希向量(256 维)
  embedding_semantic TEXT                -- JSON number[] 语义向量(512 维),可为 NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

-- ── 全文检索索引 (FTS5) ────────────────────────────────────────
-- 候选生成用,不参与打分:BM25 + 向量融合 + rerank 仍在 retrieval.ts 里算。
-- 分词器必须是 trigram 而不是 unicode61 —— unicode61 把连续汉字当成一个
-- token,「超微量建库流程」里查「建库」得 0 命中,中文检索会整体失效。
-- trigram 的代价是 <3 字的查询结构性漏召(见 retrieval.ts 的回退通道)。
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id    UNINDEXED,
  document_id UNINDEXED,
  content,
  tokenize = 'trigram'
);

-- 三个触发器保证 chunks 与 chunks_fts 严格同步。DELETE 触发器不可省:
-- removeDocument(一键回滚)删 chunks 后,FTS 表若不同步,已被回滚的知识
-- 仍能被检索到并当作证据引用,直接违背「受控进化」语义。
-- (实测:documents 的 ON DELETE CASCADE 删除 chunks 时该触发器同样会触发。)
CREATE TRIGGER IF NOT EXISTS trg_chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(chunk_id, document_id, content)
  VALUES (new.id, new.document_id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS trg_chunks_fts_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE chunk_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_chunks_fts_au AFTER UPDATE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE chunk_id = old.id;
  INSERT INTO chunks_fts(chunk_id, document_id, content)
  VALUES (new.id, new.document_id, new.text);
END;

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

-- 降级矩阵触发流水(第 8 节「五开关各自触发次数」)。
--
-- 为什么不能拿 quality_events 的行数当触发次数:开事件是**按闸门去重**的
-- (同一道闸门已有未闭事件就直接复用,见 api/quality-events)。去重对事件闭环
-- 是对的 —— 一道一直失败的闸门不该堆出一百条待办;但它让「触发了几次」这个数
-- 永远等于「有几道闸门出过问题」。第 8 节问的是前者,所以必须另开一张只追加的
-- 流水表。两个数并列上板:触发次数看抖动频次,未闭事件数看待办积压。
CREATE TABLE IF NOT EXISTS degrade_triggers (
  id          TEXT PRIMARY KEY,
  gate_key    TEXT NOT NULL,
  label       TEXT NOT NULL,
  -- console = 运营台手工注入(演示/演练);runtime = 系统自身降级。
  -- 两者混在一起会让演练把真实降级次数冲高,所以分开记、分开出数。
  source      TEXT NOT NULL,
  -- 触发时是否有一条未闭事件被复用(即这一次触发被去重吃掉了)。
  deduped     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_degrade_triggers_gate ON degrade_triggers(gate_key, created_at);

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
  created_at          TEXT NOT NULL,
  -- 候选→全量周期(第 7 节)。auditTrail 的条目是 {stage, actor},**没有时间戳**,
  -- 所以「什么时候发布的」全库无记录,离线脚本也补不出来 —— 是结构性缺失,不是缺聚合。
  -- NULL = 尚未发布;发布后回滚**不清空**它:那次发布真实发生过,清掉等于篡改历史。
  published_at        TEXT,
  -- 灰度期问题率(第 7 节)的窗口左端。质量事件要能关联到「哪一次灰度期内」,
  -- 只有一个发布时刻是不够的:回滚之后再次灰度,是两个窗口。
  gray_started_at     TEXT
);

-- ── Expert cases ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expert_cases (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  status       TEXT NOT NULL,
  payload      TEXT NOT NULL,          -- full ExpertCase JSON
  created_at   TEXT NOT NULL,
  -- 专家 SLA 达标率(第 6 节)。payload JSON 里有 claimedAt,但 SLA 是要按窗口
  -- 聚合的比率,从 JSON 里捞需要全表扫 + 解析;更要命的是 resolvedAt 此前
  -- **根本没有** —— updateExpertCase 收 resolution 文本却不记时刻,于是
  -- 「4h 实质响应达标率」结构性不可算。两个时刻都提到列上,SQL 直接能算。
  claimed_at   TEXT,
  resolved_at  TEXT
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
  updated_at  TEXT NOT NULL,
  -- 角色分布(第 3 节)。存的是**咨询者视角**(pi | postdoc | student | rnd) ——
  -- 用户在角色条上自己选的那个,此前只活在前端 useState 里,从未落库。
  -- 注意口径:指标体系第 3 节的「四角色」指的是咨询者/专家/知识管理员/运营
  -- 这四类**系统角色**,那一份由 roleActivity() 从各自的表里算(见 session-mix.ts);
  -- 这一列是咨询者内部的画像分布,两者不是同一个数,看板上分两格显示。
  role        TEXT,
  -- 会话闭环时刻(第 3 节跨周唤醒占比 + 第 11 节 P2)。
  -- 定义:最后一轮产出了 formal 卡 = 这次咨询被答完了。下一轮再来提问时清回 NULL
  -- (会话被重新打开)。所以它表达的是「当前是否处于已闭环状态」,而不是一个
  -- 只增不减的墓碑 —— 后者会让「跨周唤醒」这个指标永远算不出重新打开的会话。
  closed_at   TEXT
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
  -- B3-4:这条记忆是哪来的。resolved = 真实办结的咨询;cold-start = 随包发布的
  -- 冷启动样例。相似案例会被喂给 Actor 影响措辞,所以「这是真实先例还是我们写的
  -- 样例」必须能区分 —— 冷启动样例在 UI 上标注待 Coach 复核,不能冒充历史战绩。
  provenance   TEXT,                   -- resolved | cold-start(NULL 视为 resolved)
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

-- ── 知识摄取日志 (B3 摄取流水线) ───────────────────────────────
-- 每次 npm run kb:ingest 落一行,记录摄取了哪些文档、多少 chunk、金标回归
-- 门禁判定、以及回归不过时是否已回滚。知识库的每一次变更都要有据可查 ——
-- 「受控进化」不能只体现在候选知识那条链路上,批量摄取同样要留痕。
CREATE TABLE IF NOT EXISTS ingest_runs (
  id           TEXT PRIMARY KEY,
  source_dir   TEXT NOT NULL,
  doc_count    INTEGER NOT NULL,
  chunk_count  INTEGER NOT NULL,
  docs         TEXT NOT NULL,            -- JSON [{id,file,title,chunks}]
  parse_errors TEXT NOT NULL DEFAULT '[]', -- JSON string[]
  gate         TEXT NOT NULL,            -- JSON 金标回归门禁判定,未跑时为 null
  outcome      TEXT NOT NULL,            -- committed | rolled-back | parse-failed
  detail       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_created ON ingest_runs(created_at);

-- ══ 指标体系 v1.1 第 12 节:四处埋点缺口 ═══════════════════════════
-- 指标体系点出现有系统缺四处采集。补上它们的目的不是「多几张表」,而是让看板上
-- 的护栏对(第 10 节)真正成对有数 —— 只有激励指标有数、护栏指标没数的看板,
-- 比没有看板更危险,因为它会让人以为自己在被约束。

-- ── 埋点 A:引用号反查审计(服务「证据绑定率」) ─────────────────
-- 每出一张卡就把卡上每个引用号拿回本轮检索结果里反查一遍:在不在、是否
-- verified、是否过期。这是本系统的生命线指标(目标 100%,非估算),所以它必须由
-- 一段**独立于生成路径**的代码判定 —— Critic 放行不等于绑定成立,自己证明自己
-- 通过没有意义。绑定率 < 100% 时同时落一条 quality_events(P0)。
CREATE TABLE IF NOT EXISTS citation_audits (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  trace_id      TEXT NOT NULL,
  card_status   TEXT NOT NULL,
  total         INTEGER NOT NULL,        -- 卡上引用号总数
  bound         INTEGER NOT NULL,        -- 反查成立的个数
  binding_rate  REAL NOT NULL,           -- bound / total;total=0 时记 1
  violations    TEXT NOT NULL DEFAULT '[]', -- JSON [{citation,reason}]
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_citation_audits_created ON citation_audits(created_at);

-- ── 埋点 B:拦截/未转样本复核队列(服务「误拦截率」「该转未转率」「judge 一致率」)
-- 两级机制(指标体系 5.1):LLM 离线预审给「应放/应拦」判定 + 置信度,专家只审
-- 分歧。所以一行里同时留 judge 判定与专家判定两套字段,agreement 由两者比对
-- 得出 —— judge 只做预筛,终审权在专家手里,这是那一节写死的铁律。
-- judge 是**离线任务**,不在运行时链路上,不破坏离线确定性约束。
CREATE TABLE IF NOT EXISTS review_samples (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,         -- intercepted(被拦) | not-escalated(未转)
  project_id      TEXT NOT NULL,
  trace_id        TEXT NOT NULL,
  system_action   TEXT NOT NULL,         -- 系统当时的处置
  context         TEXT NOT NULL,         -- JSON 复核所需上下文摘要
  judge_verdict   TEXT,                  -- should-pass | should-block | should-escalate | should-not-escalate
  judge_confidence REAL,
  judge_model     TEXT,
  judge_at        TEXT,
  expert_verdict  TEXT,                  -- 同上枚举;专家终审,缺省 NULL = 未审
  expert_note     TEXT,
  expert_at       TEXT,
  agreement       TEXT,                  -- agree | disagree | pending(任一方缺失)
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_samples_kind ON review_samples(kind, created_at);

-- ── 埋点 C:专家办结「是否产出候选知识」标记(服务「修订回流率」) ───
-- 知识进化飞轮的转速表。为 0 说明进化闭环断裂 —— 专家在一次次解决同样的问题,
-- 而系统一次也没学会。所以办结时必须回答这个问题,并且「否」也要填理由:
-- 无脑填「否」和无脑填「是」一样会让指标失真,填了理由才能事后判断是真没有
-- 可沉淀的东西,还是嫌麻烦。
CREATE TABLE IF NOT EXISTS case_closures (
  id             TEXT PRIMARY KEY,
  case_id        TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  owner          TEXT NOT NULL,
  resolution     TEXT NOT NULL,          -- 办结结论
  produced_candidate INTEGER NOT NULL,   -- 0 | 1
  candidate_id   TEXT,                   -- 产出时指向 candidates.id
  no_candidate_reason TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_closures_created ON case_closures(created_at);

-- ── 埋点 D:决策卡采纳事件(服务「隐式采纳率」) ────────────────────
-- 科研用户方案好用时默默复制走、从不点赞,只看显式负反馈会系统性高估不满。
-- 复制/导出/同步三个动作都算主动采纳行为。
-- 口径边界(指标体系 4.4):复制也可能是「复制去质疑」,所以隐式采纳率**只做
-- 体验对冲指标,不进可信解决率计算链** —— 这张表的数据不允许被算进任何可信度
-- 指标,否则它自己就成了可游戏化对象。
CREATE TABLE IF NOT EXISTS adoption_events (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  card_id      TEXT NOT NULL,
  action       TEXT NOT NULL,            -- copy | export | sync
  surface      TEXT NOT NULL DEFAULT '', -- 触发位置,便于诊断
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adoption_events_created ON adoption_events(created_at);
CREATE INDEX IF NOT EXISTS idx_adoption_events_project ON adoption_events(project_id);

-- ── 端到端延迟采样(服务第 10 节「P95 延迟 ↔ 防线通过率结构」这一对) ──
-- 这一张不属于四处埋点,是护栏对重组时补的缺口:第 10 节要求延迟必须与防线结构
-- 成对看(「优化延迟不得以防线为代价」),而系统里原本一个延迟数都没落库。
-- 只记 API 边界的墙上时钟毫秒 + 处置状态 —— 有了状态,才能验证「延迟下降」不是
-- 靠少走防线换来的:formal 与 expert-review 的延迟要分开看。
-- 检索层的 elapsedMs 不能拿来充当这个数:它只覆盖一段,标成端到端 P95 是偷换口径。
CREATE TABLE IF NOT EXISTS latency_samples (
  id           TEXT PRIMARY KEY,
  trace_id     TEXT NOT NULL,
  route        TEXT NOT NULL,            -- consultations | consultations:stream
  kind         TEXT NOT NULL,            -- research | chat
  card_status  TEXT NOT NULL DEFAULT '', -- formal | expert-review | needs-conditions | ''
  duration_ms  INTEGER NOT NULL,
  -- 流式成功率(第 8 节)。此前这一项结构性不可算:采样写在 respond() **之后**,
  -- 中断的流一行都不落,分子分母都拿不到 —— 于是「成功率」只能由成功的样本算出来,
  -- 恒等于 100%。改成**开流即落一行** started,收尾改 completed / failed,
  -- 消费端断开由 ReadableStream 的 cancel() 改 aborted。
  -- 非流式路由固定写 completed;它没有「中断」这个状态,不该混进流式分母。
  outcome      TEXT NOT NULL DEFAULT 'completed', -- started | completed | aborted | failed
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_latency_samples_created ON latency_samples(created_at);

-- ── 检索日志(服务第 6 节「检索侧」四项 + 第 11 节 P2 告警路径) ─────
-- 这些数原本「有」但取不出来:每轮检索的诊断确实写进了 checkpoints.state 的
-- JSON,可 checkpoints 的主键是 (trace_id, node) 且 ON CONFLICT DO UPDATE ——
-- 一次咨询最多三轮加深检索,后一轮把前一轮**原地覆盖**掉。看板要的
-- 「短查询回退触发率」分母是**轮次**不是会话,靠聚合 checkpoints 绕不过去。
-- 所以单开一张按轮次寻址的表(id = RL-<traceId>-<round>)。
--
-- 为什么不给「分值过阈」留一列:rerank 的融合分在**每次查询内部**做了
-- max 归一化(retrieval.ts 里 bm25/maxBm),最高命中的 bm 恒为 1.0,于是
-- top rerank 恒 ≥ 0.22,和这次检索到底准不准无关。拿它设阈值是自欺欺人。
-- 「知识盲区」因此改用一个真信号:该轮检索出的证据**有没有撑住核验** ——
-- 由 review 节点回填 verified,末轮 verified = 0 才算盲区。
CREATE TABLE IF NOT EXISTS retrieval_logs (
  id                  TEXT PRIMARY KEY,   -- RL-<traceId>-<round>
  trace_id            TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  round               INTEGER NOT NULL,
  query               TEXT NOT NULL,
  query_chars         INTEGER NOT NULL,   -- 短查询回退的自变量,单独存便于分桶
  scope_hint          TEXT NOT NULL DEFAULT '',  -- 主题维度:知识盲区按它归组
  top_k               INTEGER NOT NULL,
  channel             TEXT NOT NULL,      -- fts | fallback
  fallback_reason     TEXT,               -- channel = fts 时为 NULL
  vector_space        TEXT NOT NULL,      -- semantic | hash
  vector_space_reason TEXT,               -- vector_space = semantic 时为 NULL
  candidate_count     INTEGER NOT NULL,
  hit_count           INTEGER NOT NULL,
  hit_doc_ids         TEXT NOT NULL DEFAULT '[]',  -- JSON string[](去重后的文档 id)
  elapsed_ms          INTEGER NOT NULL,
  -- 回填字段:检索发生在起草之前,本轮证据是否撑住核验要等 review 节点才知道。
  -- NULL 表示还没回填(流程中断/异常),不能当 0 用 —— 会把中断算成盲区。
  verified            INTEGER,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retrieval_logs_created ON retrieval_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_retrieval_logs_trace ON retrieval_logs(trace_id, round);
`;

export const SCHEMA_VERSION = "9";

/**
 * 存量库回填:FTS 表是 schema v2 新增的,老库里 chunks 已有数据但
 * chunks_fts 为空。触发器只覆盖新写入,所以 migrate 时补一次差集。
 * 幂等 —— 已在 FTS 里的 chunk 不会重复插入,每次启动都可安全执行。
 */
export const FTS_BACKFILL_SQL = `
INSERT INTO chunks_fts(chunk_id, document_id, content)
SELECT c.id, c.document_id, c.text
FROM chunks c
WHERE NOT EXISTS (SELECT 1 FROM chunks_fts f WHERE f.chunk_id = c.id);
`;

/**
 * 逐列增补迁移:`CREATE TABLE IF NOT EXISTS` 对**已存在**的表是空操作,所以
 * v2 老库升到 v3 时不会自动长出 `embedding_semantic` 列。migrate() 按
 * `PRAGMA table_info` 判断后补 ALTER。
 *
 * 新增列必须可为 NULL 且无默认值 —— SQLite 的 ADD COLUMN 才能 O(1) 完成,
 * 也正好对应「模型缺失时语义向量为空」的降级语义。
 */
export const ADDITIVE_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  ddl: string;
}> = [
  {
    table: "chunks",
    column: "embedding_semantic",
    ddl: "ALTER TABLE chunks ADD COLUMN embedding_semantic TEXT",
  },
  {
    table: "case_memory",
    column: "provenance",
    ddl: "ALTER TABLE case_memory ADD COLUMN provenance TEXT",
  },
  // v9 · 生命周期时刻。这一批全部是「原本连原始数据都不存在」的指标的数据源,
  // 补的是列不是聚合 —— 没有这些列,对应指标在离线脚本里也算不出来。
  {
    table: "candidates",
    column: "published_at",
    ddl: "ALTER TABLE candidates ADD COLUMN published_at TEXT",
  },
  {
    table: "candidates",
    column: "gray_started_at",
    ddl: "ALTER TABLE candidates ADD COLUMN gray_started_at TEXT",
  },
  {
    table: "expert_cases",
    column: "claimed_at",
    ddl: "ALTER TABLE expert_cases ADD COLUMN claimed_at TEXT",
  },
  {
    table: "expert_cases",
    column: "resolved_at",
    ddl: "ALTER TABLE expert_cases ADD COLUMN resolved_at TEXT",
  },
  {
    table: "conversations",
    column: "role",
    ddl: "ALTER TABLE conversations ADD COLUMN role TEXT",
  },
  {
    table: "conversations",
    column: "closed_at",
    ddl: "ALTER TABLE conversations ADD COLUMN closed_at TEXT",
  },
  {
    // 唯一一个带默认值的:老库里已有的样本都是「跑完了才落库」的,
    // 按 completed 回填是对它们的如实描述。新库里 started 由开流时写入。
    table: "latency_samples",
    column: "outcome",
    ddl: "ALTER TABLE latency_samples ADD COLUMN outcome TEXT NOT NULL DEFAULT 'completed'",
  },
];
