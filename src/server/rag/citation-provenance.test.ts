/**
 * §7 引用核实合规率 —— 提取 / 台账 / 计算单测（纯函数，`citation-provenance.ts`）。
 *
 * 钉三件事：
 *  1. 从自述 citation 字符串抽 PMID/DOI，抽不出来的（SOP 内部编号）不进分母；
 *  2. 台账三态（verified / 存在但 unverified / 压根不在台账里）分别映射到
 *     正确的分子与违规原因，不能把「没查过」和「查过但没通过」混为一谈；
 *  3. 台账文件读写往返、损坏/缺失时安全降级为空台账。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkCitationCompliance,
  extractCitationIdentifier,
  ledgerKey,
  loadProvenanceLedger,
  saveProvenanceLedger,
  type ProvenanceLedger,
} from "./citation-provenance";

describe("extractCitationIdentifier", () => {
  it("识别 PMID", () => {
    expect(extractCitationIdentifier("PMID: 35361992")).toEqual({ kind: "pmid", value: "35361992" });
    expect(extractCitationIdentifier("PMID35361992")).toEqual({ kind: "pmid", value: "35361992" });
  });

  it("识别 DOI，并去掉尾随标点", () => {
    expect(extractCitationIdentifier("DOI: 10.1038/s41598-021-00042-7")).toEqual({
      kind: "doi",
      value: "10.1038/s41598-021-00042-7",
    });
    expect(extractCitationIdentifier("见 DOI:10.1038/s41598-021-00042-7.")).toEqual({
      kind: "doi",
      value: "10.1038/s41598-021-00042-7",
    });
  });

  it("SOP 内部编号抽不出标识符 —— 不该被当成文献", () => {
    expect(extractCitationIdentifier("NV-SOP-RNA-042")).toBeNull();
  });
});

describe("checkCitationCompliance", () => {
  const docs = [
    { id: "D-SOP", source: "SOP", citation: "NV-SOP-RNA-042" },
    { id: "D-PMID-OK", source: "SCI", citation: "PMID: 111" },
    { id: "D-PMID-NEW", source: "SCI", citation: "PMID: 222" },
    { id: "D-DOI-BAD", source: "SCI", citation: "DOI: 10.1000/bad" },
    { id: "D-SCI-NO-ID", source: "SCI", citation: "内部综述,无编号" },
  ];
  const ledger: ProvenanceLedger = {
    "pmid:111": { kind: "pmid", value: "111", status: "verified", verifiedAt: "2026-09-01T00:00:00Z", method: "PubMed E-utilities", note: "ok" },
    "doi:10.1000/bad": { kind: "doi", value: "10.1000/bad", status: "unverified", verifiedAt: null, method: "", note: "官网未找到该 DOI" },
  };

  it("SOP 文档与抽不出标识符的 SCI 文档都不进分母", () => {
    const r = checkCitationCompliance(docs, ledger);
    // 分母只有 PMID-OK、PMID-NEW、DOI-BAD 三条；D-SOP 和 D-SCI-NO-ID 都不计入
    expect(r.total).toBe(3);
    expect(r.violations.some((v) => v.docId === "D-SOP")).toBe(false);
    expect(r.violations.find((v) => v.docId === "D-SCI-NO-ID")?.reason).toBe("unparseable");
  });

  it("台账三态分别映射:verified 计入分子;存在但 unverified 计违规不计分子;压根不在台账里是另一种违规原因", () => {
    const r = checkCitationCompliance(docs, ledger);
    expect(r.verified).toBe(1);
    expect(r.rate).toBeCloseTo(1 / 3);
    expect(r.violations.find((v) => v.docId === "D-DOI-BAD")?.reason).toBe("unverified");
    expect(r.violations.find((v) => v.docId === "D-PMID-NEW")?.reason).toBe("not-in-ledger");
  });

  it("库里没有任何 SCI 文献:分母为 0,读作「没有样本」而不是 0% 合规", () => {
    const r = checkCitationCompliance(
      [{ id: "D-SOP", source: "SOP", citation: "NV-SOP-RNA-042" }],
      {},
    );
    expect(r.total).toBe(0);
    expect(r.rate).toBeNull();
  });
});

describe("provenance ledger 文件 IO", () => {
  it("写入后原样读回", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "np-prov-")), "citation-provenance.json");
    const ledger: ProvenanceLedger = {
      [ledgerKey({ kind: "pmid", value: "999" })]: {
        kind: "pmid",
        value: "999",
        status: "verified",
        verifiedAt: "2026-09-06T00:00:00Z",
        method: "PubMed E-utilities",
        note: "标题匹配",
      },
    };
    saveProvenanceLedger(ledger, file);
    expect(loadProvenanceLedger(file)).toEqual(ledger);
  });

  it("文件不存在或不是合法 JSON 时安全降级为空台账,不抛错", () => {
    expect(loadProvenanceLedger("/no/such/file.json")).toEqual({});
    const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "np-prov-bad-")), "bad.json");
    fs.writeFileSync(bad, "{not json", "utf8");
    expect(loadProvenanceLedger(bad)).toEqual({});
  });
});
