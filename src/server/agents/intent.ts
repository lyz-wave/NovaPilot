/**
 * Intent classification — the gate in front of the consultation pipeline.
 *
 * NovaPilot's decision-card pipeline (retrieval + Actor/Critic + risk gate) only
 * makes sense for an actual research/experimental-design question. Greetings,
 * capability questions ("你可以干啥") and general chit-chat must NOT trigger it —
 * otherwise every "你好" gets answered with a FFPE decision card full of
 * citations, which is exactly the "乱显示" the user reported.
 *
 * This is deliberately a cheap, deterministic rule (works offline, testable):
 * the question is treated as a research consultation only when it carries a
 * domain signal. Everything else is handled as a normal chat reply.
 */
export type Intent = "research" | "chat";

/**
 * Domain signals for a scientific-services consultation. Kept broad on purpose:
 * a false "research" classification just runs the (correct) card pipeline, while
 * a false "chat" classification is the failure we care about — so the tokens
 * lean toward recall. Matched case-insensitively as substrings, with a few
 * word-boundary guards for short ambiguous acronyms.
 */
const DOMAIN_PATTERNS: RegExp[] = [
  // sample types & degraded material
  /ffpe|石蜡|福尔马林/i,
  /\b(rna|dna|cdna|mrna|mirna|lncrna|circrna)\b/i,
  /核酸|样本|标本|组织|血浆|血清|细胞系|菌株/i,
  // sequencing & library prep
  /测序|建库|文库|上机|下机|library|sequenc|\bngs\b|二代|三代|纳米孔|nanopore|illumina|pacbio|mgi|华大/i,
  /\b(wgs|wes|rrbs|atac|chip|rip|clip|hi-?c|16s|its|amplicon)\b/i,
  /扩增子|宏基因组|metagenom|单细胞|single[- ]?cell|空间转录组|spatial|甲基化|methylation/i,
  // analysis & metrics
  /表达谱|差异表达|差异分析|转录组|transcriptom|基因组|genome|外显子|exome|变异|突变|variant|mutation|snp|indel|cnv|sv\b/i,
  /富集分析|通路|pathway|注释|annotation|生信|bioinformatic|比对|alignment|reads|测序深度|覆盖度|coverage|q30/i,
  /dv200|rin\b|od260|投入量|input|质控|\bqc\b|文库浓度/i,
  // proteomics / metabolomics / other omics
  /蛋白|proteom|代谢组|metabolom|质谱|mass spec|磷酸化|phospho/i,
  // platforms / primers / assays
  /平台|platform|引物|primer|探针|probe|\bpcr\b|qpcr|富集|捕获|capture|panel|文库制备/i,
  // consultation framing that clearly targets an experimental design
  /实验设计|方案设计|建库路线|测序策略|研究设计|study design|experimental design/i,
  // knowledge sources & consultation-flow phrasing (SOP / literature / conflict /
  // expert escalation / non-standard) — these carry no lab token but are still
  // real consultation requests, and drive the graph's escalation scenarios.
  /\bsop\b|标准操作|文献|参考文献|literature|指南|guideline/i,
  /冲突|矛盾|conflict|contradict|inconsistent/i,
  /专家复核|转(交|接)?专家|人工复核|转人工|specialist|escalat/i,
  /非标准|特殊样本|non[- ]?standard/i,
];

/** Classify a free-text question as a research consultation or general chat. */
export function classifyIntent(question: string): Intent {
  const q = question.trim();
  if (!q) return "chat";
  return DOMAIN_PATTERNS.some((re) => re.test(q)) ? "research" : "chat";
}
