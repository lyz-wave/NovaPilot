/**
 * Seed knowledge base — real scientific documents that ground the FFPE RNA
 * consultation. Each doc mirrors the `Evidence` metadata the domain model
 * already cites (E-SOP-042, E-PMID-35361992, E-DOI-101038) plus supporting
 * material for platform selection and sequencing depth.
 *
 * These are the "internal SOP + public SCI" cold-start corpus the proposal
 * describes for P0.
 */
export interface SeedDoc {
  id: string;
  source: "SOP" | "SCI";
  title: string;
  citation: string;
  version: string;
  appliesTo: string;
  validUntil: string;
  lang: "zh" | "en";
  validation: "verified" | "conflict" | "expired";
  /** Chunk-sized passages. Each becomes a retrievable, citable unit. */
  passages: string[];
}

export const SEED_DOCS: SeedDoc[] = [
  {
    id: "E-SOP-042",
    source: "SOP",
    title: "FFPE RNA 建库与质控规范",
    citation: "NV-SOP-RNA-042",
    version: "v6.2",
    appliesTo: "FFPE RNA; DV200 ≥ 50%; 10–100 ng",
    validUntil: "2027-03-31",
    lang: "zh",
    validation: "verified",
    passages: [
      "FFPE 来源 RNA 建库前必须完成 DV200 质控。DV200 ≥ 50% 且 RNA 投入量 ≥ 10 ng 时，可进入链特异性总 RNA 文库自动推荐路线。",
      "当 DV200 处于 30%–50% 灰区时，禁止直接套用标准方案，应先进行试建库或增加质控，并由专家确认止损条件。",
      "DV200 低于 30% 属于极低质量样本，建库失败风险高，必须转交解决方案专家评估，不得由系统自动给出最终方案。",
      "链特异性总 RNA 文库适用于降解样本的差异表达研究，可在信息保留、稳健性与可解释性之间取得平衡。推荐测序策略为 PE150、每样本 50M reads。",
    ],
  },
  {
    id: "E-PMID-35361992",
    source: "SCI",
    title: "Performance of RNA sequencing methods for degraded FFPE material",
    citation: "PMID: 35361992",
    version: "2022",
    appliesTo: "FFPE-derived RNA expression profiling",
    validUntil: "2027-12-31",
    lang: "en",
    validation: "verified",
    passages: [
      "Stranded total RNA sequencing outperforms poly(A) selection on degraded FFPE material because it does not depend on intact 3' poly(A) tails.",
      "For FFPE RNA with DV200 above 50 percent, differential expression estimates are robust when at least 10 nanograms of input is available and sequencing depth reaches 40 to 50 million reads per sample.",
      "Low-input RNA capture (exome-style) is a viable fallback for samples with variable quality but narrows detection to targeted regions and can bias quantification.",
    ],
  },
  {
    id: "E-DOI-101038",
    source: "SCI",
    title: "Benchmarking library preparation from low-quality clinical RNA",
    citation: "DOI: 10.1038/s41598-021-00042-7",
    version: "2021",
    appliesTo: "Low-input and degraded RNA",
    validUntil: "2027-12-31",
    lang: "en",
    validation: "verified",
    passages: [
      "PE150 read configuration supports both gene-level and transcript-level quantification and leaves headroom for later re-analysis of degraded clinical RNA.",
      "Fusion-gene discovery and ultra-low-frequency event detection require dedicated protocols and deeper sequencing; they are out of scope for standard differential-expression library preparation.",
      "Paired study designs and consistent batch handling materially reduce technical variance in low-quality RNA cohorts.",
    ],
  },
  {
    id: "E-SOP-051",
    source: "SOP",
    title: "测序平台选型与数据量规范",
    citation: "NV-SOP-PLATFORM-051",
    version: "v3.1",
    appliesTo: "Illumina 平台; RNA 表达谱",
    validUntil: "2027-06-30",
    lang: "zh",
    validation: "verified",
    passages: [
      "常规 RNA 差异表达研究推荐使用 Illumina NovaSeq 平台，PE150 读长，人源样本每样本 50M reads 可满足基因与转录本层级定量。",
      "样本量低于 3 个生物学重复时，差异表达统计功效不足，应提示客户补充重复或采用更保守的解读。",
    ],
  },
  {
    id: "E-SOP-MED-001",
    source: "SOP",
    title: "医学转录组服务规格(官方口径)",
    citation: "NV-SOP-MED-001",
    version: "v1.0",
    appliesTo: "人和小鼠 mRNA; Illumina; FFPE RNA",
    validUntil: "2027-12-31",
    lang: "zh",
    validation: "verified",
    passages: [
      "标准医学转录组(mRNA)路线建库起始量为 RNA 400 ng(0.4 μg)/样本;低于该起始量属于低输入场景,应改用低输入捕获方案或先做预实验评估。",
      "医学转录组测序采用 Illumina 平台、PE150 读长,单样本数据量 6–12 Gb,测序质量 Q20 大于 90%、Q30 不低于 85%。",
      "样本量不超过 30 个时项目周期为 18 天;石蜡切片送样要求厚度 5–10 μm、含组织面积大于 25 mm²,切片 12 张。",
      "肿瘤样本取下后应立即放入 RNAlater 保存或液氮速冻,-80℃ 保存、干冰运输,减少常温暴露时间以保护 RNA 完整性。",
    ],
  },
  {
    id: "E-SOP-ANALYSIS-001",
    source: "SOP",
    title: "FFPE RNA 差异表达数据分析规范",
    citation: "NV-SOP-ANALYSIS-001",
    version: "v1.2",
    appliesTo: "FFPE RNA; 差异表达; 转录组数据分析",
    validUntil: "2027-12-31",
    lang: "zh",
    validation: "verified",
    passages: [
      "FFPE RNA 差异表达分析推荐使用 DESeq2 或 edgeR 进行基因水平定量与差异检验,计数矩阵以 TMM/RLE 方法归一化;存在明显批次效应时用 RUVSeq 校正。",
      "差异基因的功能解读推荐 GO 与 KEGG 富集分析,人源样本可补充 DisGeNET 与 Reactome 富集;多重检验采用 BH 校正,FDR < 0.05 为显著阈值。",
      "样本量低于 3 个生物学重复时差异表达统计功效不足,应采用更保守的显著性阈值并避免过度解读;所有分析软件与版本须记录,保证可复现。",
    ],
  },
  {
    id: "E-SOP-PAPER-001",
    source: "SOP",
    title: "结果解读与论文写作支持规范",
    citation: "NV-SOP-PAPER-001",
    version: "v1.0",
    appliesTo: "FFPE RNA; 转录组结果解读; 论文写作; 图表规范",
    validUntil: "2027-12-31",
    lang: "zh",
    validation: "verified",
    passages: [
      "论文方法学章节应完整记录实验流程、数据量、质控指标与分析软件版本,保证研究可复现。",
      "差异表达结果解读应结合 DV200 等样本质量指标说明局限性;火山图与热图须标注多重检验校正方法与统计量(FDR、log2FC)。",
      "图表规范:主图使用矢量格式,关键结论附统计量;原始数据与代码可提交公共数据库或补充材料,便于审稿复核。",
    ],
  },
];
