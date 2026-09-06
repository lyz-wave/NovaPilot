import { describe, it, expect } from "vitest";
import scorecard from "../../../docs/metric-scorecard.json";

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

  // ② D 折合 = 明细合计 × 30/39
  it("D 折合 = 明细合计 × 30/39", () => {
    const rawTotal = indicators.reduce((sum, i) => sum + i.score, 0);
    const computed = rawTotal * (30 / 39);
    expect(dimensions.D.score).toBeCloseTo(computed, 0);
  });

  // ③ 总分 = 五维之和
  it("总分 = 五维得分之和", () => {
    const total =
      dimensions.A.score +
      dimensions.B.score +
      dimensions.C.score +
      dimensions.D.score +
      dimensions.E.score;
    expect(total).toBeCloseTo(94.5, 0);
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
});
