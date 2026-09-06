/**
 * §8 降级矩阵触发次数单测。
 *
 * 核心那一条是 `去重不吃掉触发次数` —— 这一格此前拿不到数不是因为没聚合,
 * 是因为**唯一的数据源被去重了**。其余几条钉的是「五行恒在」和「演练与真实
 * 降级分开计数」。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type NovaDb } from "../db/client";
import {
  DEGRADE_GATES,
  degradeMatrixSummary,
  recordDegradeTrigger,
} from "./degrade-matrix";

const NOW = "2026-09-02T00:00:00.000Z";
const at = (i: number) => new Date(Date.parse(NOW) + i * 60_000).toISOString();

let db: NovaDb;
beforeEach(() => {
  db = createDb(":memory:");
});

function trigger(
  gateKey: string,
  opts: { source?: "console" | "runtime"; deduped?: boolean; now?: string } = {},
) {
  recordDegradeTrigger(db, {
    gateKey,
    label: "闸门",
    source: opts.source ?? "runtime",
    deduped: opts.deduped ?? false,
    now: opts.now ?? NOW,
  });
}

describe("§8 降级矩阵触发次数", () => {
  it("空库也是五行,没触发过的闸门占位为 0", () => {
    const s = degradeMatrixSummary(db);
    expect(s.gates.map((g) => g.gateKey)).toEqual([...DEGRADE_GATES]);
    // 缺行会被读成「没有这道闸门」,而不是「这道闸门本周没触发」。
    for (const g of s.gates) expect(g.triggers).toBe(0);
    expect(s.triggers).toBe(0);
  });

  it("同一道闸门反复触发逐次累加 —— 这正是去重吃掉的那个数", () => {
    for (let i = 0; i < 12; i++) {
      // 第一次开了事件,后面 11 次都被事件去重复用了已有事件。
      trigger("p0-defects", { deduped: i > 0, now: at(i) });
    }
    const gate = degradeMatrixSummary(db).gates.find((g) => g.gateKey === "p0-defects")!;
    // 若拿 quality_events 行数当触发次数,这里只会是 1。
    expect(gate.triggers).toBe(12);
    expect(gate.deduped).toBe(11);
    expect(gate.lastAt).toBe(at(11));
  });

  it("演练与真实降级分开计数:演示不该把真实降级次数冲高", () => {
    trigger("data-boundary", { source: "console" });
    trigger("data-boundary", { source: "console" });
    trigger("data-boundary", { source: "runtime" });

    const s = degradeMatrixSummary(db);
    const gate = s.gates.find((g) => g.gateKey === "data-boundary")!;
    expect(gate.triggers).toBe(3);
    expect(gate.console).toBe(2);
    expect(gate.runtime).toBe(1);
    // 总数含演练,runtimeTriggers 不含 —— 两个数并列给,读的人自己选口径。
    expect(s.triggers).toBe(3);
    expect(s.runtimeTriggers).toBe(1);
  });

  it("五道闸门各自独立计数,顺序与看板一致", () => {
    trigger("escalation-recall");
    trigger("citation-validity");
    trigger("citation-validity");

    const s = degradeMatrixSummary(db);
    expect(s.gates.map((g) => g.triggers)).toEqual([1, 2, 0, 0, 0]);
    expect(s.triggers).toBe(3);
  });

  it("切窗按触发时刻", () => {
    trigger("p0-defects", { now: "2026-08-01T00:00:00.000Z" });
    trigger("p0-defects", { now: NOW });
    expect(degradeMatrixSummary(db).triggers).toBe(2);
    expect(degradeMatrixSummary(db, "2026-08-25T00:00:00.000Z").triggers).toBe(1);
  });

  it("未知闸门也被记下,不被静默丢弃", () => {
    trigger("some-new-gate");
    const s = degradeMatrixSummary(db);
    expect(s.gates).toHaveLength(DEGRADE_GATES.length + 1);
    expect(s.gates.find((g) => g.gateKey === "some-new-gate")?.triggers).toBe(1);
  });

  it("表被删时只告警不抛 —— 埋点挂掉不该让降级流程失败", () => {
    db.exec("DROP TABLE degrade_triggers");
    expect(() => trigger("p0-defects")).not.toThrow();
    expect(degradeMatrixSummary(db).triggers).toBe(0);
  });
});
