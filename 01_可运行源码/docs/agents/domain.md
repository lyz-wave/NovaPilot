# Domain Docs

本项目采用单上下文领域文档结构。

## Before exploring, read these

- 根目录 `CONTEXT.md`
- `docs/adr/` 中与当前工作相关的 ADR

文件不存在时静默继续，不预先创建无实际决策内容的领域文档。

## Use the glossary's vocabulary

Issue 标题、规格、测试名称、接口和领域模型必须使用 `CONTEXT.md` 定义的术语，不使用其中明确标记为应避免的同义词。

若缺少必要术语，应先判断是否引入了项目外语言；确属领域缺口时，再通过领域建模流程补充。

## Flag ADR conflicts

任何与既有 ADR 冲突的实现或规格都必须显式标注冲突及重开决策的原因，不得静默覆盖。
