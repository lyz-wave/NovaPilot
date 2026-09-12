/**
 * v9 增补迁移单测。
 *
 * `CREATE TABLE IF NOT EXISTS` 对**已存在**的表是空操作 —— 这意味着老库不会
 * 自动长出新列,而 SQLite 的报错(`no such column`)只在真正查到那一列时才出现。
 * 如果聚合侧恰好被 try/catch 兜底成了「这一格是 0」,一次没生效的迁移可以在
 * 生产里静默活很久。所以这里的做法是**造一个真的老库**:先建 v8 形状的表,
 * 再跑 migrate,然后既验证列长出来了,也验证老数据被如实回填。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createDb, migrate, type NovaDb } from "./client";
import { ADDITIVE_COLUMNS } from "./schema";

const NOW = "2026-09-02T00:00:00.000Z";

/** v9 新增的七列,与 ADDITIVE_COLUMNS 里那一批一一对应。 */
const V9_COLUMNS: ReadonlyArray<[table: string, column: string]> = [
  ["candidates", "published_at"],
  ["candidates", "gray_started_at"],
  ["expert_cases", "claimed_at"],
  ["expert_cases", "resolved_at"],
  ["conversations", "role"],
  ["conversations", "closed_at"],
  ["latency_samples", "outcome"],
];

function columns(db: NovaDb, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

let db: NovaDb;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("v9 增补迁移", () => {
  it("新建库直接带齐七列", () => {
    for (const [table, column] of V9_COLUMNS) {
      expect(columns(db, table), `${table}.${column}`).toContain(column);
    }
  });

  it("ADDITIVE_COLUMNS 与实际表结构不脱节", () => {
    // 这一条防的是「往数组里加了一行,但 SCHEMA_SQL 里忘了同步加列」——
    // 新库走 SCHEMA_SQL,老库走 ALTER,两条路径必须收敛到同一个形状。
    for (const { table, column } of ADDITIVE_COLUMNS) {
      expect(columns(db, table), `${table}.${column}`).toContain(column);
    }
  });

  it("v8 老库跑 migrate 后长出新列,老数据不丢", () => {
    const old = createDb(":memory:");
    // 造一个 v8 形状的库:把新列删掉(SQLite 3.35+ 支持 DROP COLUMN),
    // 塞进老数据,再跑一次 migrate。
    for (const [table, column] of V9_COLUMNS) {
      old.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    for (const [table, column] of V9_COLUMNS) {
      expect(columns(old, table)).not.toContain(column);
    }

    old
      .prepare(
        `INSERT INTO conversations(id, tenant_id, title, created_at, updated_at)
         VALUES('C-old', 'novapilot-demo', '老会话', ?, ?)`,
      )
      .run(NOW, NOW);
    old
      .prepare(
        `INSERT INTO latency_samples(id, trace_id, route, kind, card_status, duration_ms, created_at)
         VALUES('LT-old', 't-old', 'consultations', 'card', 'formal', 900, ?)`,
      )
      .run(NOW);

    migrate(old);

    for (const [table, column] of V9_COLUMNS) {
      expect(columns(old, table), `${table}.${column}`).toContain(column);
    }
    // 老数据还在,新列为 NULL —— 「这条记录没有这个时刻」是它的如实描述。
    const conv = old
      .prepare("SELECT title, role, closed_at FROM conversations WHERE id='C-old'")
      .get() as { title: string; role: string | null; closed_at: string | null };
    expect(conv.title).toBe("老会话");
    expect(conv.role).toBeNull();
    expect(conv.closed_at).toBeNull();
  });

  it("老的延迟样本按 completed 回填 —— 那是对它们的如实描述", () => {
    const old = createDb(":memory:");
    old.exec("ALTER TABLE latency_samples DROP COLUMN outcome");
    old
      .prepare(
        `INSERT INTO latency_samples(id, trace_id, route, kind, card_status, duration_ms, created_at)
         VALUES('LT-old', 't-old', 'consultations:stream', 'card', 'formal', 900, ?)`,
      )
      .run(NOW);

    migrate(old);

    // 改造前的采样写在 respond() 之后 —— 能落库就意味着那次请求跑完了。
    // 所以回填成 completed 不是猜测,而是对老口径的准确翻译。
    // 反过来把它们填成 started 会让「在途流」凭空多出一批永远不收场的行。
    const row = old.prepare("SELECT outcome FROM latency_samples WHERE id='LT-old'").get() as {
      outcome: string;
    };
    expect(row.outcome).toBe("completed");
  });

  it("老库自动长出 degrade_triggers 表 —— 新表走 CREATE IF NOT EXISTS,不需要 ALTER", () => {
    const old = createDb(":memory:");
    old.exec("DROP TABLE degrade_triggers");
    migrate(old);
    expect(columns(old, "degrade_triggers")).toContain("gate_key");
    // deduped 有默认值,老库补表后直接可写。
    expect(() =>
      old
        .prepare(
          `INSERT INTO degrade_triggers(id, gate_key, label, source, created_at)
           VALUES('DT-1', 'p0-defects', 'P0', 'runtime', ?)`,
        )
        .run(NOW),
    ).not.toThrow();
  });

  it("PRAGMA busy_timeout 正确配置为 5000ms", () => {
    const res = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    expect(res.timeout).toBe(5000);
  });

  it("SCHEMA_SQL 结构性防回归: 所有可增补列均支持 DROP COLUMN 往返解析", () => {
    // 专门防御在列定义之间书写多行注释破坏 SQLite 逆向语法解析器的回归隐患
    const testDb = createDb(":memory:");
    for (const [table, column] of V9_COLUMNS) {
      expect(() => {
        testDb.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }, `${table}.${column} drop column`).not.toThrow();
    }
    expect(() => migrate(testDb)).not.toThrow();
  });

  it("migrate 幂等:重复跑不报 duplicate column", () => {
    expect(() => {
      migrate(db);
      migrate(db);
      migrate(db);
    }).not.toThrow();
  });
});
