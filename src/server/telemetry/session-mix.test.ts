/**
 * §3 会话口径单测。
 *
 * 测的是口径,不是算术。五件事各有一条钉住:
 *
 *  1. 分母是「当周有活动的会话」,跨周被唤醒的存量会话必须在分母里。
 *  2. 有效会话只数用户消息 —— 助手回复再多也撑不起「有效」。
 *  3. 测试租户被剔除,而且剔除量必须可见。
 *  4. 咨询者视角分布与系统四角色是两个口径,单位不同(会话 vs 动作)。
 *  5. closed_at 是**状态不是墓碑**:再次提问会解除闭环,这正是跨周唤醒的形态。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type NovaDb } from "../db/client";
import {
  P2_WAKEUP,
  consultantLensMix,
  crossWeekWakeup,
  sessionBoard,
  sessionVolume,
  systemRoleActivity,
  wakeupBreaches,
} from "./session-mix";
import {
  appendMessage,
  createConversation,
  setConversationClosure,
  setConversationRole,
} from "../db/repositories";

const WEEK_START = "2026-09-01T00:00:00.000Z";
const IN_WEEK = "2026-09-03T00:00:00.000Z";
const LAST_WEEK = "2026-08-25T00:00:00.000Z";

let db: NovaDb;
beforeEach(() => {
  db = createDb(":memory:");
});

function conversation(
  db: NovaDb,
  opts: {
    id: string;
    tenantId?: string;
    role?: string | null;
    createdAt: string;
    updatedAt: string;
    closedAt?: string | null;
  },
) {
  createConversation(db, {
    id: opts.id,
    tenantId: opts.tenantId ?? "novapilot-demo",
    role: opts.role,
    now: opts.createdAt,
  });
  db.prepare(`UPDATE conversations SET created_at = ?, updated_at = ? WHERE id = ?`).run(
    opts.createdAt,
    opts.updatedAt,
    opts.id,
  );
  if (opts.closedAt !== undefined) {
    setConversationClosure(db, { id: opts.id, closedAt: opts.closedAt });
  }
}

function userTurns(db: NovaDb, conversationId: string, texts: string[]) {
  texts.forEach((text, i) => {
    appendMessage(db, {
      id: `${conversationId}-u${i}`,
      conversationId,
      role: "user",
      kind: "chat",
      text,
      traceId: `T-${conversationId}-${i}`,
      now: IN_WEEK,
    });
  });
}

describe("§3 周会话总量的分母", () => {
  it("跨周被唤醒的存量会话算进当周分母 —— 切窗切的是 updated_at", () => {
    // 上周建的,本周又被问了一次:它是本周的活动会话。
    conversation(db, { id: "C-old", createdAt: LAST_WEEK, updatedAt: IN_WEEK });
    conversation(db, { id: "C-new", createdAt: IN_WEEK, updatedAt: IN_WEEK });
    // 上周建、上周就没再动过:不在本周分母里。
    conversation(db, { id: "C-dormant", createdAt: LAST_WEEK, updatedAt: LAST_WEEK });

    const v = sessionVolume(db, WEEK_START);
    expect(v.active).toBe(2);
    // created 只数当周新建的;active - created 就是被唤醒的存量会话数。
    expect(v.created).toBe(1);
    expect(v.active - v.created).toBe(1);
  });

  it("测试租户被剔除,且剔除量单独可见", () => {
    conversation(db, { id: "C-real", createdAt: IN_WEEK, updatedAt: IN_WEEK });
    conversation(db, {
      id: "C-test",
      tenantId: "test-ci-runner",
      createdAt: IN_WEEK,
      updatedAt: IN_WEEK,
    });

    const v = sessionVolume(db, WEEK_START);
    expect(v.active).toBe(1);
    // 剔除量必须能看见:分母悄悄变小而看板上没有任何痕迹,是最难查的一类口径错。
    expect(v.excludedTestSessions).toBe(1);
  });

  it("「testing」开头之外的租户名不被误剔 —— 判据是前缀不是包含", () => {
    conversation(db, {
      id: "C-lab",
      tenantId: "zhejiang-testing-lab",
      createdAt: IN_WEEK,
      updatedAt: IN_WEEK,
    });
    expect(sessionVolume(db, WEEK_START).active).toBe(1);
    expect(sessionVolume(db, WEEK_START).excludedTestSessions).toBe(0);
  });
});

describe("§3 有效会话的判据", () => {
  it("用户消息 ≥2 轮且非空才算有效", () => {
    conversation(db, { id: "C-2", createdAt: IN_WEEK, updatedAt: IN_WEEK });
    userTurns(db, "C-2", ["第一问", "第二问"]);
    conversation(db, { id: "C-1", createdAt: IN_WEEK, updatedAt: IN_WEEK });
    userTurns(db, "C-1", ["只问了一句"]);

    const v = sessionVolume(db, WEEK_START);
    expect(v.active).toBe(2);
    expect(v.effective).toBe(1);
    expect(v.effectiveRate).toBeCloseTo(0.5);
  });

  it("空白消息不算一轮 —— 否则回车两下就能把会话刷成有效", () => {
    conversation(db, { id: "C-blank", createdAt: IN_WEEK, updatedAt: IN_WEEK });
    userTurns(db, "C-blank", ["真的问题", "   "]);
    expect(sessionVolume(db, WEEK_START).effective).toBe(0);
  });

  it("助手的回复撑不起「有效」", () => {
    conversation(db, { id: "C-assistant", createdAt: IN_WEEK, updatedAt: IN_WEEK });
    userTurns(db, "C-assistant", ["只问了一句"]);
    for (const i of [0, 1, 2]) {
      appendMessage(db, {
        id: `C-assistant-a${i}`,
        conversationId: "C-assistant",
        role: "assistant",
        kind: "chat",
        text: `回复 ${i}`,
        traceId: `T-a${i}`,
        now: IN_WEEK,
      });
    }
    // 三条助手消息 + 一条用户消息 = 仍然不是有效会话。
    expect(sessionVolume(db, WEEK_START).effective).toBe(0);
  });

  it("没有会话时占比是 null,不是 0", () => {
    expect(sessionVolume(db, WEEK_START).effectiveRate).toBeNull();
  });
});

describe("§3 两份「角色」是两个口径", () => {
  it("咨询者视角分布数会话,未记录的独立成档并计入分母", () => {
    conversation(db, { id: "C-pi", role: "pi", createdAt: IN_WEEK, updatedAt: IN_WEEK });
    conversation(db, { id: "C-stu", role: "student", createdAt: IN_WEEK, updatedAt: IN_WEEK });
    conversation(db, { id: "C-none", createdAt: IN_WEEK, updatedAt: IN_WEEK });

    const mix = consultantLensMix(db, WEEK_START);
    expect(mix.map((m) => m.role).sort()).toEqual(["pi", "student", "未记录"]);
    // 未记录计入分母:三档各 1/3。把它摊掉会让四个角色看起来加总 100%,
    // 而实际上有整整三分之一的会话根本没有角色数据。
    for (const row of mix) expect(row.share).toBeCloseTo(1 / 3);
  });

  it("老客户端不送角色时,已记录的画像不被抹掉", () => {
    conversation(db, { id: "C-keep", role: "pi", createdAt: IN_WEEK, updatedAt: IN_WEEK });
    setConversationRole(db, { id: "C-keep", role: undefined });
    expect(consultantLensMix(db, WEEK_START)[0]?.role).toBe("pi");
  });

  it("用户中途换角色,当前画像跟着换", () => {
    conversation(db, { id: "C-switch", role: "student", createdAt: IN_WEEK, updatedAt: IN_WEEK });
    setConversationRole(db, { id: "C-switch", role: "pi" });
    expect(consultantLensMix(db, WEEK_START)[0]?.role).toBe("pi");
  });

  it("系统四角色数的是动作,数据源各表各出各的", () => {
    conversation(db, { id: "C-a", role: "pi", createdAt: IN_WEEK, updatedAt: IN_WEEK });
    db.prepare(
      `INSERT INTO expert_cases(id, project_id, status, payload, created_at, claimed_at)
       VALUES('EC-1', 'P1', 'claimed', '{}', ?, ?)`,
    ).run(IN_WEEK, IN_WEEK);

    const roles = systemRoleActivity(db, WEEK_START);
    expect(roles.map((r) => r.role)).toEqual(["咨询者", "专家", "知识管理员", "运营"]);
    expect(roles.find((r) => r.role === "咨询者")?.actions).toBe(1);
    expect(roles.find((r) => r.role === "专家")?.actions).toBe(1);
    // 四角色恒定四行,即使某一类角色本周没有任何动作 —— 缺行会被读成「没有这个角色」。
    expect(roles.find((r) => r.role === "运营")?.actions).toBe(0);
  });
});

describe("§3 跨周唤醒", () => {
  it("本窗口前建、本窗口内闭环 = 跨周", () => {
    conversation(db, {
      id: "C-cross",
      createdAt: LAST_WEEK,
      updatedAt: IN_WEEK,
      closedAt: IN_WEEK,
    });
    conversation(db, {
      id: "C-same",
      createdAt: IN_WEEK,
      updatedAt: IN_WEEK,
      closedAt: IN_WEEK,
    });
    // 还开着的会话不进分母。
    conversation(db, { id: "C-open", createdAt: IN_WEEK, updatedAt: IN_WEEK });

    const w = crossWeekWakeup(db, WEEK_START);
    expect(w.closed).toBe(2);
    expect(w.crossWeek).toBe(1);
    expect(w.rate).toBeCloseTo(0.5);
  });

  it("closed_at 是状态不是墓碑:再次提问会解除闭环", () => {
    conversation(db, { id: "C-reopen", createdAt: IN_WEEK, updatedAt: IN_WEEK, closedAt: IN_WEEK });
    expect(crossWeekWakeup(db, WEEK_START).closed).toBe(1);
    // 下一轮没产出正式卡 → 写回 null。会话重新打开,这正是「被唤醒」在数据上的样子;
    // 如果 closed_at 是只写一次的墓碑,被唤醒的会话就永远看不见了。
    setConversationClosure(db, { id: "C-reopen", closedAt: null });
    expect(crossWeekWakeup(db, WEEK_START).closed).toBe(0);
  });

  it("没有闭环会话时占比是 null,不是 0", () => {
    expect(crossWeekWakeup(db, WEEK_START).rate).toBeNull();
  });
});

describe("§11 P2 · 跨周唤醒告警", () => {
  it("样本量不足时不报警 —— 三条会话决定不了一个趋势", () => {
    for (let i = 0; i < 3; i++) {
      conversation(db, {
        id: `C-few-${i}`,
        createdAt: LAST_WEEK,
        updatedAt: IN_WEEK,
        closedAt: IN_WEEK,
      });
    }
    const board = sessionBoard(db, WEEK_START);
    // 占比 100%,远超阈值,但样本量不够 —— 不说话。
    expect(board.wakeup.rate).toBe(1);
    expect(wakeupBreaches(board)).toEqual([]);
  });

  it("样本量够且超阈时报警,并说清是哪一条", () => {
    for (let i = 0; i < P2_WAKEUP.minClosed; i++) {
      conversation(db, {
        id: `C-many-${i}`,
        createdAt: LAST_WEEK,
        updatedAt: IN_WEEK,
        closedAt: IN_WEEK,
      });
    }
    const breaches = wakeupBreaches(sessionBoard(db, WEEK_START));
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toContain("跨周唤醒会话占比");
    expect(breaches[0]).toContain("追问链路过长");
  });

  it("样本量够但未超阈时不报警", () => {
    for (let i = 0; i < P2_WAKEUP.minClosed; i++) {
      conversation(db, {
        id: `C-ok-${i}`,
        createdAt: IN_WEEK, // 本周建本周结,不算跨周
        updatedAt: IN_WEEK,
        closedAt: IN_WEEK,
      });
    }
    expect(wakeupBreaches(sessionBoard(db, WEEK_START))).toEqual([]);
  });
});

describe("sessionBoard 兜底", () => {
  it("空库不抛,率一律 null", () => {
    const board = sessionBoard(db, WEEK_START);
    expect(board.volume.active).toBe(0);
    expect(board.volume.effectiveRate).toBeNull();
    expect(board.wakeup.rate).toBeNull();
    expect(board.lensMix).toEqual([]);
    expect(board.roleActivity).toHaveLength(4);
  });

  it("不切窗时统计全量", () => {
    conversation(db, { id: "C-old", createdAt: LAST_WEEK, updatedAt: LAST_WEEK });
    conversation(db, { id: "C-new", createdAt: IN_WEEK, updatedAt: IN_WEEK });
    expect(sessionBoard(db).volume.active).toBe(2);
  });
});
