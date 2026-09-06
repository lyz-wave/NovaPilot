/**
 * §7 引用核实合规率（硬性铁律，指标体系 v1.1 第 7 节）。
 *
 * 原文口径：「入库文献中 PMID/DOI 经官网核实并留痕的比例」。这一条的核实动作
 * 天然要求联网（查 PubMed / CrossRef 官方接口），而「离线可运行」是本项目的
 * 硬不变式——摄取流水线、NovaBench、运营看板全部必须在断网环境下跑得动。
 *
 * 两者的调和方式不是「运行时联网查证」（那会让 kb:ingest 变成看运气的网络调用，
 * 而且每次摄取都要重新核实同一批本就不会变的文献），而是把「核实」拆成一个独立
 * 的、显式联网的离线步骤：
 *
 *   1. `npm run kb:verify-citations`（scripts/verify-citations.ts）——单独的维护
 *      脚本，允许联网，把每篇 SCI 文献的 PMID/DOI 拿去 PubMed / CrossRef 官方
 *      接口核实一次，结果写进本文件旁边的 provenance 台账
 *      （data/knowledge/citation-provenance.json），并记录核实时间与核实方式——
 *      这就是「留痕」。
 *   2. `kb:ingest`、运营看板、种子路径都只读这个台账，不发起任何网络请求——
 *      读台账是纯本地 IO，和「离线可运行」完全不冲突。
 *
 * 联网核实与离线摄取被拆成了两个独立的操作，前者的产物（台账）是后者的输入。
 * 这不是「没做联网核实」，是把它挪到了不违反离线约束的地方。
 *
 * 台账里当前的两条种子文献（E-PMID-35361992 / E-DOI-101038）标记为 unverified：
 * 本仓库的开发沙箱本身出网受限（WebFetch 对 pubmed.ncbi.nlm.nih.gov /
 * api.crossref.org / api.semanticscholar.org 都被安全策略拦下，实测确认过），
 * 没有条件真的去敲官方接口。诚实起见，没有在台账里「假装核实通过」去凑一个
 * 好看的百分比——那正是指标体系反复强调要杜绝的自证自过。需要一个有出网条件
 * 的环境跑一次 `kb:verify-citations` 才能把它们转正。
 */
import fs from "node:fs";
import path from "node:path";
import { queryAll, type NovaDb } from "../db/client";

export type CitationIdentifierKind = "pmid" | "doi";

export interface CitationIdentifier {
  kind: CitationIdentifierKind;
  value: string;
}

export interface ProvenanceEntry {
  kind: CitationIdentifierKind;
  value: string;
  status: "verified" | "unverified";
  /** 核实时间（ISO）。未核实/核实失败为 null。 */
  verifiedAt: string | null;
  /** 核实方式，例如 "PubMed E-utilities" / "CrossRef REST API"。未核实为空串。 */
  method: string;
  /** 人类可读的核实结果或失败原因，供台账审阅时对账。 */
  note: string;
}

export type ProvenanceLedger = Record<string, ProvenanceEntry>;

export const PROVENANCE_PATH = path.join("data", "knowledge", "citation-provenance.json");

export function provenancePath(): string {
  return process.env.NP_CITATION_PROVENANCE_PATH ?? path.join(process.cwd(), PROVENANCE_PATH);
}

/**
 * 从 frontmatter 的 `citation` 自述字符串里抽取 PMID / DOI。抽不出来的（比如
 * SOP 内部编号 NV-SOP-RNA-042）不进这一指标的分母——原文限定的是「入库文献
 * （PMID/DOI）」，不是所有引用来源；把 SOP 内部编号也塞进分母，只会稀释分母，
 * 让合规率看起来比真实情况更好看，这正是指标体系要防的游戏化路径。
 */
export function extractCitationIdentifier(citation: string): CitationIdentifier | null {
  const pmid = /PMID:?\s*(\d+)/i.exec(citation);
  if (pmid) return { kind: "pmid", value: pmid[1]! };
  const doi = /DOI:?\s*(10\.\d{4,9}\/\S+)/i.exec(citation);
  if (doi) return { kind: "doi", value: doi[1]!.replace(/[.,;)]+$/, "") };
  return null;
}

export function ledgerKey(id: CitationIdentifier): string {
  return `${id.kind}:${id.value}`;
}

/** 台账缺失或损坏时按空台账处理——不能因为一个坏 JSON 文件把摄取/看板都拖垮。 */
export function loadProvenanceLedger(file = provenancePath()): ProvenanceLedger {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ProvenanceLedger;
  } catch {
    return {};
  }
}

export function saveProvenanceLedger(ledger: ProvenanceLedger, file = provenancePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

export interface CitationComplianceViolation {
  docId: string;
  citation: string;
  reason: "unparseable" | "not-in-ledger" | "unverified";
}

export interface CitationComplianceReport {
  /** 分母：source = SCI 且能抽出 PMID/DOI 的文献数。 */
  total: number;
  /** 分子：台账里状态为 verified 的那些。 */
  verified: number;
  /** total 为 0（库里还没有 SCI 文献）时为 null——没有样本，不是「0% 合规」。 */
  rate: number | null;
  violations: CitationComplianceViolation[];
}

/**
 * 对一批文献（source + citation）算合规率。纯函数，`docs` 可以来自 `documents`
 * 表（看板口径）也可以来自摄取解析结果（`ingest.ts` 的入库前校验）——同一把
 * 函数两处复用，口径不会走岔。
 */
export function checkCitationCompliance(
  docs: Array<{ id: string; source: string; citation: string }>,
  ledger: ProvenanceLedger,
): CitationComplianceReport {
  const literature = docs.filter((d) => d.source === "SCI");
  const violations: CitationComplianceViolation[] = [];
  let total = 0;
  let verified = 0;

  for (const doc of literature) {
    const id = extractCitationIdentifier(doc.citation);
    if (!id) {
      violations.push({ docId: doc.id, citation: doc.citation, reason: "unparseable" });
      continue; // 抽不出标识符的，不计入这一硬性指标的分母（见上方函数注释）
    }
    total++;
    const entry = ledger[ledgerKey(id)];
    if (!entry) {
      violations.push({ docId: doc.id, citation: doc.citation, reason: "not-in-ledger" });
    } else if (entry.status === "verified") {
      verified++;
    } else {
      violations.push({ docId: doc.id, citation: doc.citation, reason: "unverified" });
    }
  }

  return { total, verified, rate: total === 0 ? null : verified / total, violations };
}

/** 看板口径：直接读 documents 表——种子库与摄取入库的文献一视同仁，没有二等公民。 */
export function citationComplianceFromDb(
  db: NovaDb,
  ledger: ProvenanceLedger = loadProvenanceLedger(),
): CitationComplianceReport {
  const docs = queryAll<{ id: string; source: string; citation: string }>(
    db,
    `SELECT id, source, citation FROM documents`,
  );
  return checkCitationCompliance(docs, ledger);
}
