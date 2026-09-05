# `data/knowledge/` —— 可摄取知识库源文件

这个目录里的 Markdown 文件由 `npm run kb:ingest` 解析、分块、入库,成为检索链路里
**可被引用的证据块**(与 `src/server/rag/seed-knowledge.ts` 里的内置种子库完全同构)。

## 铁律:外部编号必须逐条核实

**PMID / DOI 只有在 PubMed / 出版社官网逐条核实后才能写进 `citation`。存疑一律不用。**

方案早期版本里引用的 `PMID-31215456`、`PMID-36587412` 未能核实,已移除,不要再加回来。
本目录当前**全部为内部 SOP 类文档**(`source: SOP`,`citation: NV-SOP-*`)——
内部编号由本项目自己定义,不存在冒用外部文献编号的问题。

需要新增 SCI 文献时:先核实,把核实过程(检索式、访问日期、标题作者年份是否一致)
写进 PR 说明,再入库。

## frontmatter 契约

九个字段全部必填,缺一个整篇拒收(见 `src/server/rag/ingest.ts` 的 `FrontmatterSchema`):

```
---
id: E-SOP-XXX-000          # 全局唯一。重复会被摄取脚本判错
source: SOP                # SOP | SCI
title: 文档标题
citation: NV-SOP-XXX-000   # 决策卡里显示的引用号
version: v1.0
appliesTo: 适用范围;分号分隔
validUntil: 2027-12-31     # YYYY-MM-DD,过期文档不会被引用
lang: zh                   # zh | en
validation: verified       # verified | conflict | expired
---
```

## 分块规则

按二级标题(`## `)切段,段内按自然段聚合到 300~500 字。
每个块会自动带上所属小节标题(`【送样要求】…`)—— 检索是按 chunk 打分的,
脱离小节标题的段落经常丢掉「这段在讲什么」的关键词。

写作时因此有两条实用建议:

1. **二级标题要能独立读懂**。`## 二、送样要求` 比 `## 二、要求` 好得多。
2. **一段讲一件事,别写超过 500 字的巨段**。超长段会被按句硬切,切点未必理想。

## 摄取即受控进化

`npm run kb:ingest` 不是「直接灌库」:入库后会立刻跑一次 NovaBench 金标回归,
**回归不过就自动 `removeDocument` 回滚全部本次摄取的文档**,并在 `ingest_runs` 表
留下一行判定记录。想跳过门禁只有显式加 `--no-gate`,而且日志里会如实标注。
