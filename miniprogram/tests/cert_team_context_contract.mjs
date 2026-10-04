/**
 * POST-R5-P6B Client Team-Context Gate —— 前端静态契约（Backend Authority）。
 *
 * 校验目标（闭环 P6 finding：/certificates/mine 与 /certificates/:id 强制 team scope）：
 *   1) 统一 Request Client（transport.ts）在 teamScoped 时从 session.getActiveTeamId()
 *      注入 X-Team-Id；不硬编码 team id。
 *   2) trainingApi（志愿者端）默认 teamScoped=true；listMyCertificates / getCertificate
 *      均为团队作用域，绝不 teamScoped:false。
 *   3) adminApi（管理端）默认 teamScoped=true；listTrainingCertificates 为团队作用域。
 *   4) “我的证书”页（certificates.ts）与证书详情页（detail.ts）调用前 pre-guard hasTeamContext()，
 *      无团队上下文时渲染显式“请先选择团队”提示（非静默空列表）。
 *   5) 证书调用一律经 V2 wrapper（trainingApi / adminApi），不存在 legacy/散写 wx.request 绕过。
 *
 * 运行：node miniprogram/tests/cert_team_context_contract.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, '..', 'pages');
const UTILS = join(HERE, '..', 'utils');

const read = (p) => readFileSync(p, 'utf8');

let pass = 0;
let fail = 0;
function check(cond, name) {
  if (cond) {
    pass += 1;
    console.log('  PASS: ' + name);
  } else {
    fail += 1;
    console.error('  FAIL: ' + name);
  }
}

const F = {
  transport: read(join(UTILS, 'transport.ts')),
  trainingApi: read(join(UTILS, 'trainingApi.ts')),
  adminApi: read(join(UTILS, 'adminApi.ts')),
  session: read(join(UTILS, 'session.ts')),
  certMine: read(join(PAGES, 'certificates', 'certificates.ts')),
  certMineWxml: read(join(PAGES, 'certificates', 'certificates.wxml')),
  certDetail: read(join(PAGES, 'certificates', 'detail', 'detail.ts')),
  adminCert: read(join(PAGES, 'admin', 'training-certificates', 'index.ts')),
};

const certLines = (src) => src.split('\n').filter((l) => /\/certificates\//.test(l));
const noneUnscoped = (src, label) =>
  certLines(src).forEach((l) =>
    check(!/teamScoped:\s*false/.test(l), `${label}_CERT_CALL_NOT_UNSCOPED: ${l.trim()}`),
  );

// =========================================================================
// 1) 统一 Request Client：X-Team-Id 注入机制
// =========================================================================
check(/export function buildHeaders/.test(F.transport), 'TP_HEADER_BUILDER_EXISTS');
check(/if \(opts\.teamScoped\)/.test(F.transport), 'TP_TEAM_SCOPED_GUARD');
check(/const teamId = getActiveTeamId\(\)/.test(F.transport), 'TP_READS_ACTIVE_TEAM');
check(/header\['X-Team-Id'\] = teamId/.test(F.transport), 'TP_INJECTS_X_TEAM_ID');
check(
  !/header\['X-Team-Id'\] = '[^']+'/.test(F.transport),
  'TP_NO_HARDCODED_TEAM_ID',
);
check(
  /export function getActiveTeamId/.test(F.session),
  'SESSION_GET_ACTIVE_TEAM_ID_EXISTS',
);

// =========================================================================
// 2) trainingApi（志愿者端）：默认 teamScoped + 证书端点团队作用域
// =========================================================================
check(/export function hasTeamContext\(\)/.test(F.trainingApi), 'TR_HAS_TEAM_CONTEXT_FN');
check(
  /getActiveTeamId\(\)\.length > 0/.test(F.trainingApi),
  'TR_HAS_TEAM_CONTEXT_USES_ACTIVE',
);
check(
  /const teamScoped = opts\.teamScoped !== false/.test(F.trainingApi),
  'TR_DEFAULT_TEAM_SCOPED_TRUE',
);
check(/\/certificates\/mine/.test(F.trainingApi), 'TR_MINE_ENDPOINT_PRESENT');
check(certLines(F.trainingApi).length >= 1, 'TR_CERT_CALLS_PRESENT');
noneUnscoped(F.trainingApi, 'TR');

// =========================================================================
// 3) adminApi（管理端）：默认 teamScoped + 证书列表团队作用域
// =========================================================================
check(
  /const teamScoped = opts\.teamScoped !== false/.test(F.adminApi),
  'ADMIN_DEFAULT_TEAM_SCOPED_TRUE',
);
check(/\/certificates\/admin/.test(F.adminApi), 'ADMIN_CERT_LIST_ENDPOINT_PRESENT');
check(certLines(F.adminApi).length >= 1, 'ADMIN_CERT_CALLS_PRESENT');
noneUnscoped(F.adminApi, 'ADMIN');

// =========================================================================
// 4) 志愿者证书页：pre-guard + 显式“请先选择团队”提示
// =========================================================================
check(/hasTeamContext/.test(F.certMine), 'CERT_MINE_IMPORTS_HAS_TEAM');
check(/ensureTeam\(\)/.test(F.certMine), 'CERT_MINE_CALLS_ENSURE_TEAM');
check(/teamMissing/.test(F.certMineWxml), 'CERT_MINE_WXML_TEAM_MISSING_STATE');
check(/请先选择团队/.test(F.certMineWxml), 'CERT_MINE_WXML_PROMPT_TEXT');
check(/去选择团队/.test(F.certMineWxml), 'CERT_MINE_WXML_SELECT_TEAM_CTA');
check(/hasTeamContext/.test(F.certDetail), 'CERT_DETAIL_IMPORTS_HAS_TEAM');
check(/ensureTeam\(\)/.test(F.certDetail), 'CERT_DETAIL_CALLS_ENSURE_TEAM');
check(/TEAM_SCOPE_REQUIRED/.test(F.certDetail), 'CERT_DETAIL_HANDLES_TEAM_SCOPE');

// =========================================================================
// 5) 无 legacy / 散写绕过：证书调用一律经 V2 wrapper
// =========================================================================
check(
  /from '.*utils\/trainingApi'/.test(F.certMine),
  'CERT_MINE_USES_V2_WRAPPER',
);
check(
  /from '.*utils\/trainingApi'/.test(F.certDetail),
  'CERT_DETAIL_USES_V2_WRAPPER',
);
check(
  /adminApi\.listTrainingCertificates/.test(F.adminCert),
  'ADMIN_CERT_USES_V2_WRAPPER',
);
check(
  !/wx\.request\([^)]*\/certificates\//.test(F.certMine + F.certDetail + F.adminCert),
  'NO_SCATTERED_WX_REQUEST_TO_CERT',
);

// =========================================================================
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
