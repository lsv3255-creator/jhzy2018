/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ETL Engine · Extract（F8-4）
 * ---------------------------------------------------------------------------
 * 一、Extract：从 V1 MySQL 读取 10 张核心源表（含用户枚举的 8 张 + 规范必需的
 *    user_teams / certificates 通用表）。以只读 SELECT 方式进行，禁止任何写入。
 *
 * 实现：
 *  - V1Extractor 接口：解耦具体数据源。
 *  - MySqlV1Extractor：真实 SQL（SELECT * FROM <real> ORDER BY <key> LIMIT ? OFFSET ?）。
 *  - MockV1Extractor：内存数据源，供自测构造模拟数据、支持 offset/limit。
 *  - createMysqlV1Extractor：运行期动态加载 mysql2 组装连接（库本身不静态依赖）。
 * ---------------------------------------------------------------------------
 */
import type { SqlQueryClient, V1Extractor, V1ExtractOptions } from './types';
import { V1_TABLE_MAP } from './types';

export class MySqlV1Extractor implements V1Extractor {
  constructor(
    private readonly client: SqlQueryClient,
    private readonly tableMap: Record<string, { real: string; orderBy: string }> = V1_TABLE_MAP,
  ) {}

  get sourceTables(): string[] {
    return Object.keys(this.tableMap);
  }

  async extractTable(table: string, opts?: V1ExtractOptions): Promise<Array<Record<string, unknown>>> {
    const m = this.tableMap[table];
    if (!m) throw new Error(`[Extract] 未知源表: ${table}`);
    const limit = opts?.limit ?? 1000;
    const offset = opts?.offset ?? 0;
    // real 表名为固定常量（非用户输入），使用反引号转义，无注入风险。
    const sql = `SELECT * FROM \`${m.real}\` ORDER BY ${m.orderBy} LIMIT ? OFFSET ?`;
    return this.client.query<Record<string, unknown>>(sql, [limit, offset]);
  }
}

/** 内存数据源（自测用），支持 offset/limit 切片 */
export class MockV1Extractor implements V1Extractor {
  constructor(private readonly data: Record<string, Array<Record<string, unknown>>>) {}

  get sourceTables(): string[] {
    return Object.keys(this.data);
  }

  async extractTable(table: string, opts?: V1ExtractOptions): Promise<Array<Record<string, unknown>>> {
    const all = this.data[table] ?? [];
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? all.length;
    return all.slice(offset, offset + limit);
  }
}

/** MySQL 连接配置 */
export interface MySqlConnConfig {
  host?: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  socketPath?: string;
  connectionLimit?: number;
}

/**
 * 运行期创建 MySQL 抽取器（动态加载 mysql2）。
 * 仅声明式使用，库不静态依赖 mysql2；迁移运行器需自行 `npm i mysql2`。
 */
export async function createMysqlV1Extractor(config: MySqlConnConfig): Promise<V1Extractor> {
  const mysql = await import('mysql2/promise').catch(() => null);
  if (!mysql) {
    throw new Error('[ETL] 未检测到 mysql2；请在迁移运行器中执行 `npm i mysql2` 后重试。');
  }
  const pool = mysql.createPool({
    host: config.host,
    port: config.port ?? 3306,
    user: config.user,
    password: config.password,
    database: config.database,
    socketPath: config.socketPath,
    waitForConnections: true,
    connectionLimit: config.connectionLimit ?? 5,
  });
  const client: SqlQueryClient = {
    query: <T,>(sql: string, params?: unknown[]): Promise<T[]> =>
      pool.query<T>(sql, params).then(([rows]) => rows as T[]),
  };
  return new MySqlV1Extractor(client, V1_TABLE_MAP);
}
