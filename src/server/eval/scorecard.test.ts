import { describe, it, expect } from "vitest";
import scorecard from "../../../docs/metric-scorecard.json";
import { PROBES } from "./evidence-probes";
import { createDb } from "../db/client";

/**
 * 已交付批次号。断言 9 用它挡住「已经交付却还在 gap 里说未来会修」的滞后
 * 记账 —— 761994c/960e9fb/153fc9b/d82800b 对应的批次统称 B1~B5（见
 * docs/B1-B5-验收记录.md）；W1~W5 是方案文档里的旧称呼，实际以 B 编号交付。
 */
const DELIVERED_BATCHES = ["B1", "B2", "B3", "B4", "B5", "W1", "W2", "W3", "W4", "W5"];

describe("metric-scorecard.json arithmetic assertions", () => {
  const { indicators, sectionSubtotals, dimensions } = scorecard;

  // ① 每节小计 = 该节明细之和
  for (const [sec, expected] of Object.entries(sectionSubtotals)) {
    it(`${sec} 小计 = 明细之和`, () => {
      const actual = indicators
        .filter((i) => i.section === sec)
        .reduce((sum, i) => sum + i.score, 0);
      expect(actual).toBeCloseTo(expected as number, 1);
    });
  }

  // ② D 折合 = 明细合计 × 30/40（v1.2 量表，分母 40）
  it("D 折合 = 明细合计 × 30/40", () => {
    const rawTotal = indicators.reduce((sum, i) => sum + i.score, 0);
    const computed = rawTotal * (30 / 40);
    expect(dimensions.D.score).toBeCloseTo(computed, 0);
  });

  // ③ 总分 = 五维之和（S1 修订后 99.0：D=30.0，B=19 待 2 条引用联网核实后才满）
  it("总分 = 五维得分之和", () => {
    const total =
      dimensions.A.score +
      dimensions.B.score +
      dimensions.C.score +
      dimensions.D.score +
      dimensions.E.score;
    expect(total).toBeCloseTo(99.0, 0);
  });

  // ④ 每条 score < 1 的行必须有非空 gap
  it("所有扣分项都有非空 gap 说明", () => {
    for (const item of indicators) {
      if (item.score < 1) {
        expect(
          item.gap,
          `${item.section} "${item.indicator}" score=${item.score} 但 gap 为空`
        ).toBeTruthy();
      }
    }
  });

  // ⑤ 每条 probeExpectation 与探针实测逐字段相等
  it("probeExpectation 与探针实测值一致", () => {
    const db = createDb(":memory:");
    for (const item of indicators) {
      const probe = PROBES[item.id];
      expect(probe, `缺少探针: ${item.id}`).toBeDefined();
      const result = probe(db);
      const exp = item.probeExpectation;
      expect(result.hasSource, `${item.id}.hasSource`).toBe(exp.hasSource);
      expect(result.hasAggregation, `${item.id}.hasAggregation`).toBe(exp.hasAggregation);
      expect(result.onDashboard, `${item.id}.onDashboard`).toBe(exp.onDashboard);
      expect(result.isProxy, `${item.id}.isProxy`).toBe(exp.isProxy);
    }
  });

  // ⑥ score >= 1 ⟹ 三布尔全 true 且非 proxy
  it("满分项的探针三布尔全为 true 且非 proxy", () => {
    const db = createDb(":memory:");
    for (const item of indicators) {
      if (item.score >= 1) {
        const probe = PROBES[item.id];
        if (!probe) continue;
        const result = probe(db);
        expect(
          result.hasSource,
          `${item.id} score=1 但 hasSource=false`
        ).toBe(true);
        expect(
          result.hasAggregation,
          `${item.id} score=1 但 hasAggregation=false`
        ).toBe(true);
        expect(
          result.onDashboard,
          `${item.id} score=1 但 onDashboard=false`
        ).toBe(true);
        expect(
          result.isProxy,
          `${item.id} score=1 但 isProxy=true`
        ).toBe(false);
      }
    }
  });

  // ⑦ 三布尔全 true 且非 proxy ⟹ score >= 1（主防滞后断言）
  it("探针三布尔全 true 且非 proxy 的指标计分必须 >= 1", () => {
    const db = createDb(":memory:");
    for (const item of indicators) {
      const probe = PROBES[item.id];
      if (!probe) continue;
      const result = probe(db);
      if (result.hasSource && result.hasAggregation && result.onDashboard && !result.isProxy) {
        expect(
          item.score,
          `${item.id} 探针全绿但 score=${item.score}（记账滞后）`
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });

  // ⑧ isProxy === true ⟹ score <= 0.7 且 proxyNote 非空
  it("代理指标的 score <= 0.7 且 proxyNote 非空", () => {
    for (const item of indicators) {
      if (item.probeExpectation.isProxy) {
        expect(
          item.score,
          `${item.id} isProxy 但 score=${item.score} > 0.7`
        ).toBeLessThanOrEqual(0.7);
        expect(
          item.proxyNote,
          `${item.id} isProxy 但 proxyNote 为空`
        ).toBeTruthy();
      }
    }
  });

  // ⑨ score < 1 ⟹ gap 非空且不含已交付批次号（防止 gap 成为无效占位符）
  it("扣分项 gap 不能引用已交付批次", () => {
    for (const item of indicators) {
      if (item.score < 1 && item.gap) {
        for (const batch of DELIVERED_BATCHES) {
          const re = new RegExp(`\\b${batch}\\b`);
          expect(
            re.test(item.gap),
            `${item.id} gap 引用了已交付批次 "${batch}"：${item.gap}`
          ).toBe(false);
        }
      }
    }
  });
});
