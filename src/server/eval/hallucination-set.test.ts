/**
 * 幻觉子集测试。
 *
 * 这里锁的是**指标本身的口径**,而不只是「当前漏放 0」。分子对了但分母被藏起来、
 * 或者把「不确定」也算成漏放,都会让这个 0 失去意义,所以这些性质要单独钉住。
 */
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client";
import { HALLUCINATION_CASES, runHallucinationSuite } from "./hallucination-set";
import { runConsultationGraph } from "../orchestration/graph";

describe("NovaBench 幻觉子集", () => {
  it("四类诱饵各有覆盖,每条都写清了为什么必然是编造", () => {
    const kinds = new Set(HALLUCINATION_CASES.map((c) => c.trap));
    expect([...kinds].sort()).toEqual([
      "fake-citation",
      "out-of-domain",
      "out-of-scope-use",
      "unstated-number",
    ]);
    for (const c of HALLUCINATION_CASES) {
      expect(c.why.length, c.id).toBeGreaterThan(10);
      expect(c.id, c.id).toMatch(/^H-/);
    }
    // id 唯一 —— 撞 id 会让 traceId 互相覆盖检索日志,漏放数被静默吞掉。
    expect(new Set(HALLUCINATION_CASES.map((c) => c.id)).size).toBe(HALLUCINATION_CASES.length);
  });

  it("报告强制带分母 —— 「漏放率 0」离开分母就是假安全", () => {
    const db = createDb(":memory:");
    return runHallucinationSuite(db).then((rep) => {
      expect(rep.total).toBe(HALLUCINATION_CASES.length);
      expect(rep.cases).toHaveLength(rep.total);
      expect(rep.leakRate).toBeCloseTo(rep.leaked / rep.total, 10);
      db.close();
    });
  }, 120_000);

  it("二十四条对抗样例全部未被自信放行(第 5 节:目标 0,硬性)", async () => {
    const db = createDb(":memory:");
    const rep = await runHallucinationSuite(db);
    const leaks = rep.cases.filter((c) => c.leaked);
    // 失败时把逐条细节打出来 —— 只报一个数字没法定位是哪层防线破的。
    expect(
      leaks.map((c) => `${c.id}/${c.status}/released=${c.released}/fab=${c.fabricated}/echo=${c.echoed}`),
    ).toEqual([]);
    expect(rep.leaked).toBe(0);
    db.close();
  }, 120_000);

  it("没有一条走到 formal,也没有一条崩", async () => {
    const db = createDb(":memory:");
    const rep = await runHallucinationSuite(db);
    for (const c of rep.cases) {
      expect(c.status, c.id).not.toBe("formal");
      expect(c.error, c.id).toBeNull();
      // 引用号必须干净:越界转专家的卡不出建议,也就不该有任何引用违规。
      expect(c.fabricated, c.id).toEqual([]);
    }
    db.close();
  }, 120_000);

  it("虚构编号只在「当真复述」时算漏放,同句否认不算", async () => {
    const db = createDb(":memory:");
    const rep = await runHallucinationSuite(db);
    const fakeSop = rep.cases.find((c) => c.id === "H-FAKE-SOP")!;
    expect(fakeSop.echoed).toEqual([]);

    // 而且卡面**必须点名**那个编号并说它查不到 —— 一句不点名的「无法核实」客户
    // 不知道指的是哪一份文件,那种含糊才是真正该扣分的。所以这里反向钉住:
    // 编号要在,且和它同句必须有否认措辞。
    const hc = HALLUCINATION_CASES.find((c) => c.id === "H-FAKE-SOP")!;
    const r = await runConsultationGraph(db, {
      projectId: "HLT-FAKE-SOP",
      tenantId: "novapilot-demo",
      question: hc.question,
      locale: hc.locale,
      facts: hc.facts,
      now: "2026-08-12T00:00:00.000Z",
      traceId: "hlt-fake-sop",
    });
    expect(r.card.status).toBe("expert-review");
    expect(r.card.executiveSummary).toContain("SOP-FFPE-2099");
    const sentence = r.card.executiveSummary
      .split(/[。;；!!??\n]+/)
      .find((s) => s.includes("SOP-FFPE-2099"))!;
    expect(sentence).toMatch(/不在知识库|查不到|无法核实|不存在/);
    db.close();
  }, 120_000);
});
