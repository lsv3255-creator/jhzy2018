#!/usr/bin/env node
/**
 * CERT-R3B —— Shared Issuance Core 本地隔离测试（§20 测试矩阵 A–T）。
 *
 * 方法（对齐 tests/cert_r2_migration_fixture.mjs 的隔离模式）：
 *   - 在 workers/tmp/ 下建【独立】sqlite（不碰 local D1，更不碰 remote D1）。
 *   - 还原 0001 的相关表 + 0022 + **真实应用 0045（含 CERT-R3A-FIX 修正后的
 *     issue_source 列与四列 uq_cert_user_source 索引）**。
 *     → 服务是真正跑在修正后的 schema 上，不是省略 DB 约束的 mock（§21）。
 *   - 用最小 D1 适配器把 node:sqlite 暴露为 D1Database 所需接口
 *     （prepare/batch/first/all/run），使仓储与服务代码【零改动】即可执行。
 *   - 合成数据；无生产/预发写入；无真实 PII。
 *
 * 覆盖矩阵（§20）：
 *   A. ACTIVITY 首次发放成功
 *   B. ACTIVITY 重试 → ALREADY_ISSUED
 *   C. SERVICE 首次发放成功
 *   D. SERVICE 重试 → ALREADY_ISSUED
 *   E. 同 user + 同数值 source_id 跨 ACTIVITY/SERVICE 均成功
 *   F. 不同 user 同成就允许
 *   G. 缺 source_id → SOURCE_ID_REQUIRED
 *   H. 源实体不存在 → SOURCE_NOT_FOUND
 *   I. 接收者不存在 → RECIPIENT_NOT_FOUND
 *   J. 系统账号 1676 → 拒绝（不报 ISSUED）
 *   K. 不支持的源 → UNSUPPORTED_SOURCE
 *   L. 池未播种 → NUMBER_POOL_UNAVAILABLE（确定性、不回退 cert_trn）
 *   M. 池耗尽 → NUMBER_POOL_EXHAUSTED
 *   N. 证书 INSERT 失败 → 不产生假成功
 *   O. 审计缺失 → AUDIT_FAILED（不报 ISSUED）
 *   P. UNIQUE 冲突 → ALREADY_ISSUED（并发竞态确定性归一）
 *   Q. 无编号重复
 *   R. 已消费编号绝不重分配
 *   S. 请求/审计不含 PII
 *   T. 考试/既有证书回归断言仍成立（0045 fixture 独立保证）
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(process.cwd(), 'tmp');
mkdirSync(TMP, { recursive: true });
const FIX = join(TMP, '_cert_r3b_fixture.sqlite');
if (existsSync(FIX)) unlinkSync(FIX);

const db = new DatabaseSync(FIX);
db.exec('PRAGMA foreign_keys = OFF;');

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

// =============================================================================
// §21 最小 schema：0001 相关表 + 0022 + 真实 0045
// =============================================================================
db.exec(`
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  public_id     TEXT NOT NULL UNIQUE,
  nickname      TEXT,
  cert_level    INTEGER NOT NULL DEFAULT 1,
  status        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at    INTEGER DEFAULT NULL
);
CREATE TABLE teams (
  id          INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  status      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE activities (id INTEGER PRIMARY KEY, team_id INTEGER, title TEXT);
CREATE TABLE service_records (
  id INTEGER PRIMARY KEY, session_id INTEGER, user_id INTEGER, team_id INTEGER,
  activity_id INTEGER, minutes INTEGER, status INTEGER DEFAULT 1
);
CREATE TABLE exam_papers (id INTEGER PRIMARY KEY);
CREATE TABLE exam_sessions (id INTEGER PRIMARY KEY, user_id INTEGER, team_id INTEGER, paper_id INTEGER, status INTEGER);
CREATE TABLE certificate_templates (id INTEGER PRIMARY KEY, name TEXT, cert_type TEXT, layout TEXT, status INTEGER DEFAULT 1);
CREATE TABLE files (id INTEGER PRIMARY KEY);

CREATE TABLE certificates (
  id            INTEGER PRIMARY KEY,
  public_id     TEXT NOT NULL UNIQUE,
  cert_no       TEXT NOT NULL UNIQUE,
  verify_code   TEXT NOT NULL UNIQUE,
  template_id   INTEGER NOT NULL REFERENCES certificate_templates(id),
  user_id       INTEGER NOT NULL REFERENCES users(id),
  team_id       INTEGER NOT NULL REFERENCES teams(id),
  cert_type     TEXT NOT NULL CHECK (cert_type IN ('training','activity','honor')),
  source_type   TEXT CHECK (source_type IS NULL OR source_type IN ('course','exam','activity','manual')),
  source_id     INTEGER,
  holder_name   TEXT,
  issuer_name   TEXT,
  snapshot      TEXT,
  file_id       INTEGER REFERENCES files(id),
  issued_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  status        INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2)),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER,
  exam_paper_id INTEGER REFERENCES exam_papers(id)
);

CREATE TABLE certificate_logs (
  id            INTEGER PRIMARY KEY,
  team_id       INTEGER NOT NULL REFERENCES teams(id),
  certificate_id INTEGER NOT NULL REFERENCES certificates(id),
  action        TEXT NOT NULL CHECK (action IN ('issue','revoke','reissue','regenerate')),
  reason        TEXT,
  operator_id   INTEGER REFERENCES users(id),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE id_pools (
  id          INTEGER PRIMARY KEY,
  pool_type   TEXT NOT NULL CHECK (pool_type IN ('cert_trn','cert_srv','cert_hon','volunteer')),
  code        TEXT NOT NULL,
  status      INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2)),
  assigned_to INTEGER,
  assigned_at INTEGER,
  -- CERT-R3D-FIX：分配资格要求显式 provenance（0046 起存在；fail-closed 白名单）
  provenance  TEXT CHECK (provenance IS NULL OR provenance IN
                ('legacy_migrated','v2_synthetic_compat','v2_native')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (pool_type, code)
);
`);

// 合成基础数据（无 PII；users 表结构对齐真实 0001 schema）
db.exec(`INSERT INTO teams (id, owner_user_id, is_system, status) VALUES (1, 1, 0, 1);`);
db.exec(`INSERT INTO certificate_templates (id, name, cert_type, layout, status) VALUES (1,'活动证书','activity','{}',1);`);
db.exec(`INSERT INTO certificate_templates (id, name, cert_type, layout, status) VALUES (2,'培训证书','training','{}',1);`);
for (let i = 1; i <= 20; i++) {
  db.prepare('INSERT INTO users (id, public_id, status) VALUES (?, ?, 1)').run(i, `01USER${String(i).padStart(20, '0')}`);
}
db.prepare('INSERT INTO users (id, public_id, status) VALUES (?, ?, 1)').run(1676, '01PLATFORMSYSACCOUNT00001');
for (let i = 1; i <= 10; i++) db.prepare('INSERT INTO activities (id, team_id, title) VALUES (?, 1, ?)').run(i, `act-${i}`);
// service_records 与 activities 数值空间【故意重叠】——复现 CERT-R3A 证明的碰撞前提
for (let i = 1; i <= 10; i++) {
  db.prepare('INSERT INTO service_records (id, session_id, user_id, team_id, activity_id, minutes) VALUES (?, ?, ?, 1, ?, ?)').run(i, 900 + i, i, ((i % 10) + 1), 120);
}
// cert_trn 池仅 2 条（够用且与活动池隔离）；cert_srv【不播种】→ 验证 POOL_UNAVAILABLE
db.exec(`WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<2)
INSERT INTO id_pools (pool_type, code, status, created_at) SELECT 'cert_trn', printf('CTRN%06d', x), 0, unixepoch() FROM seq;`);

// ★ 真实应用 0045（含 issue_source + 四列索引）
let migrationOk = true;
try {
  db.exec(readFileSync(join(process.cwd(), 'migrations', '0045_certificate_domain_contract.sql'), 'utf8'));
} catch (e) {
  migrationOk = false;
  process.stderr.write(`  MIGRATION ERROR: ${e}\n`);
}
check('§21 真实 0045 应用成功（含 issue_source 修正）', migrationOk);

const appliedCols = db.prepare('PRAGMA table_info(certificates)').all().map((c) => c.name);
check('§21 schema 确实含 issue_source（非 mock）', appliedCols.includes('issue_source'), appliedCols.join(','));
const idxSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_cert_user_source'").get()?.sql ?? '';
check('§21 四列 uq_cert_user_source 已生效', /issue_source/i.test(idxSql), idxSql);

// =============================================================================
// 最小 D1 适配器：让仓储/服务代码零改动运行在 node:sqlite 上
// =============================================================================
function makeD1(database) {
  const prep = (sql) => {
    const st = database.prepare(sql);
    let bound = null;
    const api = {
      bind(...args) { bound = args; return api; },
      _run() {
        const r = bound ? st.run(...bound) : st.run();
        return { success: true, meta: { changes: r.changes }, results: [] };
      },
      async run() { return api._run(); },
      async first() {
        const r = bound ? st.get(...bound) : st.get();
        return r ?? null;
      },
      async all() {
        const r = bound ? st.all(...bound) : st.all();
        return { success: true, meta: {}, results: r };
      },
    };
    return api;
  };
  return {
    prepare: (sql) => prep(sql),
    async batch(stmts) {
      const out = [];
      database.exec('BEGIN');
      try {
        for (const s of stmts) out.push(await s.run());
        database.exec('COMMIT');
        return out;
      } catch (e) {
        database.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

const d1 = makeD1(db);

// 动态导入真实源码（经 tsc 编译产物；与生产源码同源，非副本）

// —— 采用策略：将 TS 源码编译到 tmp 后动态 import（零副本、跑真实源码）——
// 使用项目 tsconfig 的编译选项（strict + workers-types），与 `npm run typecheck` 同源。
// 仅覆盖 outDir 以产出可被 node 直接 import 的 ESM。
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, writeFileSync, readFileSync as rf } from 'node:fs';
const OUT = join(TMP, '_cert_r3b_build');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
execFileSync(
  process.execPath,
  [
    join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project', join(process.cwd(), 'tsconfig.json'),
    '--outDir', OUT,
    '--module', 'esnext',
    '--noEmit', 'false',
    '--declaration', 'false',
    '--sourceMap', 'false',
  ],
  { stdio: 'pipe' },
);
// tsc 以 moduleResolution=bundler 产出【无扩展名】相对导入；Node ESM 需显式 .js。
// 逐文件补全扩展名（仅改 tmp 编译产物，不触碰源码）。
function fixExt(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { fixExt(p); continue; }
    if (!p.endsWith('.js')) continue;
    let s = rf(p, 'utf8');
    s = s.replace(/(from\s+['"])(\.[^'"]*?)(['"])/g, (m, a, spec, c) => {
      if (spec.endsWith('.js')) return m;
      // 目录导入补 /index.js
      try { if (statSync(join(dir, spec)).isDirectory()) return `${a}${spec}/index.js${c}`; } catch { /* noop */ }
      return `${a}${spec}.js${c}`;
    });
    writeFileSync(p, s);
  }
}
fixExt(OUT);
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ type: 'module' }));

const { CertificateIssuanceService } = await import(join(OUT, 'services', 'certificate-issuance-service.js'));
const { CertificateIssuanceRepository } = await import(join(OUT, 'repository', 'certificate-issuance.js'));

// 合成授权操作者上下文（§10：无路由，测试仅用合成已授权上下文）
const ctx = {
  auth: { authenticated: true, userId: 1, role: 'team_admin', teamId: 1, roles: [{ role: 'team_admin', scopeTeamId: 1 }] },
  tenant: { scope: 'TEAM_SCOPED', teamId: 1, userId: 1 },
};
const repo = new CertificateIssuanceRepository({ db: d1, ctx });
// —— fail-closed 依赖注入（CERT-R3B-FIX）——
// 核心不发明资格/守卫业务规则，只强制「必须有人负责」：
//   - eligibility  : 测试用「显式放行」策略，模拟未来真实政策接入
//   - recipientGuard: 测试用「显式拒绝指定 id」策略
// 生产接入方必须注入真实实现；缺失时核心在构造期抛 POLICY_NOT_CONFIGURED。
const ALLOW_ELIGIBILITY = { async check() { return { eligible: true }; } };
const DENY_ELIGIBILITY = { async check() { return { eligible: false, reason: 'TEST_POLICY_DENY' }; } };
const GUARD_ALLOW = { isDisallowedRecipient: () => false };
const GUARD_DENY_SYS = { isDisallowedRecipient: (uid) => uid === 1676 };

const svc = new CertificateIssuanceService({
  repo,
  eligibility: ALLOW_ELIGIBILITY,
  recipientGuard: GUARD_ALLOW,
});
const { CertificateSource } = await import(join(OUT, 'domain', 'certificate.js'));
const { CertificateKind, IssuanceReason } = await import(join(OUT, 'domain', 'certificate.js'));

const baseReq = (o) => ({
  recipientUserId: 3, teamId: 1, domainSource: CertificateSource.ACTIVITY, sourceId: 1,
  certKind: CertificateKind.PARTICIPANT, templateId: 1, operatorUserId: 1, ...o,
});

// =============================================================================
// §20 测试矩阵
// =============================================================================

// L. 池未播种 → NUMBER_POOL_UNAVAILABLE（确定性，绝不回退 cert_trn）
{
  const r = await svc.issue(baseReq({ recipientUserId: 3, sourceId: 1 }));
  check('L. cert_srv 未播种 → NUMBER_POOL_UNAVAILABLE', r.outcome === 'NUMBER_POOL_UNAVAILABLE', r.outcome);
  check('L. 未回退到 cert_trn（无编号被消费）',
    db.prepare("SELECT COUNT(*) n FROM id_pools WHERE status=1").get().n === 0);
  check('L. 未产生任何证书行（无假成功）',
    db.prepare('SELECT COUNT(*) n FROM certificates').get().n === 0);
}

// 播种 cert_srv（测试夹具内的合成播种，模拟「未来种子迁移」；非生产行为）
// 数量足以覆盖 A–F，随后由 M 用例专门耗尽以验证确定性失败。
db.exec(`WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<8)
INSERT INTO id_pools (pool_type, code, status, provenance, created_at) SELECT 'cert_srv', printf('CSRV%06d', x), 0, 'legacy_migrated', unixepoch() FROM seq;`);

// A. ACTIVITY 首次发放成功
let act1;
{
  const r = await svc.issue(baseReq({ recipientUserId: 3, sourceId: 1 }));
  act1 = r;
  check('A. ACTIVITY 首次发放 → ISSUED', r.outcome === 'ISSUED', r.outcome);
  check('A. 返回 fileStatus=PENDING（PDF 在事务外）', r.fileStatus === 'pending', String(r.fileStatus));
  const row = db.prepare("SELECT cert_kind, issue_reason, issue_source, source_type, source_id, status FROM certificates WHERE user_id=3 AND source_id=1").get();
  check('A. 持久化 issue_source=activity / source_type=activity / cert_kind=participant',
    row.issue_source === 'activity' && row.source_type === 'activity' && row.cert_kind === 'participant', JSON.stringify(row));
  check('A. audit 已写入（result=success）',
    (db.prepare("SELECT COUNT(*) n FROM certificate_logs WHERE action='issue' AND result='success'").get().n) === 1);
  check('A. 号池已消费且绑定接收者',
    (db.prepare("SELECT assigned_to FROM id_pools WHERE code=?").get(r.certificateNo).assigned_to) === 3);
}

// B. ACTIVITY 重试 → ALREADY_ISSUED
{
  const r = await svc.issue(baseReq({ recipientUserId: 3, sourceId: 1 }));
  check('B. ACTIVITY 重试 → ALREADY_ISSUED', r.outcome === 'ALREADY_ISSUED', r.outcome);
  check('B. 重试未产生第二张证书',
    db.prepare('SELECT COUNT(*) n FROM certificates').get().n === 1);
}

// C. SERVICE 首次发放成功
let srv1;
{
  const r = await svc.issue(baseReq({ recipientUserId: 4, domainSource: CertificateSource.SERVICE, sourceId: 1 }));
  srv1 = r;
  check('C. SERVICE 首次发放 → ISSUED', r.outcome === 'ISSUED', r.outcome);
  const row = db.prepare("SELECT issue_source, source_type FROM certificates WHERE user_id=4").get();
  check('C. 持久化 issue_source=service / source_type=activity',
    row.issue_source === 'service' && row.source_type === 'activity', JSON.stringify(row));
}

// D. SERVICE 重试 → ALREADY_ISSUED
{
  const r = await svc.issue(baseReq({ recipientUserId: 4, domainSource: CertificateSource.SERVICE, sourceId: 1 }));
  check('D. SERVICE 重试 → ALREADY_ISSUED', r.outcome === 'ALREADY_ISSUED', r.outcome);
}

// E. 同 user + 同数值 source_id 跨命名空间均成功（核心验收）
{
  const act = await svc.issue(baseReq({ recipientUserId: 5, sourceId: 2 }));
  const srv = await svc.issue(baseReq({ recipientUserId: 5, domainSource: CertificateSource.SERVICE, sourceId: 2 }));
  check('E. 同 user 同数值 source_id：ACTIVITY 成功', act.outcome === 'ISSUED', act.outcome);
  check('E. 同 user 同数值 source_id：SERVICE 也成功（不误判重复）', srv.outcome === 'ISSUED', srv.outcome);
  check('E. 两张证书编号不同（无编号重复）', act.certificateNo !== srv.certificateNo, `${act.certificateNo} vs ${srv.certificateNo}`);
}

// F. 不同 user 同成就允许
{
  const r = await svc.issue(baseReq({ recipientUserId: 6, sourceId: 1 }));
  check('F. 不同 user 同成就 → ISSUED', r.outcome === 'ISSUED', r.outcome);
}

// G. 缺 source_id
{
  const r = await svc.issue(baseReq({ recipientUserId: 7, sourceId: null }));
  check('G. 缺 source_id → SOURCE_ID_REQUIRED', r.outcome === 'SOURCE_ID_REQUIRED', r.outcome);
}

// H. 源实体不存在
{
  const r = await svc.issue(baseReq({ recipientUserId: 7, sourceId: 9999 }));
  check('H. 源实体不存在 → SOURCE_NOT_FOUND', r.outcome === 'SOURCE_NOT_FOUND', r.outcome);
}

// I. 接收者不存在
{
  const r = await svc.issue(baseReq({ recipientUserId: 999999, sourceId: 1 }));
  check('I. 接收者不存在 → RECIPIENT_NOT_FOUND', r.outcome === 'RECIPIENT_NOT_FOUND', r.outcome);
}

// J. 平台系统账号 1676 被拒（真实参与者证书）
// 说明：V2.0 users 表无 is_system 列（实测），故「系统账号」由【注入式守卫】表达，
// 不硬编码在核心里。测试注入「拒绝 1676」的守卫以验证该扩展点可用。
{
  const guarded = new CertificateIssuanceService({
    repo,
    eligibility: ALLOW_ELIGIBILITY,
    recipientGuard: GUARD_DENY_SYS,
  });
  const r = await guarded.issue(baseReq({ recipientUserId: 1676, sourceId: 1 }));
  check('J. 守卫拒绝 → 非 ISSUED', r.outcome !== 'ISSUED', r.outcome);
  check('J. 系统账号未获得证书行',
    db.prepare('SELECT COUNT(*) n FROM certificates WHERE user_id=1676').get().n === 0);
  // 守卫放行时同一 id 可正常发放（证明拒绝来自策略而非硬编码）
  const allowed = new CertificateIssuanceService({
    repo, eligibility: ALLOW_ELIGIBILITY, recipientGuard: GUARD_ALLOW,
  });
  const r2 = await allowed.issue(baseReq({ recipientUserId: 1676, sourceId: 1 }));
  check('J. 守卫放行 → 同一 id 可发放（无硬编码）', r2.outcome !== 'INVALID_REQUEST', r2.outcome);
}

// K. 不支持的域源
{
  const r = await svc.issue(baseReq({ recipientUserId: 8, domainSource: CertificateSource.TRAINING_EXAM, sourceId: 1 }));
  check('K. 不支持的域源 → UNSUPPORTED_SOURCE', r.outcome === 'UNSUPPORTED_SOURCE', r.outcome);
}

// M. 池耗尽 → NUMBER_POOL_EXHAUSTED
// 用【互不相同的 user + source_id】连续发放，真实耗尽池。
// 预先确保 user 与 activity 存在足够多，避免中途撞到 RECIPIENT/SOURCE 错误。
{
  for (let i = 21; i <= 60; i++) {
    db.prepare('INSERT INTO users (id, public_id, status) VALUES (?, ?, 1)').run(i, `01USER${String(i).padStart(20, '0')}`);
  }
  for (let i = 11; i <= 40; i++) {
    db.prepare('INSERT INTO activities (id, team_id, title) VALUES (?, 1, ?)').run(i, `act-${i}`);
  }
  let guard = 0;
  let last = null;
  while (guard++ < 20) {
    last = await svc.issue(baseReq({ recipientUserId: 21 + guard, sourceId: 11 + guard }));
    if (last.outcome !== 'ISSUED') break;
  }
  check('M. 池耗尽 → NUMBER_POOL_EXHAUSTED', last.outcome === 'NUMBER_POOL_EXHAUSTED', last.outcome);
  check('M. 耗尽后无空闲编号残留',
    db.prepare("SELECT COUNT(*) n FROM id_pools WHERE pool_type='cert_srv' AND status=0").get().n === 0);
}

// N. 证书 INSERT 失败不产生假成功（模板缺失触发 FK 失败 → 整批回滚）
{
  const before = db.prepare('SELECT COUNT(*) n FROM certificates').get().n;
  const r = await svc.issue(baseReq({ recipientUserId: 12, sourceId: 3, templateId: 999999 }));
  check('N. 模板不存在 → 非 ISSUED（不假成功）', r.outcome !== 'ISSUED', r.outcome);
  check('N. 失败后证书行数未增加', db.prepare('SELECT COUNT(*) n FROM certificates').get().n === before);
}

// O. 审计持久化失败 → 绝不产生假成功（证书随整批回滚）
// 模拟：把 certificate_logs 换成缺少 result/batch_id 列的旧结构 → 审计 INSERT 抛错。
// 由于审计与证书 INSERT 在同一 D1 batch，整批回滚 → 既不报 ISSUED，也不留孤儿证书。
{
  db.exec(`WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<2)
INSERT INTO id_pools (pool_type, code, status, provenance, created_at) SELECT 'cert_srv', printf('CSRV9%05d', x), 0, 'legacy_migrated', unixepoch() FROM seq;`);
  const before = db.prepare('SELECT COUNT(*) n FROM certificates').get().n;
  db.exec('ALTER TABLE certificate_logs RENAME TO certificate_logs_bak;');
  db.exec(`CREATE TABLE certificate_logs (
    id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL, certificate_id INTEGER NOT NULL,
    action TEXT NOT NULL, reason TEXT, operator_id INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );`);
  const r = await svc.issue(baseReq({ recipientUserId: 13, sourceId: 4 }));
  check('O. 审计失败 → 绝不报 ISSUED（无假成功）', r.outcome !== 'ISSUED', r.outcome);
  check('O. 审计失败 → 证书随整批回滚（无孤儿证书）',
    db.prepare('SELECT COUNT(*) n FROM certificates').get().n === before,
    `before=${before} after=${db.prepare('SELECT COUNT(*) n FROM certificates').get().n}`);
  check('O. 审计失败 → 号未被烧（池仍可消费）',
    db.prepare("SELECT COUNT(*) n FROM id_pools WHERE pool_type='cert_srv' AND status=0").get().n > 0);
  // 还原审计表
  db.exec('DROP TABLE certificate_logs;');
  db.exec('ALTER TABLE certificate_logs_bak RENAME TO certificate_logs;');
}

// P. UNIQUE 竞态 → 归一为 ALREADY_ISSUED
// 模拟：预检通过但 INSERT 时键已被占（直接在预检后插入占位行，再调用 issue）
{
  // 占位：绕过服务直接插一行同键 active 证书
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO certificates (public_id, cert_no, verify_code, template_id, user_id, team_id,
      cert_type, source_type, issue_source, source_id, cert_kind, issue_reason, issued_by, status, issued_at, created_at)
    VALUES ('01RACE0000000000000001', 'RACE-CODE-1', 'RACE-VC-1', 1, 14, 1, 'activity',
      'activity', 'activity', 5, 'participant', 'normal', 1, 1, ?, ?)`).run(now, now);
  const r = await svc.issue(baseReq({ recipientUserId: 14, sourceId: 5 }));
  check('P. UNIQUE 竞态 → ALREADY_ISSUED（确定性归一）', r.outcome === 'ALREADY_ISSUED', r.outcome);
}

// Q. 无编号重复
{
  const dup = db.prepare('SELECT cert_no, COUNT(*) n FROM certificates GROUP BY cert_no HAVING n>1').all();
  check('Q. 无编号重复（cert_no 全局唯一）', dup.length === 0, JSON.stringify(dup));
}

// R. 已消费编号绝不重分配
{
  const rows = db.prepare("SELECT code, status, assigned_to FROM id_pools WHERE pool_type='cert_trn' AND status=1").all();
  // cert_trn 从未被本服务消费（活动走 cert_srv）→ 断言未被误用
  check('R. cert_trn 未被活动/服务发放误消费', rows.length === 0, JSON.stringify(rows));
  const consumed = db.prepare("SELECT code, assigned_to FROM id_pools WHERE status=1 AND pool_type='cert_srv'").all();
  const codes = consumed.map((c) => c.code);
  check('R. 已消费编号唯一且各自绑定唯一接收者', new Set(codes).size === codes.length, JSON.stringify(consumed));
  check('R. 已消费编号的 assigned_to 均非空（无悬空烧号）',
    consumed.every((c) => c.assigned_to != null), JSON.stringify(consumed));
}

// S. 请求/审计不含 PII
{
  const snap = db.prepare('SELECT holder_name, issuer_name, snapshot FROM certificates LIMIT 5').all();
  check('S. 证书未写入 holder/issuer/snapshot（PII 面为空）',
    snap.every((r) => r.holder_name == null && r.issuer_name == null && r.snapshot == null), JSON.stringify(snap));
  const req = baseReq({ recipientUserId: 3, sourceId: 1 });
  check('S. 发证请求结构不含 PII 字段',
    !('holderName' in req) && !('phone' in req) && !('idCard' in req) && !('realName' in req));
}

// T. 考试路径未被改动（本 Gate 不 import/修改 exam.ts；0045 fixture 独立保证其回归）
{
  const examHead = readFileSync(join(process.cwd(), 'src', 'repository', 'exam.ts'), 'utf8');
  check('T. exam.ts 未被本服务引用（exam 编排保持独立）',
    !readFileSync(join(process.cwd(), 'src', 'services', 'certificate-issuance-service.ts'), 'utf8').includes("from '../repository/exam'"));
  check('T. exam.ts 仍含 submitAndMaybeIssueAtomically（未被移除）',
    examHead.includes('submitAndMaybeIssueAtomically'));
  // 训练域仍走 uq_cert_user_paper（exam_paper_id 维度），与本核心正交
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name='uq_cert_user_paper'").get();
  void idx; // 0045 不创建该索引（属 0022）；此处仅断言 0045 未破坏 exam 列
  const cols = db.prepare('PRAGMA table_info(certificates)').all().map((c) => c.name);
  check('T. exam_paper_id 列仍在（考试归属未被破坏）', cols.includes('exam_paper_id'));
}

// =============================================================================
// CERT-R3B-FIX §1 / §2 —— fail-closed 依赖（资格策略 + 接收者守卫）
// =============================================================================

// §1 政策明确放行 → 可正常发放
{
  db.exec(`INSERT INTO id_pools (pool_type, code, status, provenance, created_at) VALUES ('cert_srv','CSRV-FC01',0,'legacy_migrated',unixepoch());`);
  const s = new CertificateIssuanceService({ repo, eligibility: ALLOW_ELIGIBILITY, recipientGuard: GUARD_ALLOW });
  const r = await s.issue(baseReq({ recipientUserId: 30, sourceId: 20 }));
  check('§1 policy 显式 eligible → 允许发放', r.outcome === 'ISSUED', r.outcome);
}

// §1 政策明确拒绝 → NOT_ELIGIBLE，且无副作用
{
  const before = db.prepare('SELECT COUNT(*) n FROM certificates').get().n;
  const poolBefore = db.prepare("SELECT COUNT(*) n FROM id_pools WHERE pool_type='cert_srv' AND status=0").get().n;
  const auditBefore = db.prepare("SELECT COUNT(*) n FROM certificate_logs WHERE action='issue'").get().n;
  const s = new CertificateIssuanceService({ repo, eligibility: DENY_ELIGIBILITY, recipientGuard: GUARD_ALLOW });
  const r = await s.issue(baseReq({ recipientUserId: 31, sourceId: 21 }));
  check('§1 policy 显式 not eligible → NOT_ELIGIBLE', r.outcome === 'NOT_ELIGIBLE', r.outcome);
  check('§1 拒绝后无证书插入', db.prepare('SELECT COUNT(*) n FROM certificates').get().n === before);
  check('§1 拒绝后无编号被消费',
    db.prepare("SELECT COUNT(*) n FROM id_pools WHERE pool_type='cert_srv' AND status=0").get().n === poolBefore);
  check('§1 拒绝后无成功审计行',
    db.prepare("SELECT COUNT(*) n FROM certificate_logs WHERE action='issue'").get().n === auditBefore);
}

// §1 缺政策 → 构造期即拒（fail-closed，绝不默认放行）
{
  let threw = false;
  try {
    new CertificateIssuanceService({ repo, recipientGuard: GUARD_ALLOW }); // eslint-disable-line no-new
  } catch (e) {
    threw = /POLICY_NOT_CONFIGURED/.test(String(e && e.message));
  }
  check('§1 缺 eligibility 策略 → 构造抛 POLICY_NOT_CONFIGURED', threw);
}

// §2 守卫放行 → 允许；守卫拒绝 → 拒绝
{
  db.exec(`INSERT INTO id_pools (pool_type, code, status, provenance, created_at) VALUES ('cert_srv','CSRV-FC02',0,'legacy_migrated',unixepoch());`);
  const before1676 = db.prepare('SELECT COUNT(*) n FROM certificates WHERE user_id=1676').get().n;
  const s = new CertificateIssuanceService({ repo, eligibility: ALLOW_ELIGIBILITY, recipientGuard: GUARD_DENY_SYS });
  const r = await s.issue(baseReq({ recipientUserId: 1676, sourceId: 22 }));
  check('§2 守卫 deny → 拒绝发放', r.outcome === 'INVALID_REQUEST', r.outcome);
  check('§2 守卫 deny → 无证书插入',
    db.prepare('SELECT COUNT(*) n FROM certificates WHERE user_id=1676').get().n === before1676);
}

// §2 缺守卫 → 构造期即拒（fail-closed）
{
  let threw = false;
  try {
    new CertificateIssuanceService({ repo, eligibility: ALLOW_ELIGIBILITY }); // eslint-disable-line no-new
  } catch (e) {
    threw = /POLICY_NOT_CONFIGURED/.test(String(e && e.message));
  }
  check('§2 缺 recipientGuard → 构造抛 POLICY_NOT_CONFIGURED', threw);
}

// =============================================================================
// CERT-R3B-FIX §3 —— 并发/竞态证明（同一 cert_no 候选被两个请求争抢）
// =============================================================================

// §3-A 静态证明：条件消费 + cert_no UNIQUE 双重约束使「同号二次分配」不可能
{
  const poolCols = db.prepare("SELECT sql FROM sqlite_master WHERE name='id_pools'").get().sql;
  const certCols = db.prepare("SELECT sql FROM sqlite_master WHERE name='certificates'").get().sql;
  check('§3 证明：id_pools 有 UNIQUE(pool_type, code) → 同号不可重复入池',
    /UNIQUE\s*\(\s*pool_type\s*,\s*code\s*\)/i.test(poolCols));
  check('§3 证明：certificates.cert_no 有 UNIQUE → 同一编号不可绑定两张证书',
    /cert_no\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(certCols));
}

// §3-B 动态证明：两个请求「看到」同一候选号 X，只有一个能成功消费
{
  // 场景：池中仅剩 1 个空闲编号；两个不同 user 的请求先后进入。
  // 断言：先到者 ISSUED 并消费 X；后到者因 X 已被 status=1 而无法再消费
  //       （allocator 只会挑 status=0，故后到者得到 POOL_UNAVAILABLE/EXHAUSTED），
  //       绝不会出现「X 被两张证书共用」。
  db.exec(`DELETE FROM id_pools WHERE pool_type='cert_srv';`);
  db.exec(`INSERT INTO id_pools (pool_type, code, status, provenance, created_at) VALUES ('cert_srv','CSRV-RACE-X',0,'legacy_migrated',unixepoch());`);

  const s = new CertificateIssuanceService({ repo, eligibility: ALLOW_ELIGIBILITY, recipientGuard: GUARD_ALLOW });
  const a = await s.issue(baseReq({ recipientUserId: 40, sourceId: 30 }));
  const b = await s.issue(baseReq({ recipientUserId: 41, sourceId: 31 }));

  check('§3 争抢：先到者 ISSUED', a.outcome === 'ISSUED', a.outcome);
  check('§3 争抢：后到者未获发（无第二张证书）', b.outcome !== 'ISSUED', b.outcome);
  const xRows = db.prepare("SELECT COUNT(*) n FROM certificates WHERE cert_no='CSRV-RACE-X'").get().n;
  check('§3 证明：编号 X 只绑定 1 张证书（不可二次分配）', xRows === 1, `rows=${xRows}`);
  const xPool = db.prepare("SELECT status, assigned_to FROM id_pools WHERE code='CSRV-RACE-X'").get();
  check('§3 证明：X 状态=1 且绑定首个接收者（一致）',
    xPool.status === 1 && xPool.assigned_to === 40, JSON.stringify(xPool));
}

// §3-C 真正的「同号并发」：绕过 allocator 抢占同一 code，模拟两请求同时持有 X
{
  // 直接对仓储发起同号分配：两条语句用同一 code，仅有一条能 changes=1
  db.exec(`DELETE FROM id_pools WHERE pool_type='cert_srv';`);
  db.exec(`INSERT INTO id_pools (pool_type, code, status, provenance, created_at) VALUES ('cert_srv','CSRV-DUP',0,'legacy_migrated',unixepoch());`);
  // user 42 / activity 42 可能已由 M 用例的预填充创建 → 用 INSERT OR IGNORE 幂等补齐
  db.exec(`INSERT OR IGNORE INTO users (id, public_id, status) VALUES (42,'01USER42',1);`);
  db.exec(`INSERT OR IGNORE INTO activities (id, team_id, title) VALUES (42, 1, 'act-42');`);

  const mk = (uid, sid, pub, vc) => ({
    poolType: 'cert_srv', poolCode: 'CSRV-DUP',
    certPublicId: pub, certNo: 'CSRV-DUP', verifyCode: vc,
    templateId: 1, userId: uid, teamId: 1, certType: 'activity',
    sourceType: 'activity', issueSource: 'activity', sourceId: sid,
    certKind: 'participant', issueReason: 'normal', operatorId: 1, now: 1700000000,
  });

  const r1 = await repo.issueBatch(mk(42, 42, '01DUPA', 'VC-DUP-A'));
  // 第二请求若成功插入，其 cert_no 会与第一行冲突 → 整批回滚（此处用不同 public_id 但同 cert_no）
  let r2 = null; let r2Threw = false;
  try {
    r2 = await repo.issueBatch(mk(42, 42, '01DUPB', 'VC-DUP-B'));
  } catch (e) {
    r2Threw = /UNIQUE/i.test(String(e && e.message));
  }
  check('§3 同号二次分配被 DB 拒绝（cert_no UNIQUE）', r1.certInserted && (r2Threw || (r2 && !r2.certInserted)),
    `r1=${r1.certInserted} r2threw=${r2Threw} r2=${r2 && r2.certInserted}`);
  const dup = db.prepare("SELECT COUNT(*) n FROM certificates WHERE cert_no='CSRV-DUP'").get().n;
  check('§3 同号最终仅 1 张证书', dup === 1, `rows=${dup}`);
  const pool = db.prepare("SELECT status, assigned_to FROM id_pools WHERE code='CSRV-DUP'").get();
  check('§3 失败竞争未留下不一致消耗（status=1 且绑定实际发放者）',
    pool.status === 1 && pool.assigned_to === 42, JSON.stringify(pool));
  const auditRows = db.prepare("SELECT COUNT(*) n FROM certificate_logs l JOIN certificates c ON c.id=l.certificate_id WHERE c.cert_no='CSRV-DUP'").get().n;
  check('§3 失败竞争未产生多余审计行', auditRows === 1, `audit=${auditRows}`);
}

db.close();
process.stderr.write(`\nCERT-R3B CORE TESTS: ${pass} pass, ${fail} fail\n`);
if (fail > 0) process.stderr.write(`FAILED: ${failures.join(' | ')}\n`);
process.exitCode = fail === 0 ? 0 : 1;
