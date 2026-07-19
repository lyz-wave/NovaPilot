# NovaPilot 完整项目交付包

本文件夹汇总了 NovaPilot 可信科研客户服务智能体的可运行源码、最终竞赛文档、PRD、架构图及历史参考方案。

## 目录说明

- `01_可运行源码`：Next.js 前端、API、领域模型、测试、ADR、工程规格及项目记录。
- `02_最终交付文档`：完整方案、融合终版、PRD、方案大纲、团队补充材料、PDF、DOCX、SVG 与原交付压缩包。
- `03_历史方案与参考`：早期诺禾方案和用于融合对比的另一套设计方案。

## 启动前端

进入 `01_可运行源码` 后执行：

```bash
npm install
npm run dev
```

浏览器打开：

- 客户咨询：`http://localhost:3000`
- 专家工作台：`http://localhost:3000/expert`
- 知识进化：`http://localhost:3000/knowledge`
- 运营评测：`http://localhost:3000/operations`

## 质量验证

```bash
npm test
npm run typecheck
npm run build
```

当前版本包含 15 项领域测试，并已完成四个页面的桌面端、移动端及 WCAG A/AA 自动验收。

## 未包含内容

为控制交付体积，没有复制以下可重新生成的内容：

- `node_modules`
- `.next`
- Git 内部历史 `.git`
- 临时 PDF/图片渲染目录 `tmp`
- TypeScript 构建缓存

这些内容均不影响源码恢复、依赖安装、运行和构建。

