# NovaPilot — Trusted Scientific Research Customer Service Agent

> **2026 AI Pioneer Future Competition (飞书2026AI先锋未来大赛)**
>
> [中文版](README.zh-CN.md) · [部署说明](docs/部署说明.md) · [架构说明](docs/架构说明.md) · [参赛方案提交文档](docs/参赛方案提交文档.md) · [前端优化记录](docs/前端优化说明.md)

NovaPilot is an AI-powered service system for **scientific research customer support**. It replaces fragmented manual workflows with a structured, evidence-driven decision engine: the AI answers safely when evidence suffices, asks precisely when it doesn't, and hands off to experts with full context when risk is high — and every expert amendment feeds a **governed knowledge-evolution loop**.

- **Fully offline-deterministic by default** — zero API keys required; every pipeline step is reproducible.
- **Every recommendation is evidence-bound** — citations can only come from verified SOP/literature chunks, enforced by a rule-authority critic.
- **Governed self-evolution** — expert amendments become candidates; only Owner review + NovaBench gold-set regression + human approval + gray release promote them to production, with one-click rollback and a full audit trail.

## 体验与下载 (Demo & Downloads)

**三平台免安装体验包(v3.2.0)**:内置 Node 运行时 + 全部依赖 + 构建产物,下载解压、双击即用,**无需联网、无需安装任何东西**。

| 平台 | 下载 | 启动方式 |
| --- | --- | --- |
| Windows x64 | [NovaPilot-portable-windows-x64.zip](https://github.com/lyz-wave/NovaPilot/releases/download/v3.2.0/NovaPilot-portable-windows-x64.zip) | 双击「启动.bat」 |
| macOS (Apple Silicon) | [NovaPilot-portable-macos-arm64.zip](https://github.com/lyz-wave/NovaPilot/releases/download/v3.2.0/NovaPilot-portable-macos-arm64.zip) | 双击「启动.command」 |
| Linux x64 | [NovaPilot-portable-linux-x64.zip](https://github.com/lyz-wave/NovaPilot/releases/download/v3.2.0/NovaPilot-portable-linux-x64.zip) | 运行 start.sh |

启动后浏览器打开 http://localhost:3210,演示动线见 [评委快速上手](docs/评委快速上手.md)。每次推送 `v*` 标签,GitHub Actions 会自动重建三平台包并挂载到 Release。

- **源码包**:[v3.0.0 源码 zip](https://github.com/lyz-wave/NovaPilot/archive/refs/tags/v3.0.0.zip) — `npm install && npm run build && PORT=3210 npm start`
- **在线部署**:NovaPilot 依赖 Node 服务端(内置 `node:sqlite`),无法用 GitHub Pages;可用 Render 免费一键部署(公开链接)或 GitHub Codespaces 一键启动,详见 [部署说明](docs/部署说明.md):
  [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lyz-wave/NovaPilot)

## Screenshots

| Customer Consultation | Expert Workbench |
|:---:|:---:|
| ![Consultation](screenshots/consultation.png) | ![Expert](screenshots/expert.png) |
| Role-lensed Q&A, streaming replies, scientific decision cards | Evidence review, SLA queue, amendment approval |

| Knowledge Evolution | Operations Dashboard |
|:---:|:---:|
| ![Knowledge](screenshots/knowledge.png) | ![Operations](screenshots/operations.png) |
| Candidates, gates, gray release, one-click rollback | Real trends, degradation matrix, quality events, gold-set drilldown |

## Promo Video

<p align="center">
  <img src="screenshots/novapilot-promo.webp" alt="NovaPilot promotional video demo" width="100%">
</p>

## Key Features

| Module | What it does |
|---|---|
| **🧑‍🔬 Consultation** | Multi-turn Q&A over four role lenses (PI / postdoc / student / corporate R&D); streaming replies; scenario inference; scientific decision cards with budget, timeline, risk gauge and click-to-evidence chips |
| **🛠 Expert Workbench** | Escalation queue with risk sorting and SLA timers; one-shot handoff package (goal, confirmed facts, retrieved evidence, decisions needed); per-chunk evidence review (excluded items never enter candidates); amendment → candidate knowledge |
| **🧠 Knowledge Evolution** | Expert amendments become candidates; Owner review → NovaBench gold-set regression → human approval → 5% gray release; multi-candidate switcher, per-gate audit trail, one-click rollback, bench slices that survive refresh |
| **📊 Operations Dashboard** | Real NovaBench runs with persisted history and real trend sparklines; five-switch degradation matrix (per-gate fault injection); quality events with mandatory closing evidence; expandable 9-case gold-set drilldown; KPI target board |

## Architecture Highlights

- **Deterministic orchestration state machine** — a zero-dependency implementation of the stateful-graph model popularized by LangGraph (the default path does not depend on it); every node writes a DB checkpoint, so runs are inspectable and replayable. The grounding loop can additionally be driven by a **real `@langchain/langgraph` `StateGraph`** via `NP_ORCHESTRATOR=langgraph` — both paths reuse the same node functions, differential tests pin that swapping orchestrators cannot change the answer, and the package sits in `optionalDependencies` so a missing install silently falls back.
- **Actor–Critic dual agents with a rule-authority critic** — the model only writes prose; titles, citations and boundaries are rule-derived, so hallucinated citations are impossible.
- **Three-layer grounding defense** — retrieval grounding → rule verification → semantic review; any layer can reject a recommendation. After three failed retrieval rounds the system escalates with a full reasoning chain instead of fabricating an answer.
- **Two-stage hybrid retrieval** — SQLite FTS5 (trigram) candidate generation → BM25 + dense-vector fusion → rerank. The dense channel runs a bundled `bge-small-zh-v1.5` (ONNX int8) on a pure-WASM backend with zero native binaries; if the model is absent the whole search **degrades wholesale** to the deterministic hash embedding and retrieval never breaks.
- **NovaGuard trust-control layer** — evidence whitelist ("answer only with evidence"), risk-tiered approval ("escalate when needed"), and a write contract (401/403/412/428).
- **Version-controlled knowledge ingestion** — `data/knowledge/*.md` (frontmatter validated by zod) is ingested via `npm run kb:ingest` **behind the NovaBench gold-set regression gate**: a `stop` verdict rolls the entire batch back in one SQLite transaction, so knowledge that fails regression leaves not a single chunk behind.
- **Guardrail-paired observability** — six instrumentation points (citation reverse-audit, interception/non-escalation review sampling, case-closure inflow, implicit adoption, end-to-end latency, per-round retrieval logs) make every incentive metric on the operations dashboard carry a guardrail metric **at the type level**, computed from one query over one time window. Retrieval logs get their own table keyed by `(traceId, round)` because the `checkpoints` primary key collapses three deepening rounds into one row, making per-round fallback rates structurally uncomputable from there.
- **Scientific Decision Card** as the primary artifact — formal / provisional / needs-conditions / expert-review state machine (ADR-0004).
- **Offline operation is a hard invariant** — no API key, end-to-end offline run; 377 unit tests and 14 Playwright acceptance scripts are all reproducible offline. The dense retrieval channel is **deterministically degradable** (`NP_DISABLE_SEMANTIC=1` restores bit-for-bit determinism across the whole chain); everything else is unconditionally deterministic.

## Tech Stack

- **Frontend**: Next.js 15 (App Router), React 19, TypeScript, zod, lucide-react
- **Backend**: Next.js API routes, Node built-in `node:sqlite` (zero native deps), domain-driven design
- **AI**: OpenAI-compatible model gateway (Doubao Ark / Claude / self-hosted) with offline deterministic fallback; semantic embeddings via `onnxruntime-web`'s pure-WASM backend (no native bindings — one artifact for all three platforms)
- **Testing**: Vitest (377 tests) + Playwright (14 E2E acceptance scripts, `.xxx-check.cjs`)

## Getting Started

    npm install
    npm run model:fetch        # fetch the embedding model (23 MB, once; prebuilt bundles ship it)
    npm run build
    PORT=3210 npm start

> `model:fetch` is the only step that needs network access, and it is **optional** — skip it and
> retrieval falls back to the deterministic hash embedding. Everything still works; only recall on
> paraphrased questions degrades (see `docs/B2-语义向量验收记录.md`).

Open in browser:

| Page | URL |
|---|---|
| Customer Consultation | http://localhost:3210 |
| Expert Workbench | http://localhost:3210/expert |
| Knowledge Evolution | http://localhost:3210/knowledge |
| Operations Dashboard | http://localhost:3210/operations |

### Verify

    npm test            # 377 unit tests
    npm run typecheck   # tsc --noEmit
    npm run build       # production build
    npm run model:smoke # semantic smoke test (proves this machine can infer offline)

### Knowledge base & operations

    npm run kb:ingest              # ingest data/knowledge/*.md; commits only if the gold-set gate passes
    npm run kb:ingest -- --dry-run # parse and chunk only, no writes
    npm run model:backfill         # fill in 512-dim vectors for chunks that lack them
    npm run review:judge           # run the LLM first-pass judge over the pending review queue

> The bundled knowledge base is **15 documents / 54 chunks** (7 seed + 8 SOPs under `data/knowledge/`).
> Ingestion is idempotent (delete-old-then-reinsert by doc id), so re-runs do not inflate the index.
> See `docs/B3-知识摄取验收记录.md`.

### E2E acceptance scripts (local, port 3210)

    rm -rf .data                       # fresh DB per script
    node qa/knowledge-check-check.cjs          # and so on — 14 scripts total

Scripts: capability · streaming · align · composer · pin · role-lens · facts · card · collapse · expert · knowledge · operations · click-audit · smoke. Each prints a PASS/FAIL summary.

## Project Structure

    src/
      app/                     Pages & API routes (consultations, expert-cases, knowledge, quality-events, feishu/*)
      components/              UI components (workspace, thread, panels, dashboards)
      domain/                  Domain models, decision-card & knowledge-evolution logic + tests
      server/
        orchestration/         Deterministic graph + checkpoints; optional LangGraph adapter for the grounding loop
        agents/                Actor-Critic, intent, model gateway
        rag/                   Hybrid retrieval, seed knowledge, case memory, ingestion pipeline
        guards/                NovaGuard release gates, citation reverse-audit
        telemetry/             Six instrumentation points + guardrail-pair board definitions
        eval/                  NovaBench gold set, governed promotion
        db/                    SQLite schema + repositories
        feishu/                Feishu integration modules (credential-gated)
    data/
      knowledge/               Version-controlled knowledge source (8 SOPs, zod-validated frontmatter)
    docs/
      adr/                     13 Architecture Decision Records
      feishu/                  Feishu integration guide + Miaoda recipes
    deliverables/              Competition docs (outlines, PDFs, architecture SVGs)
    docs/前端优化说明.md              Frontend optimization changelog (9.1–9.15)
    docs/B1-检索升级验收记录.md        FTS5 Chinese full-text search
    docs/B2-语义向量验收记录.md        Real semantic vectors (pure WASM)
    docs/B3-知识摄取验收记录.md        Ingestion pipeline + instrumentation + guardrail board
    docs/B4-检索日志与可选LangGraph编排验收记录.md
                                      Per-round retrieval logs (P2 alerts) + optional LangGraph orchestration

## ADR Highlights

- [ADR-0001](docs/adr/0001-define-prd-as-blueprint-with-trusted-mvp.md) — PRD as blueprint with trusted MVP
- [ADR-0004](docs/adr/0004-make-scientific-decision-card-the-primary-artifact.md) — Scientific Decision Card as primary artifact
- [ADR-0008](docs/adr/0008-use-one-knowledge-base-for-three-language-service.md) — Single KB for three-language service
- [ADR-0009](docs/adr/0009-govern-evolution-through-candidates-and-release-gates.md) — Governed knowledge evolution
- [ADR-0012](docs/adr/0012-approve-decision-cards-by-risk-tier.md) — Risk-tiered card approval
- [ADR-0013](docs/adr/0013-consolidate-safety-controls-into-novaguard.md) — NovaGuard trust-control consolidation

## License

MIT
