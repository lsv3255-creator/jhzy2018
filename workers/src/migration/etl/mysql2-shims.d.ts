/**
 * mysql2 可选依赖的最小环境声明。
 * 本 ETL 引擎不在库层静态依赖 mysql2；仅在 createMysqlV1Extractor 运行期
 * 动态 import('mysql2/promise')。此处声明仅为 tsc 提供类型，避免编译报错；
 * 运行期若未安装 mysql2，将抛出明确错误提示迁移运行器安装。
 */
declare module 'mysql2/promise' {
  export interface PoolConnection {
    query<T = unknown>(sql: string, params?: unknown[]): Promise<[T[], unknown]>;
    release(): void;
  }
  export interface Pool {
    query<T = unknown>(sql: string, params?: unknown[]): Promise<[T[], unknown]>;
    getConnection(): Promise<PoolConnection>;
    end(): Promise<void>;
  }
  export function createPool(config: Record<string, unknown>): Pool;
}
