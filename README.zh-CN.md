# NovaPilot — 可信科研客户服务智能体

> **2026 AI 先锋未来大赛（飞书）** — 多轮融合优化优胜方案

NovaPilot 是一个面向**科研客户技术支持与咨询**场景的 AI 智能服务体系。它将多语言、多学科、多通道的技术咨询从碎片化的人工流程转变为基于证据的结构化决策引擎。

## 界面截图

| 客户咨询 | 专家工作台 |
|:---:|:---:|
| ![咨询](screenshots/consultation.png) | ![专家](screenshots/expert.png) |
| 多轮问答与科学决策卡 | 证据绑定、知情同意升级、审批 |

| 知识进化 | 运营评测 |
|:---:|:---:|
| ![知识](screenshots/knowledge.png) | ![运营](screenshots/operations.png) |
|| GraphRAG 知识库与结构化记忆 | 质量指标、发布门控、反馈闭环 |

## 宣传视频

<p align="center">
  <img src="screenshots/novapilot-promo.webp" alt="NovaPilot 宣传视频" width="100%">
</p>

## 核心模块

| 模块 | 说明 |
|---|---|
| **🧑‍💻 客户咨询** | 多轮上下文感知问答，支持领域路由与决策卡生成 |
| **🔬 专家工作台** | 科学决策卡、证据绑定、知情同意升级、推荐审批 |
| **🧠 知识进化** | GraphRAG + Cross-encoder 重排序 + 结构化记忆（xMemory）统一知识库 |
| **📊 运营评测** | 咨询指标、质量评估、发布门控治理、反馈闭环 |

## 架构亮点

- **Agentic RAG 流水线**：LangGraph 编排 + MCP 工具集成 + 自进化反馈飞轮
- **科学决策卡**作为核心工件：每条推荐绑定证据、按风险等级分层、发布门控审批
- **多模态支持**：文本、文档、结构化数据查询，统一知识库
- **三语服务**（中/英/日）：单一知识库支撑三种语言（ADR-0008）
- **发布门控治理**：模型行为与知识更新的受控演化（ADR-0009）

## 技术栈

- **前端**：Next.js 15（App Router）、TypeScript、React
- **后端**：Next.js API Routes、领域驱动模型
- **测试**：Vitest，15 项领域模型测试
- **质量**：桌面端/移动端响应式 + WCAG A/AA 合规

## 快速开始

```bash
npm install
npm run dev
```

浏览器打开：

| 页面 | 地址 |
|---|---|
| 客户咨询 | http://localhost:3000 |
| 专家工作台 | http://localhost:3000/expert |
| 知识进化 | http://localhost:3000/knowledge |
| 运营评测 | http://localhost:3000/operations |

### 质量验证

```bash
npm test        # 15 项领域测试
npm run typecheck
npm run build
```

## 项目结构

```
src/                      ← 可运行源码（Next.js 应用）
  app/                    ← 页面 & API 路由
  components/             ← 7 个 UI 组件
  domain/                 ← 领域模型 + 测试
docs/
  adr/                    ← 13 项架构决策记录
  agents/                 ← Agent 协作规则
deliverables/             ← 精选竞赛交付物
  *.md                    ← 最终方案大纲
  *.svg                   ← 架构图
  PRD/                    ← 产品需求文档
```

## ADR 精选

- [ADR-0001](docs/adr/0001-define-prd-as-blueprint-with-trusted-mvp.md) — PRD 作为蓝图，构建可信 MVP
- [ADR-0004](docs/adr/0004-make-scientific-decision-card-the-primary-artifact.md) — 科学决策卡作为核心工件
- [ADR-0008](docs/adr/0008-use-one-knowledge-base-for-three-language-service.md) — 单一知识库支持三种语言
- [ADR-0009](docs/adr/0009-govern-evolution-through-candidates-and-release-gates.md) — 发布门控治理

## 许可

MIT
