# NovaPilot — Trusted Scientific Research Customer Service Agent

> **2026 AI Pioneer Future Competition (飞书2026AI先锋未来大赛)**
>
> [中文版](README.zh-CN.md) · [部署说明](部署说明.md) · [架构说明](NovaPilot-Agent架构说明.md) · [参赛方案提交文档](参赛方案提交文档.md) · [前端优化记录](前端优化说明.md)

NovaPilot is an AI-powered service system for **scientific research customer support**. It replaces fragmented manual workflows with a structured, evidence-driven decision engine: the AI answers safely when evidence suffices, asks precisely when it doesn't, and hands off to experts with full context when risk is high — and every expert amendment feeds a **governed knowledge-evolution loop**.

- **Fully offline-deterministic by default** — zero API keys required; every pipeline step is reproducible.
- **Every recommendation is evidence-bound** — citations can only come from verified SOP/literature chunks, enforced by a rule-authority critic.
- **Governed self-evolution** — expert amendments become candidates; only Owner review + NovaBench gold-set regression + human approval + gray release promote them to production, with one-click rollback and a full audit trail.

## Online Demo (Deploy & Click)

NovaPilot needs a Node server (built-in `node:sqlite` local database), so it **cannot run on GitHub Pages (static hosting only)**. Two one-click options, see [部署说明](部署说明.md):

- **Render free one-click deploy** (public link anyone can open):
  [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lyz-wave/NovaPilot)
  You get `https://novapilot.onrender.com` after deployment. Free instances sleep after ~15 min idle and wake in tens of seconds; data resets to the seeded demo state (the app self-seeds).
- **GitHub Codespaces**: repo page → Code → Codespaces → Create codespace. The devcontainer auto-installs, builds and starts the app, forwarding port 3210 with a preview.

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

**Feishu five-in-one integration** (all optional, gracefully disabled without credentials):

| Feishu capability | Role in NovaPilot |
|---|---|
| 企业豆包 (Enterprise Doubao) | LLM backend via Volcengine Ark (OpenAI-compatible); auto-registered from env |
| aily 智能助手 | Consultation entry — decision cards returned as Feishu message cards |
| 多维表格 (Bitable) | Auto-sync of decision cards & quality events (idempotent upsert) |
| 妙搭 (Miaoda) | No-code dashboards — table schemas + view recipes provided |
| 智能纪要 (Minutes) | Meeting transcript → project-fact extraction (DV200, sample count, species…) |

Details: [docs/feishu/飞书五合一集成说明.md](docs/feishu/飞书五合一集成说明.md) · [docs/feishu/妙搭看板表结构.md](docs/feishu/妙搭看板表结构.md)

## Architecture Highlights

- **Deterministic orchestration state machine** (LangGraph replacement) — every node writes a DB checkpoint; runs are inspectable and replayable.
- **Actor–Critic dual agents with a rule-authority critic** — the model only writes prose; titles, citations and boundaries are rule-derived, so hallucinated citations are impossible.
- **Three-layer grounding defense** — retrieval grounding → rule verification → semantic review; any layer can reject a recommendation. After three failed retrieval rounds the system escalates with a full reasoning chain instead of fabricating an answer.
- **NovaGuard trust-control layer** — evidence whitelist ("answer only with evidence"), risk-tiered approval ("escalate when needed"), and a write contract (401/403/412/428).
- **Scientific Decision Card** as the primary artifact — formal / provisional / needs-conditions / expert-review state machine (ADR-0004).
- **Offline determinism is a hard invariant** — no API key, end-to-end deterministic run; 145 unit tests and 14 Playwright acceptance scripts are all reproducible offline.

## Tech Stack

- **Frontend**: Next.js 15 (App Router), React 19, TypeScript, zod, lucide-react
- **Backend**: Next.js API routes, Node built-in `node:sqlite` (zero native deps), domain-driven design
- **AI**: OpenAI-compatible model gateway (Doubao Ark / Claude / self-hosted) with offline deterministic fallback
- **Testing**: Vitest (145 tests) + Playwright (14 E2E acceptance scripts, `.xxx-check.cjs`)

## Getting Started

    npm install
    npm run build
    PORT=3210 npm start

Open in browser:

| Page | URL |
|---|---|
| Customer Consultation | http://localhost:3210 |
| Expert Workbench | http://localhost:3210/expert |
| Knowledge Evolution | http://localhost:3210/knowledge |
| Operations Dashboard | http://localhost:3210/operations |

### Verify

    npm test            # 145 unit tests
    npm run typecheck   # tsc --noEmit
    npm run build       # production build

### E2E acceptance scripts (local, port 3210)

    rm -rf .data                       # fresh DB per script
    node .knowledge-check.cjs          # and so on — 14 scripts total

Scripts: capability · streaming · align · composer · pin · role-lens · facts · card · collapse · expert · knowledge · operations · click-audit · smoke. Each prints a PASS/FAIL summary.

## Project Structure

    src/
      app/                     Pages & API routes (consultations, expert-cases, knowledge, quality-events, feishu/*)
      components/              UI components (workspace, thread, panels, dashboards)
      domain/                  Domain models, decision-card & knowledge-evolution logic + tests
      server/
        orchestration/         Deterministic graph + checkpoints
        agents/                Actor-Critic, intent, model gateway
        rag/                   Hybrid retrieval, seed knowledge, case memory
        guards/                NovaGuard release gates
        eval/                  NovaBench gold set, governed promotion
        db/                    SQLite schema + repositories
        feishu/                Feishu five-in-one integration (credential-gated)
    docs/
      adr/                     13 Architecture Decision Records
      feishu/                  Feishu integration guide + Miaoda recipes
    deliverables/              Competition docs (outlines, PDFs, architecture SVGs)
    前端优化说明.md              Frontend optimization changelog (9.1–9.15)

## ADR Highlights

- [ADR-0001](docs/adr/0001-define-prd-as-blueprint-with-trusted-mvp.md) — PRD as blueprint with trusted MVP
- [ADR-0004](docs/adr/0004-make-scientific-decision-card-the-primary-artifact.md) — Scientific Decision Card as primary artifact
- [ADR-0008](docs/adr/0008-use-one-knowledge-base-for-three-language-service.md) — Single KB for three-language service
- [ADR-0009](docs/adr/0009-govern-evolution-through-candidates-and-release-gates.md) — Governed knowledge evolution
- [ADR-0012](docs/adr/0012-approve-decision-cards-by-risk-tier.md) — Risk-tiered card approval
- [ADR-0013](docs/adr/0013-consolidate-safety-controls-into-novaguard.md) — NovaGuard trust-control consolidation

## License

MIT
