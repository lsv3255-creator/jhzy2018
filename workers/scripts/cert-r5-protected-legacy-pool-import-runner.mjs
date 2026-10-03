#!/usr/bin/env node
// =============================================================================
// CERT-R4-RUNNER —— 受保护的生产 legacy pool 导入 Runner（设计 + 安全闸门）
//
// 目标：补齐 R4-CLOSEOUT 中 IMPORTER_PRODUCTION_READY = NO 的缺口。
//   workers/src/services/legacy-pool-importer.ts 是纯逻辑 importer（幂等/可续跑/
//   UNIQUE(code)/冲突 fail-closed）。本 Runner 是「受保护的 caller」：在调用底层
//   importer 之前，强制校验 账户 / 目标 DB UUID / 源档案 SHA / 计数 / 迁移前置条件，
//   并要求两步显式确认，才允许写入。
//
// 纪律（本任务 / R4-RUNNER）：
//   - 默认【不】执行任何生产写入。
//   - execute 模式必须显式提供全部 --confirm-* 才允许写；否则 fail-closed。
//   - 本文件可用于未来 R5 生产执行，但 R4-RUNNER 任务【不】对生产运行 execute。
//   - 生产只读查询（ledger / precondition）允许，但需经双锁：
//       CLOUDFLARE_ACCOUNT_ID + --profile jhzy
//
// 运行（仅 plan / dry-run，安全）：
//   node scripts/cert-r5-protected-legacy-pool-import-runner.mjs --mode plan
//   node scripts/cert-r5-protected-legacy-pool-import-runner.mjs --mode dry-run
//
// 导出（供 tests/cert_r4_runner_production_guard.test.mjs 使用）：
//   GUARDS, validateTarget, validateSource, validatePreconditions,
//   withRetry, isTransientError, parseLegacySourceStats, buildPlan,
//   runLegacyPoolImportRunner, createSafeLogger
// =============================================================================
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// =============================================================================
// §5 生产目标硬守卫常量（fail-closed 基准）
// =============================================================================
export const GUARDS = Object.freeze({
  EXPECTED_ACCOUNT_ID: '8770e4917f904aed5df91c883cf058af',

  PROD_D1_NAME: 'jhzy-v2-prod',
  PROD_D1_UUID: 'd372229f-c0ae-4dcc-b968-4ec7c2832842',

  // 禁止的默认 DB（绝不允许回退）
  FORBIDDEN_DEFAULT_D1_NAME: 'jhzy-v2-db',
  FORBIDDEN_DEFAULT_D1_UUID: 'ea603f43-d076-4df5-b118-3d8a0c245439',

  // 禁止误写预发
  STAGING_D1_NAME: 'jhzy-v2-staging',
  STAGING_D1_UUID: '85853fb1-1384-486e-9be3-566f72f45c5d',

  // §6 源档案（仅接受离线 WP4-D 权威快照）
  SOURCE_ARCHIVE: '/Users/Shared/jhzy-v2-wp4d-authoritative-20260921.tar.gz',
  EXPECTED_SOURCE_SHA256: 'd51563b0e3149535eb66ff64a3d447a5ad9dfa1cdf26f00b680b4824c4d688bf',
  EXPECTED_SOURCE_ROWS: 450000,
  EXPECTED_POOL_TOTALS: Object.freeze({
    cert_trn: 180000,
    cert_srv: 150000,
    cert_hon: 10000,
    cert_skl: 10000,
    volunteer: 100000,
  }),
  EXPECTED_STATUS_TOTALS: Object.freeze({
    available: 448312,
    assigned: 1661,
    reserved: 27,
  }),
  EXPECTED_ASSIGNED_TO: Object.freeze({
    null: 939,
    sentinel: 2,
    unresolved: 747,
    proven_mappable: 0,
  }),

  // §3 源分类（与 importer 一致）
  SENTINEL_REFS: Object.freeze([999999, 0, -1]),

  // §8 retry/backoff 默认
  RETRY_MAX: 5,
  RETRY_BASE_MS: 500,
  RETRY_FACTOR: 2,
  RETRY_CAP_MS: 8000,
});

// =============================================================================
// §10 安全日志：绝不输出 raw code / PII
// =============================================================================
export class TransientError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'TransientError';
  }
}

export function createSafeLogger(sink) {
  const out = sink ?? ((s) => process.stderr.write(s + '\n'));
  // §10 禁止出现在日志中的模式（raw code / PII）
  // 注意：键值对模式必须连值一起脱敏，否则 openid/real_name/session_token 等值会泄漏。
  const FORBIDDEN = [
    /\bJHCRT-[A-Z0-9-]{6,}\b/g, // 真实 cert_no 前缀
    /\bJH-[A-Z0-9]{4,}\b/g, // 真实 cert_no 前缀
    /\bCTRN[0-9]{6}\b/g, // 合成码
    /\b1[3-9][0-9]{9}\b/g, // 手机号
    /\b[1-9][0-9]{16}[0-9Xx]\b/g, // 身份证
    /\bBearer\b/gi, // 鉴权令牌（修正 Beare r 拼写）
    /secret\S*/gi, // secret 字面量（含后缀）
    /\b(openid|phone|id_card|real_name|session_token)\s*[:=]\s*\S+/gi, // 键值对整体脱敏
  ];
  function redact(line) {
    let s = String(line);
    for (const re of FORBIDDEN) s = s.replace(re, '[REDACTED]');
    return s;
  }
  return {
    info: (...a) => out(redact(a.map(String).join(' '))),
    warn: (...a) => out(redact('[warn] ' + a.map(String).join(' '))),
    error: (cat, ...a) => out(redact(`[error:${cat}] ` + a.map(String).join(' '))),
    retry: (n, kind) => out(redact(`[retry ${n}] ${kind} (no raw codes logged)`)),
    // 暴露给测试：返回最近若干条已脱敏日志（不含原值）
    _redact: redact,
  };
}

// =============================================================================
// §5 / §6 目标 + 源守卫（纯函数，fail-closed）
// =============================================================================
export function validateTarget({ accountId, dbName, dbUuid }) {
  const f = [];
  if (!accountId) f.push('ACCOUNT_ID_MISSING');
  else if (accountId !== GUARDS.EXPECTED_ACCOUNT_ID) f.push('ACCOUNT_ID_MISMATCH');

  if (!dbName) f.push('DB_NAME_MISSING');
  else if (dbName === GUARDS.FORBIDDEN_DEFAULT_D1_NAME) f.push('DB_NAME_IS_FORBIDDEN_DEFAULT');
  else if (dbName === GUARDS.STAGING_D1_NAME) f.push('DB_NAME_IS_STAGING');
  else if (dbName !== GUARDS.PROD_D1_NAME) f.push('DB_NAME_MISMATCH');

  if (!dbUuid) f.push('DB_UUID_MISSING');
  else if (dbUuid === GUARDS.FORBIDDEN_DEFAULT_D1_UUID) f.push('DB_UUID_IS_FORBIDDEN_DEFAULT');
  else if (dbUuid === GUARDS.STAGING_D1_UUID) f.push('DB_UUID_IS_STAGING');
  else if (dbUuid !== GUARDS.PROD_D1_UUID) f.push('DB_UUID_MISMATCH');

  return { ok: f.length === 0, failures: f };
}

export function validateSource(stats) {
  const f = [];
  if (!stats) return { ok: false, failures: ['SOURCE_STATS_MISSING'] };
  if (stats.sha256 !== GUARDS.EXPECTED_SOURCE_SHA256) f.push('SOURCE_SHA_MISMATCH');
  if (stats.rows !== GUARDS.EXPECTED_SOURCE_ROWS) f.push('SOURCE_ROW_COUNT_MISMATCH');

  for (const [pool, exp] of Object.entries(GUARDS.EXPECTED_POOL_TOTALS)) {
    const got = stats.poolCounts?.[pool];
    if (got !== exp) f.push(`SOURCE_POOL_${pool}_MISMATCH exp=${exp} got=${got ?? 'undefined'}`);
  }
  for (const [st, exp] of Object.entries(GUARDS.EXPECTED_STATUS_TOTALS)) {
    const got = stats.statusCounts?.[st];
    if (got !== exp) f.push(`SOURCE_STATUS_${st}_MISMATCH exp=${exp} got=${got ?? 'undefined'}`);
  }
  const at = stats.assignedTo ?? {};
  if ((at.null ?? -1) !== GUARDS.EXPECTED_ASSIGNED_TO.null) f.push('SOURCE_ASSIGNED_NULL_MISMATCH');
  if ((at.sentinel ?? -1) !== GUARDS.EXPECTED_ASSIGNED_TO.sentinel) f.push('SOURCE_ASSIGNED_SENTINEL_MISMATCH');
  if ((at.unresolved ?? -1) !== GUARDS.EXPECTED_ASSIGNED_TO.unresolved) f.push('SOURCE_ASSIGNED_UNRESOLVED_MISMATCH');
  if ((at.proven_mappable ?? -1) !== GUARDS.EXPECTED_ASSIGNED_TO.proven_mappable) f.push('SOURCE_ASSIGNED_PROVEN_MISMATCH');

  return { ok: f.length === 0, failures: f };
}

// §7 迁移前置条件守卫（基于生产只读状态）
export function validatePreconditions(prod) {
  const f = [];
  if (!prod) return { ok: false, ready: false, reason: 'PROD_STATE_MISSING', failures: f };
  // 0045 / 0046 必须各恰好应用一次
  if (prod.migration0045Count !== 1) f.push('MIGRATION_0045_NOT_APPLIED_EXACTLY_ONCE');
  if (prod.migration0046Count !== 1) f.push('MIGRATION_0046_NOT_APPLIED_EXACTLY_ONCE');
  // id_pools 必须含 0046 的 provenance 列
  if (prod.hasProvenanceColumn !== true) f.push('ID_POOLS_MISSING_PROVENANCE_COLUMN');
  // 导入前：恰好 500 条 v2_synthetic_compat
  if (prod.syntheticCompatCount !== 500) f.push('SYNTHETIC_COMPAT_COUNT_NOT_500');
  // 导入前：legacy_migrated = 0
  if ((prod.legacyMigratedCount ?? -1) !== 0) f.push('LEGACY_MIGRATED_NOT_ZERO_BEFORE_IMPORT');
  // 导入前：NULL provenance = 0
  if ((prod.nullProvenanceCount ?? -1) !== 0) f.push('NULL_PROVENANCE_NOT_ZERO_BEFORE_IMPORT');
  // 导入前：重复 code 组 = 0
  if ((prod.duplicateCodeGroups ?? -1) !== 0) f.push('DUPLICATE_CODE_GROUPS_NOT_ZERO');

  const ready = f.length === 0;
  return {
    ok: ready,
    ready,
    reason: ready ? 'READY_FOR_IMPORT' : 'NOT_READY_FOR_IMPORT_BECAUSE_0045_0046_ABSENT',
    failures: f,
  };
}

// =============================================================================
// §8 retry / backoff（区分 transient 与 deterministic）
// =============================================================================
export function isTransientError(e) {
  return e instanceof TransientError || /ETIMEDOUT|ECONNRESET|5\d\d|rate.?limit|timeout/i.test(String(e?.message ?? ''));
}

export async function withRetry(fn, opts = {}) {
  const max = opts.maxRetries ?? GUARDS.RETRY_MAX;
  const base = opts.baseMs ?? GUARDS.RETRY_BASE_MS;
  const factor = opts.factor ?? GUARDS.RETRY_FACTOR;
  const cap = opts.capMs ?? GUARDS.RETRY_CAP_MS;
  const logger = opts.logger ?? createSafeLogger();
  let attempt = 0;
  let lastErr = null;
  while (attempt <= max) {
    try {
      return await fn(attempt);
    } catch (e) {
      // deterministic（守卫/冲突/源不匹配）→ 立即 fail-closed，绝不重试
      if (!isTransientError(e)) {
        lastErr = e;
        break;
      }
      lastErr = e;
      if (attempt >= max) break;
      const delay = Math.min(cap, base * Math.pow(factor, attempt));
      logger.retry(attempt + 1, e.name || 'transient');
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    }
  }
  throw lastErr;
}

// =============================================================================
// §6 源档案解析（纯函数；可在测试中以小夹具验证）
// =============================================================================
export function parseLegacySourceStats(sqlText) {
  const rows = [];
  const re = /INSERT INTO `id_pool` VALUES /g;
  let m;
  while ((m = re.exec(sqlText)) !== null) {
    const end = sqlText.indexOf(';', m.index + m[0].length);
    const s = sqlText.slice(m.index + m[0].length, end);
    const rr = /\((\d+),'([^']*)','([^']*)',(\d+|NULL),'([^']*)',(\d+|NULL),('([^']*)'|NULL),('([^']*)'|NULL)\)/g;
    let t;
    while ((t = rr.exec(s)) !== null) {
      const ts = (x) => (x === 'NULL' || x == null ? null : x);
      rows.push({
        id: Number(t[1]),
        code: t[2],
        poolType: t[3],
        status: t[5], // available|assigned|reserved
        assignedTo: t[6] === 'NULL' ? null : Number(t[6]),
      });
    }
    re.lastIndex = end;
  }
  const poolCounts = {};
  const statusCounts = { available: 0, assigned: 0, reserved: 0 };
  let nullN = 0,
    sentinelN = 0,
    unresolvedN = 0,
    provenN = 0;
  for (const r of rows) {
    poolCounts[r.poolType] = (poolCounts[r.poolType] ?? 0) + 1;
    if (r.status === 'available') statusCounts.available++;
    else if (r.status === 'assigned') statusCounts.assigned++;
    else if (r.status === 'reserved') statusCounts.reserved++;
    if (r.assignedTo == null) {
      nullN++;
    } else if (GUARDS.SENTINEL_REFS.includes(r.assignedTo)) {
      sentinelN++;
    } else {
      // 离线快照无 users 表可交叉验证 → 全部 unresolved
      unresolvedN++;
    }
  }
  return {
    rows: rows.length,
    poolCounts,
    statusCounts,
    assignedTo: { null: nullN, sentinel: sentinelN, unresolved: unresolvedN, proven_mappable: provenN },
  };
}

// 读取 .sql / .gz / .tar.gz 内嵌 sql 的纯文本（仅用于 R5 实跑；测试注入 stats 不依赖此）
export function readArchiveSql(path) {
  if (!existsSync(path)) throw new Error('SOURCE_ARCHIVE_NOT_FOUND');
  const buf = readFileSync(path);
  // 启发式：gzip 魔数 1f 8b
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    // 可能是 .tar.gz（含嵌套 sql）或纯 .gz sql。先整体 gunzip 试一次；
    // 若是 tar，则需进一步解析 —— R5 实跑前会先 `tar xzf` 抽取内层 sql，
    // 本函数仅负责纯 .gz sql 的解压。
    return gunzipSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

export async function sha256FileHex(path) {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

// =============================================================================
// §9 内置 executor（镜像 importer 的幂等/冲突 fail-closed 语义）
// 生产 R5 应将 config.executor 替换为真实 importLegacyPools（编译后的 .js）；
// 测试注入 spy/fake 以验证「守卫通过后才调用底层 importer」。
// =============================================================================
const UPSERT = `INSERT INTO id_pools (pool_type, code, status, assigned_to, assigned_at, batch_id, provenance, created_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?
   WHERE NOT EXISTS (SELECT 1 FROM id_pools WHERE code = ?)`;

export async function builtinImportExecutor(rows, { db, batchSize = 5000, afterLegacyId = -1, provenMappings = new Map(), onProgress } = {}) {
  const STATUS_MAP = { available: 0, assigned: 1, reserved: 2 };
  const LEGACY_PROV = 'legacy_migrated';
  const sorted = [...rows].sort((a, b) => a.id - b.id).filter((r) => r.id > afterLegacyId);
  const batches = [];
  for (let i = 0; i < sorted.length; i += batchSize) batches.push(sorted.slice(i, i + batchSize));
  let inserted = 0,
    alreadyPresent = 0,
    conflicts = 0,
    lastLegacyId = afterLegacyId;
  for (const b of batches) {
    // 冲突检测（同 code 但受保护字段不同 → 记录，不覆盖）
    for (const r of b) {
      const ex = await db
        .prepare('SELECT pool_type, status, provenance FROM id_pools WHERE code = ?')
        .bind(r.code)
        .first();
      if (!ex) continue;
      const inc = { pool_type: r.poolType, status: STATUS_MAP[r.status], provenance: LEGACY_PROV };
      if (ex.pool_type !== inc.pool_type || ex.status !== inc.status || (ex.provenance ?? null) !== inc.provenance) {
        conflicts++;
      }
    }
    const stmts = b.map((r) => {
      const cls = r.assignedTo == null ? 'NULL' : GUARDS.SENTINEL_REFS.includes(r.assignedTo) ? 'SENTINEL' : provenMappings.has(r.assignedTo) ? 'PROVEN' : 'UNRESOLVED';
      const at = cls === 'PROVEN' ? provenMappings.get(r.assignedTo) : null;
      return db
        .prepare(UPSERT)
        .bind(r.poolType, r.code, STATUS_MAP[r.status], at, r.assignedAt ?? null, r.batchId ?? null, LEGACY_PROV, r.createdAt ?? 1700000000, r.code);
    });
    const res = await db.batch(stmts);
    for (const x of res) {
      if (Number(x?.meta?.changes ?? 0) > 0) inserted++;
      else alreadyPresent++;
    }
    lastLegacyId = b[b.length - 1].id;
    onProgress?.({ processed: inserted + alreadyPresent, total: sorted.length, lastLegacyId });
  }
  return { inserted, alreadyPresent, conflicts, batches: batches.length, lastLegacyId };
}

// =============================================================================
// §13 plan / dry-run / execute 主入口
// =============================================================================
export function buildPlan({ target, source, precondition, mode }) {
  return {
    mode,
    target: { accountId: target.accountId, dbName: target.dbName, dbUuid: target.dbUuid },
    sourceSha: source.sha256,
    sourceRows: source.rows,
    poolCounts: source.poolCounts,
    statusCounts: source.statusCounts,
    preconditionReady: precondition.ready,
    preconditionReason: precondition.reason,
    writes: false,
    note: 'PLAN_ONLY — no production write performed',
  };
}

/**
 * 主 Runner。
 * @param {object} config
 *   mode: 'plan' | 'dry-run' | 'execute'
 *   target: { accountId, dbName, dbUuid }
 *   source: { sha256, rows, poolCounts, statusCounts, assignedTo }  // 已解析的源统计
 *   readProdState: async () => ({ migration0045Count, migration0046Count, hasProvenanceColumn,
 *                                syntheticCompatCount, legacyMigratedCount, nullProvenanceCount,
 *                                duplicateCodeGroups })
 *   executor: async (rows, opts) => stats   // 底层 importer（默认 builtinImportExecutor）
 *   rows: LegacyPoolRow[]                      // 待导入行（execute 时使用）
 *   confirmations: { productionD1, account, sourceSha, maintenanceWindow, iUnderstandProductionWrite }
 *   logger
 */
export async function runLegacyPoolImportRunner(config) {
  const mode = config.mode ?? 'plan';
  const logger = config.logger ?? createSafeLogger();
  const target = config.target ?? {};
  const source = config.source ?? {};

  // ---- 目标守卫 ----
  const tgt = validateTarget(target);
  if (!tgt.ok) {
    logger.error('TARGET_GUARD', ...tgt.failures);
    return { ok: false, stage: 'target', guard: 'target', failures: tgt.failures, writes: false };
  }

  // ---- 源守卫 ----
  const src = validateSource(source);
  if (!src.ok) {
    logger.error('SOURCE_GUARD', ...src.failures);
    return { ok: false, stage: 'source', guard: 'source', failures: src.failures, writes: false };
  }

  // ---- 读取生产前置条件（只读）----
  let prod = {};
  if (config.readProdState) {
    prod = (await config.readProdState()) ?? {};
  }
  const pre = validatePreconditions(prod);

  // plan / dry-run：不写，仅报告
  if (mode === 'plan' || mode === 'dry-run') {
    const plan = buildPlan({ target, source, precondition: pre, mode });
    logger.info(`MODE=${mode} PLAN_OK target=${target.dbName}/${target.dbUuid} sourceRows=${source.rows} precondition=${pre.reason}`);
    return { ok: true, mode, writes: false, plan, precondition: pre, executed: false };
  }

  // ---- execute 模式：强制两步确认 ----
  if (mode === 'execute') {
    const c = config.confirmations ?? {};
    const missing = [];
    if (c.productionD1 !== GUARDS.PROD_D1_UUID) missing.push('confirm-production-d1');
    if (c.account !== GUARDS.EXPECTED_ACCOUNT_ID) missing.push('confirm-account');
    if (c.sourceSha !== GUARDS.EXPECTED_SOURCE_SHA256) missing.push('confirm-source-sha');
    if (c.maintenanceWindow !== 'CERTIFICATE_ISSUANCE_CLOSED') missing.push('confirm-maintenance-window');
    if (!c.iUnderstandProductionWrite) missing.push('confirm-i-understand-production-write');
    if (missing.length) {
      logger.error('CONFIRMATION_GUARD', ...missing);
      return { ok: false, stage: 'confirmation', guard: 'confirmation', failures: missing, writes: false };
    }
    // 前置条件未就绪 → 即使确认也 fail-closed（避免误导入到未迁移 schema）
    if (!pre.ok) {
      logger.error('PRECONDITION_GUARD', ...pre.failures);
      return { ok: false, stage: 'precondition', guard: 'precondition', failures: pre.failures, writes: false };
    }
    // 真正执行（经 retry/backoff + 底层 executor）
    const executor = config.executor ?? builtinImportExecutor;
    const rows = config.rows ?? [];
    try {
      const stats = await withRetry(
        async () => executor(rows, { db: config.db, batchSize: config.batchSize, afterLegacyId: config.resumeFromLegacyId ?? -1, provenMappings: config.provenMappings, logger }),
        { logger, maxRetries: config.retryMax, baseMs: config.retryBaseMs, factor: config.retryFactor, capMs: config.retryCapMs },
      );
      logger.info(`EXECUTE_OK inserted=${stats.inserted} alreadyPresent=${stats.alreadyPresent} conflicts=${stats.conflicts} batches=${stats.batches}`);
      return { ok: true, mode, writes: true, executed: true, stats, precondition: pre };
    } catch (e) {
      logger.error('EXECUTE_FAILED', e?.name || 'error', String(e?.message ?? ''));
      return { ok: false, stage: 'execute', guard: 'execute', failures: [String(e?.message ?? e)], writes: false };
    }
  }

  return { ok: false, stage: 'mode', guard: 'mode', failures: ['UNKNOWN_MODE'], writes: false };
}

// =============================================================================
// CLI（默认不写；仅 plan/dry-run 安全；execute 需显式确认）
// =============================================================================
export function parseCliArgs(argv) {
  const a = { mode: 'plan', target: {}, confirmations: {} };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--mode': a.mode = next(); break;
      case '--target': a.target.dbName = next(); break;
      case '--account': a.target.accountId = next(); break;
      case '--db-uuid': a.target.dbUuid = next(); break;
      case '--confirm-production-d1': a.confirmations.productionD1 = next(); break;
      case '--confirm-account': a.confirmations.account = next(); break;
      case '--confirm-source-sha': a.confirmations.sourceSha = next(); break;
      case '--confirm-maintenance-window': a.confirmations.maintenanceWindow = next(); break;
      case '--confirm-i-understand-production-write': a.confirmations.iUnderstandProductionWrite = true; break;
      default: break;
    }
  }
  return a;
}

// 仅在直接运行（node scripts/...mjs）时进入 CLI
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseCliArgs(process.argv.slice(2));
  const logger = createSafeLogger();
  logger.info(`CERT-R5-RUNNER invoked mode=${args.mode} (no production write unless --mode execute with full confirmations)`);
  // CLI 不直接连生产；仅打印守卫常量与模式说明，避免任何副作用。
  logger.info(`EXPECTED_ACCOUNT=${GUARDS.EXPECTED_ACCOUNT_ID} PROD_D1=${GUARDS.PROD_D1_NAME}/${GUARDS.PROD_D1_UUID}`);
  logger.info('This runner is guarded. Execute mode requires explicit --confirm-* flags and a maintenance window.');
  process.exitCode = 0;
}

