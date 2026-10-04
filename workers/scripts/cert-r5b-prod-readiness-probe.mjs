#!/usr/bin/env node
/**
 * CERT-R5B —— Production Readiness Probe（**只读**，零写入）
 *
 * 用途：在 R5B 生产导入前，用双锁 wrangler 证明「runner 执行环境可用」，
 * 并复核当前生产状态是否满足导入前置（READY_FOR_IMPORT）。
 *
 * 认证二选一（二者任一即可）：
 *   A. 在 **TTY**（真实终端）中运行：复用 `wrangler --profile jhzy` 登录态
 *      cd workers && node scripts/cert-r5b-prod-readiness-probe.mjs --profile jhzy
 *   B. 提供 API token：
 *      export CLOUDFLARE_API_TOKEN=<token>
 *      cd workers && CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af \
 *        node scripts/cert-r5b-prod-readiness-probe.mjs --no-profile
 *
 * 说明：
 *   - 全程只读（d1 list + SELECT），绝不 apply 迁移、绝不导入、绝不 deploy。
 *   - 绝不打印 token / secret / raw code / PII。
 *   - 退出码：0 = READY；2 = NOT_READY；3 = 环境/认证不可用。
 *
 * 运行：node scripts/cert-r5b-prod-readiness-probe.mjs
 */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GUARDS,
  readProdStateViaWrangler,
  validatePreconditions,
} from './cert-r5-protected-legacy-pool-import-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKERS_DIR = join(__dirname, '..');

const argv = process.argv.slice(2);
const useProfile = !argv.includes('--no-profile');
const profile = useProfile ? 'jhzy' : undefined;
const accountId = GUARDS.EXPECTED_ACCOUNT_ID;

const out = (s) => process.stdout.write(s + '\n');

out('=== CERT-R5B PRODUCTION READINESS PROBE (READ-ONLY) ===');
out(`UTC=${new Date().toISOString()}`);
out(`ACCOUNT_ID=${accountId}`);
out(`AUTH_MODE=${useProfile ? `wrangler --profile ${profile} (TTY login)` : 'CLOUDFLARE_API_TOKEN env'}`);
out(`DB_TARGET=${GUARDS.PROD_D1_NAME} / ${GUARDS.PROD_D1_UUID}`);
out(`FORBIDDEN_DB=${GUARDS.FORBIDDEN_DEFAULT_DB_NAME ?? 'jhzy-v2-db'} / ${GUARDS.FORBIDDEN_DEFAULT_DB_UUID ?? ''}`);
out(`STAGING_DB=${GUARDS.STAGING_D1_NAME ?? 'jhzy-v2-staging'} / ${GUARDS.STAGING_D1_UUID ?? ''}`);
out('');

// -----------------------------------------------------------------------------
// 1) 目标证明：D1 列表中 jhzy-v2-prod 的 UUID 必须与冻结基线一致
// -----------------------------------------------------------------------------
function resolveWranglerBin() {
  try {
    const p = execFileSync('which', ['wrangler'], { encoding: 'utf8' }).trim();
    if (p && existsSync(p)) return p;
  } catch { /* fallthrough */ }
  const local = join(WORKERS_DIR, 'node_modules', '.bin', 'wrangler');
  return existsSync(local) ? local : null;
}

let uuidMatch = false;
let listOk = false;
try {
  const bin = resolveWranglerBin();
  const args = ['d1', 'list', '--json'];
  if (profile) args.push('--profile', profile);
  const raw = execFileSync(bin, args, {
    cwd: WORKERS_DIR,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CI: '1' },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const dbs = JSON.parse(raw);
  const prod = dbs.find((d) => d.name === GUARDS.PROD_D1_NAME);
  listOk = true;
  uuidMatch = prod?.uuid === GUARDS.PROD_D1_UUID;
  out(`D1_LIST_OK=${listOk} count=${dbs.length}`);
  out(`PROD_DB_FOUND=${prod ? 'YES' : 'NO'} uuid=${prod?.uuid ?? 'n/a'}`);
  out(`UUID_MATCH=${uuidMatch ? 'YES' : 'NO'}`);
} catch (e) {
  const d = String(e?.stdout ?? '') + ' ' + String(e?.stderr ?? '');
  out(`D1_LIST_OK=false reason=${/non-interactive/i.test(d) ? 'NON_INTERACTIVE_NO_TOKEN' : /Invalid access token|Authentication error/i.test(d) ? 'AUTH_TOKEN_REJECTED' : 'LIST_FAILED'}`);
}
out('');

// -----------------------------------------------------------------------------
// 2) 只读生产状态
// -----------------------------------------------------------------------------
const ps = await readProdStateViaWrangler({ profile, accountId, dbName: GUARDS.PROD_D1_NAME });
if (!ps.ok) {
  out(`PROD_STATE_OK=false`);
  out(`REASON=${ps.reason}`);
  out('');
  out('ENVIRONMENT_PROOF = BLOCKED');
  out('REMEDIATION = 在 TTY 内执行 `wrangler login --profile jhzy`，或设置 CLOUDFLARE_API_TOKEN 后重跑');
  process.exitCode = 3;
  process.exit(3);
}

out('PROD_STATE_OK=true');
out(`MIGRATION_0045=${ps.migration0045Count}`);
out(`MIGRATION_0046=${ps.migration0046Count}`);
out(`HAS_PROVENANCE_COLUMN=${ps.hasProvenanceColumn}`);
out(`ID_POOLS_SYNTHETIC_COMPAT=${ps.syntheticCompatCount}`);
out(`ID_POOLS_LEGACY_MIGRATED=${ps.legacyMigratedCount}`);
out(`ID_POOLS_NULL_PROVENANCE=${ps.nullProvenanceCount}`);
out(`DUPLICATE_CODE_GROUPS=${ps.duplicateCodeGroups}`);
out(`UUID_MATCH=${uuidMatch ? 'YES' : 'NO'}`);
out('');

const pre = validatePreconditions(ps);
out(`PRECONDITION=${pre.ready ? 'READY_FOR_IMPORT' : 'NOT_READY_FOR_IMPORT'}`);
if (!pre.ready) out(`PRECONDITION_FAILURES=${(pre.failures ?? []).join(', ')}`);
out('');
out(`ENVIRONMENT_PROOF = ${uuidMatch ? 'PASS' : 'PASS_WITH_FINDINGS(uuid not cross-checked)'}`);
process.exitCode = pre.ready && uuidMatch ? 0 : 2;
