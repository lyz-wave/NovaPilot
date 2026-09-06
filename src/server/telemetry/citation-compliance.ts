/**
 * §7 引用核实合规率看板聚合（指标体系 v1.1 第 7 节 / 第 10 节护栏对第 4 项）。
 *
 * 核心判定逻辑在 `rag/citation-provenance.ts`（提取 + 台账 + 计算，纯函数，
 * ingest 校验与本看板共用）。这一层只做两件事：查 `documents` 表、套上与
 * guardrail-board / retrieval-log 一致的 `safe()` 降级壳——老库缺表或台账
 * 文件损坏，只降级这一块，不拖垮整块运营页。
 *
 * 这个指标此前在看板上被 `board.binding.bindingRate`（证据绑定率，运行时防
 * 编造）冒名顶替——两者口径完全不同：证据绑定率答的是「这次出卡引用的证据
 * 在不在本轮检索集里」，这里答的是「入库文献的 PMID/DOI 有没有经官网核实」。
 * 自评文档已经点出过这个混淆（见 docs/指标体系达成度自评.md 的「注意别混淆」
 * 一行），这里补上真实口径后，operations-dashboard.tsx 不再借用绑定率充数。
 */
import { type NovaDb } from "../db/client";
import {
  citationComplianceFromDb,
  loadProvenanceLedger,
  type CitationComplianceReport,
} from "../rag/citation-provenance";

export type CitationComplianceBoard = CitationComplianceReport;

export function citationComplianceBoard(db: NovaDb): CitationComplianceBoard {
  try {
    return citationComplianceFromDb(db, loadProvenanceLedger());
  } catch (err) {
    console.error(`[telemetry] 口径缺格 citation-compliance`, err);
    return { total: 0, verified: 0, rate: null, violations: [] };
  }
}
