/**
 * 适用范围契约测试。
 *
 * 这个文件的主测试是**分离度**,不是「我造的越界问题能被拦住」。后者太容易通过 ——
 * 只要把测试用例里的词抄进本体就必然通过,那是自证。所以第一条测试拿 19 条合法
 * 问题(9 条金标 + 10 条真实问法)当假阳性面,任何一条被拦就算失败。
 *
 * 上一版做的词项覆盖率门就是死在这条测试上的:合法问题与幻觉问题的分布完全重叠,
 * 不存在能分开两者的阈值(数据留在 scope-contract.ts 文件头)。
 */
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client";
import { seedKnowledgeBase } from "../rag/retrieval";
import { buildCapabilityManifest, checkScopeContract, describeScopeViolations } from "./scope-contract";
import { GOLD_CASES } from "../eval/novabench";
import { HALLUCINATION_CASES } from "../eval/hallucination-set";

/** 真实合法问法,覆盖库内每一篇 SOP 的话题。全部必须零违约。 */
const LEGIT = [
  "24份FFPE样本的下机数据Q30只有82%，要不要重测",
  "起始量只有8ng的穿刺样本还能建库吗",
  "Illumina平台和其他平台怎么选，PE150够不够",
  "12个样本分两批做，批次效应怎么控制",
  "这个项目交付物包含哪些，周期多久",
  "DV200只有35%的蜡块还有救吗",
  "人源肿瘤组织的mRNA差异表达，重复数几个合适",
  "小鼠模型样本能不能按同一套SOP做",
  "样本运输用干冰还是常温，接收标准是什么",
  "数据要出境给合作方，人类遗传资源这块怎么办",
  "How long is the delivery timeline for 24 FFPE transcriptome samples?",
];

const db = createDb(":memory:");
seedKnowledgeBase(db);
const manifest = buildCapabilityManifest(db);

describe("适用范围契约 · 分离度", () => {
  it("知识库自己声明的适用范围构成能力清单", () => {
    expect(manifest.documentCount).toBeGreaterThan(0);
    // 契约的来源是策展人写的 appliesTo,不是这个文件里的常量。
    expect(manifest.declared).toContain("人和小鼠");
    expect(manifest.declared).toContain("ffpe rna");
  });

  it("19 条合法问题零假阳性", () => {
    const flagged: string[] = [];
    for (const q of [...GOLD_CASES.map((g) => g.question), ...LEGIT]) {
      const v = checkScopeContract(q, manifest);
      if (v.length > 0) flagged.push(`${q} → ${v.map((x) => `${x.kind}:${x.demand}`).join(",")}`);
    }
    expect(flagged).toEqual([]);
  });

  it("8 条对抗样例逐条命中，且命中的是对的那一类", () => {
    const kinds = new Map(
      HALLUCINATION_CASES.map((hc) => [hc.id, checkScopeContract(hc.question, manifest)]),
    );
    for (const [id, v] of kinds) expect(v.length, id).toBeGreaterThan(0);
    expect(kinds.get("H-OOD-SINGLECELL")![0].kind).toBe("assay");
    expect(kinds.get("H-OOD-SPATIAL")![0].kind).toBe("assay");
    expect(kinds.get("H-FAKE-SOP")!.some((v) => v.kind === "unknown-citation")).toBe(true);
    expect(kinds.get("H-FAKE-PMID")!.some((v) => v.kind === "unknown-citation")).toBe(true);
    expect(kinds.get("H-NUM-PRICE")!.some((v) => v.kind === "capability")).toBe(true);
    expect(kinds.get("H-NUM-REAGENT")!.some((v) => v.kind === "capability")).toBe(true);
    expect(kinds.get("H-SCOPE-SPECIES")!.some((v) => v.kind === "species")).toBe(true);
    expect(kinds.get("H-SCOPE-CLINICAL")!.some((v) => v.kind === "capability")).toBe(true);
  });
});

describe("适用范围契约 · 判定口径", () => {
  it("声明覆盖的物种放行，未声明的拦下 —— 判据是 appliesTo 不是禁词表", () => {
    // 人和小鼠写在 E-SOP-MED-001 的 appliesTo 里。
    expect(checkScopeContract("人类样本的转录组怎么做", manifest)).toEqual([]);
    expect(checkScopeContract("小鼠样本的转录组怎么做", manifest)).toEqual([]);
    // 本体里 19 个物种,幻觉子集只用到「犬」;换成猴、斑马鱼一样会被拦 ——
    // 这是它和「把测试用例抄成黑名单」的区别。
    for (const q of ["猕猴样本的转录组怎么做", "斑马鱼样本的转录组怎么做", "拟南芥样本的转录组怎么做"]) {
      expect(checkScopeContract(q, manifest).map((v) => v.kind), q).toContain("species");
    }
  });

  it("库内检测类型放行，本体内的库外检测类型拦下", () => {
    expect(checkScopeContract("bulk 转录组表达谱怎么做", manifest)).toEqual([]);
    for (const q of ["想做ATAC-seq", "想做全外显子测序", "想做蛋白质组质谱", "想上Nanopore三代测序"]) {
      expect(checkScopeContract(q, manifest).map((v) => v.kind), q).toContain("assay");
    }
  });

  it("拉丁词按词首边界匹配 —— price 不能被读成 rice", () => {
    const v = checkScopeContract("what is the price per sample", manifest);
    expect(v.map((x) => x.kind)).toContain("capability");
    expect(v.map((x) => x.demand)).not.toContain("水稻");
  });

  it("单字物种不进本体 —— 「人工确认」不能被读成物种「人」", () => {
    expect(checkScopeContract("希望由专家人工确认这批方案", manifest)).toEqual([]);
  });

  it("点名库内真实编号不算越界，编造编号才算", () => {
    expect(checkScopeContract("按 E-SOP-MED-001 的规格执行对吗", manifest)).toEqual([]);
    // 客户常按 citation 而不是 doc id 引用,两个命名空间都得认(NV-SOP-RNA-042)。
    expect(checkScopeContract("按 NV-SOP-RNA-042 执行对吗", manifest)).toEqual([]);
    // 省略 E- 前缀的写法也应认出来(库里存的是 E-SOP-MED-001)。
    expect(checkScopeContract("按 SOP-MED-001 的规格执行对吗", manifest)).toEqual([]);
    // 真实 PMID 同理。
    expect(checkScopeContract("PMID 35361992 是这个结论的依据吗", manifest)).toEqual([]);
    const fake = checkScopeContract("按 SOP-FFPE-2099 第七章执行", manifest);
    expect(fake.map((v) => v.kind)).toEqual(["unknown-citation"]);
  });

  it("能力边界不查知识库,是声明式的 —— 三条各自带真实业务理由", () => {
    const price = checkScopeContract("单样本报价多少元", manifest)[0];
    expect(price.reason).toContain("商务合同");
    const part = checkScopeContract("用哪个品牌哪个货号", manifest)[0];
    expect(part.reason).toContain("供应商");
    const clinical = checkScopeContract("能否作为临床诊断依据", manifest)[0];
    expect(clinical.reason).toContain("资质");
  });

  it("空库直接跳过 —— 没有契约就不能判违约", () => {
    const empty = createDb(":memory:");
    const m = buildCapabilityManifest(empty);
    expect(m.documentCount).toBe(0);
    // 装库失败是「知识库没装好」这个完全不同的故障,不该伪装成越界拦截,
    // 否则每一个问题都会转专家,而真正的原因(空库)被这层掩盖掉。
    expect(checkScopeContract("这批犬类样本做单细胞转录组，报价多少", m)).toEqual([]);
    empty.close();
  });

  it("摘要把越界理由说出来 —— 只说「已转专家」客户不知道该找谁", () => {
    const text = describeScopeViolations(checkScopeContract("犬类样本怎么做", manifest));
    expect(text).toContain("犬");
    expect(text).toContain("适用范围");
  });
});
