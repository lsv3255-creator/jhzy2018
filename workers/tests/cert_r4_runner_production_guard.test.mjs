#!/usr/bin/env node
/**
 * CERT-R4-RUNNER —— 受保护生产导入 Runner 守卫测试（16 项）。
 *
 * 设计：纯 mock/fake，不依赖生产网络、不触碰 D1。
 * 通过注入 fake executor / fake readProdState / capture SafeLogger 验证：
 *   - 目标/源/前置条件/确认 四类 fail-closed 守卫
 *   - plan / dry-run 不写
 *   - execute 仅在全部确认 + 前置就绪后才调用底层 importer
 *   - retry/backoff 对 transient 重试、对 deterministic 不重试
 *   - 日志绝不输出 raw code / PII
 *
 * 运行：node tests/cert_r4_runner_production_guard.test.mjs
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  GUARDS,
  validateTarget,
  validateSource,
  validatePreconditions,
  withRetry,
  TransientError,
  createSafeLogger,
  runLegacyPoolImportRunner,
} from '../scripts/cert-r5-protected-legacy-pool-import-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// ---- 有效目标 / 源（用于"应通过"用例）----
const GOOD_TARGET = {
  accountId: GUARDS.EXPECTED_ACCOUNT_ID,
  dbName: GUARDS.PROD_D1_NAME,
  dbUuid: GUARDS.PROD_D1_UUID,
};
const GOOD_SOURCE = {
  sha256: GUARDS.EXPECTED_SOURCE_SHA256,
  rows: GUARDS.EXPECTED_SOURCE_ROWS,
  poolCounts: { ...GUARDS.EXPECTED_POOL_TOTALS },
  statusCounts: { ...GUARDS.EXPECTED_STATUS_TOTALS },
  assignedTo: { ...GUARDS.EXPECTED_ASSIGNED_TO },
};
// 前置就绪的生产状态（0045/0046 已应用）
const READY_PROD = {
  migration0045Count: 1,
  migration0046Count: 1,
  hasProvenanceColumn: true,
  syntheticCompatCount: 500,
  legacyMigratedCount: 0,
  nullProvenanceCount: 0,
  duplicateCodeGroups: 0,
};
// 前置未就绪（0045/0046 缺失）
const NOTREADY_PROD = {
  migration0045Count: 0,
  migration0046Count: 0,
  hasProvenanceColumn: false,
  syntheticCompatCount: 500,
  legacyMigratedCount: 0,
  nullProvenanceCount: 0,
  duplicateCodeGroups: 0,
};

const FULL_CONFIRM = {
  productionD1: GUARDS.PROD_D1_UUID,
  account: GUARDS.EXPECTED_ACCOUNT_ID,
  sourceSha: GUARDS.EXPECTED_SOURCE_SHA256,
  maintenanceWindow: 'CERTIFICATE_ISSUANCE_CLOSED',
  iUnderstandProductionWrite: true,
};

// =============================================================================
// 1. 缺 account ID
// =============================================================================
{
  const r = validateTarget({ accountId: undefined, dbName: GOOD_TARGET.dbName, dbUuid: GOOD_TARGET.dbUuid });
  check('1. 缺 account ID → fail', !r.ok && r.failures.includes('ACCOUNT_ID_MISSING'), JSON.stringify(r.failures));
}

// =============================================================================
// 2. 错误 account ID
// =============================================================================
{
  const r = validateTarget({ accountId: '000000000000000000000000000000000000', dbName: GOOD_TARGET.dbName, dbUuid: GOOD_TARGET.dbUuid });
  check('2. 错误 account ID → fail', !r.ok && r.failures.includes('ACCOUNT_ID_MISMATCH'), JSON.stringify(r.failures));
}

// =============================================================================
// 3. 错误 DB UUID
// =============================================================================
{
  const r = validateTarget({ accountId: GOOD_TARGET.accountId, dbName: GOOD_TARGET.dbName, dbUuid: '11111111-1111-1111-1111-111111111111' });
  check('3. 错误 DB UUID → fail', !r.ok && r.failures.includes('DB_UUID_MISMATCH'), JSON.stringify(r.failures));
}

// =============================================================================
// 4. 预发 DB UUID
// =============================================================================
{
  const r = validateTarget({ accountId: GOOD_TARGET.accountId, dbName: GOOD_TARGET.dbName, dbUuid: GUARDS.STAGING_D1_UUID });
  check('4. 预发 DB UUID → fail', !r.ok && r.failures.includes('DB_UUID_IS_STAGING'), JSON.stringify(r.failures));
}

// =============================================================================
// 5. 禁止的默认 DB UUID
// =============================================================================
{
  const r = validateTarget({ accountId: GOOD_TARGET.accountId, dbName: GOOD_TARGET.dbName, dbUuid: GUARDS.FORBIDDEN_DEFAULT_D1_UUID });
  check('5. 禁止默认 DB UUID → fail', !r.ok && r.failures.includes('DB_UUID_IS_FORBIDDEN_DEFAULT'), JSON.stringify(r.failures));
  // 同时验证名字也会被拦
  const r2 = validateTarget({ accountId: GOOD_TARGET.accountId, dbName: GUARDS.FORBIDDEN_DEFAULT_D1_NAME, dbUuid: GOOD_TARGET.dbUuid });
  check('5b. 禁止默认 DB NAME → fail', !r2.ok && r2.failures.includes('DB_NAME_IS_FORBIDDEN_DEFAULT'), JSON.stringify(r2.failures));
}

// =============================================================================
// 6. 源 SHA 不匹配
// =============================================================================
{
  const bad = { ...GOOD_SOURCE, sha256: 'deadbeef'.repeat(8) };
  const r = validateSource(bad);
  check('6. 源 SHA 不匹配 → fail', !r.ok && r.failures.includes('SOURCE_SHA_MISMATCH'), JSON.stringify(r.failures));
}

// =============================================================================
// 7. 源行数不匹配
// =============================================================================
{
  const bad = { ...GOOD_SOURCE, rows: 449999 };
  const r = validateSource(bad);
  check('7. 源行数不匹配 → fail', !r.ok && r.failures.includes('SOURCE_ROW_COUNT_MISMATCH'), JSON.stringify(r.failures));
  // 状态计数不匹配也应被拦
  const bad2 = { ...GOOD_SOURCE, statusCounts: { ...GOOD_SOURCE.statusCounts, reserved: 26 } };
  const r2 = validateSource(bad2);
  check('7b. 源 status 计数不匹配 → fail', !r2.ok && r2.failures.some((f) => f.includes('SOURCE_STATUS_reserved')), JSON.stringify(r2.failures));
}

// =============================================================================
// 8. execute 缺确认 → 写前 fail
// =============================================================================
{
  const calls = [];
  const fakeExec = async (rows, opts) => { calls.push(1); return { inserted: 0, alreadyPresent: 0, conflicts: 0, batches: 0, lastLegacyId: -1 }; };
  const r = await runLegacyPoolImportRunner({
    mode: 'execute',
    target: GOOD_TARGET,
    source: GOOD_SOURCE,
    readProdState: async () => READY_PROD,
    executor: fakeExec,
    rows: [],
    confirmations: {}, // 全部缺失
  });
  check('8. execute 缺确认 → ok=false', !r.ok, JSON.stringify(r));
  check('8b. execute 缺确认 → 底层 importer 未被调用', calls.length === 0, `calls=${calls.length}`);
  check('8c. execute 缺确认 → writes=false', r.writes === false);
}

// =============================================================================
// 9. plan 模式不写
// =============================================================================
{
  const calls = [];
  const fakeExec = async (rows, opts) => { calls.push(1); return { inserted: 0, alreadyPresent: 0, conflicts: 0, batches: 0, lastLegacyId: -1 }; };
  const r = await runLegacyPoolImportRunner({
    mode: 'plan',
    target: GOOD_TARGET,
    source: GOOD_SOURCE,
    readProdState: async () => READY_PROD,
    executor: fakeExec,
    rows: [],
  });
  check('9. plan 模式 → ok=true', r.ok === true, JSON.stringify(r));
  check('9b. plan 模式 → 底层 importer 未被调用', calls.length === 0, `calls=${calls.length}`);
  check('9c. plan 模式 → writes=false', r.writes === false);
}

// =============================================================================
// 10. dry-run 模式不写
// =============================================================================
{
  const calls = [];
  const fakeExec = async (rows, opts) => { calls.push(1); return { inserted: 0, alreadyPresent: 0, conflicts: 0, batches: 0, lastLegacyId: -1 }; };
  const r = await runLegacyPoolImportRunner({
    mode: 'dry-run',
    target: GOOD_TARGET,
    source: GOOD_SOURCE,
    readProdState: async () => READY_PROD,
    executor: fakeExec,
    rows: [],
  });
  check('10. dry-run 模式 → ok=true', r.ok === true, JSON.stringify(r));
  check('10b. dry-run 模式 → 底层 importer 未被调用', calls.length === 0, `calls=${calls.length}`);
  check('10c. dry-run 模式 → writes=false', r.writes === false);
}

// =============================================================================
// 11. transient 错误触发重试
// =============================================================================
{
  let n = 0;
  let retries = 0;
  const cap = [];
  const logger = createSafeLogger((s) => { cap.push(s); if (/\[retry /.test(s)) retries++; });
  const fakeExec = async () => {
    n++;
    if (n < 3) throw new TransientError('d1 api timeout');
    return { inserted: 10, alreadyPresent: 0, conflicts: 0, batches: 1, lastLegacyId: 99 };
  };
  const r = await runLegacyPoolImportRunner({
    mode: 'execute',
    target: GOOD_TARGET,
    source: GOOD_SOURCE,
    readProdState: async () => READY_PROD,
    executor: fakeExec,
    rows: [{ id: 1, code: 'X', poolType: 'cert_trn', status: 'available', assignedTo: null }],
    confirmations: FULL_CONFIRM,
    logger,
  });
  check('11. transient 错误被重试后成功', r.ok === true && r.stats.inserted === 10, JSON.stringify(r));
  check('11b. executor 被调用 3 次（2 次失败后成功）', n === 3, `n=${n}`);
  check('11c. 重试日志被记录（无 raw code）', retries >= 2, `retries=${retries}`);
}

// =============================================================================
// 12. deterministic 冲突不重试
// =============================================================================
{
  let n = 0;
  const fakeExec = async () => { n++; throw new Error('DETERMINISTIC_CONFLICT_FAIL_CLOSED'); };
  const r = await runLegacyPoolImportRunner({
    mode: 'execute',
    target: GOOD_TARGET,
    source: GOOD_SOURCE,
    readProdState: async () => READY_PROD,
    executor: fakeExec,
    rows: [{ id: 1, code: 'Y', poolType: 'cert_trn', status: 'available', assignedTo: null }],
    confirmations: FULL_CONFIRM,
  });
  check('12. deterministic 冲突 → ok=false', r.ok === false, JSON.stringify(r));
  check('12b. deterministic 冲突 → 仅调用 1 次（不重试）', n === 1, `n=${n}`);
}

// =============================================================================
// 13. raw code 不出现在日志
// =============================================================================
{
  const cap = [];
  const logger = createSafeLogger((s) => cap.push(s));
  // 直接验证 redact
  const red = logger._redact('conflict on JHCRT-TEST-SYNTHETIC-9Z8Y7X pool JHCRT-* phone 13800138000 idcard 11010119900307123X');
  check('13. redact 抹除合成 cert_no', !/JHCRT-TEST-SYNTHETIC-9Z8Y7X/.test(red), red);
  check('13b. redact 抹除手机号', !/13800138000/.test(red), red);
  check('13c. redact 抹除身份证', !/11010119900307123X/.test(red), red);

  // 端到端：底层 executor 抛含 raw code 的错误，日志应被脱敏
  const cap2 = [];
  const logger2 = createSafeLogger((s) => cap2.push(s));
  const fakeExec = async () => { throw new Error('boom at code JHCRT-TRN-ABCDEFGH-12345'); };
  const r = await runLegacyPoolImportRunner({
    mode: 'execute',
    target: GOOD_TARGET,
    source: GOOD_SOURCE,
    readProdState: async () => READY_PROD,
    executor: fakeExec,
    rows: [{ id: 1, code: 'Z', poolType: 'cert_trn', status: 'available', assignedTo: null }],
    confirmations: FULL_CONFIRM,
    logger: logger2,
  });
  const joined = cap2.join(' ');
  check('13d. 执行日志不含 raw cert_no', !/JHCRT-TRN-ABCDEFGH-12345/.test(joined), joined.slice(0, 200));
}

// =============================================================================
// 14. PII 类值不出现在日志
// =============================================================================
{
  const cap = [];
  const logger = createSafeLogger((s) => cap.push(s));
  const red = logger._redact('user openid=oABC1234567890 phone=13912345678 real_name=张三 session_token=abc.def.ghi');
  check('14. redact 抹除 openid', !/oABC1234567890/.test(red), red);
  check('14b. redact 抹除 real_name', !/张三/.test(red), red);
  check('14c. redact 抹除 session_token', !/abc\.def\.ghi/.test(red), red);
}

// =============================================================================
// 15. 守卫通过后（仅 execute+就绪）才调用底层 importer
// =============================================================================
{
  const calls = [];
  const fakeExec = async (rows, opts) => { calls.push(1); return { inserted: 1, alreadyPresent: 0, conflicts: 0, batches: 1, lastLegacyId: 1 }; };

  // (a) 目标错误 → 不调用
  await runLegacyPoolImportRunner({
    mode: 'execute', target: { ...GOOD_TARGET, dbUuid: 'bad' }, source: GOOD_SOURCE,
    readProdState: async () => READY_PROD, executor: fakeExec, rows: [], confirmations: FULL_CONFIRM,
  });
  // (b) 源错误 → 不调用
  await runLegacyPoolImportRunner({
    mode: 'execute', target: GOOD_TARGET, source: { ...GOOD_SOURCE, sha256: 'x' },
    readProdState: async () => READY_PROD, executor: fakeExec, rows: [], confirmations: FULL_CONFIRM,
  });
  // (c) plan 模式（即便目标/源正确）→ 不调用
  await runLegacyPoolImportRunner({
    mode: 'plan', target: GOOD_TARGET, source: GOOD_SOURCE,
    readProdState: async () => READY_PROD, executor: fakeExec, rows: [],
  });
  // (d) execute + 确认 + 就绪 → 调用 1 次
  await runLegacyPoolImportRunner({
    mode: 'execute', target: GOOD_TARGET, source: GOOD_SOURCE,
    readProdState: async () => READY_PROD, executor: fakeExec,
    rows: [{ id: 1, code: 'A', poolType: 'cert_trn', status: 'available', assignedTo: null }],
    confirmations: FULL_CONFIRM,
  });
  check('15. 仅 execute+确认+就绪 时调用底层 importer（共 1 次）', calls.length === 1, `calls=${calls.length}`);
}

// =============================================================================
// 16. 前置条件报告 NOT_READY（0045/0046 缺失）
// =============================================================================
{
  const pre = validatePreconditions(NOTREADY_PROD);
  check('16. 前置条件 0045/0046 缺失 → ready=false', pre.ready === false, JSON.stringify(pre));
  check('16b. 前置条件缺失 → 原因含 NOT_READY_FOR_IMPORT_BECAUSE_0045_0046_ABSENT',
    pre.reason === 'NOT_READY_FOR_IMPORT_BECAUSE_0045_0046_ABSENT', pre.reason);

  // 在 plan 模式报告而非失败
  const rPlan = await runLegacyPoolImportRunner({
    mode: 'plan', target: GOOD_TARGET, source: GOOD_SOURCE,
    readProdState: async () => NOTREADY_PROD, executor: async () => ({}), rows: [],
  });
  check('16c. plan 模式报告 NOT_READY（ok=true, 不写）', rPlan.ok === true && rPlan.precondition.reason === 'NOT_READY_FOR_IMPORT_BECAUSE_0045_0046_ABSENT' && rPlan.writes === false, JSON.stringify(rPlan));

  // 在 execute 模式（即便确认）→ 前置 fail-closed
  const rExec = await runLegacyPoolImportRunner({
    mode: 'execute', target: GOOD_TARGET, source: GOOD_SOURCE,
    readProdState: async () => NOTREADY_PROD, executor: async () => ({}), rows: [],
    confirmations: FULL_CONFIRM,
  });
  check('16d. execute 模式前置缺失 → ok=false（仍不写）', rExec.ok === false && rExec.writes === false, JSON.stringify(rExec));
}

process.stderr.write(`\nCERT-R4 RUNNER GUARD TESTS: ${pass} pass, ${fail} fail\n`);
if (fail > 0) process.stderr.write(`FAILED: ${failures.join(' | ')}\n`);
process.exitCode = fail === 0 ? 0 : 1;
