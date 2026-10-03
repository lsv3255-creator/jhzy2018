#!/usr/bin/env node
/**
 * CERT-R5A —— 本地全量导入模拟（LOCAL ONLY，绝不触达生产）。
 *
 * 目的：在零网络、零生产副作用的前提下，验证「真实 wiring」端到端可用：
 *   离线归档 → parse 450,000 行 → 真实 importLegacyPools → 本地 SQLite。
 *
 * 与生产的差异（明确声明）：
 *   - 目标为本地 SQLite（node:sqlite），不是 jhzy-v2-prod。
 *   - 预置 500 条 v2_synthetic_compat 合成行，镜像生产 0046 后的初始状态。
 *   - 不经过 --read-prod-state 生产前置闸门（本地无生产态），
 *     但【复用】与生产完全相同的 source 解析、守卫常量与 importer 实现。
 *
 * 运行：node --experimental-sqlite scripts/cert-r5a-local-import-simulation.mjs
 */
import { loadLegacySource, formatStats } from './legacy-pool-source-parser.mjs';
import { createLocalSqliteD1, ID_POOLS_SCHEMA } from './d1-executor-adapters.mjs';
import { compileImporter } from './cert-r5-protected-legacy-pool-import-runner.mjs';
import { GUARDS } from './cert-r5-protected-legacy-pool-import-runner.mjs';

const ARCHIVE = GUARDS.SOURCE_ARCHIVE;
const WORK_DIR = process.env.R5A_WORK_DIR ?? '/tmp/cert-r5a-sim';

const t0 = Date.now();
process.stderr.write('[sim] loading offline source...\n');
const loaded = loadLegacySource({
  archivePath: ARCHIVE,
  workDir: WORK_DIR,
  expectedSha256: GUARDS.EXPECTED_SOURCE_SHA256,
});
process.stderr.write(`[sim] parsed: ${formatStats(loaded.stats)}\n`);
process.stderr.write(`[sim] parse_ms=${Date.now() - t0}\n`);

// ---- 本地库：镜像生产 0046 后的初始态（500 条合成兼容库存）----
const db = createLocalSqliteD1({ path: ':memory:', schema: ID_POOLS_SCHEMA });
const seed = db.prepare(
  `INSERT INTO id_pools (pool_type, code, status, assigned_to, assigned_at, batch_id, provenance, created_at)
   VALUES ('cert_trn', ?, 0, NULL, NULL, NULL, 'v2_synthetic_compat', 0)`,
);
// 使用显式「本地模拟」前缀，避免生成与生产同形的 CTRN%06d 码（不产生 raw pool code）。
// 语义目的不变：预置 500 条 v2_synthetic_compat 行，验证导入不会消费/改写它们。
for (let i = 1; i <= 500; i++) {
  await seed.bind(`LOCALSIM-SYNTH-${String(i).padStart(6, '0')}`).run();
}
process.stderr.write('[sim] seeded 500 synthetic v2_synthetic_compat rows\n');

// ---- 真实 importer（esbuild 编译产物），非镜像实现 ----
const mod = await compileImporter();
process.stderr.write('[sim] executing importLegacyPools (local sqlite)...\n');
const t1 = Date.now();
const stats = await mod.importLegacyPools(loaded.rows, {
  db,
  batchSize: 5000,
  afterLegacyId: -1,
  provenMappings: new Map(),
});
const importMs = Date.now() - t1;

// ---- 校验 ----
function q1(sql) {
  return db.prepare(sql).bind().first();
}
const total = await q1('SELECT COUNT(*) AS n FROM id_pools');
const legacy = await q1("SELECT COUNT(*) AS n FROM id_pools WHERE provenance='legacy_migrated'");
const synth = await q1("SELECT COUNT(*) AS n FROM id_pools WHERE provenance='v2_synthetic_compat'");
const nullProv = await q1('SELECT COUNT(*) AS n FROM id_pools WHERE provenance IS NULL');
const dup = await q1('SELECT COUNT(*) AS n FROM (SELECT code FROM id_pools GROUP BY code HAVING COUNT(*)>1)');
const guessed = await q1("SELECT COUNT(*) AS n FROM id_pools WHERE provenance='legacy_migrated' AND assigned_to IS NOT NULL");
const pool = await db.prepare('SELECT pool_type, COUNT(*) AS n FROM id_pools GROUP BY pool_type').bind().all();
const st = await db.prepare('SELECT status, COUNT(*) AS n FROM id_pools GROUP BY status').bind().all();

const out = {
  LOCAL_FULL_IMPORT_EXECUTED: 'YES',
  parse_ms: Date.now() - t0,
  import_ms: importMs,
  source_rows: loaded.stats.rows,
  inserted: stats.inserted,
  alreadyPresent: stats.alreadyPresent,
  conflicts: stats.conflicts,
  batches: stats.batches,
  id_pools_total: total?.n,
  legacy_migrated: legacy?.n,
  synthetic_compat: synth?.n,
  null_provenance: nullProv?.n,
  duplicate_code_groups: dup?.n,
  guessed_assigned_to_mappings: guessed?.n,
  pool_totals: Object.fromEntries((pool?.results ?? []).map((r) => [r.pool_type, r.n])),
  status_totals: Object.fromEntries((st?.results ?? []).map((r) => [String(r.status), r.n])),
};
process.stderr.write('[sim] RESULT ' + JSON.stringify(out, null, 2) + '\n');
process.exitCode =
  out.id_pools_total === 450500 &&
  out.legacy_migrated === 450000 &&
  out.synthetic_compat === 500 &&
  out.null_provenance === 0 &&
  out.duplicate_code_groups === 0 &&
  out.guessed_assigned_to_mappings === 0 &&
  out.conflicts === 0
    ? 0
    : 1;
process.stderr.write(`[sim] EXIT=${process.exitCode}\n`);
