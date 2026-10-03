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
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
// CERT-R5A —— 真实接线（source parser + D1 适配器 + 编译后的 importer）
//
// ⚠ R5 原 CLI 为「空转守卫桩」：只打印常量并 exit 0，从未读取归档、从未解析
//   450,000 行、从未校验源统计、从未连接 D1 → 其 exit 0 属伪通过。
//   本段将其替换为真实实现：plan / dry-run 必须真实解析源；execute 仍需完整确认。
// =============================================================================
import { loadLegacySource, formatStats } from './legacy-pool-source-parser.mjs';
import { createLocalSqliteD1, createRemoteD1Adapter, ID_POOLS_SCHEMA } from './d1-executor-adapters.mjs';

/** 默认离线归档（WP4-D 权威快照）；禁用任何 live JHZY 1.0 源。 */
export const DEFAULT_SOURCE_ARCHIVE = GUARDS.SOURCE_ARCHIVE;

const IMPORTER_TS = join(__dirname, '..', 'src', 'services', 'legacy-pool-importer.ts');
const IMPORTER_OUT = join(__dirname, '..', 'tmp', '_r5a', 'legacy-pool-importer.mjs');

/**
 * 用 esbuild 把 TypeScript importer 转译为可 import 的 ESM（缓存在 gitignored tmp/）。
 * 失败即 fail-closed —— 绝不使用「镜像实现」替代真实 importer 执行生产写入。
 */
export async function compileImporter({ force = false } = {}) {
  if (!force && existsSync(IMPORTER_OUT)) return import(pathToFileURL(IMPORTER_OUT).href);
  mkdirSync(dirname(IMPORTER_OUT), { recursive: true });
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [IMPORTER_TS],
    outfile: IMPORTER_OUT,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    bundle: true,
    logLevel: 'silent',
  });
  return import(pathToFileURL(IMPORTER_OUT).href);
}

/** 把解析出的 legacy rows 交给【真实】importLegacyPools 执行（本地 SQLite 或远程 D1）。 */
export async function createImporterExecutor({ logger } = {}) {
  const mod = await compileImporter();
  return async (rows, opts) => mod.importLegacyPools(rows, { ...opts, logger });
}

/**
 * 只读读取生产前置状态（双锁 wrangler）。不可用时降级为空对象 + 记录原因，
 * 不阻断 plan/dry-run（守卫仍会对缺失状态给出 NOT_READY）。
 */
export async function readProdStateViaWrangler({
  profile = 'jhzy',
  accountId = GUARDS.EXPECTED_ACCOUNT_ID,
  dbName = GUARDS.PROD_D1_NAME,
  wranglerBin,
} = {}) {
  const bin = wranglerBin ?? resolveWranglerBin();
  if (!bin) return { ok: false, reason: 'WRANGLER_NOT_FOUND' };
  const sql = [
    `SELECT COUNT(*) AS c0045 FROM d1_migrations WHERE name LIKE '%0045%'`,
    `SELECT COUNT(*) AS c0046 FROM d1_migrations WHERE name LIKE '%0046%'`,
    `SELECT COUNT(*) AS hasProvenanceColumn FROM pragma_table_info('id_pools') WHERE name='provenance'`,
    `SELECT COUNT(*) AS syntheticCompatCount FROM id_pools WHERE provenance='v2_synthetic_compat'`,
    `SELECT COUNT(*) AS legacyMigratedCount FROM id_pools WHERE provenance='legacy_migrated'`,
    `SELECT COUNT(*) AS nullProvenanceCount FROM id_pools WHERE provenance IS NULL`,
    `SELECT COUNT(*) AS duplicateCodeGroups FROM (SELECT code FROM id_pools GROUP BY code HAVING COUNT(*)>1)`,
  ].join('; ');
  try {
    const out = execFileSync(
      bin,
      ['d1', 'execute', dbName, '--remote', '-e', 'production', '--profile', profile, '--json', '--command', sql],
      {
        // cwd 必须是 workers/（wrangler.toml 所在），否则 wrangler 找不到 --env production
        cwd: join(__dirname, '..'),
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CI: '1' },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // 继承 stdin：wrangler 以「是否交互」决定是否复用 --profile 的登录态。
        // 若 stdin 被 pipe，wrangler 会强制要求 CLOUDFLARE_API_TOKEN 而失败。
        stdio: ['inherit', 'pipe', 'pipe'],
      },
    );
    const nums = [...out.matchAll(/"(c0045|c0046|hasProvenanceColumn|syntheticCompatCount|legacyMigratedCount|nullProvenanceCount|duplicateCodeGroups)":\s*(\d+)/g)];
    const pick = (k) => {
      const m = nums.find((x) => x[1] === k);
      return m ? Number(m[2]) : undefined;
    };
    return {
      ok: true,
      migration0045Count: pick('c0045'),
      migration0046Count: pick('c0046'),
      hasProvenanceColumn: pick('hasProvenanceColumn') === 1,
      syntheticCompatCount: pick('syntheticCompatCount'),
      legacyMigratedCount: pick('legacyMigratedCount'),
      nullProvenanceCount: pick('nullProvenanceCount'),
      duplicateCodeGroups: pick('duplicateCodeGroups'),
    };
  } catch (e) {
    // 诊断信息只取短摘要（不含任何 secret）；wrangler 在无 TTY 且无
    // CLOUDFLARE_API_TOKEN 时会拒绝执行，此时降级为「前置状态不可用」，
    // 由守卫按缺失状态给出 NOT_READY（fail-closed），不阻断 plan/dry-run。
    const detail = String(e?.stderr ?? e?.message ?? e).slice(0, 200).replace(/\s+/g, ' ');
    return { ok: false, reason: `WRANGLER_READ_FAILED: ${detail}` };
  }
}

/**
 * 解析 wrangler 可执行文件。
 * 优先使用 PATH 上的 wrangler（已配置 --profile jhzy 的登录态）；
 * 仅当 PATH 不可用时才回落到仓库本地 .bin（本地版本在非交互环境可能强制要求
 * CLOUDFLARE_API_TOKEN，故不作为首选）。
 */
function resolveWranglerBin() {
  try {
    const p = execFileSync('which', ['wrangler'], { encoding: 'utf8' }).trim();
    if (p && existsSync(p)) return p;
  } catch { /* PATH 未命中，继续回落 */ }
  const local = join(__dirname, '..', 'node_modules', '.bin', 'wrangler');
  if (existsSync(local)) return local;
  return null;
}

/**
 * 构建 D1 适配器。
 *  - dbMode='local'  → node:sqlite（本地模拟 / 测试，零网络）
 *  - dbMode='remote' → Cloudflare D1 REST（生产写入；需 CLOUDFLARE_API_TOKEN）
 *  - dbMode='none'   → 不建连接（plan / dry-run 默认）
 */
export async function createDbAdapter({ dbMode = 'none', localDbPath, accountId, dbUuid, dbName, apiToken }) {
  if (dbMode === 'none') return null;
  if (dbMode === 'local') return createLocalSqliteD1({ path: localDbPath ?? ':memory:', schema: ID_POOLS_SCHEMA });
  if (dbMode === 'remote') {
    if (dbUuid !== GUARDS.PROD_D1_UUID) throw new Error('REMOTE_TARGET_UUID_GUARD_FAILED');
    if (accountId !== GUARDS.EXPECTED_ACCOUNT_ID) throw new Error('REMOTE_TARGET_ACCOUNT_GUARD_FAILED');
    return createRemoteD1Adapter({ accountId, dbUuid, dbName, apiToken: apiToken ?? process.env.CLOUDFLARE_API_TOKEN });
  }
  throw new Error(`UNKNOWN_DB_MODE:${dbMode}`);
}

export function parseCliArgs(argv) {
  const a = {
    mode: 'plan',
    target: {},
    confirmations: {},
    dbMode: 'none',
    archivePath: DEFAULT_SOURCE_ARCHIVE,
    workDir: undefined,
    readProdState: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--mode': a.mode = next(); break;
      case '--target': a.target.dbName = next(); break;
      case '--account': a.target.accountId = next(); break;
      case '--db-uuid': a.target.dbUuid = next(); break;
      case '--source-archive': a.archivePath = next(); break;
      case '--work-dir': a.workDir = next(); break;
      case '--db-mode': a.dbMode = next(); break;
      case '--local-db-path': a.localDbPath = next(); break;
      case '--batch-size': a.batchSize = Number(next()); break;
      case '--read-prod-state': a.readProdState = true; break;
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

/**
 * 真实 CLI 主流程。
 * plan / dry-run：必须真实读取并解析离线归档，产出 450,000 行统计；失败即非 0 退出。
 * execute：仍需全部 --confirm-*，且必须显式 --db-mode。
 */
export async function runCli(argv, { logger = createSafeLogger(), executorOverride } = {}) {
  const args = parseCliArgs(argv);
  const target = {
    accountId: args.target.accountId ?? GUARDS.EXPECTED_ACCOUNT_ID,
    dbName: args.target.dbName ?? GUARDS.PROD_D1_NAME,
    dbUuid: args.target.dbUuid ?? GUARDS.PROD_D1_UUID,
  };
  logger.info(`CERT-R5A-RUNNER mode=${args.mode} target=${target.dbName}/${target.dbUuid} dbMode=${args.dbMode}`);

  // ---- 目标守卫 ----
  const tgt = validateTarget(target);
  if (!tgt.ok) {
    logger.error('TARGET_GUARD', ...tgt.failures);
    return { ok: false, exitCode: 2, stage: 'target', failures: tgt.failures };
  }

  // ---- 真实解析离线源（plan / dry-run / execute 都必须执行）----
  let loaded;
  try {
    loaded = loadLegacySource({
      archivePath: args.archivePath,
      workDir: args.workDir ?? join(tmpdir(), 'cert-r5a-source'),
      expectedSha256: GUARDS.EXPECTED_SOURCE_SHA256,
    });
  } catch (e) {
    logger.error('SOURCE_LOAD_FAILED', String(e?.message ?? e));
    return { ok: false, exitCode: 3, stage: 'source-load', failures: [String(e?.message ?? e)] };
  }
  const source = {
    sha256: loaded.sha256,
    rows: loaded.stats.rows,
    poolCounts: loaded.stats.poolCounts,
    statusCounts: loaded.stats.statusCounts,
    assignedTo: loaded.stats.assignedTo,
  };
  logger.info(`SOURCE_PARSED ${formatStats(loaded.stats)}`);
  if (loaded.stats.availableWithRef > 0) {
    logger.warn(`SOURCE_ANOMALY availableWithAssignedToRef=${loaded.stats.availableWithRef}`);
  }

  const src = validateSource(source);
  if (!src.ok) {
    logger.error('SOURCE_GUARD', ...src.failures);
    return { ok: false, exitCode: 4, stage: 'source', failures: src.failures };
  }

  // ---- 生产前置（可选，只读）----
  let prod = {};
  if (args.readProdState) {
    const ps = await readProdStateViaWrangler({ profile: 'jhzy', accountId: target.accountId, dbName: target.dbName });
    if (ps.ok) {
      prod = ps;
      logger.info(`PROD_STATE 0045=${ps.migration0045Count} 0046=${ps.migration0046Count} synthetic=${ps.syntheticCompatCount} legacy=${ps.legacyMigratedCount}`);
    } else {
      logger.warn(`PROD_STATE_UNAVAILABLE ${ps.reason}`);
    }
  }
  const pre = validatePreconditions(prod);

  // ---- plan / dry-run：不写 ----
  if (args.mode === 'plan' || args.mode === 'dry-run') {
    const plan = buildPlan({ target, source, precondition: pre, mode: args.mode });
    logger.info(`MODE=${args.mode} PLAN_OK rows=${source.rows} precondition=${pre.reason} batches=${plan?.batches ?? 'n/a'}`);
    if (args.mode === 'dry-run') {
      logger.info(`DRY_RUN_BATCH_PLAN batchSize=${args.batchSize ?? 5000} batches=${Math.ceil(source.rows / (args.batchSize ?? 5000))} writes=0`);
    }
    return { ok: true, exitCode: 0, mode: args.mode, writes: false, plan, precondition: pre, stats: loaded.stats };
  }

  // ---- execute：完整确认 + 真实 executor ----
  if (args.mode === 'execute') {
    const c = args.confirmations ?? {};
    const missing = [];
    if (c.productionD1 !== GUARDS.PROD_D1_UUID) missing.push('confirm-production-d1');
    if (c.account !== GUARDS.EXPECTED_ACCOUNT_ID) missing.push('confirm-account');
    if (c.sourceSha !== GUARDS.EXPECTED_SOURCE_SHA256) missing.push('confirm-source-sha');
    if (c.maintenanceWindow !== 'CERTIFICATE_ISSUANCE_CLOSED') missing.push('confirm-maintenance-window');
    if (!c.iUnderstandProductionWrite) missing.push('confirm-i-understand-production-write');
    if (args.dbMode === 'none') missing.push('--db-mode(local|remote)');
    if (missing.length) {
      logger.error('CONFIRMATION_GUARD', ...missing);
      return { ok: false, exitCode: 5, stage: 'confirmation', failures: missing };
    }
    if (!pre.ok) {
      logger.error('PRECONDITION_GUARD', ...pre.failures);
      return { ok: false, exitCode: 6, stage: 'precondition', failures: pre.failures };
    }
    const db = await createDbAdapter({
      dbMode: args.dbMode,
      localDbPath: args.localDbPath,
      accountId: target.accountId,
      dbUuid: target.dbUuid,
      dbName: target.dbName,
    });
    const executor = executorOverride ?? (await createImporterExecutor({ logger }));
    const stats = await withRetry(
      () => executor(loaded.rows, {
        db,
        batchSize: args.batchSize ?? 5000,
        afterLegacyId: -1,
        provenMappings: new Map(),
        logger,
      }),
      { logger },
    );
    logger.info(`EXECUTE_OK inserted=${stats.inserted} alreadyPresent=${stats.alreadyPresent} conflicts=${stats.conflicts} batches=${stats.batches}`);
    return { ok: true, exitCode: 0, mode: 'execute', writes: true, stats, precondition: pre };
  }

  logger.error('UNKNOWN_MODE', args.mode);
  return { ok: false, exitCode: 7, stage: 'mode', failures: ['UNKNOWN_MODE'] };
}

// 仅在直接运行（node scripts/...mjs）时进入 CLI
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const logger = createSafeLogger();
  const r = await runCli(process.argv.slice(2), { logger });
  process.exitCode = r.exitCode;
}

