/**
 * S4-3 持久层端口化
 *
 * NovaDbPort 是 node:sqlite DatabaseSync 的轻量接口，让上层业务代码不直接依赖
 * node:sqlite 的具体类型。测试可以注入 mock 实现；未来迁移到 libsql/better-sqlite3
 * 只需换实现，不改任何业务逻辑。
 *
 * 当前唯一实现：node:sqlite（via getDb() / createDb()），见 client.ts。
 */

export interface PreparedStatementPort {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface NovaDbPort {
  /** Prepare an SQL statement and return a reusable handle. */
  prepare(sql: string): PreparedStatementPort;

  /** Execute one or more SQL statements (DDL, multi-statement, no return). */
  exec(sql: string): void;

  /** Run a synchronous transaction. Commits on success, rolls back on throw. */
  transaction<T>(fn: () => T): T;
}
