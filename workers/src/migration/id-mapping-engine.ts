/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ID 映射引擎（ID Mapping Engine）
 * ---------------------------------------------------------------------------
 * 依据：docs/migration/01-data-mapping-spec.md（P11-F8-1）
 *
 * 职责：
 *  - 管理 legacy_id_maps 的读写（内存缓存 + 可插拔持久化后端）
 *  - 提供 resolve / tryResolve 反查，禁止在 ETL 中硬编码旧→新 ID
 *  - 复用既有 crypto.generateUlid 生成 public_id（与 V2 运行时完全一致）
 *
 * 设计边界：
 *  - 仅作为迁移工具被调用，不被任何线上路由 import（不进入 Worker 运行时请求路径）
 *  - 本模块不发起任何 D1 写入以外的副作用；真实迁移执行在维护窗口 + GO 签署后进行
 *  - 不修改生产数据库结构、不部署、不新增业务功能
 * ---------------------------------------------------------------------------
 */
import { generateUlid } from '../utils/crypto';

/** D1 最小接口（避免硬依赖 @cloudflare/workers-types，便于离线单测） */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
}

/** 一条 legacy_id_maps 记录 */
export interface IdMappingRecord {
  legacyTable: string;
  legacyId: string;
  newTable: string;
  newId: number;
}

/** 持久化后端抽象 */
export interface IdMappingStore {
  loadAll(): Promise<IdMappingRecord[]>;
  save(rec: IdMappingRecord): Promise<void>;
}

/** 内存后端（默认；迁移启动时 warm 全量） */
export class InMemoryIdMappingStore implements IdMappingStore {
  private map = new Map<string, IdMappingRecord>();

  private static keyOf(r: Omit<IdMappingRecord, 'newId'>): string {
    return `${r.legacyTable}${r.legacyId}${r.newTable}`;
  }

  async loadAll(): Promise<IdMappingRecord[]> {
    return [...this.map.values()];
  }

  async save(rec: IdMappingRecord): Promise<void> {
    this.map.set(InMemoryIdMappingStore.keyOf(rec), rec);
  }

  /** 仅供测试/调试：按 key 直接读取 */
  peek(r: Omit<IdMappingRecord, 'newId'>): IdMappingRecord | undefined {
    return this.map.get(InMemoryIdMappingStore.keyOf(r));
  }
}

/** D1 后端（真实迁移使用，legacy_id_maps 表已存在于 0001） */
export class D1IdMappingStore implements IdMappingStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async loadAll(): Promise<IdMappingRecord[]> {
    const res = await this.db
      .prepare(
        `SELECT legacy_table AS legacyTable, legacy_id AS legacyId, new_table AS newTable, new_id AS newId FROM legacy_id_maps`,
      )
      .all<IdMappingRecord>();
    return res.results ?? [];
  }

  async save(rec: IdMappingRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO legacy_id_maps (legacy_table, legacy_id, new_table, new_id, created_at)
         VALUES (?, ?, ?, ?, unixepoch())`,
      )
      .bind(rec.legacyTable, rec.legacyId, rec.newTable, rec.newId)
      .run();
  }
}

/**
 * ID 映射引擎：迁移期核心反查设施。
 */
export class IdMappingEngine {
  private readonly cache = new Map<string, number>();
  private readonly store: IdMappingStore;

  constructor(store: IdMappingStore) {
    this.store = store;
  }

  private static keyOf(legacyTable: string, legacyId: string, newTable: string): string {
    return `${legacyTable}${legacyId}${newTable}`;
  }

  /**
   * 预加载全量映射到内存（迁移启动调用一次）。
   * 之后所有 resolve 走内存 O(1)，避免逐行查 D1。
   */
  async warm(): Promise<number> {
    const all = await this.store.loadAll();
    for (const r of all) {
      this.cache.set(IdMappingEngine.keyOf(r.legacyTable, r.legacyId, r.newTable), r.newId);
    }
    return all.length;
  }

  /**
   * 注册并落盘一条映射（幂等：同 key 重复注册返回首次 newId）。
   * 整数主键沿用场景下 newId 由调用方传入（V1 int id == V2 int id）。
   */
  async register(rec: IdMappingRecord): Promise<number> {
    const k = IdMappingEngine.keyOf(rec.legacyTable, rec.legacyId, rec.newTable);
    const existing = this.cache.get(k);
    if (existing !== undefined) return existing;
    await this.store.save(rec);
    this.cache.set(k, rec.newId);
    return rec.newId;
  }

  /** 便捷：注册（legacy 字符串 id → 已沿用 newId） */
  async registerResolved(
    legacyTable: string,
    legacyId: string,
    newTable: string,
    newId: number,
  ): Promise<number> {
    return this.register({ legacyTable, legacyId, newTable, newId });
  }

  /**
   * 反查：legacy → new id。
   * 未命中抛错（fail-fast）：禁止在 ETL 中硬编码旧 ID，未映射即数据质量问题。
   */
  resolve(legacyTable: string, legacyId: string, newTable: string): number {
    const v = this.cache.get(IdMappingEngine.keyOf(legacyTable, legacyId, newTable));
    if (v === undefined) {
      throw new Error(
        `IdMappingEngine.resolve: 未找到映射 ${legacyTable}.${legacyId} -> ${newTable}（请先 register 或检查数据质量）`,
      );
    }
    return v;
  }

  /**
   * 可空反查：用于可选关联（如 reviewer_id / certificate_url 关联）。
   * 空输入或缺失返回 null，由调用方决定默认值。
   */
  tryResolve(legacyTable: string, legacyId: string | null | undefined, newTable: string): number | null {
    if (legacyId === null || legacyId === undefined || legacyId === '') return null;
    const v = this.cache.get(IdMappingEngine.keyOf(legacyTable, legacyId, newTable));
    return v === undefined ? null : v;
  }

  /** 当前内存中已注册映射条数（诊断用） */
  size(): number {
    return this.cache.size;
  }

  /**
   * 生成新的 ULID public_id。
   * 复用 V2 运行时同一 generateUlid，保证 sessions/teams/activities 等 public_id 规则一致。
   */
  newPublicId(): string {
    return generateUlid();
  }
}

/**
 * 自测：纯内存后端验证逻辑正确（供迁移 runner 启动前 sanity check 调用）。
 * 不触碰任何外部存储。
 */
export async function selfTest(): Promise<{ pass: boolean; checks: string[] }> {
  const checks: string[] = [];
  let pass = true;
  const fail = (msg: string) => {
    pass = false;
    checks.push(`FAIL: ${msg}`);
  };

  const store = new InMemoryIdMappingStore();
  const engine = new IdMappingEngine(store);

  // 1) register + resolve 往返
  const id = await engine.registerResolved('volunteers', 'V20230001', 'users', 123);
  if (id !== 123) fail(`registerResolved 返回错误: ${id}`);
  if (engine.resolve('volunteers', 'V20230001', 'users') !== 123) fail('resolve 未返回 123');
  checks.push('OK: register/resolve 往返');

  // 2) 幂等：重复注册返回首次
  const again = await engine.registerResolved('volunteers', 'V20230001', 'users', 999);
  if (again !== 123) fail(`幂等失败: ${again}`);
  checks.push('OK: register 幂等');

  // 3) tryResolve 空/缺失
  if (engine.tryResolve('x', null, 'y') !== null) fail('tryResolve(null) 应返回 null');
  if (engine.tryResolve('x', '', 'y') !== null) fail('tryResolve("") 应返回 null');
  if (engine.tryResolve('missing', 'abc', 'users') !== null) fail('tryResolve 缺失应返回 null');
  checks.push('OK: tryResolve 空/缺失处理');

  // 4) resolve 未命中抛错
  try {
    engine.resolve('nope', '1', 'users');
    fail('resolve 未命中应抛错');
  } catch {
    checks.push('OK: resolve 未命中 fail-fast');
  }

  // 5) warm 加载全量
  const e2 = new IdMappingEngine(store);
  const n = await e2.warm();
  if (n !== 1) fail(`warm 计数错误: ${n}`);
  if (e2.resolve('volunteers', 'V20230001', 'users') !== 123) fail('warm 后 resolve 失败');
  checks.push('OK: warm 加载');

  // 6) ULID 唯一性 + 格式（生成 5000 个不重复，且匹配 26 位 Crockford）
  const set = new Set<string>();
  const re = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  let bad = 0;
  for (let i = 0; i < 5000; i++) {
    const u = engine.newPublicId();
    if (!re.test(u)) bad++;
    set.add(u);
  }
  if (bad > 0) fail(`ULID 格式非法 ${bad} 个`);
  if (set.size !== 5000) fail(`ULID 唯一性冲突: ${5000 - set.size} 个重复`);
  checks.push('OK: ULID 唯一性/格式 (5000)');

  return { pass, checks };
}
