/**
 * 嘉禾志愿 2.0 —— P11-F8-2B 专用测试支持：Mock D1 binding
 * ---------------------------------------------------------------------------
 * 仅用于离线单测，绝不连接 Cloudflare production/staging D1。
 *
 * 设计目标（对应任务 §5 Mock D1 质量门）：
 *  - 识别 D1IdMappingStore 实际执行的 SQL 类型（SELECT / INSERT OR IGNORE）。
 *  - 保存 bind 参数，并在测试内维护真实的 mapping state。
 *  - 对 INSERT：模拟 `INSERT OR IGNORE` 语义（按
 *    (legacy_table, legacy_id, new_table) 唯一，重复写入不新增行）。
 *  - 对 SELECT：返回测试内维护的 mapping state（字段别名与正式 SQL 对齐）。
 *  - 对【未知 SQL】或【错误绑定参数个数】主动抛错，使测试失败——
 *    不是“无论什么 SQL 都返回预设 PASS”的万能 stub。
 *
 * 注意：本 mock 只覆盖 D1IdMappingStore 真实调用到的 contract；
 * 生产 D1IdMappingStore 不使用 transaction/batch，故 mock 亦不模拟。
 * ---------------------------------------------------------------------------
 */
import type { D1DatabaseLike, D1PreparedStatement } from './id-mapping-engine';

export interface MockIdMapRow {
  legacyTable: string;
  legacyId: string;
  newTable: string;
  newId: number;
}

const INSERT_HINT = 'INSERT OR IGNORE INTO legacy_id_maps';
const SELECT_HINT = 'FROM legacy_id_maps';

/**
 * 正式 D1IdMappingStore 实际写入/读取的列，必须与 migrations/0001 的
 * legacy_id_maps DDL 完全一致（否则线上 D1 写入会爆列名错误）。
 * mock 主动校验这些列名，避免“只验证 op 类型 + 绑定个数”而漏掉列契约。
 */
const EXPECTED_INSERT_COLUMNS = ['LEGACY_TABLE', 'LEGACY_ID', 'NEW_TABLE', 'NEW_ID', 'CREATED_AT'];
const EXPECTED_SELECT_COLUMNS = ['LEGACY_TABLE', 'LEGACY_ID', 'NEW_TABLE', 'NEW_ID'];

/**
 * 一条 PreparedStatement 的 mock 实现。
 * prepare() 时即校验 SQL 是否属于受支持契约；bind() 记录参数；run()/all() 落到测试 state。
 */
export class MockD1PreparedStatement implements D1PreparedStatement {
  private binds: unknown[] = [];

  constructor(
    private readonly db: MockD1Database,
    private readonly rawQuery: string,
  ) {
    const normalized = rawQuery.replace(/\s+/g, ' ').trim().toUpperCase();
    const isSelect = normalized.includes('SELECT') && normalized.includes(SELECT_HINT.toUpperCase());
    const isInsert = normalized.includes(INSERT_HINT.toUpperCase());
    if (!isSelect && !isInsert) {
      throw new Error(`MockD1: 拒绝未受支持的 SQL 契约: ${rawQuery}`);
    }
    // 列契约校验：INSERT 必须按既定顺序写出全部 5 列；SELECT 必须覆盖 4 列。
    if (isInsert) {
      this.assertInsertColumns(normalized);
    } else {
      this.assertSelectColumns(normalized);
    }
  }

  private assertInsertColumns(normalized: string): void {
    const open = normalized.indexOf('LEGACY_ID_MAPS (');
    if (open === -1) {
      throw new Error(`MockD1: INSERT 未找到 legacy_id_maps 列清单: ${normalized}`);
    }
    const start = open + 'LEGACY_ID_MAPS ('.length;
    const end = normalized.indexOf(')', start);
    if (end === -1) {
      throw new Error(`MockD1: INSERT 列清单括号未闭合: ${normalized}`);
    }
    const cols = normalized
      .slice(start, end)
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const expected = EXPECTED_INSERT_COLUMNS.join(',');
    const actual = cols.join(',');
    if (actual !== expected) {
      throw new Error(`MockD1: INSERT 列契约不匹配\n  期望: ${expected}\n  实际: ${actual}`);
    }
  }

  private assertSelectColumns(normalized: string): void {
    for (const col of EXPECTED_SELECT_COLUMNS) {
      if (!normalized.includes(col)) {
        throw new Error(`MockD1: SELECT 未引用列契约 ${col}: ${normalized}`);
      }
    }
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this.binds = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const all = await this.all<T>();
    return all.results[0] ?? null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    const normalized = this.rawQuery.replace(/\s+/g, ' ').trim().toUpperCase();
    if (normalized.includes('INSERT')) {
      throw new Error('MockD1: all() 不应在 INSERT 语句上调用');
    }
    if (!normalized.includes('SELECT')) {
      throw new Error('MockD1: all() 仅支持 SELECT 契约');
    }
    return { results: this.db.selectAll() as T[] };
  }

  async run(): Promise<unknown> {
    const normalized = this.rawQuery.replace(/\s+/g, ' ').trim().toUpperCase();
    if (!normalized.includes(INSERT_HINT.toUpperCase())) {
      throw new Error('MockD1: run() 仅支持 INSERT OR IGNORE 契约');
    }
    if (this.binds.length !== 4) {
      throw new Error(`MockD1: INSERT 需要 4 个绑定参数，实际收到 ${this.binds.length}`);
    }
    const [legacyTable, legacyId, newTable, newId] = this.binds as [string, string, string, number];
    this.db.insert({ legacyTable, legacyId, newTable, newId });
    return { success: true };
  }
}

/** 最小 Mock D1 binding：维护测试内 mapping 状态，并实现 OR IGNORE 去重语义。 */
export class MockD1Database implements D1DatabaseLike {
  private rows: MockIdMapRow[] = [];

  prepare(query: string): D1PreparedStatement {
    return new MockD1PreparedStatement(this, query);
  }

  /** 模拟 INSERT OR IGNORE：按 (legacy_table, legacy_id, new_table) 唯一去重。 */
  insert(r: MockIdMapRow): void {
    const exists = this.rows.some(
      (x) => x.legacyTable === r.legacyTable && x.legacyId === r.legacyId && x.newTable === r.newTable,
    );
    if (!exists) this.rows.push({ ...r });
  }

  selectAll(): MockIdMapRow[] {
    return this.rows.map((r) => ({ ...r }));
  }

  /** 测试诊断：当前已落库行数（验证 INSERT OR IGNORE 去重 / 不重复写入）。 */
  rowCount(): number {
    return this.rows.length;
  }

  /** 测试诊断：直接读取全部已落库行（验证 bind 参数真实回写）。 */
  debugRows(): MockIdMapRow[] {
    return this.selectAll();
  }
}
