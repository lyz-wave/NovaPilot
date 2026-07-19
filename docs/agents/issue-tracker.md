# Issue tracker: Local Markdown

本项目的 Issue 与规格（PRD）以 Markdown 文件保存在 `.scratch/`。

## Conventions

- 每项能力使用一个目录：`.scratch/<feature-slug>/`
- 规格文件为 `.scratch/<feature-slug>/spec.md`
- 实施任务分别写入 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号，不使用合并式 tickets 文件
- Issue 文件顶部使用 `Status:` 记录 triage 状态，标签含义参见 `triage-labels.md`
- 评论与讨论历史追加到文件底部的 `## Comments`

## When a skill says "publish to the issue tracker"

在 `.scratch/<feature-slug>/` 下创建文件，并按需创建目录。

## When a skill says "fetch the relevant ticket"

读取用户指定的文件路径或 Issue 编号所对应的文件。

## Wayfinding operations

- Map：`.scratch/<effort>/map.md`
- 子任务：`.scratch/<effort>/issues/NN-<slug>.md`
- 子任务顶部使用 `Type:` 和 `Status:` 记录类型与状态
- 阻塞关系使用 `Blocked by: NN, NN`
- 认领前将状态改为 `claimed` 并保存
- 完成后在 `## Answer` 下记录结果，将状态改为 `resolved`，并把摘要与链接追加到 Map
