/**
 * 适用范围契约（NovaGuard 第 4 项检查）—— 「接地」不等于「相关」。
 *
 * ── 这层是被一次实测逼出来的 ──
 *
 * 建完 NovaBench 幻觉子集(`eval/hallucination-set.ts`)第一次跑,8 条里漏放 7 条。
 * 最典型的一条:
 *
 *   问:这批 FFPE 样本想改做**单细胞**转录组,细胞捕获率和最低上样细胞数要求是多少
 *   答:formal 卡 ·「标准医学转录组(mRNA)路线建库起始量为 RNA 400 ng」
 *      引用 E-SOP-MED-001#0 —— 真实、已验证、未过期
 *
 * 三层防线全部放行,而且**每一层都判对了自己那件事**:引用号确实在本轮检索集内、
 * 确实 verified、确实没过期,`appliesTo` 也确实匹配 —— 因为那个 hint 是从 facts
 * 推出来的,material 就是 FFPE RNA。问题是没有任何一层在问:**这份证据回答的是
 * 用户问的那个问题吗?** 知识库里一个 chunk 都没提过单细胞,系统却给出了自信的
 * 建库参数。这就是幻觉的真实形态 —— 不是编造引用号(那个早就防住了),而是
 * **拿真引用答错问题**。
 *
 * ── 先试过一条更「通用」的路,失败了,记在这里 ──
 *
 * 第一版做的是**词项覆盖率**:把问题切成 CJK bigram + 拉丁词,算它们在被引用
 * chunk 里的出现比例,低于阈值就不许 formal。理由很漂亮 —— 这条规则不认识
 * 「单细胞」,任何库外话题都会自然落到低覆盖。
 *
 * 实测 14 条合法问题 + 8 条幻觉问题,formal 卡的两个分布**完全重叠**:
 *
 *   合法 formal:  T-PLAT 0.118  G-STD-ZH 0.125  T-BATCH 0.125  T-DELIV 0.158  T-QC 0.333
 *   漏放 formal:  H-SINGLECELL 0.094  H-SPECIES 0.111  H-PRICE 0.130  H-PMID 0.188
 *
 * 合法的 T-PLAT(0.118)比漏放的 H-FAKE-PMID(0.188)还低 —— 不存在能分开两者的
 * 阈值。噪声来自跨词边界的 bigram(份肿/本想/批样)和「肿瘤」这类知识库根本不用的
 * 真词。把阈值卡在 0.15 能让 8 条里过 6 条,但那是拿阈值去拟合自己写的测试用例,
 * 和被否决过的「用 rerank 分值设阈值」是同一种自欺。**那版代码已删除**,只留结论。
 *
 * ── 改成什么:声明式契约,不是关键词黑名单 ──
 *
 * 关键区别在于**比对面是知识库自己的声明,不是我列的禁词**。库里每篇文档的
 * frontmatter 都有 `appliesTo`(E-SOP-MED-001 写的是「人和小鼠 mRNA; Illumina;
 * FFPE RNA」),这是策展人写下的适用边界 —— 一份契约。这层做三件事:
 *
 *   1. **物种**:问题点名了某个物种,而全库没有一篇声明覆盖它 → 越界。
 *      犬类被拦住不是因为「犬」在黑名单里,是因为 appliesTo 写的是人和小鼠。
 *   2. **检测类型**:问题点名了某个检测/平台类型,全库没有一篇声明覆盖 → 越界。
 *   3. **点名引用**:问题里出现引用号形状的标识符,而全库没有这个号 → 越界。
 *      复用 NovaGuard 的白名单思路,只是方向反过来:查的是**用户索取**的引用。
 *
 * 物种表和检测类型表是**领域本体**,不是测试用例清单:表里 19 个物种、17 类检测,
 * 幻觉子集只用到其中 3 个。有人问 ATAC-seq、问猴子、问蛋白质组,同样会被拦 ——
 * 这是它和黑名单的区别。**它的边界也必须说清楚**:本体之外的检测类型(比如
 * Nanopore 直接 RNA 测序的某个新变体)拦不住,这是已知残差,写在验收记录里。
 *
 * ── 第 4 项:业务能力边界 ──
 *
 * 报价、试剂品牌货号、临床诊断结论 —— 这三件事不是「库里恰好没写」,是**业务上
 * 本来就不由这个通道承担**。所以它们不走「库里有没有」的判定,而是直接声明为
 * 能力边界,每条附上真实的业务理由(见 `CAPABILITY_BOUNDARIES`)。
 * 把它们编码进来是编码业务政策,不是给指标刷分。
 *
 * ── 处置:不新开分支,交给 NovaGuard 现有的转专家路径 ──
 *
 * 越界只做一件事:让 `guardRiskGate` 强制 `expert-review`,并把越界理由写进
 * `reasons` 和卡面摘要。不新增第五种卡状态 —— 处置逻辑有两套就必然漂移。
 * 越界与「三轮耗尽」在卡面上要分得清:`loopExhausted` 明确排除越界,因为
 * 「找不到证据」和「这件事不该我答」对专家来说是两种完全不同的交接上下文。
 */
import type { NovaDb } from "../db/client";

// ── 领域本体 ────────────────────────────────────────────────────

interface OntologyEntry {
  /** 规范名,出现在越界理由里,给专家看。 */
  canonical: string;
  /** 问题侧的表述形式(中文按子串匹配,拉丁按词首边界匹配)。 */
  forms: string[];
}

/**
 * 物种本体。刻意**不含**裸「人」「马」这类单字 —— 「人工确认」「马上」会误命中。
 * 人用「人类/人体/患者/人和」这些两字以上的形式,马用「马匹/马属」。
 */
const SPECIES: OntologyEntry[] = [
  { canonical: "人", forms: ["人类", "人体", "患者", "病人", "人和", "human", "patient", "homo sapiens"] },
  { canonical: "小鼠", forms: ["小鼠", "鼠源", "c57", "balb", "mouse", "mice", "murine", "mus musculus"] },
  { canonical: "大鼠", forms: ["大鼠", "rat", "rattus"] },
  { canonical: "犬", forms: ["犬", "狗", "dog", "canine", "canis"] },
  { canonical: "猫", forms: ["猫", "feline", "felis"] },
  { canonical: "猴", forms: ["猴", "猕猴", "食蟹猴", "monkey", "macaque"] },
  { canonical: "猪", forms: ["猪", "porcine", "swine"] },
  { canonical: "兔", forms: ["兔", "rabbit"] },
  { canonical: "牛", forms: ["牛", "bovine", "cattle"] },
  { canonical: "羊", forms: ["绵羊", "山羊", "ovine", "sheep", "goat"] },
  { canonical: "马", forms: ["马匹", "马属", "horse", "equine"] },
  { canonical: "鸡", forms: ["鸡", "chicken", "gallus"] },
  { canonical: "斑马鱼", forms: ["斑马鱼", "zebrafish", "danio"] },
  { canonical: "果蝇", forms: ["果蝇", "drosophila"] },
  { canonical: "线虫", forms: ["线虫", "elegans", "nematode"] },
  { canonical: "酵母", forms: ["酵母", "yeast", "cerevisiae"] },
  { canonical: "拟南芥", forms: ["拟南芥", "arabidopsis"] },
  { canonical: "水稻", forms: ["水稻", "oryza", "rice"] },
  { canonical: "玉米", forms: ["玉米", "maize"] },
];

/**
 * 检测类型本体。第一条(bulk 转录组)是**库内**覆盖的类型,留在表里是为了让
 * 评审能一眼看出「哪些覆盖、哪些不覆盖」不是我说的,是拿同一张表去问知识库的。
 */
const ASSAYS: OntologyEntry[] = [
  {
    canonical: "bulk 转录组 / 表达谱",
    forms: ["转录组", "表达谱", "mrna", "差异表达", "transcriptome", "expression profil", "rna-seq", "rna seq", "differential expression"],
  },
  { canonical: "单细胞转录组", forms: ["单细胞", "单核转录组", "single-cell", "single cell", "scrna", "snrna", "chromium"] },
  { canonical: "空间转录组", forms: ["空间转录组", "空间组学", "空间定位", "spatial transcript", "visium", "geomx", "stereo-seq"] },
  { canonical: "染色质可及性(ATAC)", forms: ["染色质可及性", "atac"] },
  { canonical: "ChIP / CUT&Tag", forms: ["染色质免疫共沉淀", "chip-seq", "chip seq", "cut&tag", "cut and tag"] },
  { canonical: "DNA 甲基化", forms: ["甲基化", "methylation", "wgbs", "rrbs", "bisulfite"] },
  { canonical: "全基因组测序", forms: ["全基因组测序", "wgs", "whole genome sequencing"] },
  { canonical: "全外显子测序", forms: ["全外显子", "wes", "whole exome", "exome"] },
  { canonical: "宏基因组 / 微生物组", forms: ["宏基因组", "微生物组", "肠道菌群", "16s", "18s", "metagenom", "microbiome"] },
  { canonical: "蛋白质组 / 质谱", forms: ["蛋白质组", "质谱", "proteomic", "mass spectrometry"] },
  { canonical: "代谢组", forms: ["代谢组", "metabolom"] },
  { canonical: "small RNA / miRNA", forms: ["小rna", "微小rna", "small rna", "mirna", "microrna"] },
  { canonical: "三维基因组(Hi-C)", forms: ["染色质构象", "三维基因组", "hi-c", "hichip"] },
  { canonical: "长读长测序", forms: ["三代测序", "长读长", "全长转录组", "nanopore", "pacbio", "long-read", "long read"] },
  { canonical: "流式细胞术", forms: ["流式细胞", "流式分选", "facs", "flow cytometry"] },
  { canonical: "免疫组化 / 免疫荧光", forms: ["免疫组化", "免疫荧光", "immunohistochem", "ihc"] },
  { canonical: "免疫组库(TCR/BCR)", forms: ["免疫组库", "tcr-seq", "bcr-seq"] },
];

/**
 * 业务能力边界。和上面两张表**判定方式不同**:这三件事不查知识库有没有写,
 * 它们是声明式的能力边界 —— 就算哪天库里进了一篇价目表,咨询通道也不报价。
 */
const CAPABILITY_BOUNDARIES: { canonical: string; forms: string[]; reason: string }[] = [
  {
    canonical: "报价与折扣",
    forms: ["报价", "价格", "多少钱", "单价", "折扣", "几折", "含税", "收费", "费用是", "预算是多少", "price", "quote", "quotation", "cost per", "discount"],
    reason: "咨询通道不承担报价职能:价格与折扣由商务合同确定,知识库内不含任何价目数据。",
  },
  {
    canonical: "试剂品牌与货号",
    forms: ["货号", "品牌", "厂家", "供应商", "哪家公司", "试剂盒型号", "采购", "catalog number", "cat no", "part number", "vendor", "brand"],
    reason: "SOP 只规定性能指标与验收标准,不指定品牌货号:既避免绑定单一供应商,采购信息也不在知识范围内。",
  },
  {
    canonical: "临床诊断结论",
    forms: ["临床诊断", "诊断依据", "诊断报告", "出具诊断", "病理诊断", "临床报告", "用药指导", "治疗方案", "确诊", "clinical diagnos", "diagnostic report", "treatment decision"],
    reason: "科研服务不具备临床诊断资质(LDT/IVD):任何诊断性结论必须由持证医疗机构出具。",
  },
];

/**
 * 问题里「点名索取」的引用号形状。比 NovaGuard 的 `CITATION_TOKEN_RE` 宽 ——
 * 那个只认库内命名空间(`E-SOP-*` / `NV-SOP-*`),而用户编的假号往往长得像
 * `SOP-FFPE-2099`,不带前缀。这里要认得出**任何**像编号的东西才能反查。
 */
const DEMANDED_CITATION_RE =
  /PMID\s*[:：]?\s*\d{4,}|DOI\s*[:：]?\s*10\.\S+|\b(?:NV-|E-)?SOP-[A-Z0-9]+(?:-[A-Z0-9]+)+\b|\bE-(?:PMID|DOI)-[A-Z0-9-]+\b/gi;

// ── 能力清单(从知识库读出来的,不是写死的) ──────────────────────

export interface CapabilityManifest {
  /** 全库 id + citation + title + appliesTo 拼成的小写检索面。 */
  declared: string;
  /** 文档数。为 0 时整层跳过 —— 没有契约就无法判定违约。 */
  documentCount: number;
}

/**
 * 从 `documents` 表现场构建能力清单。
 *
 * 用全库而不是「本轮被引用的 chunk」:这里问的是**能力**问题(「单细胞这件事
 * 我们有没有依据」),而不是「这条建议的支撑够不够」。用被引用 chunk 会把
 * 合法问题也判越界 —— 差异表达的问题很可能只引到医学规格那一篇。
 */
export function buildCapabilityManifest(db: NovaDb): CapabilityManifest {
  const rows = db
    .prepare("SELECT id, citation, title, applies_to FROM documents")
    .all() as { id: string; citation: string; title: string; applies_to: string }[];
  return {
    declared: rows.map((r) => `${r.id} ${r.citation} ${r.title} ${r.applies_to}`).join("\n").toLowerCase(),
    documentCount: rows.length,
  };
}

// ── 判定 ────────────────────────────────────────────────────────

export type ScopeViolationKind = "species" | "assay" | "capability" | "unknown-citation";

export interface ScopeViolation {
  kind: ScopeViolationKind;
  /** 越界的那个东西(物种名 / 检测类型 / 边界名 / 引用号)。 */
  demand: string;
  /** 给专家和卡面看的一句话理由。 */
  reason: string;
}

/**
 * 中文按子串匹配,拉丁按**词首边界**匹配。
 *
 * 词首边界是必须的:`rice` 是 `price` 的子串、`wes` 是 `west` 的子串,纯子串
 * 匹配会让「单样本报价 price」误报成「水稻」。四字以内的短形式(`atac`/`wes`/
 * `16s`)两端都加边界,更长的只加词首,这样 `price` 能匹配 `prices`/`pricing`。
 */
function hit(haystack: string, form: string): boolean {
  if (/[^\x00-\x7f]/.test(form)) return haystack.includes(form);
  const esc = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = form.length <= 4 ? new RegExp(`\\b${esc}\\b`, "i") : new RegExp(`\\b${esc}`, "i");
  return re.test(haystack);
}

function matched(haystack: string, entry: { forms: string[] }): boolean {
  return entry.forms.some((f) => hit(haystack, f));
}

/**
 * 查一条咨询请求是否越出知识库声明的适用范围与业务能力边界。
 *
 * 返回空数组 = 未检出越界。**注意这不等于「一定在范围内」** —— 本体之外的
 * 物种与检测类型检不出来(见文件头「已知残差」)。这层是拦已知越界,不是
 * 范围内证明。
 */
export function checkScopeContract(question: string, manifest: CapabilityManifest): ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  const q = question.toLowerCase();
  // 空库时整层跳过:此时 declared 为空串,任何物种/检测都会判越界,而那是
  // 「知识库没装好」这个完全不同的故障,不该伪装成越界拦截。
  if (manifest.documentCount === 0) return violations;

  for (const sp of SPECIES) {
    if (!matched(q, sp) || matched(manifest.declared, sp)) continue;
    violations.push({
      kind: "species",
      demand: sp.canonical,
      reason: `知识库没有任何一篇文档的适用范围声明覆盖「${sp.canonical}」,现有 SOP 的物种边界不能外推。`,
    });
  }

  for (const as of ASSAYS) {
    if (!matched(q, as) || matched(manifest.declared, as)) continue;
    violations.push({
      kind: "assay",
      demand: as.canonical,
      reason: `知识库没有「${as.canonical}」的证据,拿现有转录组 SOP 的参数回答这类问题即为越界。`,
    });
  }

  for (const cb of CAPABILITY_BOUNDARIES) {
    if (!matched(q, cb)) continue;
    violations.push({ kind: "capability", demand: cb.canonical, reason: cb.reason });
  }

  for (const m of question.matchAll(DEMANDED_CITATION_RE)) {
    const token = m[0].replace(/\s+/g, "").toLowerCase();
    // 去掉 PMID/DOI 前缀后再比,库里存的是「PMID: 35361992」这种带空格的写法。
    const bare = token.replace(/^(pmid[:：]?|doi[:：]?)/, "");
    if (manifest.declared.includes(bare)) continue;
    violations.push({
      kind: "unknown-citation",
      demand: m[0],
      reason: `问题点名的「${m[0]}」不在知识库内,无法核实;确认或复述一个查不到的编号等同于编造。`,
    });
  }

  return violations;
}

/** 一行摘要,写进卡面 executiveSummary 与专家交接包。 */
export function describeScopeViolations(violations: readonly ScopeViolation[]): string {
  return violations.map((v) => `${v.demand} —— ${v.reason}`).join(" ");
}
