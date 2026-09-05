/**
 * B3-4 · 案例记忆冷启动种子(方案 v2.2 第 6 章第 5 步)。
 *
 * 相似案例检索在空库上是个安全 no-op —— 但那意味着评委第一次提问时,「历史相似
 * 案例」这一栏永远是空的,一个核心能力看不见。所以随包发布三条覆盖主要场景的样例。
 *
 * 三条硬约束:
 *
 *  1. **不冒充历史战绩。** 三条都写 `provenance: "cold-start"`,前端标注「冷启动
 *     样例 · 待 Coach 复核」。把我们自己编的样例混在真实办结记录里,是把演示做成
 *     了造假 —— 答辩时被追问一句「这三个项目号能查到吗」就崩了。
 *  2. **不成为引用。** 相似案例只作为上下文喂给 Actor,引用号仍然只能来自
 *     SOP/SCI chunk(见 case-memory.ts 顶部说明与 Critic)。这一条由现有架构保证,
 *     种子数据不需要额外做什么 —— 但正因为它只影响措辞不影响引用,写得保守才对。
 *  3. **与知识库阈值一致。** 三条样例里的 DV200、投入量、处置结论必须和
 *     `data/knowledge/` 里的 SOP 对得上,否则同一个问题问两遍会得到互相矛盾的
 *     「先例」和「证据」。
 *
 * 项目号统一 `CS-` 前缀(cold-start),一眼能从真实项目号里区分出来。
 */
import type { NovaDb } from "../db/client";
import { queryAll } from "../db/client";
import { recordCaseMemory } from "./case-memory";
import type { ProjectFacts, Scenario } from "@/domain/consultation-journey";

interface ColdStartCase {
  projectId: string;
  question: string;
  scenario: Scenario;
  facts: ProjectFacts;
  status: string;
  outcome: string;
}

/** 固定时间戳:冷启动样例不是「刚发生的事」,不该按今天排到最前面。 */
const COLD_START_AT = "2026-01-15T00:00:00.000Z";

export const COLD_START_CASES: ReadonlyArray<ColdStartCase> = [
  {
    // 标准路线:双边界都过,正式决策卡。这是最常见的问法,也是唯一一条 formal。
    projectId: "CS-LUAD-FFPE-01",
    question:
      "肺腺癌 FFPE 蜡块 24 例做转录组差异表达,DV200 62%、RNA 投入 20 ng,能不能直接走常规建库?",
    scenario: "standard",
    facts: { sampleCount: 24, dv200: 62, rnaInputNg: 20, material: "FFPE RNA" },
    status: "formal",
    outcome:
      "DV200 与投入量双边界均达标,按链特异性总 RNA 常规路线执行;每组不少于 3 例生物学重复,24 例分 2 组时同批完成提取建库上机。",
  },
  {
    // 灰区路线:条件可行,必须先明确止损条件才放行 —— provisional 而非 formal。
    projectId: "CS-BIOPSY-LOWINPUT-02",
    question: "穿刺样本 RNA 只提到 3 ng,DV200 41%,还能做转录组吗?需要注意什么?",
    scenario: "non-standard",
    facts: { sampleCount: 8, dv200: 41, rnaInputNg: 3, material: "FFPE RNA" },
    status: "provisional",
    outcome:
      "投入量落在 2~10 ng 低输入档、DV200 落在 30%~50% 灰区,判为条件可行:走低输入优化建库(13~15 循环),先试建库并预设止损条件(文库产量不达上机下限即停);穿刺样本须先由病理确认肿瘤区域占比,低于 20% 时在报告中标注稀释影响。",
  },
  {
    // 升级路线:硬阈值触发,系统不出方案,转专家。这条存在的意义是让「该转就转」
    // 也有先例可循 —— 冷启动只放能过的例子会把系统教成过度乐观。
    projectId: "CS-ARCHIVAL-ESCALATE-03",
    question: "2018 年的老蜡块,DV200 只有 24%,客户还是想做全转录组,有办法吗?",
    scenario: "manual-escalation",
    facts: { sampleCount: 12, dv200: 24, rnaInputNg: 8, material: "FFPE RNA" },
    status: "expert-review",
    outcome:
      "DV200 低于 30% 触发硬性升级条件,系统不自动出方案,转解决方案专家评估;升级材料需含样本存放年限、DV200 图谱编号、已尝试的去交联条件与客户的分析目标,专家会诊两个工作日内给出结论并附可判定的止损条件。",
  },
];

/**
 * 幂等植入冷启动样例。库里已经有**真实**办结记录时跳过 —— 有真实先例可用之后,
 * 我们编的样例就只是噪声了,让它自然退场。
 */
export function seedColdStartCases(db: NovaDb, tenantId = "novapilot-demo"): number {
  const resolved = queryAll<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM case_memory WHERE tenant_id = ? AND (provenance IS NULL OR provenance <> 'cold-start')",
    tenantId,
  )[0]!.n;
  if (resolved > 0) return 0;

  for (const c of COLD_START_CASES) {
    recordCaseMemory(db, {
      projectId: c.projectId,
      tenantId,
      question: c.question,
      scenario: c.scenario,
      facts: c.facts,
      status: c.status,
      outcome: c.outcome,
      now: COLD_START_AT,
      provenance: "cold-start",
    });
  }
  return COLD_START_CASES.length;
}
