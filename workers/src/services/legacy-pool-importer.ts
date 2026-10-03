/**
 * LegacyPoolImporter（CERT-R3D）—— 历史编号库存分批导入器。
 *
 * 职责：
 *   - 把 legacy `id_pool` 的 450,000 行库存迁入 V2 `id_pools`。
 *   - 逐字节保留 code；直译 status；**不生成、不重编号、不臆造 assigned_to**。
 *   - 确定性顺序（按 legacy `id` 升序）、分批、可断点续跑、幂等、冲突显式化。
 *
 * 硬约束（承 CERT-R3C / R3C-FIX 冻结决策）：
 *   - LEGACY CODE MUTATION / REGENERATION / RENNUMBERING = FORBIDDEN
 *   - 新编号格式 / 新编号生成 = FORBIDDEN
 *   - 合成 CTRN 500 行**不得**被消费、删除或改写
 *   - reserved(status=2) 必须保留为 2，**不得**因引用不确定而降级
 *   - assigned_to 仅在**有权威映射证据**时填写；否则一律 NULL，
 *     legacy 分配溯源写入 artifact（不臆造 V2 用户 id）
 *
 * 该导入器【不含】证书发放逻辑，也不消费任何编号 —— 它只搬运库存。
 */

export type LegacyStatus = 'available' | 'assigned' | 'reserved';

/** 分配引用分类（R3C §18）。 */
export type AssignmentRefClass =
  | 'ASSIGNMENT_REF_NULL'
  | 'ASSIGNMENT_REF_SENTINEL'
  | 'ASSIGNMENT_REF_UNRESOLVED'
  | 'ASSIGNMENT_REF_PROVEN_MAPPABLE';

/** 权威映射证据表：仅当某 legacy 引用被证明对应某 V2 users.id 时才登记。 */
export type ProvenMappingTable = ReadonlyMap<number, number>;

/** 输入行（来自权威快照解析，字段与 legacy id_pool 一致）。 */
export interface LegacyPoolRow {
  id: number;
  code: string;
  poolType: 'cert_trn' | 'cert_srv' | 'cert_hon' | 'cert_skl' | 'volunteer';
  status: LegacyStatus;
  assignedTo: number | null;
  assignedAt: number | null;
  batchId: number | null;
  createdAt: number;
}

/** 导入后 V2 行形态。 */
export interface V2PoolRow {
  pool_type: string;
  code: string;
  status: number;
  assigned_to: number | null;
  assigned_at: number | null;
  batch_id: number | null;
  provenance: string;
  created_at: number;
}

/** legacy status → V2 status（冻结映射，无证据不得改）。 */
export const STATUS_MAP: Readonly<Record<LegacyStatus, number>> = Object.freeze({
  available: 0,
  assigned: 1,
  reserved: 2,
});

/**
 * 导入行的 provenance（CERT-R3D-FIX §8）。
 *
 * 每一条历史库存行都【必须】被显式分类为 'legacy_migrated' —— 不允许留 NULL，
 * 也不允许事后从 code 格式反推。分配器据此把历史库存纳入正常候选。
 */
export const LEGACY_PROVENANCE = 'legacy_migrated' as const;

/** 视为哨兵值的历史引用（不可当作 users.id）。 */
export const SENTINEL_REFS: ReadonlySet<number> = new Set([999999, 0, -1]);

export const DEFAULT_BATCH_SIZE = 5000;

/** 单行冲突（同名但受保护字段不同）—— 绝不静默覆盖。 */
export interface ImportConflict {
  code: string;
  field: 'pool_type' | 'status' | 'provenance';
  existing: string | number;
  incoming: string | number;
}

export interface ImportStats {
  inserted: number;
  alreadyPresent: number;
  conflicts: number;
  batches: number;
}

export interface ImportOptions {
  db: D1DatabaseLike;
  batchSize?: number;
  provenMappings?: ProvenMappingTable;
  /**
   * 断点续跑游标：已成功处理到的最大 legacy id。
   * 提供时只处理 id > afterLegacyId 的行（安全重跑）。
   */
  afterLegacyId?: number;
  onProgress?: (s: { processed: number; total: number; lastLegacyId: number }) => void;
}

/** 已绑定参数的可执行语句。 */
export interface D1BoundStatement {
  run(): Promise<{ meta?: { changes?: number } }>;
  all<T>(): Promise<{ results?: T[] }>;
  first<T>(): Promise<T | null>;
}

/** 最小 D1 接口（便于在 node:sqlite 适配器上复用同一实现）。 */
export interface D1PreparedLike {
  bind(...args: unknown[]): D1BoundStatement;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedLike;
  batch<T>(stmts: D1BoundStatement[]): Promise<T[]>;
}

/** 引用分类（纯函数，便于单测）。 */
export function classifyAssignmentRef(
  assignedTo: number | null,
  proven: ProvenMappingTable,
): AssignmentRefClass {
  if (assignedTo == null) return 'ASSIGNMENT_REF_NULL';
  if (SENTINEL_REFS.has(assignedTo)) return 'ASSIGNMENT_REF_SENTINEL';
  if (proven.has(assignedTo)) return 'ASSIGNMENT_REF_PROVEN_MAPPABLE';
  return 'ASSIGNMENT_REF_UNRESOLVED';
}

/**
 * 映射为 V2 行。
 * assigned_to 仅在 PROVEN_MAPPABLE 时写入；否则保持 NULL（不臆造）。
 * status 永不降级：即便引用不可考，assigned 仍是 1、reserved 仍是 2。
 */
export function toV2Row(row: LegacyPoolRow, proven: ProvenMappingTable): V2PoolRow {
  const cls = classifyAssignmentRef(row.assignedTo, proven);
  return {
    pool_type: row.poolType,
    code: row.code, // 逐字节原样，不改写
    status: STATUS_MAP[row.status],
    assigned_to: cls === 'ASSIGNMENT_REF_PROVEN_MAPPABLE' ? proven.get(row.assignedTo!)! : null,
    assigned_at: row.assignedAt,
    batch_id: row.batchId,
    provenance: LEGACY_PROVENANCE, // 显式来源语义；绝不由 code 格式推断
    created_at: row.createdAt,
  };
}

/** 确定性排序：按 legacy id 升序（稳定、可复现）。 */
export function sortLegacy(rows: LegacyPoolRow[]): LegacyPoolRow[] {
  return [...rows].sort((a, b) => a.id - b.id);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const UPSERT = `INSERT INTO id_pools (pool_type, code, status, assigned_to, assigned_at, batch_id, provenance, created_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?
   WHERE NOT EXISTS (SELECT 1 FROM id_pools WHERE code = ?)`;

/**
 * 执行导入。
 * 返回 inserted / alreadyPresent / conflicts 精确计数。
 * 冲突（同 code 但 pool_type 或 status 不同）只报告、绝不覆盖。
 */
export async function importLegacyPools(
  legacyRows: LegacyPoolRow[],
  opts: ImportOptions,
): Promise<ImportStats & { conflictDetails: ImportConflict[] }> {
  const { db, provenMappings = new Map(), afterLegacyId = -1 } = opts;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  const sorted = sortLegacy(legacyRows);
  const pending = sorted.filter((r) => r.id > afterLegacyId);
  const batches = chunk(pending, batchSize);

  let inserted = 0;
  let alreadyPresent = 0;
  let processed = 0;
  let lastLegacyId = afterLegacyId;
  const conflictDetails: ImportConflict[] = [];

  for (const batch of batches) {
    // 冲突检测：同 code 已存在但受保护字段不同 → 记录，不覆盖
    // （provenance 亦为受保护字段：同一 code 已是合成兼容库存却声称历史来源，
    //   属必须显式暴露的矛盾，绝不静默改写 —— CERT-R3D-FIX §19）
    for (const r of batch) {
      const existing = await db
        .prepare(`SELECT pool_type, status, provenance FROM id_pools WHERE code = ?`)
        .bind(r.code)
        .first<{ pool_type: string; status: number; provenance: string | null }>();
      if (existing == null) continue;
      const incoming = toV2Row(r, provenMappings);
      if (existing.pool_type !== incoming.pool_type) {
        conflictDetails.push({ code: r.code, field: 'pool_type', existing: existing.pool_type, incoming: incoming.pool_type });
      } else if (existing.status !== incoming.status) {
        conflictDetails.push({ code: r.code, field: 'status', existing: existing.status, incoming: incoming.status });
      } else if ((existing.provenance ?? null) !== incoming.provenance) {
        conflictDetails.push({ code: r.code, field: 'provenance', existing: existing.provenance ?? 'NULL', incoming: incoming.provenance });
      }
    }

    // 批量插入（WHERE NOT EXISTS 保证幂等）
    const stmts = batch.map((r) => {
      const v = toV2Row(r, provenMappings);
      return db
        .prepare(UPSERT)
        .bind(v.pool_type, v.code, v.status, v.assigned_to, v.assigned_at, v.batch_id, v.provenance, v.created_at, v.code);
    });
    const results = await db.batch(stmts);
    for (let i = 0; i < results.length; i++) {
      const changes = Number((results[i] as { meta?: { changes?: number } })?.meta?.changes ?? 0);
      if (changes > 0) inserted++;
      else alreadyPresent++;
    }

    processed += batch.length;
    lastLegacyId = batch[batch.length - 1].id;
    opts.onProgress?.({ processed, total: pending.length, lastLegacyId });
  }

  return {
    inserted,
    alreadyPresent,
    conflicts: conflictDetails.length,
    batches: batches.length,
    conflictDetails,
  };
}

/** 确定性哈希工具（隐私安全：只输出哈希，绝不输出 code）。 */
export async function sha256Hex(input: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle == null) throw new Error('SubtleCrypto unavailable');
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** code 集合哈希：升序 → "\n" 连接 → SHA-256。 */
export async function hashCodeSet(codes: string[]): Promise<string> {
  const sorted = [...codes].sort();
  return sha256Hex(sorted.join('\n') + '\n');
}

/** 状态哈希：(code,status) 升序 → "\t" 连接、行间 "\n"。 */
export async function hashPoolState(pairs: Array<{ code: string; status: number }>): Promise<string> {
  const sorted = [...pairs].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return sha256Hex(sorted.map((p) => `${p.code}\t${p.status}`).join('\n') + '\n');
}

/**
 * 状态 + 来源哈希：(code,status,provenance) 升序 → "\t" 连接、行间 "\n"。
 *
 * CERT-R3D-FIX §18：provenance 纳入对账契约 —— 迁移前后 provenance 必须
 * 完全一致，否则说明来源语义在迁移中漂移（例如合成行被误标为 legacy）。
 * NULL 以字面量 `NULL` 参与哈希（与 SQL 输出的区分明确，不与字符串混淆）。
 */
export async function hashPoolStateWithProvenance(
  rows: Array<{ code: string; status: number; provenance: string | null }>,
): Promise<string> {
  const sorted = [...rows].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return sha256Hex(
    sorted.map((p) => `${p.code}\t${p.status}\t${p.provenance ?? 'NULL'}`).join('\n') + '\n',
  );
}
