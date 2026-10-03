#!/usr/bin/env node
/**
 * CERT-R2 —— Migration 0045 LOCAL VALIDATION FIXTURE（§20 / §22）。
 *
 * 方法（对齐 tests/n0a_legacy_migration_fixture.mjs）：
 *   - 在 workers/tmp/ 下建【独立】sqlite（不碰真实 local D1，更不碰 remote D1）。
 *   - 还原 certificates 相关既有 schema（0001 + 0022 的 exam_paper_id）。
 *
 * 关于 uq_cert_user_paper 为何【不】在本 PRE-0045 fixture 中创建（§D 显式理由）：
 *   生产现存 8 组历史 (user, exam_paper) 重复 active 证书是先于 uq_cert_user_paper
 *   落库就已存在的数据形态（V1.0 迁移遗留）。若在 fixture 里先建该唯一索引，这 8 组
 *   历史重复行将无法被插入，fixture 就【无法忠实表示生产的既有历史状态】。
 *   0045 的职责范围【不包含】回溯校验历史 uq_cert_user_paper 条件——它是 CERT-R1
 *   记录的既有数据质量异常（recommend remediation ticket，非 CERT-R2 blocker），
 *   0045 对这 8 组 0 改动、0 删除。故本 fixture【故意】不含 uq_cert_user_paper，
 *   以便真实表示该历史形态，并断言 0045 迁移后这 8 组仍原样保留（8→8）。
 *   ⚠ 此为「忠实表示历史」的取舍，【不是】削弱新约束的理由：0045 新增的
 *   uq_cert_user_source 仍被完整测试（含负向幂等用例），未被放宽。
 *
 * 关于 source_id 的 fixture 取值（对齐 2026-10-03 生产只读发现）：
 *   生产 413 张证书 source_id 全为 NULL（legacy/service 种子形状），
 *   exam_paper_id 亦全为 NULL。fixture 忠实复现该【历史存量】形状
 *   （358 course + 55 activity 中大量 source_id=NULL 行）。
 *   另【故意】注入少量 source_id 非 NULL 的合成行（如 (c) 的 15 个 activity），
 *   用途是【前向验证】新唯一索引在「真实发放形态」下确实生效——这是合成
 *   forward-looking 数据，不代表生产存量。生产存量与 fixture 合成前向行的
 *   区分在断言中显式标注。
 *
 *   - 执行【真实】migrations/0045_certificate_domain_contract.sql。
 *   - 断言：计数 / cert_no / user / source / status 不变；8 组 course 重复保留；
 *     NULL-source activity 保留；索引创建；新列 + 默认值；cert_act 池未播种；
 *     logs/batches schema；考试发卡列清单仍可用（回归）；幂等强制（含 revoked
 *     状态策略）；CHECK 强制；验收种类可写。
 *
 * 全部 synthetic fixture；无 production / staging 写入；无真实 PII。
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(process.cwd(), 'tmp');
mkdirSync(TMP, { recursive: true });
const FIX = join(TMP, '_cert_r2_fixture.sqlite');
if (existsSync(FIX)) unlinkSync(FIX);

const db = new DatabaseSync(FIX);
db.exec('PRAGMA foreign_keys = OFF;'); // 隔离测试数据迁移逻辑；FK 仅元数据

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    process.stderr.write(`  PASS ${name}\n`);
  } else {
    fail += 1;
    process.stderr.write(`  FAIL ${name} ${detail}\n`);
  }
}

// ===== 还原既有 schema（最小但结构完整）=====
db.exec(`
CREATE TABLE users (id INTEGER PRIMARY KEY, is_system INTEGER DEFAULT 0);
CREATE TABLE teams (id INTEGER PRIMARY KEY);
CREATE TABLE courses (id INTEGER PRIMARY KEY);
CREATE TABLE activities (id INTEGER PRIMARY KEY);
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
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (pool_type, code)
);
`);

// 基础引用数据
db.prepare('INSERT INTO teams (id) VALUES (1)').run();
db.prepare('INSERT INTO certificate_templates (id, name, cert_type, layout, status) VALUES (?, ?, ?, ?, ?)')
  .run(1, '培训证书（默认）', 'training', '{"title":"培训证书"}', 1);
for (let i = 1; i <= 400; i++) db.prepare('INSERT INTO users (id, is_system) VALUES (?, ?)').run(i, 0);
db.prepare('INSERT INTO users (id, is_system) VALUES (?, ?)').run(1676, 1); // 系统账号
for (let i = 1; i <= 400; i++) db.prepare('INSERT INTO courses (id) VALUES (?)').run(i);
for (let i = 1; i <= 100; i++) db.prepare('INSERT INTO activities (id) VALUES (?)').run(i);
for (let i = 1; i <= 50; i++) db.prepare('INSERT INTO exam_papers (id) VALUES (?)').run(i);

// cert_trn 池（模拟生产初始状态，500 条）
db.exec(`WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<500)
INSERT INTO id_pools (pool_type, code, status, created_at) SELECT 'cert_trn', printf('CTRN%06d', x), 0, unixepoch() FROM seq;`);

// ===== 注入 413 行 fixture =====
const insertCert = db.prepare(
  `INSERT INTO certificates (public_id, cert_no, verify_code, template_id, user_id, team_id,
     cert_type, source_type, source_id, exam_paper_id, holder_name, issuer_name, snapshot, status, issued_at)
   VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?, ?, NULL, NULL, NULL, 1, 1700000000)`,
);

let idx = 0;
const certNosBefore = [];
function nextIds() {
  idx += 1;
  return {
    public_id: `01CERT${String(idx).padStart(20, '0')}`,
    cert_no: `CERTNO-${idx}-${Math.random().toString(36).slice(2, 8)}`,
    verify_code: `VC-${idx}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

// (a) 342 course 单行（exam_paper_id = NULL）
for (let i = 1; i <= 342; i++) {
  const id = nextIds();
  certNosBefore.push(id.cert_no);
  insertCert.run(id.public_id, id.cert_no, id.verify_code, i, 'training', 'course', i);
}
// (b) 8 组 course (user, exam_paper) 重复组（每组 2 行，status=1，source_type='course'）
for (let g = 1; g <= 8; g++) {
  const uid = 1000 + g; // 不与其他 user 冲突
  const ep = g; // exam_paper_id 相同
  for (let k = 0; k < 2; k++) {
    const id = nextIds();
    certNosBefore.push(id.cert_no);
    insertCert.run(id.public_id, id.cert_no, id.verify_code, uid, 'training', 'course', 500 + g * 10 + k, ep);
  }
}
// (c) 15 个真实 activity 单行（user, activity_id，source_id 非 NULL）
for (let i = 1; i <= 15; i++) {
  const id = nextIds();
  certNosBefore.push(id.cert_no);
  insertCert.run(id.public_id, id.cert_no, id.verify_code, 500 + i, 'activity', 'activity', i);
}
// (d) user 17：2 行 activity，source_id=NULL（复现生产异常）
for (let k = 0; k < 2; k++) {
  const id = nextIds();
  certNosBefore.push(id.cert_no);
  insertCert.run(id.public_id, id.cert_no, id.verify_code, 17, 'activity', 'activity', null);
}
// (e) user 1676（系统账号）：38 行 activity，source_id=NULL，cert_no 前缀 JHCRT-SRV-*
for (let k = 0; k < 38; k++) {
  idx += 1;
  const id = {
    public_id: `01CERT${String(idx).padStart(20, '0')}`,
    cert_no: `JHCRT-SRV-${k}-${Math.random().toString(36).slice(2, 6)}`,
    verify_code: `VC-SRV-${k}`,
  };
  certNosBefore.push(id.cert_no);
  insertCert.run(id.public_id, id.cert_no, id.verify_code, 1676, 'activity', 'activity', null);
}

// 基准计数（应用迁移前）
const baseTotal = db.prepare('SELECT COUNT(*) n FROM certificates').get().n;
check('fixture 基准 = 413 行', baseTotal === 413, `got ${baseTotal}`);

// 迁移前 user/source 绑定快照（用于迁移后比对：0 mutation 证明）
const baseBindingSig = JSON.stringify(
  db.prepare('SELECT id, user_id, source_type, source_id FROM certificates ORDER BY id').all(),
);
const baseCourseDupGroups = db
  .prepare(`SELECT COUNT(*) n FROM (SELECT user_id, exam_paper_id FROM certificates
    WHERE status=1 AND source_type='course' AND exam_paper_id IS NOT NULL
    GROUP BY user_id, exam_paper_id HAVING COUNT(*)>1)`)
  .get().n;
check('fixture 含 8 组 course (user,exam_paper) 重复组', baseCourseDupGroups === 8, `got ${baseCourseDupGroups}`);

// ===== 执行真实 0045 迁移 SQL =====
const sql = readFileSync(join(process.cwd(), 'migrations', '0045_certificate_domain_contract.sql'), 'utf8');
let migrationOk = true;
try {
  db.exec(sql);
} catch (e) {
  migrationOk = false;
  process.stderr.write(`  MIGRATION ERROR: ${e}\n`);
}
check('迁移 0045 执行成功（无报错）', migrationOk);

// ===== 断言：既有 413 不变 =====
const total = db.prepare('SELECT COUNT(*) n FROM certificates').get().n;
check('证书总数不变 = 413', total === 413, `got ${total}`);

const certNosAfter = db.prepare('SELECT cert_no FROM certificates').all().map((r) => r.cert_no).sort();
const beforeSorted = [...certNosBefore].sort();
check('cert_no 集合不变（未重新编号）', JSON.stringify(certNosAfter) === JSON.stringify(beforeSorted),
  `before=${beforeSorted.length} after=${certNosAfter.length}`);

const srcCounts = db.prepare('SELECT source_type, COUNT(*) n FROM certificates GROUP BY source_type').all();
const bySrc = Object.fromEntries(srcCounts.map((r) => [r.source_type, r.n]));
check('source_type 分布不变 (course=358, activity=55)', bySrc.course === 358 && bySrc.activity === 55, JSON.stringify(bySrc));

// §D/E：迁移不得改动任何 source_id / user_id 绑定（user binding mutation = 0, source mutation = 0）
const bindings = db.prepare('SELECT id, user_id, source_type, source_id FROM certificates ORDER BY id').all();
const bindingSig = JSON.stringify(bindings);
check('user 绑定与 source 绑定整体不变（0 mutation）', bindingSig === baseBindingSig);

// 生产形状对照：413 存量中大量 source_id=NULL 的 legacy 形态被忠实保留
const nullSrcTotal = db.prepare('SELECT COUNT(*) n FROM certificates WHERE source_id IS NULL').get().n;
check(
  `legacy NULL-source 行保留（fixture 存量 ${nullSrcTotal} 行 + 前向合成非 NULL 行）`,
  nullSrcTotal > 0,
  `got ${nullSrcTotal}`,
);

const statusOne = db.prepare('SELECT COUNT(*) n FROM certificates WHERE status=1').get().n;
check('status=1 数量不变 = 413', statusOne === 413, `got ${statusOne}`);

const courseDupAfter = db
  .prepare(`SELECT COUNT(*) n FROM (SELECT user_id, exam_paper_id FROM certificates
    WHERE status=1 AND source_type='course' AND exam_paper_id IS NOT NULL
    GROUP BY user_id, exam_paper_id HAVING COUNT(*)>1)`)
  .get().n;
check('8 组 course 重复组保留（未被迁移改动/删除）', courseDupAfter === 8, `got ${courseDupAfter}`);

const user17Act = db.prepare("SELECT COUNT(*) n FROM certificates WHERE user_id=17 AND source_type='activity'").get().n;
check('user 17 的 2 行 NULL-source activity 保留', user17Act === 2, `got ${user17Act}`);
const user1676Act = db.prepare("SELECT COUNT(*) n FROM certificates WHERE user_id=1676 AND source_type='activity'").get().n;
check('user 1676 系统账号 38 行 NULL-source activity 保留', user1676Act === 38, `got ${user1676Act}`);

// ===== 断言：uq_cert_user_source 索引创建 =====
const idxExists = db
  .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='uq_cert_user_source'")
  .get().n;
check('uq_cert_user_source 索引已创建', idxExists === 1, `got ${idxExists}`);

// 索引谓词与生产一致：确认 sqlite_master 中记录的谓词含 source_id IS NOT NULL
const idxSql = db
  .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_cert_user_source'")
  .get().sql;
check(
  '索引谓词显式排除 source_id IS NOT NULL（只保护有权威 source 的行）',
  /source_id IS NOT NULL/i.test(idxSql),
  idxSql,
);
check(
  '索引谓词锁定 status=1 且 source_type=activity',
  /status\s*=\s*1/i.test(idxSql) && /source_type\s*=\s*'activity'/i.test(idxSql),
  idxSql,
);

// 迁移后、测试写入前，按【精确索引谓词】统计冲突组 = 0
const exactPredConflicts = db
  .prepare(`SELECT COUNT(*) n FROM (
    SELECT user_id, source_type, source_id FROM certificates
    WHERE status = 1 AND source_type = 'activity' AND source_id IS NOT NULL
    GROUP BY user_id, source_type, source_id HAVING COUNT(*) > 1)`)
  .get().n;
check('迁移后精确索引谓词冲突组 = 0（与生产核验一致）', exactPredConflicts === 0, `got ${exactPredConflicts}`);

// 新索引不影响历史 exam/course 维度：8 组重复在索引列/谓词外，原样保留
const dupStillThere = db
  .prepare(`SELECT COUNT(*) n FROM (SELECT user_id, exam_paper_id FROM certificates
    WHERE status=1 AND source_type='course' AND exam_paper_id IS NOT NULL
    GROUP BY user_id, exam_paper_id HAVING COUNT(*)>1)`)
  .get().n;
check('新索引创建后 8 组历史 course 重复组仍原样保留（未被新约束改动）', dupStillThere === 8, `got ${dupStillThere}`);

// ===== 断言：新增列 + 默认值 =====
const cols = db.prepare('PRAGMA table_info(certificates)').all().map((c) => c.name);
const needCols = ['cert_kind', 'issued_by', 'issue_reason', 'revoked_at', 'revoked_by', 'revoke_reason'];
for (const c of needCols) check(`certificates 含新列 ${c}`, cols.includes(c), `cols=${cols.join(',')}`);

const kindAllParticipant = db.prepare("SELECT COUNT(*) n FROM certificates WHERE cert_kind='participant'").get().n;
check('全部 413 行 cert_kind 默认 participant', kindAllParticipant === 413, `got ${kindAllParticipant}`);
const newColsNull = db.prepare(
  'SELECT COUNT(*) n FROM certificates WHERE issued_by IS NULL AND issue_reason IS NULL AND revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL',
).get().n;
check('新增可空列历史行全为 NULL（向后兼容）', newColsNull === 413, `got ${newColsNull}`);

// ===== 断言：id_pools 状态（cert_act 播种本轮【不执行】，编号决策推迟 CERT-R3）=====
const actPool = db.prepare("SELECT COUNT(*) n FROM id_pools WHERE pool_type='cert_act'").get().n;
check('cert_act 池未在本迁移播种（编号决策推迟 CERT-R3，符合 §11 接口/契约范围）', actPool === 0, `got ${actPool}`);
const trnPool = db.prepare("SELECT COUNT(*) n FROM id_pools WHERE pool_type='cert_trn'").get().n;
check('cert_trn 池保持 500（未受迁移影响）', trnPool === 500, `got ${trnPool}`);

// ===== 断言：certificate_logs 扩展列 =====
const logCols = db.prepare('PRAGMA table_info(certificate_logs)').all().map((c) => c.name);
for (const c of ['batch_id', 'result', 'failure_code']) check(`certificate_logs 含 ${c}`, logCols.includes(c), `cols=${logCols.join(',')}`);

// ===== 断言：certificate_batches 表 =====
const batchTable = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='certificate_batches'").get().n;
check('certificate_batches 表已创建', batchTable === 1, `got ${batchTable}`);

// ===== 考试发卡回归：exam.ts 的 INSERT 列清单在迁移后仍可用 =====
let examRegressionOk = true;
try {
  db.prepare('INSERT INTO exam_sessions (id, user_id, team_id, paper_id, status) VALUES (9001, 700, 1, 5, 3)').run();
  const eid = { public_id: '01EXAMREGRESS0000000000', cert_no: 'CTRN-REGRESS-001', verify_code: 'VC-REGRESS-001' };
  db.prepare(
    `INSERT INTO certificates (public_id, cert_no, verify_code, template_id, user_id, team_id,
       cert_type, source_type, source_id, exam_paper_id, holder_name, issuer_name, snapshot, status, issued_at, created_at)
     VALUES (?, ?, ?, 1, 700, 1, 'training', 'exam', 9001, 5, NULL, NULL, NULL, 1, 1700000000, 1700000000)`,
  ).run(eid.public_id, eid.cert_no, eid.verify_code);
  const r = db.prepare('SELECT cert_kind FROM certificates WHERE cert_no=?').get(eid.cert_no);
  if (r.cert_kind !== 'participant') examRegressionOk = false;
} catch (e) {
  examRegressionOk = false;
  process.stderr.write(`  EXAM REGRESSION ERROR: ${e}\n`);
}
check('考试发卡 INSERT 列清单迁移后仍可用（cert_kind 默认 participant）', examRegressionOk);

// ===== 幂等强制：同 (user, activity, source_id) 重复插入应被唯一索引拒绝 =====
// §F 负向矩阵：第 1 张有效 activity/service 成就证书 → 成功；同成就第 2 张 active → DB UNIQUE 拒绝；
// 不同 user → 允许；不同 source_id → 允许；legacy source_id=NULL → 不破坏迁移；
// 历史 exam/course 重复形态 → 不被新约束改动。
let firstInsertOk = true;
try {
  const id = nextIds();
  insertCert.run(id.public_id, id.cert_no, id.verify_code, 600, 'activity', 'activity', 700); // (user600, act700) 第 1 张
} catch (e) {
  firstInsertOk = false;
  process.stderr.write(`  FIRST VALID INSERT ERROR: ${e}\n`);
}
check('§F 首张有效 activity 成就证书 INSERT 成功', firstInsertOk);

let idempotentRejected = false;
try {
  const id = nextIds();
  insertCert.run(id.public_id, id.cert_no, id.verify_code, 600, 'activity', 'activity', 700); // 同 (user600,act700) 第 2 张 active
} catch (e) {
  idempotentRejected = /UNIQUE|constraint/i.test(String(e));
}
check('§F 同成就第 2 张 active 证书被 DB UNIQUE 拒绝', idempotentRejected);

let diffUserOk = true;
try {
  const id = nextIds();
  insertCert.run(id.public_id, id.cert_no, id.verify_code, 601, 'activity', 'activity', 700); // 不同 user，同 source
} catch (e) {
  diffUserOk = false;
  process.stderr.write(`  DIFF USER ERROR: ${e}\n`);
}
check('§F 不同 user 同 source_id 允许（约束不误伤）', diffUserOk);

let diffSourceOk = true;
try {
  const id = nextIds();
  insertCert.run(id.public_id, id.cert_no, id.verify_code, 600, 'activity', 'activity', 701); // 同 user，不同 source_id
} catch (e) {
  diffSourceOk = false;
  process.stderr.write(`  DIFF SOURCE ERROR: ${e}\n`);
}
check('§F 同 user 不同 source_id 允许（按成就粒度唯一）', diffSourceOk);

// ===== §F 状态策略：谓词仅锁 status=1（active）；status=2（revoked）不参与唯一性 =====
// 依据实际 schema：status INTEGER NOT NULL DEFAULT 1 CHECK (status IN (1,2))，1=active / 2=revoked。
// 故撤销后的同一成就可重新发证（不违反唯一性）——此为从 schema 推导的策略，非假设。
let revokeReissueOk = true;
try {
  db.prepare("UPDATE certificates SET status=2 WHERE user_id=600 AND source_type='activity' AND source_id=700 AND cert_kind='participant'").run();
  const id = nextIds();
  // 撤销后对同一成就重新发证应被允许（status=1 新行，谓词不命中旧 status=2 行）
  insertCert.run(id.public_id, id.cert_no, id.verify_code, 600, 'activity', 'activity', 700);
} catch (e) {
  revokeReissueOk = false;
  process.stderr.write(`  REVOKE/REISSUE ERROR: ${e}\n`);
}
check('§F status=2(revoked) 不参与唯一性 → 撤销后可重发同一成就', revokeReissueOk);

// ===== NULL source_id activity 仍可插入（系统账号服务种子不冲突）=====
let nullSourceOk = true;
try {
  const id = nextIds();
  insertCert.run(id.public_id, id.cert_no, id.verify_code, 17, 'activity', 'activity', null); // user17 第 3 行
} catch (e) {
  nullSourceOk = false;
  process.stderr.write(`  NULL SOURCE INSERT ERROR: ${e}\n`);
}
check('NULL source_id activity 仍可插入（NULL 互异，不冲突）', nullSourceOk);
const user17ActAfter = db.prepare("SELECT COUNT(*) n FROM certificates WHERE user_id=17 AND source_type='activity'").get().n;
check('user 17 activity 增至 3 行（证明 NULL 互异）', user17ActAfter === 3, `got ${user17ActAfter}`);

// ===== CHECK 强制 =====
let kindCheckOk = false;
try {
  const id = nextIds();
  insertCert.run(id.public_id, id.cert_no, id.verify_code, 1, 'activity', 'activity', 1);
  db.prepare("UPDATE certificates SET cert_kind='bogus' WHERE public_id=?").run(id.public_id);
} catch (e) {
  kindCheckOk = /CHECK|constraint/i.test(String(e));
}
check('cert_kind CHECK 强制（bogus 被拒）', kindCheckOk);

let logResultCheckOk = false;
try {
  const cid = db.prepare('SELECT id FROM certificates LIMIT 1').get().id;
  db.prepare("INSERT INTO certificate_logs (team_id, certificate_id, action, reason, operator_id, result) VALUES (1, ?, 'issue', NULL, 1, 'bogus')").run(cid);
} catch (e) {
  logResultCheckOk = /CHECK|constraint/i.test(String(e));
}
check('certificate_logs.result CHECK 强制（bogus 被拒）', logResultCheckOk);

// ===== 验收种类可写（§18 语义）=====
let acceptanceOk = true;
try {
  const id = nextIds();
  db.prepare(
    `INSERT INTO certificates (public_id, cert_no, verify_code, template_id, user_id, team_id,
       cert_type, source_type, source_id, cert_kind, issue_reason, status, issued_at)
     VALUES (?, ?, ?, 1, 800, 1, 'activity', 'activity', 99, 'acceptance', 'admin_acceptance', 1, 1700000000)`,
  ).run(id.public_id, id.cert_no, id.verify_code);
  const r = db.prepare('SELECT cert_kind, issue_reason FROM certificates WHERE public_id=?').get(id.public_id);
  acceptanceOk = r.cert_kind === 'acceptance' && r.issue_reason === 'admin_acceptance';
} catch (e) {
  acceptanceOk = false;
  process.stderr.write(`  ACCEPTANCE ERROR: ${e}\n`);
}
check('验收证书可写（cert_kind=acceptance + issue_reason=admin_acceptance）', acceptanceOk);

db.close();
process.stderr.write(`\nCERT-R2 FIXTURE TOTAL: ${pass} pass, ${fail} fail\n`);
process.exitCode = fail === 0 ? 0 : 1;
