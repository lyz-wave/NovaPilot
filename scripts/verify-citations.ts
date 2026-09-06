#!/usr/bin/env vite-node
/**
 * §7 引用核实合规率 —— 台账维护 CLI（指标体系 v1.1 第 7 节，硬性铁律）。
 *
 * 这是本系统里**唯一允许联网**的知识库相关脚本。原文口径是「入库文献中
 * PMID/DOI 经官网核实并留痕的比例」——核实动作天然要联网(查 PubMed /
 * CrossRef 官方接口),而 kb:ingest / 运营看板 / 种子路径全部必须离线可跑
 * （见 README 的离线硬不变式）。调和方式:把「联网核实」拆成这个独立的、
 * 显式联网的维护步骤,产物是本地台账文件（data/knowledge/citation-provenance.json）,
 * 其余路径只读这个文件,不再发起任何网络请求。
 *
 * 用法:
 *   npm run kb:verify-citations              # 只核实台账里还没有 verified 记录的
 *   npm run kb:verify-citations -- --recheck # 连已经 verified 的也重新核实一遍
 *
 * 网络请求失败(超时、DNS 失败、非 2xx)不会让脚本报错退出——这是维护工具,
 * 不是门禁;失败的原样落回 unverified,并把失败原因记进 note,留痕失败本身
 * 也是「留痕」的一部分,不能假装没发生过。
 */
import { resolve } from "node:path";
import { createDb } from "../src/server/db/client";
import { ensureSeeded } from "../src/server/service";
import {
  checkCitationCompliance,
  extractCitationIdentifier,
  ledgerKey,
  loadProvenanceLedger,
  saveProvenanceLedger,
  type ProvenanceEntry,
  type ProvenanceLedger,
} from "../src/server/rag/citation-provenance";

const FETCH_TIMEOUT_MS = 8000;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const recheck = flag("recheck");
const dbPath = process.env.NOVAPILOT_DB_PATH ?? resolve(process.cwd(), ".data/novapilot.db");

/** Jaccard 词元相似度（小写化 + 空格切词）。用于标题一致性校验。 */
function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean));
  const setA = tokenize(a);
  const setB = tokenize(b);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

const JACCARD_THRESHOLD = 0.3;

async function verifyPmid(pmid: string): Promise<{ ok: boolean; note: string; upstreamTitle?: string }> {
  try {
    const res = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return { ok: false, note: `PubMed 返回 HTTP ${res.status}` };
    const data = (await res.json()) as { result?: Record<string, { title?: string; error?: string }> };
    const entry = data.result?.[pmid];
    if (!entry || entry.error) return { ok: false, note: "PubMed 找不到该 PMID" };
    const upstreamTitle = entry.title ?? "";
    return { ok: true, note: `标题:${upstreamTitle}`, upstreamTitle };
  } catch (err) {
    return { ok: false, note: `联网核实失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function verifyDoi(doi: string): Promise<{ ok: boolean; note: string; upstreamTitle?: string }> {
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, note: `CrossRef 返回 HTTP ${res.status}` };
    const data = (await res.json()) as { message?: { title?: string[] } };
    const upstreamTitle = data.message?.title?.[0];
    if (!upstreamTitle) return { ok: false, note: "CrossRef 找不到该 DOI" };
    return { ok: true, note: `标题:${upstreamTitle}`, upstreamTitle };
  } catch (err) {
    return { ok: false, note: `联网核实失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function main() {
  const db = createDb(dbPath);
  ensureSeeded(db);

  const docs = db
    .prepare(`SELECT id, source, citation, title FROM documents WHERE source = 'SCI'`)
    .all() as Array<{ id: string; source: string; citation: string; title: string }>;

  const ledger: ProvenanceLedger = loadProvenanceLedger();
  const now = new Date().toISOString();

  console.log(`库内 SCI 文献 ${docs.length} 篇。`);
  let checked = 0;

  for (const doc of docs) {
    const id = extractCitationIdentifier(doc.citation);
    if (!id) {
      console.log(`  跳过 ${doc.id}:citation "${doc.citation}" 抽不出 PMID/DOI`);
      continue;
    }
    const key = ledgerKey(id);
    const existing = ledger[key];
    if (existing?.status === "verified" && !recheck) {
      console.log(`  跳过 ${doc.id}(${key}):已核实于 ${existing.verifiedAt}`);
      continue;
    }

    checked++;
    const result = id.kind === "pmid" ? await verifyPmid(id.value) : await verifyDoi(id.value);

    // 标题一致性校验（仅在接口返回成功且 upstreamTitle 存在时执行）
    let status: ProvenanceEntry["status"] = result.ok ? "verified" : "unverified";
    if (result.ok && result.upstreamTitle) {
      const jaccard = jaccardSimilarity(doc.title ?? "", result.upstreamTitle);
      if (jaccard < JACCARD_THRESHOLD) {
        status = "title-mismatch";
        console.warn(
          `  ⚠ ${doc.id}(${key}) 标题不符(Jaccard=${jaccard.toFixed(2)} < ${JACCARD_THRESHOLD}):` +
          `\n      本地: "${doc.title}"` +
          `\n      上游: "${result.upstreamTitle}"`,
        );
      }
    }

    const entry: ProvenanceEntry = {
      kind: id.kind,
      value: id.value,
      status,
      verifiedAt: status === "verified" ? now : null,
      method: id.kind === "pmid" ? "PubMed E-utilities" : "CrossRef REST API",
      note: result.note,
      ...(result.upstreamTitle ? { upstreamTitle: result.upstreamTitle } : {}),
    };
    ledger[key] = entry;
    console.log(`  ${status === "verified" ? "✓" : status === "title-mismatch" ? "⚠" : "✗"} ${doc.id}(${key}): ${result.note}`);
  }

  saveProvenanceLedger(ledger);
  const summary = checkCitationCompliance(docs, ledger);
  console.log(`\n本次联网核实 ${checked} 条,台账现有 verified ${summary.verified}/${summary.total}。`);
  console.log(`台账已写回 data/knowledge/citation-provenance.json`);
}

main().catch((err) => {
  console.error("verify-citations 异常:", err);
  process.exit(1);
});
