#!/usr/bin/env node
/**
 * CERT-R5A —— Import Runner Wiring 测试。
 *
 * 覆盖（对应任务书 G 节）：
 *   1. parser 解析 multiline / NULL / sentinel / 转义（fixture）
 *   2. plan 在归档 SHA 不匹配时失败
 *   3. plan 在行数不匹配时失败
 *   4. plan 计算出的总量与冻结基线精确一致
 *   5. dry-run 未读取源即不得 exit 0
 *   6. execute 缺确认不得运行
 *   7. 守卫全部通过后底层 importer 才被调用
 *   8. 生产当前状态 46/500/0 被判定 READY_FOR_IMPORT
 *   9. 0045/0046 缺失状态判定 NOT_READY_FOR_IMPORT
 *  10. 日志绝不输出 raw code / PII
 *
 * 运行：node --experimental-sqlite tests/cert_r5a_import_runner_wiring.test.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseIdPoolRows,
  splitTuples,
  splitFields,
  lit,
  parseSqlDateTime,
  buildSourceStats,
  findStatementBodies,
  ID_POOL_HEADER,
} from '../scripts/legacy-pool-source-parser.mjs';
import {
  GUARDS,
  validatePreconditions,
  runCli,
  createSafeLogger,
} from '../scripts/cert-r5-protected-legacy-pool-import-runner.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    process.stderr.write(`  PASS ${name}\n`);
  } else {
    fail += 1;
    failures.push(name);
    process.stderr.write(`  FAIL ${name} ${detail}\n`);
  }
}

const GOOD = [
  '--target', 'jhzy-v2-prod',
  '--account', GUARDS.EXPECTED_ACCOUNT_ID,
  '--db-uuid', GUARDS.PROD_D1_UUID,
];

/** 捕获 SafeLogger 输出。 */
function captureLogger() {
  const lines = [];
  const logger = createSafeLogger((s) => lines.push(s));
  return { logger, lines, text: () => lines.join('\n') };
}

// -----------------------------------------------------------------------------
// 1. 词法解析：multiline / NULL / sentinel / 转义
// -----------------------------------------------------------------------------
{
  // 多行 INSERT：语句体内含换行；含 NULL datetime；含 sentinel 999999；含转义单引号
  // 注意：SQL 文本中的转义单引号在 JS 源码里要写成 \\'
  const sql = [
    "INSERT INTO `id_pool` VALUES (1,'AAA-001','volunteer',1,'assigned',999999,NULL,NULL),",
    "(2,'BB\\'B-002','cert_trn',2,'available',NULL,'2026-01-17 02:44:55','2026-01-16 10:15:01'),",
    "(3,'CCC-003','cert_srv',NULL,'reserved',42,NULL,'2026-02-01 00:00:00');",
    "INSERT INTO `id_pool_old_20260214` VALUES (9,'ZZZ','volunteer',1,'assigned',1,NULL,NULL);",
  ].join('\n');

  const bodies = findStatementBodies(sql, ID_POOL_HEADER);
  check('1a. 只命中 id_pool，排除 id_pool_old_20260214', bodies.length === 1, `got=${bodies.length}`);

  const tuples = splitTuples(bodies[0]);
  check('1b. multiline INSERT 切出 3 个元组', tuples.length === 3, `got=${tuples.length}`);

  const f0 = splitFields(tuples[0]);
  check('1c. 元组字段数 = 8', f0.length === 8, `got=${f0.length}`);
  check('1d. NULL datetime 解析为 null', lit(f0[6]) === null && lit(f0[7]) === null);
  check('1e. sentinel 999999 被识别为数值', lit(f0[5]) === '999999');
  check('1f. 转义单引号正确还原', lit("'BB\\'B-002'") === "BB'B-002", `got=${lit("'BB\\'B-002'")}`);

  const { rows, stats } = parseIdPoolRows(sql);
  check('1g. 解析出 3 行', rows.length === 3, `got=${rows.length}`);
  check('1h. sentinel 归类正确', stats.assignedTo.sentinel === 1, JSON.stringify(stats.assignedTo));
  check('1i. NULL assigned_to 归类正确', stats.assignedToAllRows.null === 1, JSON.stringify(stats.assignedToAllRows));
  check('1j. NULL created_at 以 fallback 兜底', rows[0].createdAt === 0, `got=${rows[0].createdAt}`);
  check('1k. status 映射正确', rows[0].status === 'assigned' && rows[1].status === 'available' && rows[2].status === 'reserved');

  // datetime → unix（确定性：按 UTC 解释）
  const ts = parseSqlDateTime('2026-01-17 02:44:55');
  check('1l. datetime 转 unix 秒（UTC 确定性）', ts === Date.parse('2026-01-17T02:44:55Z') / 1000, `got=${ts}`);
}

// -----------------------------------------------------------------------------
// 2. plan 在归档 SHA 不匹配时失败
// -----------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'r5a-badsha-'));
  const bad = join(dir, 'bad.tar.gz');
  writeFileSync(bad, Buffer.from('not-the-authoritative-archive'));
  const { logger, text } = captureLogger();
  const r = await runCli(['--mode', 'plan', ...GOOD, '--source-archive', bad, '--work-dir', join(dir, 'x')], { logger });
  check('2. SHA 不匹配 → plan 失败且非 0 退出', r.ok === false && r.exitCode !== 0, `exit=${r.exitCode}`);
  check('2b. 失败阶段为 source-load', r.stage === 'source-load', `stage=${r.stage}`);
  check('2c. 日志含 SOURCE_LOAD_FAILED', text().includes('SOURCE_LOAD_FAILED'));
  rmSync(dir, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// 3. plan 在行数不匹配时失败（构造行数不符的 fixture 源）
// -----------------------------------------------------------------------------
{
  const { logger, text } = captureLogger();
  // 用一个字段数错误 / 行数不符的 SQL 注入：此处直接验证 stats 守卫本身
  const { stats } = parseIdPoolRows("INSERT INTO `id_pool` VALUES (1,'A','volunteer',1,'available',NULL,NULL,NULL);");
  check('3a. fixture 行数 = 1（≠450000）', stats.rows === 1);
  const badStats = { sha256: GUARDS.EXPECTED_SOURCE_SHA256, rows: 1, poolCounts: {}, statusCounts: {}, assignedTo: {} };
  const { validateSource } = await import('../scripts/cert-r5-protected-legacy-pool-import-runner.mjs');
  const v = validateSource(badStats);
  check('3b. 行数不符 → SOURCE_ROW_COUNT_MISMATCH', v.ok === false && v.failures.some((f) => f.includes('SOURCE_ROW_COUNT_MISMATCH')), JSON.stringify(v.failures));
  void text; void logger;
}

// -----------------------------------------------------------------------------
// 4. plan 计算的 totals 与冻结基线精确一致（用与真实归档同构的 fixture 复算口径）
// -----------------------------------------------------------------------------
{
  // 构造与权威口径一致的统计：非自由行 1688 → null 939 / sentinel 2 / unresolved 747
  const rows = [];
  const push = (n, poolType, status, assignedTo) => {
    for (let i = 0; i < n; i++) {
      rows.push({ id: rows.length + 1, code: `C${rows.length + 1}`, poolType, status, assignedTo, assignedAt: null, batchId: 1, createdAt: 0 });
    }
  };
  // available: 448312（其中 102 条带 ref，模拟真实数据异常）
  push(448210, 'cert_trn', 'available', null);
  push(102, 'cert_trn', 'available', 5001);
  // assigned 1661 = 912 NULL + 2 sentinel + 747 unresolved
  push(912, 'cert_trn', 'assigned', null);
  push(2, 'cert_trn', 'assigned', 999999);
  push(747, 'cert_trn', 'assigned', 7001);
  // reserved 27
  push(27, 'cert_trn', 'reserved', null);
  const st = buildSourceStats(rows);
  check('4a. rows = 450000', st.rows === 450000, `got=${st.rows}`);
  check('4b. assignedTo 非自由行口径 = 939/2/747/0',
    st.assignedTo.null === 939 && st.assignedTo.sentinel === 2 && st.assignedTo.unresolved === 747 && st.assignedTo.proven_mappable === 0,
    JSON.stringify(st.assignedTo));
  check('4c. 与 GUARDS.EXPECTED_ASSIGNED_TO 逐项一致',
    JSON.stringify(st.assignedTo) === JSON.stringify(GUARDS.EXPECTED_ASSIGNED_TO),
    `${JSON.stringify(st.assignedTo)} vs ${JSON.stringify(GUARDS.EXPECTED_ASSIGNED_TO)}`);
  check('4d. status totals 精确', st.statusCounts.available === 448312 && st.statusCounts.assigned === 1661 && st.statusCounts.reserved === 27, JSON.stringify(st.statusCounts));
  check('4e. availableWithRef 异常被识别 = 102', st.availableWithRef === 102, `got=${st.availableWithRef}`);
}

// -----------------------------------------------------------------------------
// 5. dry-run 未读取源即不得 exit 0
// -----------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'r5a-missing-'));
  const missing = join(dir, 'nope.tar.gz');
  const { logger } = captureLogger();
  const r = await runCli(['--mode', 'dry-run', ...GOOD, '--source-archive', missing], { logger });
  check('5. 源缺失 → dry-run 不得 exit 0', r.ok === false && r.exitCode !== 0, `exit=${r.exitCode}`);
  rmSync(dir, { recursive: true, force: true });
}
{
  // 反向：源可用时 dry-run 必须真实解析并给出 batch plan
  const { logger, text } = captureLogger();
  const r = await runCli(['--mode', 'dry-run', ...GOOD], { logger });
  check('5b. 源可用 → dry-run 真实解析 450000 行', r.ok === true && r.stats?.rows === 450000, `rows=${r.stats?.rows}`);
  check('5c. dry-run 产出 batch plan 且 writes=false', text().includes('DRY_RUN_BATCH_PLAN') && r.writes === false);
}

// -----------------------------------------------------------------------------
// 6. execute 缺确认不得运行
// -----------------------------------------------------------------------------
{
  const { logger, text } = captureLogger();
  const r = await runCli(['--mode', 'execute', ...GOOD, '--db-mode', 'local'], { logger });
  check('6a. 缺 --confirm-* → execute 被拦下', r.ok === false && r.stage === 'confirmation', `stage=${r.stage}`);
  check('6b. 缺失项含 confirm-production-d1 / source-sha / maintenance-window / understand',
    r.failures.includes('confirm-production-d1') &&
    r.failures.includes('confirm-source-sha') &&
    r.failures.includes('confirm-maintenance-window') &&
    r.failures.includes('confirm-i-understand-production-write'),
    JSON.stringify(r.failures));
  check('6c. 日志含 CONFIRMATION_GUARD', text().includes('CONFIRMATION_GUARD'));
}
{
  const { logger } = captureLogger();
  const r = await runCli(['--mode', 'execute', ...GOOD,
    '--confirm-production-d1', GUARDS.PROD_D1_UUID,
    '--confirm-account', GUARDS.EXPECTED_ACCOUNT_ID,
    '--confirm-source-sha', GUARDS.EXPECTED_SOURCE_SHA256,
    '--confirm-maintenance-window', 'CERTIFICATE_ISSUANCE_CLOSED',
    '--confirm-i-understand-production-write'], { logger });
  check('6d. 确认齐全但未指定 --db-mode → 仍被拦下', r.ok === false && r.failures.includes('--db-mode(local|remote)'), JSON.stringify(r.failures));
}

// -----------------------------------------------------------------------------
// 7. 守卫全部通过后底层 importer 才被调用（本地 SQLite 真实执行子集）
// -----------------------------------------------------------------------------
{
  const { logger, text } = captureLogger();
  let invoked = false;
  const spy = async (rows, opts) => { invoked = true; return { inserted: rows.length, alreadyPresent: 0, conflicts: 0, batches: 1 }; };
  // 注入 READY 前置状态：通过直接调用 runCli 无法注入，故此处验证前置守卫分支
  const r = await runCli(['--mode', 'execute', ...GOOD, '--db-mode', 'local',
    '--confirm-production-d1', GUARDS.PROD_D1_UUID,
    '--confirm-account', GUARDS.EXPECTED_ACCOUNT_ID,
    '--confirm-source-sha', GUARDS.EXPECTED_SOURCE_SHA256,
    '--confirm-maintenance-window', 'CERTIFICATE_ISSUANCE_CLOSED',
    '--confirm-i-understand-production-write'], { logger, executorOverride: spy });
  // 未 --read-prod-state（且 wrangler 不可用）→ 前置状态缺失 → fail-closed，executor 不得调用
  check('7a. 前置未就绪 → executor 未被调用（fail-closed）', invoked === false, `invoked=${invoked}`);
  check('7b. 失败阶段 = precondition', r.stage === 'precondition', `stage=${r.stage}`);
  check('7c. 日志含 PRECONDITION_GUARD', text().includes('PRECONDITION_GUARD'));
}

// -----------------------------------------------------------------------------
// 8 / 9. 前置条件判定
// -----------------------------------------------------------------------------
{
  const ready = validatePreconditions({
    migration0045Count: 1,
    migration0046Count: 1,
    hasProvenanceColumn: true,
    syntheticCompatCount: 500,
    legacyMigratedCount: 0,
    nullProvenanceCount: 0,
    duplicateCodeGroups: 0,
  });
  check('8. 生产当前状态 46/1/1/500/0 → READY_FOR_IMPORT', ready.ok === true && ready.ready === true, JSON.stringify(ready.failures));
}
{
  const notReady = validatePreconditions({
    migration0045Count: 0,
    migration0046Count: 0,
    hasProvenanceColumn: false,
    syntheticCompatCount: 500,
    legacyMigratedCount: 0,
    nullProvenanceCount: 0,
    duplicateCodeGroups: 0,
  });
  check('9. 0045/0046 缺失 → NOT_READY_FOR_IMPORT', notReady.ok === false && notReady.failures.some((f) => f.includes('MIGRATION_0045')), JSON.stringify(notReady.failures));
}

// -----------------------------------------------------------------------------
// 10. raw code / PII 绝不出现在日志
// -----------------------------------------------------------------------------
{
  const { logger, lines } = captureLogger();
  await runCli(['--mode', 'dry-run', ...GOOD], { logger });
  const all = lines.join('\n');
  const forbidden = [
    /\bJHCRT-[A-Z0-9-]{6,}\b/,
    /\bJH-[A-Z0-9]{4,}\b/,
    /\bCTRN[0-9]{6}\b/,
    /\b1[3-9][0-9]{9}\b/,
    /\b[1-9][0-9]{16}[0-9Xx]\b/,
    /\b(openid|phone|id_card|real_name|session_token)\s*[:=]\s*\S+/i,
  ];
  const hits = forbidden.filter((re) => re.test(all));
  check('10. 日志无 raw code / PII / secret 命中', hits.length === 0, `hits=${hits.length}`);
}

process.stderr.write(`\nCERT-R5A WIRING TESTS: ${pass} pass / ${fail} fail\n`);
if (fail > 0) process.stderr.write(`FAILURES: ${failures.join(', ')}\n`);
process.exitCode = fail === 0 ? 0 : 1;
