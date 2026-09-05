# B4 · 逐轮检索日志 + 可选 LangGraph 编排 —— 验收记录

> 对应《量化指标体系 v1.1》第 4 节检索侧四项 + 第 11 节 P2 告警路径,以及
> 《优化落地与工业化升级方案 v2.2》第 2 章对编排框架的取舍。
> 记录日期 2026-09-06。环境:Node v26.3.0(`node:sqlite` 内置 FTS5 与 JSON1),Windows 10 x64。

## 0. 一句话结论

两件事,一次做完:

1. **`retrieval_logs`** —— 按 `(traceId, round)` 逐轮落检索日志,点亮指标体系第 4 节里
   四项此前「连原始数据都不存在」的指标(短查询回退触发率、SOP 覆盖率、知识盲区、
   单篇知识健康度),并让 **P2 告警路径**从无数据源变成两项可用。
2. **可选 LangGraph 编排** —— 接地循环那一段可以用 `NP_ORCHESTRATOR=langgraph` 切到真实的
   `@langchain/langgraph` `StateGraph`,**两条路径复用同一组节点函数**,由 5 条对拍测试保证
   换编排器不改变答案;包在 `optionalDependencies` 里,装不上自动回退。

单测 363 → **377**,`tsc --noEmit` 干净。

---

## 1. 为什么必须单开一张表

每轮检索的诊断本来就写进了 `checkpoints.state`。取不出来的原因是**主键**:

```sql
-- schema.ts,checkpoints
PRIMARY KEY (trace_id, node)
... ON CONFLICT(trace_id, node) DO UPDATE SET state = excluded.state
```

一次咨询最多三轮加深检索,三轮都写 `node = 'retrieve'`,后一轮把前一轮**原地覆盖**。
于是任何以「轮次」为分母的口径(回退触发率、向量空间占比)从 checkpoints 里
**结构性地**算不出来 —— 不是缺聚合,是数据已经被删了。

`retrieval_logs` 的主键是 `RL-<traceId>-<round>`,三轮各留一行。

验证方式是一条带对照的单测:同一次三轮咨询,`retrieval_logs` 留 3 行,
`checkpoints` 的 `retrieve` 节点只剩 1 行。

## 2. 「知识盲区」的口径:拒绝一个恒真的指示灯

直觉做法是「top 检索分低于阈值 = 盲区」。读了 `retrieval.ts` 的 rerank 之后这条路是死的:

```ts
// 融合打分在每次查询内部做 max 归一化
const bm = s.bm25 / maxBm;      // 最高命中的 bm 恒为 1.0
const vec = s.vector / maxVec;
```

于是 top rerank 恒 ≥ `0.7 × 0.6 − 0.2 = 0.22`,**和这次检索到底准不准无关**。
拿它设阈值,得到的是一个恒亮的「质量没问题」指示灯 —— 比没有指标更糟,而且正是指标体系
第 13 节自己警告的那类假安全。

改用**核验结果**定义:`reviewNode` 把本轮 Critic 核验通过数回填进 `retrieval_logs.verified`,
一次会话的**最后一轮** `verified = 0` 才算盲区。

三条配套纪律:

- `verified IS NULL`(流程断在 review 之前)**不等于 0**,被排除在所有聚合外 ——
  把流程故障算进知识质量是另一种造假;
- 只看最后一轮:前两轮没接地正是「加深检索」在起作用,不是盲区;
- 「主题」目前按 `scope_hint` 分组,不是语义聚类 —— 自评里如实记为**部分 0.7**,
  看板脚注写明「这不等于『知识库很全』」。

## 3. 单篇知识健康度:`LEFT JOIN` 不能退化成 `INNER`

```sql
FROM documents d
LEFT JOIN (SELECT ... json_each(r.hit_doc_ids) ...) h ON h.doc_id = d.id
```

**从未被检索命中过的文档必须出现在列表里** —— 这类文档恰恰是最该被看见的
(要么写得没人搜得到,要么该下架)。用 `INNER JOIN` 或把过滤条件写进 `WHERE`
都会让它们消失,而消失的表现是「健康度列表看起来很干净」。单测直接钉这一条:
造一篇永不命中的文档,断言它在结果里且命中数为 0。

> `json_each` 依赖 SQLite 的 JSON1 扩展。已确认 Node v26.3.0 内置的 `node:sqlite` 带 JSON1。

## 4. P2 告警:带样本量门槛

```ts
export const P2_THRESHOLDS = {
  shortQueryFallback: 0.3,   // 回退触发率 > 30%
  sopCoverage: 0.5,          // SOP 覆盖率 < 50%
  minRounds: 20,             // 少于 20 轮不报警
} as const;
```

`minRounds` 和 P1 「跳过 `null`」是同一条纪律:样本太少时报出来的比率是由三五条样本
决定的噪声,报了只会训练团队忽略告警。三项里「跨周唤醒占比」仍无数据源(会话没有
闭环时刻),自评里如实扣 1 分,没有拿两项通过冒充三项。

## 5. 可选 LangGraph 编排

### 5.1 范围:只包环,不包直线

```
        START ──▶ retrieve ──▶ draft ──▶ review ──┬── done ──▶ END
                     ▲                            │
                     └──────── 加深一轮 ◀──────────┘
```

三轮加深检索是全流程里**唯一**一个带条件边的环,正是有状态图模型的主场。
环外的风险门禁、卡片组装、落库是直线流程,套图只增加间接层 —— 它们留在 `graph.ts`
原地不动。**没有第二份实现,也就没有漂移的可能。**

### 5.2 落地方式

| | 默认(native) | 可选(langgraph) |
|---|---|---|
| 打开方式 | 什么都不做 | `NP_ORCHESTRATOR=langgraph` |
| 环的实现 | `grounding-loop.ts` 的 `for(;;)` | `langgraph-adapter.ts` 的 `StateGraph` |
| 节点体 | `retrieveNode` / `draftNode` / `reviewNode` | **同一组函数** |
| 停止条件 | `shouldContinue(state)` | **同一个函数**,条件边只读它 |
| 依赖 | 零 | `@langchain/langgraph`(optionalDependencies) |

原来 `graph.ts` 里那段 ~90 行的内联循环被抽成 `grounding-loop.ts`,两条路径共用。
抽取本身不改变行为 —— 原有 13 条 graph 测试全绿。

### 5.3 三个坑

**坑一:reducer 必须是「后写覆盖」,包括 `loopTrace`。**
LangGraph 的惯例是给数组 channel 配追加型 reducer,但 `reviewNode` 返回的已经是完整新数组
(它自己做了 `[...state.loopTrace, entry]`)。再叠一层追加会让轨迹每轮翻倍 —— 而 loopTrace
正是「三轮加深检索」在专家交接包里的证据链,重复条目会让专家**以为系统检索了六轮**。
单开一条测试钉这个坑(轮次严格递增且无重复)。

**坑二:`recursionLimit` 要写死,不能用默认值。**
取 `MAX_ROUNDS * 3 + 2`(三节点 × 三轮 + START/END)。用默认的 25,环一旦因 bug 停不下来,
报出来的是「递归超限」而不是「第 4 轮不该存在」—— 预算写死才能让越界立刻可见。

**坑三:构造多轮用例不能靠「问一个库里没有的问题」。**
检索在候选不足时会回退全量扫描,冷门问题照样能捞回一堆勉强相关的 chunk 并接地,
于是那条 conditional edge 根本没被走到(第一版对拍测试就只跑出 1 轮)。
改用**把 `now` 推到所有种子知识 `validUntil` 之后**:证据全部过期 → Critic 逐轮否决 →
三轮预算耗尽转专家。

### 5.4 「装不上也能跑」是测过的,不是声称的

`runGroundingLoop` 用动态 `import()` 加载适配器,失败就打一行 warn 回退原生实现。
验收时把 `node_modules/@langchain` 整个移走后跑同一条用例:

```
[orchestration] LangGraph 编排不可用,回退原生实现: Failed to load url @langchain/langgraph ...
✓ package missing → native (1562ms)     # 依旧出正式卡
```

这条是「离线确定性是硬不变式」的必要条件:免安装包里不装它、离线机器上装不上,
都只能是自动降级,不能是咨询失败。

### 5.5 对拍测试(5 条)

同一输入跑两条编排路径,逐字段比对:

| 测试 | 钉住什么 |
|---|---|
| 普通用例卡与证据全等 | 换编排器不改变答案 |
| 多轮用例轮数与 loopTrace 一致 | 那条 conditional edge 真的被走到了 |
| loopTrace 无重复且严格递增 | 坑一 |
| `retrieval_logs` 两边行数相同 | 埋点不因编排器而变 |
| 未知 `NP_ORCHESTRATOR` 值走原生 | 拼错开关不会静默换实现 |

比对的是「答案」本身(status / path / scenario / 建议 id 与引用 / 证据 id / 待办),
不比对 traceId、projectId 这类输入回声。

---

## 6. 验收结果

```
Test Files  29 passed (29)
     Tests  377 passed (377)
  Duration  16.16s
tsc --noEmit  干净
```

自评分从 **75 → 79**:C(告警路径)8 → 9,D(指标口径覆盖)16 → 19。
明细见 `docs/指标体系达成度自评.md`。

## 7. 没做的事(有意)

- **知识盲区的语义聚类**:现按 `scope_hint` 分组,自评记部分分,没有报满分;
- **P2 的跨周唤醒占比**:需要会话闭环时刻,`conversations` 里没有,扣分留着;
- **默认切到 LangGraph**:默认路径必须零依赖,这是免安装包的前提。
