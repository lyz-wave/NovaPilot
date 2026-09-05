# NovaPilot — 可信科研客户服务智能体

> **2026 AI 先锋未来大赛(飞书)** · [英文版](README.md) · [部署说明](docs/部署说明.md) · [架构说明](docs/架构说明.md) · [参赛方案提交文档](docs/参赛方案提交文档.md) · [前端优化记录](docs/前端优化说明.md)

NovaPilot 是面向**科研客户技术支持与咨询**的 AI 智能服务体系:证据充分时安全解决问题、
证据不足时准确追问、风险较高时携带完整上下文转交专家,并把每一次专家修订经治理后反哺知识库。

- **默认离线确定性运行**:无需任何 API Key,端到端可复现。
- **每条建议绑定证据**:引用只能来自已验证的 SOP/文献证据块,由规则终审的 Critic 强制执行。
- **受治理自进化**:专家修订成为候选知识,经 Owner 审核 + NovaBench 金标回归 + 人工批准 + 灰度
  四道门禁才进生产,支持一键回滚与全程审计。

## 体验与下载

**三平台免安装体验包(v3.2.0)**:内置 Node 运行时 + 全部依赖 + 构建产物,下载解压、双击即用,**无需联网、无需安装任何东西**。

| 平台 | 下载 | 启动方式 |
| --- | --- | --- |
| Windows x64 | [NovaPilot-portable-windows-x64.zip](https://github.com/lyz-wave/NovaPilot/releases/download/v3.2.0/NovaPilot-portable-windows-x64.zip) | 双击「启动.bat」 |
| macOS (Apple Silicon) | [NovaPilot-portable-macos-arm64.zip](https://github.com/lyz-wave/NovaPilot/releases/download/v3.2.0/NovaPilot-portable-macos-arm64.zip) | 双击「启动.command」 |
| Linux x64 | [NovaPilot-portable-linux-x64.zip](https://github.com/lyz-wave/NovaPilot/releases/download/v3.2.0/NovaPilot-portable-linux-x64.zip) | 运行 start.sh |

启动后浏览器打开 http://localhost:3210,演示动线见 [评委快速上手](docs/评委快速上手.md)。每次推送 `v*` 标签,GitHub Actions 自动重建三平台包并挂载 Release。

- **源码包**:[v3.0.0 源码 zip](https://github.com/lyz-wave/NovaPilot/archive/refs/tags/v3.0.0.zip) — `npm install && npm run build && PORT=3210 npm start`
- **在线部署**:NovaPilot 依赖 Node 服务端,无法用 GitHub Pages;可用 Render 免费一键部署(公开链接)或 Codespaces 一键启动,详见 [部署说明](docs/部署说明.md):
  [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lyz-wave/NovaPilot)

## 界面截图

| 客户咨询 | 专家工作台 |
|:---:|:---:|
| ![咨询](screenshots/consultation.png) | ![专家](screenshots/expert.png) |
| 四角色镜头问答、流式回复、科学决策卡 | 证据审查、SLA 队列、修订审批 |

| 知识进化 | 运营评测 |
|:---:|:---:|
| ![知识](screenshots/knowledge.png) | ![运营](screenshots/operations.png) |
| 候选、门禁、灰度、一键回滚 | 真实趋势、退化矩阵、质量事件、金标明细 |

## 核心模块

| 模块 | 说明 |
|---|---|
| **🧑‍🔬 客户咨询** | 四角色工作台(PI/博后/研究生/企业研发)多轮问答;流式输出;场景推断;科学决策卡(预算/周期/风险刻度/证据芯片点击跳转) |
| **🛠 专家工作台** | 转接队列(风险排序 + SLA 倒计时);一次性交接包;证据逐条审查(排除项不进入候选知识);修订 → 候选知识 |
| **🧠 知识进化** | 候选切换器;Owner → NovaBench → 人工批准 → 5% 灰度;逐门禁审计轨迹;一键回滚;候选影响面刷新不丢失 |
| **📊 运营评测** | 真实 NovaBench 运行与历史趋势;五开关退化矩阵(逐门禁注入故障);质量事件(关闭证据必填);9 条金标明细;KPI 目标板 |

## 架构亮点

- **确定性编排状态机**(参考 LangGraph 有状态图模型的零依赖实现,默认路径不依赖该框架):每节点落 DB checkpoint,可审计可重放。
  接地循环那一段还可以用 `NP_ORCHESTRATOR=langgraph` 切到**真实的 `@langchain/langgraph` `StateGraph`** ——
  两条路径复用同一组节点函数,对拍测试保证换编排器不改变答案;该包在 `optionalDependencies` 里,装不上就自动回退。
- **Actor–Critic 双智能体 + 规则终审**:模型只写散文,标题/引用/边界由规则派生,幻觉引用不可能通过。
- **三层证据接地防线**:检索接地 → 规则核验 → 语义复核,任何一层可拒绝推荐;三轮无证据即携完整论证链转专家,绝不硬编。
- **两段式混合检索**:SQLite FTS5(trigram)候选生成 → BM25 + 稠密向量融合 → rerank。稠密通道用内置的
  `bge-small-zh-v1.5`(ONNX int8,纯 WASM 推理、零原生二进制),模型缺失时**整体降级**到确定性哈希向量,检索链路不中断。
- **NovaGuard 可信控制**:证据白名单(有据才答)、风险分级审批(该转就转)、写契约(401/403/412/428)。
- **可版本管理的知识摄取管线**:`data/knowledge/*.md`(frontmatter 由 zod 校验)经 `npm run kb:ingest` 入库,
  **挂在 NovaBench 金标回归门禁上** —— 门禁 `stop` 就整批 SQLite ROLLBACK,没通过的知识一个 chunk 都不留。
- **护栏对可观测性**:六处埋点(引用号反查审计 / 拦截与未转复核抽样 / 案例闭环入流 / 隐式采纳 / 端到端延迟 / 逐轮检索日志)
  让运营看板的每个激励指标都**在类型层面**必须配一个护栏指标,同源同窗成对出数。检索日志按 `(traceId, round)` 单独落表,
  因为 `checkpoints` 的主键会把三轮加深检索压成一行,轮次口径的回退率从那里算不出来。
- **科学决策卡**核心工件:formal / provisional / needs-conditions / expert-review 四态状态机(ADR-0004)。
- **离线运行是硬不变式**:377 个单测 + 14 个 Playwright 验收脚本全部可离线复现。检索的稠密通道**可确定性降级**
  (`NP_DISABLE_SEMANTIC=1` 即回到全链路逐位确定性),其余环节无条件确定。

## 技术栈

- **前端**:Next.js 15(App Router)、React 19、TypeScript、zod、lucide-react
- **后端**:Next.js API Routes、Node 内置 `node:sqlite`(零原生依赖)、领域驱动设计
- **AI**:OpenAI 兼容模型网关(豆包火山方舟 / Claude / 自建)带离线确定性回退;
  语义嵌入用 `onnxruntime-web` 纯 WASM 后端(无原生绑定,三平台同一份产物)
- **测试**:Vitest(377 个单测)+ Playwright(14 个 E2E 验收脚本)

## 快速开始

    npm install
    npm run model:fetch        # 拉语义嵌入模型(23 MB,一次即可;免安装包已内置)
    npm run build
    PORT=3210 npm start

> `model:fetch` 是唯一需要联网的一步,且**可以跳过** —— 跳过后检索自动降级到确定性
> 哈希向量,功能完整,只是语义化提问的召回质量下降(见 `docs/B2-语义向量验收记录.md`)。

浏览器打开:

| 页面 | 地址 |
|---|---|
| 客户咨询 | http://localhost:3210 |
| 专家工作台 | http://localhost:3210/expert |
| 知识进化 | http://localhost:3210/knowledge |
| 运营评测 | http://localhost:3210/operations |

### 质量验证

    npm test            # 377 个单测
    npm run typecheck   # tsc --noEmit
    npm run build       # 生产构建
    npm run model:smoke # 语义向量烟雾测试(验证本机 WASM 后端可离线推理)

### 知识库与运营命令

    npm run kb:ingest              # 摄取 data/knowledge/*.md,过金标门禁才提交
    npm run kb:ingest -- --dry-run # 只解析和分块,不写库
    npm run model:backfill         # 给缺语义向量的 chunk 补齐 512 维向量
    npm run review:judge           # 跑 LLM 初判,给复核队列里的抽样样本出 judge 结论

> 内置知识库 **15 篇文档 / 54 chunk**(7 篇种子 + `data/knowledge/` 下 8 篇 SOP)。
> 摄取是幂等的(按 doc id 删旧重插),重跑不会膨胀。详见 `docs/B3-知识摄取验收记录.md`。

### E2E 验收脚本(本地,端口 3210)

    rm -rf .data                # 每个脚本前清库
    node qa/knowledge-check-check.cjs   # 依此类推,共 14 个

脚本清单:capability · streaming · align · composer · pin · role-lens · facts · card · collapse ·
expert · knowledge · operations · click-audit · smoke,每个脚本输出 PASS/FAIL 汇总。

## 项目结构

    src/
      app/                     页面与 API 路由(consultations / expert-cases / knowledge / quality-events / feishu)
      components/              UI 组件
      domain/                  领域模型与核心逻辑 + 测试
      server/
        orchestration/         确定性编排图 + checkpoint;接地循环可选 LangGraph 适配器
        agents/                Actor-Critic、意图分类、模型网关
        rag/                   混合检索、种子知识、案例记忆、知识摄取管线
        guards/                NovaGuard 发布门禁、引用号反查审计
        telemetry/             六处埋点(复核抽样 / 案例闭环 / 采纳 / 延迟 / 逐轮检索日志)+ 护栏对看板口径
        eval/                  NovaBench 金标集、受治理晋级
        db/                    SQLite schema 与仓储
        feishu/                飞书集成模块(凭证门控)
    data/
      knowledge/               可版本管理的知识源(8 篇 SOP,frontmatter 由 zod 校验)
    docs/
      adr/                     13 项架构决策记录
      feishu/                  飞书集成说明 + 妙搭配方
    deliverables/              竞赛文档(大纲、PDF、架构 SVG)
    docs/前端优化说明.md              前端优化记录(9.1–9.15)
    docs/B1-检索升级验收记录.md        FTS5 中文全文检索
    docs/B2-语义向量验收记录.md        真实语义向量(纯 WASM)
    docs/B3-知识摄取验收记录.md        知识摄取管线 + 五处埋点 + 护栏对看板
    docs/B4-检索日志与可选LangGraph编排验收记录.md
                                      逐轮检索日志(P2 告警)+ 可选 LangGraph 编排

## ADR 精选

- [ADR-0001](docs/adr/0001-define-prd-as-blueprint-with-trusted-mvp.md) — PRD 作为蓝图,构建可信 MVP
- [ADR-0004](docs/adr/0004-make-scientific-decision-card-the-primary-artifact.md) — 科学决策卡作为核心工件
- [ADR-0008](docs/adr/0008-use-one-knowledge-base-for-three-language-service.md) — 单一知识库支持三种语言
- [ADR-0009](docs/adr/0009-govern-evolution-through-candidates-and-release-gates.md) — 发布门控治理
- [ADR-0012](docs/adr/0012-approve-decision-cards-by-risk-tier.md) — 按风险分级审批决策卡
- [ADR-0013](docs/adr/0013-consolidate-safety-controls-into-novaguard.md) — NovaGuard 可信控制整合

## 许可

MIT
