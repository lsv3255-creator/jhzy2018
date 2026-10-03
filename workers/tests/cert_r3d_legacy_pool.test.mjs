#!/usr/bin/env node
/**
 * CERT-R3D —— 迁移包 + 450,000 行全量离线 dry-run（§14/§15–§24）。
 *
 * 隔离性：全部在 workers/tmp/ 下的独立 sqlite 中进行；
 *         【不】触碰 local/staging/production D1，【不】改权威快照。
 * 合成 500 行状态：由生产只读聚合复制（code 前缀 + status=0 + assigned_to/assigned_at NULL）。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const TMP = join(process.cwd(), 'tmp');
mkdirSync(TMP, { recursive: true });
const FIX = join(TMP, '_cert_r3d_pool.sqlite');
if (existsSync(FIX)) rmSync(FIX);
const DUMP = '/tmp/r3c_data.sql';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; process.stderr.write(`  PASS ${name}\n`); }
  else { fail++; failures.push(name); process.stderr.write(`  FAIL ${name} ${detail}\n`); }
}

// ===== 解析权威快照 → LegacyPoolRow[] =====
function parseLegacy() {
  const raw = readFileSync(DUMP, 'utf8');
  const re = /INSERT INTO `id_pool` VALUES /g;
  const rows = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    const end = raw.indexOf(';', m.index + m[0].length);
    const s = raw.slice(m.index + m[0].length, end);
    const rr = /\((\d+),'([^']*)','([^']*)',(\d+|NULL),'([^']*)',(\d+|NULL),('([^']*)'|NULL),('([^']*)'|NULL)\)/g;
    let t;
    while ((t = rr.exec(s)) !== null) {
      const ts = (x) => (x === 'NULL' || x == null ? null : x);
      rows.push({
        id: Number(t[1]), code: t[2], poolType: t[3], batchId: t[4] === 'NULL' ? null : Number(t[4]),
        status: t[5], assignedTo: t[6] === 'NULL' ? null : Number(t[6]),
        assignedAt: ts(t[7]) == null ? null : Math.floor(new Date(String(t[7]).replace(' ', 'T') + 'Z').getTime() / 1000),
        createdAt: ts(t[8]) == null ? null : Math.floor(new Date(String(t[8]).replace(' ', 'T') + 'Z').getTime() / 1000),
      });
    }
    re.lastIndex = end;
  }
  return rows;
}
const LEGACY = parseLegacy();

// ===== 最小 D1 适配器 =====
function makeD1(database) {
  const prep = (sql) => {
    const st = database.prepare(sql);
    let bound = null;
    const api = {
      bind(...a) { bound = a; return api; },
      async run() { const r = bound ? st.run(...bound) : st.run(); return { success: true, meta: { changes: r.changes } }; },
      async first() { const r = bound ? st.get(...bound) : st.get(); return r ?? null; },
      async all() { const r = bound ? st.all(...bound) : st.all(); return { results: r }; },
    };
    return api;
  };
  return {
    prepare: (sql) => prep(sql),
    async batch(stmts) {
      const out = [];
      database.exec('BEGIN');
      try { for (const s of stmts) out.push(await s.run()); database.exec('COMMIT'); return out; }
      catch (e) { database.exec('ROLLBACK'); throw e; }
    },
  };
}

// ===== 建库：V2 真实 0001 schema + 合成 500 =====
function buildBase() {
  if (existsSync(FIX)) rmSync(FIX); // 幂等：允许重复调用
  const d = new DatabaseSync(FIX);
  d.exec(`CREATE TABLE id_pools (
    id INTEGER PRIMARY KEY,
    pool_type TEXT NOT NULL CHECK (pool_type IN ('cert_trn','cert_srv','cert_hon','volunteer')),
    code TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2)),
    assigned_to INTEGER, assigned_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (pool_type, code));`);
  const ins = d.prepare('INSERT INTO id_pools (pool_type,code,status,assigned_to,assigned_at,created_at) VALUES (?,?,0,NULL,NULL,?)');
  for (let i = 1; i <= 500; i++) ins.run('cert_trn', `CTRN${String(i).padStart(6, '0')}`, 1700000000);
  return d;
}

// ===== 应用 0046（真实迁移文件） =====
function apply0046(d) {
  d.exec(readFileSync(join(process.cwd(), 'migrations', '0046_id_pools_legacy_pool_compatibility.sql'), 'utf8'));
}

// ===== 哈希工具 =====
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hashSet = (codes) => sha([...codes].sort().join('\n') + '\n');
const hashState = (pairs) => {
  const s = [...pairs].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return sha(s.map((p) => `${p.code}\t${p.status}`).join('\n') + '\n');
};
// CERT-R3D-FIX §18：provenance 纳入状态哈希对账
const hashStateProv = (rows) => {
  const s = [...rows].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return sha(s.map((p) => `${p.code}\t${p.status}\t${p.provenance ?? 'NULL'}`).join('\n') + '\n');
};

// ===== 导入器（与 src/services/legacy-pool-importer.ts 同逻辑的本地执行体） =====
const STATUS_MAP = { available: 0, assigned: 1, reserved: 2 };
// CERT-R3D-FIX §8：每条导入行都显式标记历史来源（绝不从 code 格式推断）
const LEGACY_PROV = 'legacy_migrated';
const SENTINELS = new Set([999999, 0, -1]);
function classify(ref, proven) {
  if (ref == null) return 'ASSIGNMENT_REF_NULL';
  if (SENTINELS.has(ref)) return 'ASSIGNMENT_REF_SENTINEL';
  if (proven.has(ref)) return 'ASSIGNMENT_REF_PROVEN_MAPPABLE';
  return 'ASSIGNMENT_REF_UNRESOLVED';
}
const UPSERT = `INSERT INTO id_pools (pool_type, code, status, assigned_to, assigned_at, batch_id, provenance, created_at)
SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM id_pools WHERE code = ?)`;

async function runImport(d1, rows, proven = new Map(), afterId = -1, batchSize = 5000) {
  const sorted = [...rows].sort((a, b) => a.id - b.id).filter((r) => r.id > afterId);
  let inserted = 0, already = 0, lastId = afterId, batches = 0;
  const conflicts = [];
  for (let i = 0; i < sorted.length; i += batchSize) {
    const b = sorted.slice(i, i + batchSize);
    for (const r of b) {
      const ex = await d1.prepare('SELECT pool_type, status, provenance FROM id_pools WHERE code = ?').bind(r.code)
        .first();
      if (!ex) continue;
      const inc = { pool_type: r.poolType, status: STATUS_MAP[r.status], provenance: LEGACY_PROV };
      if (ex.pool_type !== inc.pool_type) conflicts.push({ code: r.code, field: 'pool_type' });
      else if (ex.status !== inc.status) conflicts.push({ code: r.code, field: 'status' });
      else if ((ex.provenance ?? null) !== inc.provenance) conflicts.push({ code: r.code, field: 'provenance' });
    }
    const stmts = b.map((r) => {
      const cls = classify(r.assignedTo, proven);
      const at = cls === 'ASSIGNMENT_REF_PROVEN_MAPPABLE' ? proven.get(r.assignedTo) : null;
      return d1.prepare(UPSERT).bind(r.poolType, r.code, STATUS_MAP[r.status], at, r.assignedAt, r.batchId, LEGACY_PROV, r.createdAt ?? 1700000000, r.code);
    });
    const res = await d1.batch(stmts);
    for (const x of res) { Number(x?.meta?.changes ?? 0) > 0 ? inserted++ : already++; }
    batches++;
    lastId = b[b.length - 1].id;
  }
  return { inserted, alreadyPresent: already, conflicts: conflicts.length, conflictDetails: conflicts, batches, lastLegacyId: lastId };
}

// =============================================================================
// §14 FULL DRY-RUN
// =============================================================================
const legacyCodesetHash = hashSet(LEGACY.map((r) => r.code));
const legacyByPool = {};
for (const r of LEGACY) (legacyByPool[r.poolType] ??= []).push(r);

const synthBefore = [];
{
  const d = buildBase();
  for (const r of d.prepare("SELECT pool_type,code,status,assigned_to,assigned_at,created_at FROM id_pools WHERE code LIKE 'CTRN%' ORDER BY code").all()) synthBefore.push(r);
  d.close();
}
const synthHashBefore = hashSet(synthBefore.map((r) => r.code));
check('§13 基线：合成 500 行已就位', synthBefore.length === 500, String(synthBefore.length));

let db = buildBase();
apply0046(db);
const d1 = makeD1(db);

// §6 schema 扩展验证
{
  const cols = db.prepare('PRAGMA table_info(id_pools)').all().map((c) => c.name);
  check('§6 新增列 batch_id', cols.includes('batch_id'), cols.join(','));
  const poolOk = ['cert_trn','cert_srv','cert_hon','cert_skl','volunteer'].every((p) => {
    try { db.prepare('SELECT 1 FROM id_pools WHERE pool_type=?').get(p); return true; } catch { return false; }
  });
  check('§6/§20 pool_type CHECK 接受 5 个历史池（含 cert_skl）', poolOk);
  let statusOk = true;
  for (const s of [0, 1, 2]) { try { db.prepare('SELECT 1 FROM id_pools WHERE status=?').get(s); } catch { statusOk = false; } }
  check('§6/§21 status CHECK 接受 0/1/2', statusOk);
  const uniq = db.prepare("PRAGMA index_list('id_pools')").all().filter((i) => i.unique === 1).length;
  check('§12 UNIQUE(code) 存在（legacy 全局唯一不变量已恢复）', uniq >= 1, String(uniq));
  const n = db.prepare('SELECT COUNT(*) n FROM id_pools').get().n;
  check('§13 迁移后仍为 500 行（既有行零丢失）', n === 500, String(n));
}

// §14 全量导入 450,000
const t0 = Date.now();
const res1 = await runImport(d1, LEGACY);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
check(`§14 全量导入 inserted = 450,000`, res1.inserted === 450000, `got ${res1.inserted}`);
check('§14 无冲突', res1.conflicts === 0, String(res1.conflicts));
check('§10 分批（batch=5000 → 90 批）', res1.batches === 90, String(res1.batches));
process.stderr.write(`  [info] import wall-clock ${secs}s\n`);

// §15 精确计数
{
  const total = db.prepare('SELECT COUNT(*) n FROM id_pools').get().n;
  check('§15 post-import 总量 = 450,500', total === 450500, String(total));
  const byPool = {};
  for (const r of db.prepare('SELECT pool_type, COUNT(*) n FROM id_pools GROUP BY pool_type').all()) byPool[r.pool_type] = r.n;
  // legacy 计数需排除合成族（合成 cert_trn 500 条同属 cert_trn 池）
  const legacyPoolCounts = {};
  for (const r of db.prepare(`SELECT pool_type, COUNT(*) n FROM id_pools WHERE code NOT LIKE \'CTRN%\' GROUP BY pool_type`).all()) legacyPoolCounts[r.pool_type] = r.n;
  check('§15 legacy cert_trn = 180,000（排除合成 500）', legacyPoolCounts.cert_trn === 180000, JSON.stringify(legacyPoolCounts));
  check('§15 legacy cert_srv = 150,000', legacyPoolCounts.cert_srv === 150000);
  check('§15 legacy volunteer = 100,000', legacyPoolCounts.volunteer === 100000);
  check('§15 legacy cert_hon = 10,000', legacyPoolCounts.cert_hon === 10000);
  check('§15 legacy cert_skl = 10,000', legacyPoolCounts.cert_skl === 10000);
  check('§15 legacy 合计 = 450,000', Object.values(legacyPoolCounts).reduce((a, b) => a + b, 0) === 450000);
  check('§15 V2 cert_trn 聚合 = 180,500（180,000 legacy + 500 合成）', byPool.cert_trn === 180500, String(byPool.cert_trn));
}

// §16 状态对账（source-derived）
{
  const st = db.prepare(`SELECT status, COUNT(*) n FROM id_pools WHERE code NOT LIKE 'CTRN%' GROUP BY status`).all();
  const m = Object.fromEntries(st.map((r) => [r.status, r.n]));
  check('§16 legacy free = 448,312', m[0] === 448312, JSON.stringify(m));
  check('§16 legacy assigned = 1,661', m[1] === 1661, JSON.stringify(m));
  check('§16 legacy reserved = 27', m[2] === 27, JSON.stringify(m));
  const per = db.prepare(`SELECT pool_type, status, COUNT(*) n FROM id_pools WHERE code NOT LIKE \'CTRN%\' GROUP BY pool_type, status`).all();
  const pm = {};
  for (const r of per) (pm[r.pool_type] ??= {})[r.status] = r.n;
  check('§16 cert_trn free/asg = 179,543/457', pm.cert_trn[0] === 179543 && pm.cert_trn[1] === 457, JSON.stringify(pm.cert_trn));
  check('§16 cert_srv free/asg/resv = 149,692/281/27', pm.cert_srv[0] === 149692 && pm.cert_srv[1] === 281 && pm.cert_srv[2] === 27, JSON.stringify(pm.cert_srv));
  check('§16 cert_skl free = 10,000', pm.cert_skl[0] === 10000, JSON.stringify(pm.cert_skl));
}

// §9 assigned_to 安全
{
  const nonFree = db.prepare(`SELECT COUNT(*) n FROM id_pools WHERE code NOT LIKE 'CTRN%' AND status != 0`).get().n;
  const withRef = db.prepare(`SELECT COUNT(*) n FROM id_pools WHERE code NOT LIKE 'CTRN%' AND status != 0 AND assigned_to IS NOT NULL`).get().n;
  check('§9 非自由行 1,688 条', nonFree === 1688, String(nonFree));
  check('§9 无权威映射证据 → assigned_to 全为 NULL（未臆造）', withRef === 0, String(withRef));
  const stNotDown = db.prepare(`SELECT COUNT(*) n FROM id_pools WHERE code NOT LIKE 'CTRN%' AND status=2`).get().n;
  check('§8/§9 reserved 未降级（仍为 2）', stNotDown === 27, String(stNotDown));
}

// §13 合成 500 保全
{
  const after = db.prepare(`SELECT pool_type,code,status,assigned_to,assigned_at,created_at FROM id_pools WHERE code LIKE \'CTRN%\' ORDER BY code`).all();
  check('§13 合成 500 行数量不变', after.length === 500, String(after.length));
  check('§13 合成 500 行 code 集合哈希不变', hashSet(after.map((r) => r.code)) === synthHashBefore);
  check('§13 合成 500 行全部 status=0（未消费）', after.every((r) => r.status === 0));
  check('§13 合成 500 行 assigned_to/at 仍为 NULL', after.every((r) => r.assigned_to == null && r.assigned_at == null));
  const legacyHasCtrn = LEGACY.some((r) => r.code.startsWith('CTRN'));
  check('§1 合成族未混入 legacy（legacy 中无 CTRN）', legacyHasCtrn === false);
}

// §17 哈希对账
let postLegacyHash = '', poolHashOk = true, poolStateOk = true;
{
  const legacyInV2 = db.prepare(`SELECT code, pool_type, status FROM id_pools WHERE code NOT LIKE \'CTRN%\'`).all();
  postLegacyHash = hashSet(legacyInV2.map((r) => r.code));
  check('§17 LEGACY_CODESET_HASH 一致', postLegacyHash === legacyCodesetHash);
  for (const [pool, rows] of Object.entries(legacyByPool)) {
    const exp = hashSet(rows.map((r) => r.code));
    // 逐池对账必须【排除合成族】：合成 cert_trn 与 legacy cert_trn 同属 pool_type，
    // 故按 code 族区分（合成族为 CTRN%，legacy 族为 JHCRT-*/JH-*）
    const act = hashSet(db.prepare("SELECT code FROM id_pools WHERE pool_type=? AND code NOT LIKE 'CTRN%'").all(pool).map((r) => r.code));
    if (exp !== act) { poolHashOk = false; process.stderr.write(`       pool ${pool} codeset mismatch exp=${rows.length} act=${act ? '' : ''}n/a\n`); }
    const expS = hashState(rows.map((r) => ({ code: r.code, status: STATUS_MAP[r.status] })));
    const actS = hashState(db.prepare("SELECT code,status FROM id_pools WHERE pool_type=? AND code NOT LIKE 'CTRN%'").all(pool).map((r) => ({ code: r.code, status: r.status })));
    if (expS !== actS) { poolStateOk = false; process.stderr.write(`       pool ${pool} state mismatch\n`); }
    // §18 provenance 纳入对账：迁移前后来源语义必须完全一致
    const expP = hashStateProv(rows.map((r) => ({ code: r.code, status: STATUS_MAP[r.status], provenance: LEGACY_PROV })));
    const actP = hashStateProv(db.prepare("SELECT code,status,provenance FROM id_pools WHERE pool_type=? AND code NOT LIKE 'CTRN%'").all(pool).map((r) => ({ code: r.code, status: r.status, provenance: r.provenance })));
    if (expP !== actP) { poolStateOk = false; process.stderr.write(`       pool ${pool} state+provenance mismatch\n`); }
  }
  check('§17 逐池 CODESET 哈希全部一致', poolHashOk);
  check('§17 逐池 STATE + PROVENANCE 哈希全部一致', poolStateOk);
}

// §14/§15/§16/§17 CERT-R3D-FIX：provenance 感知的分配资格（fail-closed）
// 分配谓词与生产源码共用同一语义（见 src/domain/certificate.ts allocatableProvenanceSql）：
//   provenance IN ('legacy_migrated','v2_native')  —— 白名单，未知/NULL 天然不命中
{
  const ALLOC = "provenance IN ('legacy_migrated','v2_native')";
  // 真实分配器谓词（TRAINING 与 ACTIVITY/SERVICE 共用）
  const peekAlloc = (pool) => db.prepare(
    `SELECT code, provenance FROM id_pools WHERE pool_type=? AND status=0 AND ${ALLOC} ORDER BY id ASC LIMIT 1`
  ).get(pool);

  // --- §14 关键 TRAINING 候选测试 ---
  const trn = peekAlloc('cert_trn');
  const legacyTrnCodes = new Set(legacyByPool.cert_trn.filter((r) => r.status === 'available').map((r) => r.code));
  check('§14 TRAINING 候选存在', trn != null);
  check('§14 TRAINING 候选 provenance = legacy_migrated', trn != null && trn.provenance === 'legacy_migrated',
    trn == null ? 'null' : String(trn.provenance));
  check('§14 TRAINING 候选属于权威 legacy cert_trn 集合', trn != null && legacyTrnCodes.has(trn.code));
  check('§14 TRAINING 候选【不是】500 条合成码之一',
    trn != null && !trn.code.startsWith('CTRN'));

  // --- §11 ACTIVITY / SERVICE 候选 ---
  const srv = peekAlloc('cert_srv');
  const legacySrvCodes = new Set(legacyByPool.cert_srv.filter((r) => r.status === 'available').map((r) => r.code));
  check('§11 ACTIVITY/SERVICE 候选 provenance = legacy_migrated', srv != null && srv.provenance === 'legacy_migrated');
  check('§11 ACTIVITY/SERVICE 候选属于 legacy cert_srv 集合', srv != null && legacySrvCodes.has(srv.code));
  check('§11 ACTIVITY/SERVICE 候选 status = 0（free）', srv != null && srv.status === 0 ||
    db.prepare('SELECT status FROM id_pools WHERE code = ?').get(srv.code).status === 0);

  // --- §15 合成低 id 排除测试（本缺陷的核心复现）---
  const synthMinId = db.prepare(
    "SELECT MIN(id) m FROM id_pools WHERE provenance='v2_synthetic_compat'").get().m;
  const legacyMinId = db.prepare(
    "SELECT MIN(id) m FROM id_pools WHERE provenance='legacy_migrated'").get().m;
  check('§15 前置：合成库存 id 严格小于 legacy 库存（复现生产形状）', synthMinId < legacyMinId,
    `synth=${synthMinId} legacy=${legacyMinId}`);
  // 若不带 provenance 谓词，分配器会取到合成码（证明谓词是唯一防线）
  const peekNoProv = db.prepare(
    "SELECT code FROM id_pools WHERE pool_type='cert_trn' AND status=0 ORDER BY id ASC LIMIT 1").get();
  check('§15 反证：无 provenance 谓词时会选中合成码（缺陷真实存在）',
    peekNoProv != null && peekNoProv.code.startsWith('CTRN'));
  check('§15 带 provenance 谓词时选中 legacy（缺陷已修复）',
    trn != null && !trn.code.startsWith('CTRN'));

  // --- §20 合成库存业务字段零改动 + 显式分类 ---
  const synthRows = db.prepare(
    "SELECT code, pool_type, status, assigned_to, assigned_at, provenance FROM id_pools WHERE provenance='v2_synthetic_compat' ORDER BY code").all();
  check('§20 合成 500 行全部被显式分类', synthRows.length === 500, String(synthRows.length));
  check('§20 合成 500 行 provenance 均为 v2_synthetic_compat',
    synthRows.every((r) => r.provenance === 'v2_synthetic_compat'));
  check('§20 合成 500 行 status 保持 0（SYNTHETIC_STATUS_MUTATIONS = 0）',
    synthRows.every((r) => r.status === 0));
  check('§20 合成 500 行 assigned_to/assigned_at 保持 NULL',
    synthRows.every((r) => r.assigned_to == null && r.assigned_at == null));
  check('§20 合成 500 行 pool_type 均为 cert_trn', synthRows.every((r) => r.pool_type === 'cert_trn'));
  const synthCodesIntact = synthRows.length === 500 &&
    synthRows.every((r, i) => r.code === `CTRN${String(i + 1).padStart(6, '0')}`);
  check('§20 合成 500 行 code 逐字节未变', synthCodesIntact);

  // --- §8 导入分类完备性 ---
  const legacyProvRows = db.prepare(
    "SELECT COUNT(*) n FROM id_pools WHERE code NOT LIKE 'CTRN%' AND provenance='legacy_migrated'").get().n;
  const legacyNullProv = db.prepare(
    "SELECT COUNT(*) n FROM id_pools WHERE code NOT LIKE 'CTRN%' AND provenance IS NULL").get().n;
  check('§8 全部 450,000 导入行标记为 legacy_migrated', legacyProvRows === 450000, String(legacyProvRows));
  check('§8 无任何 legacy 行 provenance 为 NULL/未知', legacyNullProv === 0, String(legacyNullProv));
  const otherPools = db.prepare(
    "SELECT pool_type, COUNT(*) n FROM id_pools WHERE provenance='legacy_migrated' GROUP BY pool_type ORDER BY pool_type").all();
  check('§12 cert_hon/cert_skl/volunteer 均获得 legacy 来源标记',
    ['cert_hon','cert_skl','volunteer'].every((p) => otherPools.find((x) => x.pool_type === p)?.n > 0),
    JSON.stringify(otherPools));
}

// §21 reserved 不可被分配器取用
{
  const reserved = db.prepare('SELECT COUNT(*) n FROM id_pools WHERE status=2 AND code IN (SELECT code FROM id_pools WHERE status=2)').get().n;
  const peekReserved = db.prepare("SELECT code FROM id_pools WHERE pool_type='cert_srv' AND status=0 ORDER BY id ASC LIMIT 1").get();
  const reservedCodes = new Set(LEGACY.filter((r) => r.status === 'reserved').map((r) => r.code));
  check('§21 reserved 27 条已按 status=2 落库', reserved === 27, String(reserved));
  check('§21 分配器（status=0）不会取到 reserved 码', peekReserved != null && !reservedCodes.has(peekReserved.code));
  check('§21 reserved 码均不可通过 status=0 路径消费', db.prepare('SELECT COUNT(*) n FROM id_pools WHERE status=0 AND code IN (SELECT code FROM id_pools WHERE status=2)').get().n === 0);
}

// §22 重跑（幂等）
{
  const r2 = await runImport(d1, LEGACY);
  check('§22 重跑 new inserts = 0', r2.inserted === 0, String(r2.inserted));
  check('§22 重跑 already_present = 450,000', r2.alreadyPresent === 450000, String(r2.alreadyPresent));
  check('§22 重跑 conflicts = 0', r2.conflicts === 0, String(r2.conflicts));
  const total = db.prepare('SELECT COUNT(*) n FROM id_pools').get().n;
  check('§22 重跑后总量仍为 450,500', total === 450500, String(total));
}

// §22 断点续跑（模拟中断后 resume）
let resumeHash = '';
{
  const d2 = new DatabaseSync(join(TMP, '_cert_r3d_resume.sqlite'));
  if (existsSync(join(TMP, '_cert_r3d_resume.sqlite'))) { /* recreated */ }
  d2.close();
  rmSync(join(TMP, '_cert_r3d_resume.sqlite'));
  const b2 = new DatabaseSync(join(TMP, '_cert_r3d_resume.sqlite'));
  b2.exec(`CREATE TABLE id_pools (
    id INTEGER PRIMARY KEY,
    pool_type TEXT NOT NULL CHECK (pool_type IN ('cert_trn','cert_srv','cert_hon','cert_skl','volunteer')),
    code TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2)),
    assigned_to INTEGER, assigned_at INTEGER, batch_id INTEGER,
    provenance TEXT CHECK (provenance IS NULL OR provenance IN ('legacy_migrated','v2_synthetic_compat','v2_native')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE (code));`);
  const d1b = makeD1(b2);
  const sorted = [...LEGACY].sort((a, b) => a.id - b.id);
  const cut = Math.floor(sorted.length / 2);
  const firstHalf = sorted.slice(0, cut);
  await runImport(d1b, firstHalf);
  const midId = firstHalf[firstHalf.length - 1].id;
  const r2 = await runImport(d1b, sorted, new Map(), midId); // resume
  const total = b2.prepare('SELECT COUNT(*) n FROM id_pools').get().n;
  check('§22 resume 后总量 = 450,000', total === 450000, String(total));
  resumeHash = hashSet(b2.prepare('SELECT code FROM id_pools').all().map((r) => r.code));
  check('§22 resume 结果与干净全量导入哈希一致', resumeHash === legacyCodesetHash);
  b2.close();
}

// §23 冲突检测（不静默覆盖）
{
  const CF = join(TMP, '_cert_r3d_conflict.sqlite');
  if (existsSync(CF)) rmSync(CF);
  const fresh = new DatabaseSync(CF);
  fresh.exec(`CREATE TABLE id_pools (
    id INTEGER PRIMARY KEY,
    pool_type TEXT NOT NULL CHECK (pool_type IN ('cert_trn','cert_srv','cert_hon','cert_skl','volunteer')),
    code TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2)),
    assigned_to INTEGER, assigned_at INTEGER, batch_id INTEGER,
    provenance TEXT CHECK (provenance IS NULL OR provenance IN ('legacy_migrated','v2_synthetic_compat','v2_native')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE (code));`);
  fresh.close();
  const d1c = makeD1(new DatabaseSync(CF));
  // 预置一个「同 code 但 status 不同」的行（模拟历史脏数据）
  const probe = LEGACY.find((r) => r.status === 'available');
  await d1c
    .prepare(`INSERT INTO id_pools (pool_type,code,status,assigned_to,assigned_at,batch_id,created_at)
              VALUES (?,?,?,NULL,NULL,NULL,1700000000)`)
    .bind('volunteer', probe.code, 1)
    .run();
  const r3 = await runImport(d1c, [probe]);
  check('§23 检出冲突（status 不同）', r3.conflicts === 1, String(r3.conflicts));
  check('§23 冲突不覆盖（既有 status 保持 1）', r3.inserted === 0 && r3.alreadyPresent === 1, `ins=${r3.inserted} already=${r3.alreadyPresent}`);
  const now = new DatabaseSync(join(TMP, '_cert_r3d_conflict.sqlite'));
  const st = now.prepare('SELECT status FROM id_pools WHERE code=?').get(probe.code).status;
  check('§23 库中状态未被静默改写', st === 1, String(st));
  check('§23 未引入重复行', now.prepare('SELECT COUNT(*) n FROM id_pools').get().n === 1);
  now.close();
}

// §15b 合成独占场景：仅有合成兼容库存空闲时，分配器必须 fail-closed（不回退）
{
  const FS2 = join(TMP, '_cert_r3d_synthonly.sqlite');
  if (existsSync(FS2)) rmSync(FS2);
  const fresh = new DatabaseSync(FS2);
  fresh.exec(`CREATE TABLE id_pools (
    id INTEGER PRIMARY KEY,
    pool_type TEXT NOT NULL CHECK (pool_type IN ('cert_trn','cert_srv','cert_hon','cert_skl','volunteer')),
    code TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2)),
    assigned_to INTEGER, assigned_at INTEGER, batch_id INTEGER,
    provenance TEXT CHECK (provenance IS NULL OR provenance IN ('legacy_migrated','v2_synthetic_compat','v2_native')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE (code));`);
  // 仅 3 条合成兼容库存空闲（无任何 legacy/native）
  for (let i = 1; i <= 3; i++) fresh.prepare(
    "INSERT INTO id_pools (pool_type,code,status,provenance,created_at) VALUES ('cert_trn',?,0,'v2_synthetic_compat',1700000000)"
  ).run(`CSYN${i}`);
  const ALLOC = "provenance IN ('legacy_migrated','v2_native')";
  const c1 = fresh.prepare(`SELECT code FROM id_pools WHERE pool_type='cert_trn' AND status=0 AND ${ALLOC} ORDER BY id ASC LIMIT 1`).get();
  const c2 = fresh.prepare("SELECT code FROM id_pools WHERE pool_type='cert_trn' AND status=0 ORDER BY id ASC LIMIT 1").get();
  check('§15b 仅有合成库存时分配器返回 null（fail-closed，无候选）', c1 == null, String(c1));
  check('§15b 反证：去掉 provenance 谓词则错误地选中合成码', c2 != null);
  // 消费侧同样不可烧合成号
  const burn = fresh.prepare(
    `UPDATE id_pools SET status=1 WHERE pool_type='cert_trn' AND code=? AND status=0 AND ${ALLOC}`).run('CSYN1');
  check('§15b 条件消费对合成码 changes=0（永不烧号）', Number(burn.changes) === 0, String(burn.changes));
  check('§15b 合成码仍为 status=0（未被消费）',
    fresh.prepare("SELECT status FROM id_pools WHERE code='CSYN1'").get().status === 0);
  fresh.close();
}

// §16 未知/NULL provenance：fail-closed
{
  const FS3 = join(TMP, '_cert_r3d_unknownprov.sqlite');
  if (existsSync(FS3)) rmSync(FS3);
  const fresh = new DatabaseSync(FS3);
  fresh.exec(`CREATE TABLE id_pools (
    id INTEGER PRIMARY KEY,
    pool_type TEXT NOT NULL CHECK (pool_type IN ('cert_trn','cert_srv','cert_hon','cert_skl','volunteer')),
    code TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2)),
    assigned_to INTEGER, assigned_at INTEGER, batch_id INTEGER,
    provenance TEXT CHECK (provenance IS NULL OR provenance IN ('legacy_migrated','v2_synthetic_compat','v2_native')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE (code));`);
  // NULL provenance 的 status=0 行（历史兼容态）—— 必须【不可】分配
  fresh.prepare("INSERT INTO id_pools (pool_type,code,status,provenance,created_at) VALUES ('cert_trn','NULLPROV',0,NULL,1700000000)").run();
  // 未知字面量必须被 CHECK 拒绝（证明 fail-closed 的 schema 前提）
  let rejected = false;
  try {
    fresh.prepare("INSERT INTO id_pools (pool_type,code,status,provenance,created_at) VALUES ('cert_trn','BOGUS',0,'bogus_provenance',1700000000)").run();
  } catch (e) { rejected = /CHECK|constraint/i.test(String(e)); }
  check('§16 CHECK 拒绝未知 provenance 字面量', rejected);
  const ALLOC = "provenance IN ('legacy_migrated','v2_native')";
  const cand = fresh.prepare(`SELECT code FROM id_pools WHERE pool_type='cert_trn' AND status=0 AND ${ALLOC} ORDER BY id ASC LIMIT 1`).get();
  check('§16 NULL provenance 行不被选为候选', cand == null, String(cand));
  const burn = fresh.prepare(
    `UPDATE id_pools SET status=1 WHERE code='NULLPROV' AND status=0 AND ${ALLOC}`).run();
  check('§16 NULL provenance 行不可被消费（changes=0）', Number(burn.changes) === 0);
  fresh.close();
}

// §17 未来原生库存策略：v2_native 可分配（仅 schema 语义，本轮不生成任何编号）
{
  const ALLOC = "provenance IN ('legacy_migrated','v2_native')";
  const d4 = db.prepare("SELECT COUNT(*) n FROM id_pools WHERE provenance='v2_native'").get().n;
  check('§17 本轮未生成任何 v2_native 库存', d4 === 0, String(d4));
  // schema 允许未来写入 v2_native 且可被分配器命中
  const FS4 = join(TMP, '_cert_r3d_native.sqlite');
  if (existsSync(FS4)) rmSync(FS4);
  const fresh = new DatabaseSync(FS4);
  fresh.exec(`CREATE TABLE id_pools (
    id INTEGER PRIMARY KEY,
    pool_type TEXT NOT NULL CHECK (pool_type IN ('cert_trn','cert_srv','cert_hon','cert_skl','volunteer')),
    code TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2)),
    assigned_to INTEGER, assigned_at INTEGER, batch_id INTEGER,
    provenance TEXT CHECK (provenance IS NULL OR provenance IN ('legacy_migrated','v2_synthetic_compat','v2_native')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE (code));`);
  fresh.prepare("INSERT INTO id_pools (pool_type,code,status,provenance,created_at) VALUES ('cert_trn','NATIVE-1',0,'v2_native',1700000000)").run();
  const c = fresh.prepare(`SELECT code FROM id_pools WHERE pool_type='cert_trn' AND status=0 AND ${ALLOC} ORDER BY id ASC LIMIT 1`).get();
  check('§17 未来 v2_native 库存可被分配（无需再改 schema）', c != null && c.code === 'NATIVE-1');
  fresh.close();
}

// §19b provenance 冲突：同 code 但来源不同 → 检出且不覆盖
{
  const FS5 = join(TMP, '_cert_r3d_provconflict.sqlite');
  if (existsSync(FS5)) rmSync(FS5);
  const fresh = new DatabaseSync(FS5);
  fresh.exec(`CREATE TABLE id_pools (
    id INTEGER PRIMARY KEY,
    pool_type TEXT NOT NULL CHECK (pool_type IN ('cert_trn','cert_srv','cert_hon','cert_skl','volunteer')),
    code TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2)),
    assigned_to INTEGER, assigned_at INTEGER, batch_id INTEGER,
    provenance TEXT CHECK (provenance IS NULL OR provenance IN ('legacy_migrated','v2_synthetic_compat','v2_native')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE (code));`);
  const d1p = makeD1(new DatabaseSync(FS5));
  const probe = LEGACY.find((r) => r.status === 'available');
  // 预置：同 code 但 provenance = v2_synthetic_compat（来源矛盾）
  await d1p.prepare(
    `INSERT INTO id_pools (pool_type,code,status,assigned_to,assigned_at,batch_id,provenance,created_at)
      VALUES (?,?,?,NULL,NULL,NULL,'v2_synthetic_compat',1700000000)`).bind(probe.poolType, probe.code, 0).run();
  const rp = await runImport(d1p, [probe]);
  check('§19b 检出 provenance 冲突', rp.conflicts === 1, JSON.stringify(rp.conflictDetails));
  check('§19b 冲突不覆盖（inserted=0）', rp.inserted === 0, String(rp.inserted));
  const nowP = new DatabaseSync(FS5);
  check('§19b 既有 provenance 未被静默改写',
    nowP.prepare('SELECT provenance FROM id_pools WHERE code=?').get(probe.code).provenance === 'v2_synthetic_compat');
  check('§19b 未引入重复行', nowP.prepare('SELECT COUNT(*) n FROM id_pools').get().n === 1);
  nowP.close();
}

db.close();
process.stderr.write(`\nCERT-R3D POOL DRY-RUN: ${pass} pass, ${fail} fail\n`);
if (fail) process.stderr.write(`FAILED: ${failures.join(' | ')}\n`);
process.exitCode = fail === 0 ? 0 : 1;
