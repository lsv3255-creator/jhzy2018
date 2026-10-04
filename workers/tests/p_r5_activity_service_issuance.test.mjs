// =============================================================================
// P_R5 — Activity / Service 证书发放接线集成测试（POST-R5-P5）
//
// 真实 app + 本地 D1（esbuild 打包 src/app.ts + buildP11Db 应用全部 migration）。
// 仅本地 node:sqlite，绝不触碰 production；不调用生产发证接口 / 不写生产证书 /
// 不消费生产号池 / 不发网络请求。
//
// 覆盖：
//   A  RBAC：未认证 401 / 无权限角色 403 / 团队角色(有证书权限) 200 / 平台角色(no team) 403
//   B  活动资格预览：eligible / 未签退(NOT_ELIGIBLE) / 阻断异常(ANOMALY_BLOCKING)
//   C  单人参与发证：ISSUED + 本地证书/审计落库 + 不建 batch 账本
//   D  批量发证：已发→ALREADY_ISSUED，不合格→NOT_ELIGIBLE，账本计数正确
//   E  幂等：再次单人发证→ALREADY_ISSUED
//   F  服务资格预览：eligible
//   G  服务发证：ISSUED + 命名空间 (source_type='activity', issue_source='service', source_id=sr.id)
//   H  服务幂等：再次发证→ALREADY_ISSUED
//   I/J 本人自发证：单人 & 服务均 → 403 SELF_ISSUE_FORBIDDEN
//   K  本地仅落 2 张证书（1 activity + 1 service，同一接收者 volC）
//   L  跨团队活动：team1 操作者访问 team2 活动 → 404（租户隔离）
//
// 运行（在 workers/ 目录）：node tests/p_r5_activity_service_issuance.test.mjs
// =============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { buildP11Db } from './lib/p11db.mjs';

const WORKERS_DIR = fileURLToPath(new URL('..', import.meta.url));

// 严格 Crockford ULID（与 utils/crypto.ts::generateUlid 同字符集）
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
  let s = '';
  for (let i = 0; i < 26; i++) s += ULID_ALPHABET[Math.floor(Math.random() * ULID_ALPHABET.length)];
  return s;
}

// ---------- 结果收集 ----------
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function bundle(entryPath, tag) {
  const built = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'error',
  });
  const p = join(tmpdir(), `${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.mjs`);
  writeFileSync(p, built.outputFiles[0].text);
  return import(pathToFileURL(p).href);
}

async function main() {
  // 1) 打包真实 app.ts
  const appPath = fileURLToPath(new URL('../src/app.ts', import.meta.url));
  const { createApp } = await bundle(appPath, 'p_r5_app');
  const app = createApp();

  // 2) 本地 sqlite + 应用全部 migration + 基础 fixture（users/teams/activities/signups/.../P11 perms）
  const p11 = await buildP11Db();
  const raw = p11.raw;
  const fixture = p11.fixture;
  const db = p11.db; // D1 shim（支持 batch）
  const ENV = { DB: db, ENVIRONMENT: 'local' };

  const seed = (sql, ...p) => raw.prepare(sql).run(...p);
  const get = (sql, ...p) => raw.prepare(sql).get(...p);

  // 3) 补种证书域测试数据（buildP11Db 不含：模板 / 号池 / 参与 / 考勤 / 服务记录 / 权限）
  // 3a) 活动证书模板（cert_type='activity', status=1）—— 不硬编码 id，避免与 buildP11Db 既有数据冲突
  const tplInfo = raw
    .prepare('INSERT INTO certificate_templates (name, cert_type, layout, status) VALUES (?,?,?,1)')
    .run('ActivityCert', 'activity', '{}');
  const tplId = Number(tplInfo.lastInsertRowid);

  // 3b) 号池：cert_srv（ACTIVITY 与 SERVICE 共用，CERT-R3B 冻结），provenance='legacy_migrated'（可分配）
  for (let i = 1; i <= 20; i++) {
    seed(
      "INSERT INTO id_pools (pool_type, code, status, provenance) VALUES ('cert_srv', ?, 0, 'legacy_migrated')",
      `JHCRT-SRV-${String(i).padStart(5, '0')}`,
    );
  }

  // 3c) 权限 certificate.certificate.issue + 绑定 team_admin / team_owner / platform_super_admin
  seed(
    "INSERT OR IGNORE INTO permissions (code, name, perm_group, risk_level) VALUES ('certificate.certificate.issue', '发放证书', 'certificate', 2)",
  );
  for (const role of ['team_admin', 'team_owner', 'platform_super_admin']) {
    seed(
      "INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE code=?), (SELECT id FROM permissions WHERE code='certificate.certificate.issue'))",
      role,
    );
  }

  // 3d) 活动参与 + 考勤（volC=user6, signup4, actA1 id=1, team1）—— 合格签发对象
  const partPubC = ulid();
  seed('INSERT INTO activity_participations (public_id, signup_id, occurrence_id, status) VALUES (?,?,?,1)', partPubC, 4, 1);
  const partIdC = get('SELECT id FROM activity_participations WHERE public_id=?', partPubC).id;
  const infoC = raw
    .prepare(
      'INSERT INTO attendance_sessions (signup_id, activity_id, user_id, team_id, status, participation_id, checkin_at, checkout_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(4, 1, 6, 1, 2, partIdC, 1756500000 + 1000, 1756500000 + 2000);
  const attIdC = Number(infoC.lastInsertRowid);

  // 3e) 异常阻断对象（volD=user7, signup5, actA1 id=1）—— 有签退但存在 blocking anomaly
  const partPubD = ulid();
  seed('INSERT INTO activity_participations (public_id, signup_id, occurrence_id, status) VALUES (?,?,?,1)', partPubD, 5, 1);
  const partIdD = get('SELECT id FROM activity_participations WHERE public_id=?', partPubD).id;
  const infoD = raw
    .prepare(
      'INSERT INTO attendance_sessions (signup_id, activity_id, user_id, team_id, status, participation_id, checkin_at, checkout_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(5, 1, 7, 1, 2, partIdD, 1756500000 + 1000, 1756500000 + 2000);
  const attIdD = Number(infoD.lastInsertRowid);
  seed('INSERT INTO attendance_anomalies (session_id, team_id, anomaly_type, status) VALUES (?,?,?,1)', attIdD, 1, 'out_of_range');

  // 3f) 服务记录（volC=user6, sr id=1, actA1 id=1, team1, status=2, settlement_status=1）
  //     独立会话（signup_id=6，避免与 volC 活动会话的 UNIQUE(signup_id) 冲突）
  const infoSR = raw
    .prepare(
      'INSERT INTO attendance_sessions (signup_id, activity_id, user_id, team_id, status, participation_id, checkin_at, checkout_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(6, 1, 6, 1, 2, null, 1756500000 + 1000, 1756500000 + 2000);
  const srSessId = Number(infoSR.lastInsertRowid);
  const srPub = ulid();
  seed(
    'INSERT INTO service_records (id, session_id, user_id, team_id, activity_id, status, settlement_status, service_date, public_id, source) VALUES (?,?,?,?,?,?,?,?,?,?)',
    1,
    srSessId,
    6,
    1,
    1,
    2,
    1,
    1756500000,
    srPub,
    'auto',
  );

  // 4) 请求驱动
  async function call(method, path, opts = {}) {
    const headers = {};
    if (opts.role) headers['x-test-role'] = opts.role;
    if (opts.user != null) headers['x-test-user'] = String(opts.user);
    if (opts.team != null) headers['x-test-team'] = String(opts.team);
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(
      path,
      { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined },
      ENV,
    );
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* ignore */
    }
    return { status: res.status, json };
  }

  // ======================= A：RBAC =======================
  {
    const r = await call('POST', `/api/v2/activities/${fixture.actA1}/certificates/preview`, {
      body: { templateId: tplId, recipientUserIds: [6] },
    });
    check('A1 未认证 → 401', r.status === 401, `status=${r.status}`);
  }
  {
    const r = await call('POST', `/api/v2/activities/${fixture.actA1}/certificates/preview`, {
      role: 'volunteer',
      user: 8,
      team: 1,
      body: { templateId: tplId, recipientUserIds: [6] },
    });
    check('A2 volunteer(无证书权限) → 403', r.status === 403, `status=${r.status}`);
  }
  {
    const r = await call('POST', `/api/v2/activities/${fixture.actA1}/certificates/preview`, {
      role: 'team_admin',
      user: 3,
      team: 1,
      body: { templateId: tplId, recipientUserIds: [6] },
    });
    check('A3 team_admin(有证书权限) → 200', r.status === 200, `status=${r.status}`);
  }
  {
    const r = await call('POST', `/api/v2/activities/${fixture.actA1}/certificates/preview`, {
      role: 'platform_super_admin',
      user: 5,
      team: null,
      body: { templateId: tplId, recipientUserIds: [6] },
    });
    check('A4 平台角色(无 team) → 403', r.status === 403, `status=${r.status}`);
  }

  // ======================= B：活动资格预览 =======================
  {
    const r = await call('POST', `/api/v2/activities/${fixture.actA1}/certificates/preview`, {
      role: 'team_admin',
      user: 3,
      team: 1,
      body: { templateId: tplId, recipientUserIds: [6, 8, 7] },
    });
    check('B 预览 200', r.status === 200, `status=${r.status}`);
    const data = r.json?.data;
    const byUser = Object.fromEntries((data?.results ?? []).map((x) => [x.userId, x]));
    check('B volC(6) eligible=true', byUser[6] && byUser[6].eligible === true, JSON.stringify(byUser[6]));
    check(
      'B volE(8) 未签退 → NOT_ELIGIBLE',
      byUser[8] && byUser[8].eligible === false && byUser[8].reason === 'ACTIVITY_NOT_ATTENDED',
      JSON.stringify(byUser[8]),
    );
    check(
      'B volD(7) 阻断异常 → ATTENDANCE_ANOMALY_BLOCKING',
      byUser[7] && byUser[7].eligible === false && byUser[7].reason === 'ATTENDANCE_ANOMALY_BLOCKING',
      JSON.stringify(byUser[7]),
    );
  }

  // ======================= C：单人参与发证 → ISSUED =======================
  {
    const r = await call('POST', `/api/v2/activities/${fixture.actA1}/participants/${partPubC}/certificate/issue`, {
      role: 'team_admin',
      user: 3,
      team: 1,
      body: { templateId: tplId },
    });
    check('C 单人发证 200', r.status === 200, `status=${r.status}`);
    const d = r.json?.data;
    check('C outcome=ISSUED', d?.outcome === 'ISSUED', `outcome=${d?.outcome}`);
    check('C certificatePublicId 非空', typeof d?.certificatePublicId === 'string' && d.certificatePublicId.length > 0);
    check('C userId=6', d?.userId === 6);
  }
  {
    const cnt = get(
      "SELECT COUNT(*) AS n FROM certificates WHERE user_id=6 AND source_type='activity' AND issue_source='activity' AND source_id=1 AND status=1",
    ).n;
    check('C-DB 本地证书落库(volC activity)', cnt === 1, `n=${cnt}`);
    const logCnt = get(
      "SELECT COUNT(*) AS n FROM certificate_logs l JOIN certificates c ON c.id=l.certificate_id WHERE c.user_id=6 AND l.action='issue' AND l.result='success'",
    ).n;
    check('C-DB 审计 success 落库', logCnt === 1, `n=${logCnt}`);
    const batchCnt = get('SELECT COUNT(*) AS n FROM certificate_batches').n;
    check('C-DB 单人发证不建 batch 账本', batchCnt === 0, `n=${batchCnt}`);
  }

  // ======================= D：批量发证（幂等 + 不合格分桶） =======================
  {
    const r = await call('POST', `/api/v2/activities/${fixture.actA1}/certificates/issue`, {
      role: 'team_admin',
      user: 3,
      team: 1,
      body: { templateId: tplId, recipientUserIds: [6, 8] },
    });
    check('D 批量 200', r.status === 200, `status=${r.status}`);
    const d = r.json?.data;
    check('D requested=2', d?.summary?.requested === 2, `req=${d?.summary?.requested}`);
    check('D issued=0', d?.summary?.issued === 0, `issued=${d?.summary?.issued}`);
    check('D alreadyIssued=1 (volC 已发)', d?.summary?.alreadyIssued === 1, `ai=${d?.summary?.alreadyIssued}`);
    check('D notEligible=1 (volE 未签退)', d?.summary?.notEligible === 1, `ne=${d?.summary?.notEligible}`);
    check('D failed=0', d?.summary?.failed === 0, `failed=${d?.summary?.failed}`);
    check('D alreadyIssued 含 volC', d?.alreadyIssued?.length === 1 && d.alreadyIssued[0].userId === 6);
    check('D notEligible 含 volE', d?.notEligible?.length === 1 && d.notEligible[0].userId === 8);
    const b = get('SELECT status, issued, already_issued, ineligible, failed FROM certificate_batches WHERE public_id=?', d?.batchId);
    check('D batch 账本计数正确(COMPLETED)', b && b.issued === 0 && b.already_issued === 1 && b.ineligible === 1 && b.failed === 0, JSON.stringify(b));
    check('D batch status=2 COMPLETED', b && b.status === 2, `status=${b?.status}`);
  }

  // ======================= E：幂等（再次单人发证 → ALREADY_ISSUED） =======================
  {
    const r = await call('POST', `/api/v2/activities/${fixture.actA1}/participants/${partPubC}/certificate/issue`, {
      role: 'team_admin',
      user: 3,
      team: 1,
      body: { templateId: tplId },
    });
    check('E 幂等 200', r.status === 200, `status=${r.status}`);
    check('E outcome=ALREADY_ISSUED', r.json?.data?.outcome === 'ALREADY_ISSUED', `outcome=${r.json?.data?.outcome}`);
  }

  // ======================= F：服务资格预览 =======================
  {
    const r = await call('POST', `/api/v2/service-records/${srPub}/certificate/preview`, {
      role: 'team_admin',
      user: 3,
      team: 1,
      body: { templateId: tplId },
    });
    check('F 服务预览 200', r.status === 200, `status=${r.status}`);
    const d = r.json?.data;
    check('F service eligible=true', d?.eligible === true, JSON.stringify(d));
    check('F service alreadyIssued=false', d?.alreadyIssued === false);
  }

  // ======================= G：服务发证 → ISSUED + 命名空间正确 =======================
  {
    const r = await call('POST', `/api/v2/service-records/${srPub}/certificate/issue`, {
      role: 'team_admin',
      user: 3,
      team: 1,
      body: { templateId: tplId },
    });
    check('G 服务发证 200', r.status === 200, `status=${r.status}`);
    const d = r.json?.data;
    check('G outcome=ISSUED', d?.outcome === 'ISSUED', `outcome=${d?.outcome}`);
    check('G userId=6', d?.userId === 6);
  }
  {
    const row = get(
      "SELECT source_type, issue_source, source_id FROM certificates WHERE user_id=6 AND issue_source='service' AND status=1",
    );
    check(
      'G-DB 服务证书命名空间(source_type=activity, issue_source=service, source_id=1)',
      row && row.source_type === 'activity' && row.issue_source === 'service' && row.source_id === 1,
      JSON.stringify(row),
    );
  }

  // ======================= H：服务幂等 =======================
  {
    const r = await call('POST', `/api/v2/service-records/${srPub}/certificate/issue`, {
      role: 'team_admin',
      user: 3,
      team: 1,
      body: { templateId: tplId },
    });
    check('H 服务幂等 200', r.status === 200, `status=${r.status}`);
    check('H outcome=ALREADY_ISSUED', r.json?.data?.outcome === 'ALREADY_ISSUED', `outcome=${r.json?.data?.outcome}`);
  }

  // ======================= I/J：本人自发证（operator==recipient）→ 403 =======================
  {
    const r = await call('POST', `/api/v2/activities/${fixture.actA1}/participants/${partPubC}/certificate/issue`, {
      role: 'team_admin',
      user: 6,
      team: 1,
      body: { templateId: tplId },
    });
    check('I 活动本人自发证 → 403', r.status === 403, `status=${r.status}`);
  }
  {
    const r = await call('POST', `/api/v2/service-records/${srPub}/certificate/issue`, {
      role: 'team_admin',
      user: 6,
      team: 1,
      body: { templateId: tplId },
    });
    check('J 服务本人自发证 → 403', r.status === 403, `status=${r.status}`);
  }

  // ======================= K：本地仅落 2 张证书（无 production 写） =======================
  {
    const total = get(
      "SELECT COUNT(*) AS n FROM certificates WHERE status=1 AND source_id=1 AND (issue_source='activity' OR issue_source='service')",
    ).n;
    check('K 本地恰好 2 张证书(1 activity + 1 service)', total === 2, `n=${total}`);
  }

  // ======================= L：跨团队隔离 =======================
  {
    const r = await call('POST', `/api/v2/activities/${fixture.actB1}/certificates/preview`, {
      role: 'team_admin',
      user: 3,
      team: 1, // 操作者属 team1，访问 team2 活动
      body: { templateId: tplId, recipientUserIds: [6] },
    });
    check('L 跨团队活动 → 404', r.status === 404, `status=${r.status}`);
  }

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n==============================');
  console.log(`P_R5 RESULT: ${passed}/${results.length} PASS`);
  if (failed) {
    console.log('FAILED:');
    for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name} ${r.detail}`);
  }
  console.log(failed ? '=== P_R5 = BLOCKED ===' : '=== P_R5 = PASS ===');

  p11.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
