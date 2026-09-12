import { describe, it, expect } from "vitest";
import { wilsonInterval, reviewSampleSummary } from "./review-samples";
import calibration from "../../../data/eval/judge-calibration.json";
import { createDb } from "../db/client";

describe("wilsonInterval", () => {
  it("全对时下界接近 1", () => {
    const { lower } = wilsonInterval(30, 30);
    expect(lower).toBeGreaterThan(0.88);
    expect(lower).toBeLessThanOrEqual(1);
  });

  it("n=0 时返回 [0,1]", () => {
    const { lower, upper } = wilsonInterval(0, 0);
    expect(lower).toBe(0);
    expect(upper).toBe(1);
  });

  it("小样本下界低于点估计", () => {
    const { lower } = wilsonInterval(10, 13); // 77%
    expect(lower).toBeLessThan(0.77);
  });

  it("27/30 的下界在 0.74~0.85 合理区间", () => {
    const { lower, upper } = wilsonInterval(27, 30);
    expect(lower).toBeGreaterThan(0.74);
    expect(upper).toBeLessThan(0.97);
  });
});

describe("judge-calibration.json 结构护栏", () => {
  const cases = calibration.cases;

  it("恰好 30 条校准案例", () => {
    expect(cases.length).toBe(30);
  });

  it("每条必须有 id、kind、judgeVerdict、expertVerdict、agreement", () => {
    for (const c of cases) {
      expect(c.id, "缺 id").toBeTruthy();
      expect(["intercepted", "not-escalated"], `${c.id} kind 非法`).toContain(c.kind);
      expect(c.judgeVerdict, `${c.id} 缺 judgeVerdict`).toBeTruthy();
      expect(c.expertVerdict, `${c.id} 缺 expertVerdict`).toBeTruthy();
      expect(["agree", "disagree"], `${c.id} agreement 非法`).toContain(c.agreement);
    }
  });

  it("agreement 字段与 judgeVerdict == expertVerdict 一致", () => {
    for (const c of cases) {
      const expected = c.judgeVerdict === c.expertVerdict ? "agree" : "disagree";
      expect(c.agreement, `${c.id} agreement 与 verdict 对应不上`).toBe(expected);
    }
  });

  it("专家一致率 Wilson 下界 ≥ 0.74（30 条样本够用）", () => {
    const agreed = cases.filter((c) => c.agreement === "agree").length;
    const { lower } = wilsonInterval(agreed, cases.length);
    expect(lower, `agreed=${agreed}/30, Wilson lower=${lower.toFixed(3)}`).toBeGreaterThanOrEqual(0.74);
  });
});

describe("reviewSampleSummary · Wilson 区间集成", () => {
  it("空库时 wilsonLower/Upper 均为 null", () => {
    const db = createDb(":memory:");
    const s = reviewSampleSummary(db);
    expect(s.judgeAgreement.wilsonLower).toBeNull();
    expect(s.judgeAgreement.wilsonUpper).toBeNull();
  });
});
