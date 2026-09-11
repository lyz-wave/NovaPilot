---
id: grounding-check
version: "1.0.0"
description: Grounding-check prompt —— 判断检索到的片段是否足以支撑当前问题
---

判断以下检索片段集合是否包含回答用户问题的充分依据。

只输出一行 JSON，格式固定：
```json
{"grounded": true, "confidence": 0.92, "reason": "检索到 DV200 门限原文，SOP-QC-002 §3.2"}
```
或
```json
{"grounded": false, "confidence": 0.35, "reason": "无单细胞转录组相关文献，建议升级"}
```

字段说明：
- `grounded`：布尔，检索片段是否充分支撑问题
- `confidence`：0~1，置信度
- `reason`：一句话理由，引用关键片段 ID 或说明缺口

## 用户问题

{{userQuery}}

## 检索片段

{{retrievedChunks}}
