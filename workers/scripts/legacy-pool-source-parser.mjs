#!/usr/bin/env node
// =============================================================================
// CERT-R5A —— Legacy Pool Source Parser（离线 WP4-D 权威归档 → LegacyPoolRow[]）
//
// 职责：把 /Users/Shared/jhzy-v2-wp4d-authoritative-20260921.tar.gz 中的
//   `id_pool` 表 450,000 行解析为 legacy-pool-importer 可直接消费的 rows，
//   并产出源统计（行数 / pool 分布 / status 分布 / assigned_to 分类）。
//
// 硬约束：
//   - 只使用【离线】WP4-D 归档；本模块不发起任何网络请求，不接触 JHZY 1.0 live。
//   - 绝不打印 raw code / raw cert_no / PII / secret。日志与返回值只含计数与哈希。
//   - 归档 SHA256 必须先校验，不匹配直接 fail-closed。
//   - 只解析 `INSERT INTO \`id_pool\` VALUES`（精确表名），
//     归档内的 `id_pool_old_20260214` 等同名前缀表必须被排除。
//
// legacy id_pool 列序（来自归档 schema）：
//   id, id_value, id_type, batch_id, status, assigned_to, assigned_at, created_at
//   status ∈ ('available','assigned','reserved')
// =============================================================================
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

/** 精确匹配的表头（反引号包裹，天然排除 id_pool_old_20260214 等前缀表）。 */
export const ID_POOL_HEADER = 'INSERT INTO `id_pool` VALUES';

/** 允许的 pool 类型（与 0046 CHECK 一致）。 */
export const POOL_TYPES = Object.freeze(['cert_trn', 'cert_srv', 'cert_hon', 'cert_skl', 'volunteer']);

/** 允许的 legacy status 字面量。 */
export const LEGACY_STATUSES = Object.freeze(['available', 'assigned', 'reserved']);

/** legacy status → V2 status（与 legacy-pool-importer STATUS_MAP 一致）。 */
export const STATUS_MAP = Object.freeze({ available: 0, assigned: 1, reserved: 2 });

/** 哨兵引用值：不可当作 V2 users.id。 */
export const SENTINEL_REFS = Object.freeze([999999, 0, -1]);

export function sha256FileHex(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// -----------------------------------------------------------------------------
// 归档解包
// -----------------------------------------------------------------------------

/**
 * 把 tar.gz 解包到 workDir，并 gunzip 出 data sql。
 * @returns {{ workDir: string, dataSqlPath: string, members: string[] }}
 */
export function extractArchive(archivePath, workDir) {
  if (!existsSync(archivePath)) throw new Error('SOURCE_ARCHIVE_NOT_FOUND');
  mkdirSync(workDir, { recursive: true });
  execFileSync('tar', ['xzf', archivePath, '-C', workDir], { stdio: 'pipe' });

  const innerRoot = join(workDir, 'wp4d_authoritative_20260921_120656');
  const root = existsSync(innerRoot) ? innerRoot : workDir;

  const gz = join(root, 'api_jhzyfw_com.data.sql.gz');
  if (!existsSync(gz)) throw new Error('ARCHIVE_DATA_SQL_NOT_FOUND');

  const dataSqlPath = join(workDir, 'api_jhzyfw_com.data.sql');
  writeFileSync(dataSqlPath, gunzipSync(readFileSync(gz)));
  return { workDir, dataSqlPath, root };
}

// -----------------------------------------------------------------------------
// SQL 词法扫描（幂等：尊重引号、转义、多级括号；支持超长单行与多行 INSERT）
// -----------------------------------------------------------------------------

/**
 * 切出所有以 header 开头、到顶层 `;` 结束的语句体。
 * 字符串内的 `;` 不会误判为结束。
 */
export function findStatementBodies(text, header) {
  const bodies = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(header, from);
    if (i < 0) break;
    let k = i + header.length;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (; k < text.length; k++) {
      const ch = text[k];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === "'") { inStr = !inStr; continue; }
      if (ch === ';' && !inStr) { end = k; break; }
    }
    if (end < 0) end = text.length;
    bodies.push(text.slice(i + header.length, end));
    from = end + 1;
  }
  return bodies;
}

/** 把 `(a,b,c),(d,e,f)` 形式的语句体切成各元组内部字符串。 */
export function splitTuples(body) {
  const out = [];
  let k = 0;
  while (k < body.length) {
    const ch = body[k];
    if (ch === '(') {
      let depth = 0;
      let m = k;
      let inStr = false;
      let esc = false;
      for (; m < body.length; m++) {
        const c = body[m];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === "'") { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) break; }
      }
      out.push(body.slice(k + 1, m));
      k = m + 1;
      continue;
    }
    k++;
  }
  return out;
}

/** 把元组内部字符串切成字段，保留 NULL / 引号原文（由 lit() 解释）。 */
export function splitFields(inner) {
  const out = [];
  let cur = '';
  let inStr = false;
  let esc = false;
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; cur += ch; continue; }
    if (ch === "'") { inStr = !inStr; cur += ch; continue; }
    if (ch === ',' && !inStr) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** 字段字面量 → JS 值（NULL → null；'str' → str；其余原样）。 */
export function lit(field) {
  if (field === 'NULL' || field === '') return null;
  if (field.length >= 2 && field[0] === "'" && field[field.length - 1] === "'") {
    return field
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
  }
  return field;
}

/**
 * =============================================================================
 * LEGACY DATETIME POLICY（CERT-R5A-CLOSEOUT 人工裁定 · 冻结）
 * =============================================================================
 *
 * MySQL dump 中的 `DATETIME` 是 **naive 挂钟时间**，不带时区信息。
 * JHZY 1.0 生产库（api_jhzyfw_com）运行在 CST(+08:00) 机房，
 * 因此权威裁定为：
 *
 *   LEGACY_DATETIME_POLICY = Asia/Shanghai / CST(+08:00)
 *
 * 即：'2024-01-01 10:30:00' 表示 **北京时间 2024-01-01 10:30:00**，
 * 对应 UTC 瞬时 = '2024-01-01T02:30:00.000Z'。
 *
 * 存储形态仍为 unix seconds（与 V2 `id_pools.assigned_at / created_at` 一致）；
 * 需要 ISO 文本时用 `sqlDateTimeToUtcIso()`，输出恒为 **UTC ISO**（带 Z）。
 *
 * ⛔ 禁止回退为 UTC 解释——那会让全部 legacy 时间戳整体偏移 8 小时。
 */
export const LEGACY_DATETIME_POLICY = Object.freeze({
  timezone: 'Asia/Shanghai',
  offset: '+08:00',
  /** 人类可读裁定口径，供文档/日志引用（不含任何源数据）。 */
  label: 'Asia/Shanghai / CST(+08:00)',
});

/** MySQL naive datetime → UTC ISO 字符串（毫秒精度，带 Z）。NULL → null。 */
export function sqlDateTimeToUtcIso(value, opts) {
  const seconds = parseSqlDateTime(value, opts);
  return seconds == null ? null : new Date(seconds * 1000).toISOString();
}

/**
 * MySQL naive datetime（'YYYY-MM-DD HH:MM:SS'）→ unix seconds（UTC 瞬时）。
 *
 * - NULL / 空串 → null（保持 NULL，绝不伪造时间戳）
 * - 默认按 LEGACY_DATETIME_POLICY（Asia/Shanghai, +08:00）解释
 * - 无法解析 → **throw**（fail-closed；静默返回 null 会掩盖脏数据）
 * - 可通过 opts.datetimeTimezone 覆盖（仅供测试/对照，生产不得覆盖）
 */
export function parseSqlDateTime(value, { datetimeTimezone = LEGACY_DATETIME_POLICY.offset } = {}) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  const iso = raw.replace(' ', 'T') + datetimeTimezone;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    // fail-closed：不打印原始值本体（可能含业务数据），只报长度与形状
    throw new Error(`DATETIME_PARSE_INVALID len=${raw.length} shape=${/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? 'ok' : 'bad'}`);
  }
  return Math.floor(ms / 1000);
}

// -----------------------------------------------------------------------------
// 行解析
// -----------------------------------------------------------------------------

/**
 * 解析一条元组为 LegacyPoolRow。
 * 字段顺序：id, id_value(code), id_type(poolType), batch_id, status, assigned_to, assigned_at, created_at
 */
export function tupleToRow(fields, opts = {}) {
  const [fId, fCode, fType, fBatch, fStatus, fAssignedTo, fAssignedAt, fCreatedAt] = fields;
  const id = Number(lit(fId));
  const code = lit(fCode);
  const poolType = lit(fType);
  const status = lit(fStatus);

  if (!Number.isFinite(id)) throw new Error('ROW_PARSE_BAD_ID');
  if (code == null || code === '') throw new Error('ROW_PARSE_EMPTY_CODE');
  if (!POOL_TYPES.includes(poolType)) throw new Error(`ROW_PARSE_UNKNOWN_POOL_TYPE:${poolType}`);
  if (!LEGACY_STATUSES.includes(status)) throw new Error(`ROW_PARSE_UNKNOWN_STATUS:${status}`);

  const assignedToRaw = lit(fAssignedTo);
  const assignedTo = assignedToRaw == null ? null : Number(assignedToRaw);

  const assignedAt = parseSqlDateTime(lit(fAssignedAt), opts);
  const createdAtRaw = parseSqlDateTime(lit(fCreatedAt), opts);
  // V2 id_pools.created_at 为 NOT NULL；legacy NULL 以 nullTimestampFallback 兜底，
  // 并在 stats.nullCreatedAt 中计数上报（不静默伪造时间戳）。
  const createdAt = createdAtRaw == null ? (opts.nullTimestampFallback ?? 0) : createdAtRaw;

  const batchRaw = lit(fBatch);
  const batchId = batchRaw == null ? null : Number(batchRaw);

  return {
    id,
    code,
    poolType,
    status,
    assignedTo: Number.isFinite(assignedTo) ? assignedTo : null,
    assignedAt,
    batchId: Number.isFinite(batchId) ? batchId : null,
    createdAt,
    __nullCreatedAt: createdAtRaw == null,
  };
}

/**
 * 解析整份 SQL 文本中的 id_pool 行。
 * @returns {{ rows: object[], stats: object }}
 */
export function parseIdPoolRows(sqlText, opts = {}) {
  const rows = [];
  const bodies = findStatementBodies(sqlText, ID_POOL_HEADER);
  const fieldCountMismatch = { count: 0 };
  const nullCreatedAt = { count: 0 };

  for (const body of bodies) {
    for (const inner of splitTuples(body)) {
      const fields = splitFields(inner);
      if (fields.length !== 8) { fieldCountMismatch.count++; continue; }
      const row = tupleToRow(fields, opts);
      if (row.__nullCreatedAt) nullCreatedAt.count++;
      delete row.__nullCreatedAt;
      rows.push(row);
    }
  }
  return { rows, stats: buildSourceStats(rows, { fieldCountMismatch: fieldCountMismatch.count, nullCreatedAt: nullCreatedAt.count }) };
}

/**
 * 由 rows 计算源统计（只含计数，绝不含 code）。
 *
 * ⚠ 口径（与 CERT-R3C 冻结决策一致）：
 *   `assignedTo` 分类作用于【非自由行】= assigned ∪ reserved（权威基线 1,688 条），
 *   与 GUARDS.EXPECTED_ASSIGNED_TO（null 939 / sentinel 2 / unresolved 747）对齐。
 *   全表口径另以 `assignedToAllRows` 输出，仅供诊断，不参与守卫比对。
 */
export function buildSourceStats(rows, extra = {}) {
  const poolCounts = {};
  const statusCounts = { available: 0, assigned: 0, reserved: 0 };

  const classify = (r) =>
    r.assignedTo == null
      ? 'null'
      : SENTINEL_REFS.includes(r.assignedTo)
        ? 'sentinel'
        : 'unresolved'; // 离线快照无 users 表可交叉验证 → 一律 unresolved

  const nf = { null: 0, sentinel: 0, unresolved: 0, proven_mappable: 0 };
  const all = { null: 0, sentinel: 0, unresolved: 0, proven_mappable: 0 };
  let availableWithRef = 0;

  for (const r of rows) {
    poolCounts[r.poolType] = (poolCounts[r.poolType] ?? 0) + 1;
    if (statusCounts[r.status] != null) statusCounts[r.status]++;
    const c = classify(r);
    all[c]++;
    if (r.status !== 'available') nf[c]++;
    else if (r.assignedTo != null) availableWithRef++;
  }
  return {
    rows: rows.length,
    poolCounts,
    statusCounts,
    assignedTo: nf,
    assignedToAllRows: all,
    availableWithRef,
    ...extra,
  };
}

/**
 * 一步到位：校验归档 SHA → 解包 → 解析 → 统计。
 * @param {{ archivePath: string, workDir: string, expectedSha256?: string }} opts
 */
export function loadLegacySource({ archivePath, workDir, expectedSha256, ...parseOpts }) {
  if (!existsSync(archivePath)) throw new Error('SOURCE_ARCHIVE_NOT_FOUND');
  const sha256 = sha256FileHex(archivePath);
  if (expectedSha256 && sha256 !== expectedSha256) {
    const e = new Error(`SOURCE_SHA_MISMATCH expected=${expectedSha256} got=${sha256}`);
    e.guard = 'source-sha';
    throw e;
  }
  const { dataSqlPath } = extractArchive(archivePath, workDir);
  const sql = readFileSync(dataSqlPath, 'utf8');
  const { rows, stats } = parseIdPoolRows(sql, parseOpts);
  return { rows, stats, sha256, dataSqlPath, archivePath };
}

/** 供 CLI 直接查看解析结果（只打印计数，不打印 code）。 */
export function formatStats(stats) {
  const pools = POOL_TYPES.map((p) => `${p}=${stats.poolCounts?.[p] ?? 0}`).join(' ');
  const st = stats.statusCounts ?? {};
  const at = stats.assignedTo ?? {};
  return [
    `rows=${stats.rows}`,
    `pools[${pools}]`,
    `status[available=${st.available ?? 0} assigned=${st.assigned ?? 0} reserved=${st.reserved ?? 0}]`,
    `assignedTo[null=${at.null ?? 0} sentinel=${at.sentinel ?? 0} unresolved=${at.unresolved ?? 0} proven_mappable=${at.proven_mappable ?? 0}]`,
  ].join(' ');
}
