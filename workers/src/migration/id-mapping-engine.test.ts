/**
 * 嘉禾志愿 2.0 —— P11-F8-2B 专用测试集（Dedicated Test Suite）
 * ---------------------------------------------------------------------------
 * MODE = IMPLEMENT_TESTS_ONLY
 *
 * 本文件【只测试】现有正式 F8-2B implementation，绝不复制实现逻辑来“证明自己”。
 * 直接 import 真实模块：
 *   - id-mapping-engine.ts      （IdMappingEngine / InMemoryIdMappingStore / D1IdMappingStore）
 *   - mapping-builder.ts        （buildMappings / readField）
 *   - foreign-key-resolver.ts   （resolveForeignKeys）
 *   - collision-checker.ts      （checkCollisions）
 *   - verify-engine.ts          （verifyMappings）
 *   - migration-resume.ts       （runMigration / serializeState / deserializeState）
 *   - mapping-types.ts          （类型 / 常量）
 *
 * 覆盖矩阵：T01 CREATE MAPPING / T02 LOOKUP / T03 IDEMPOTENCY / T04 ULID /
 *          T05 IN-MEMORY STORAGE / T06 D1 STORAGE BACKEND / T07 FK BEHAVIOR /
 *          T08 MOCK FK / T09 DUPLICATE·COLLISION / T10 VERIFY ENGINE /
 *          T11 RESUME STABILITY
 * （T12 ROLLBACK CONVERGENCE 由现有 ETL self-test 提供，本文件最终报告引用其 30/30。）
 *
 * 运行方式（不污染仓库，产物落 /tmp）：
 *   cd workers && npx tsc -p tsconfig.test.json && node /tmp/jhzy_test_build/src/migration/id-mapping-engine.test.js
 *
 * 纪律：不连接 Cloudflare production/staging D1；不写远程；不修改任何 production src。
 * ---------------------------------------------------------------------------
 */
import { IdMappingEngine, InMemoryIdMappingStore, D1IdMappingStore } from './id-mapping-engine';
import { buildMappings } from './mapping-builder';
import { resolveForeignKeys } from './foreign-key-resolver';
import { checkCollisions } from './collision-checker';
import { verifyMappings } from './verify-engine';
import { runMigration, serializeState, deserializeState } from './migration-resume';
import type { MappingPlan, SourceRow, LegacyIdMapRecord, ForeignKeyResolution } from './mapping-types';
import { MockD1Database, MockD1PreparedStatement } from './mock-d1-store';

// node 运行时的全局声明（与 etl/self-test.ts 同约定，避免 typecheck 报未定义）
declare const require: any;
declare const module: any;
declare const process: { exit(code: number): void };

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface Check {
  group: string;
  name: string;
  pass: boolean;
  detail?: string;
}
const checks: Check[] = [];

function ok(group: string, name: string, detail?: string): void {
  checks.push({ group, name, pass: true, detail });
}
function bad(group: string, name: string, detail?: string): void {
  checks.push({ group, name, pass: false, detail });
}
function assert(cond: boolean, group: string, name: string, detail?: string): void {
  if (cond) ok(group, name, detail);
  else bad(group, name, detail);
}
async function assertAsync(p: Promise<unknown>, group: string, name: string, detail?: string): Promise<void> {
  try {
    await p;
    bad(group, name, `预期抛错但未抛: ${detail ?? ''}`);
  } catch {
    ok(group, name, detail);
  }
}

// ===========================================================================
// T01 CREATE MAPPING
// ===========================================================================
async function testCreateMapping(): Promise<void> {
  const plan: MappingPlan = {
    entities: [
      { entity: 'users', legacyIdField: 'id', legacyCodeField: 'vid', newTable: 'users' },
      { entity: 'activities', legacyIdField: 'id', newTable: 'activities' },
    ],
    foreignKeys: [],
    defaultTeamId: 1,
    namespace: 'v1',
  };
  const rows: SourceRow[] = [
    { entity: 'users', values: { id: 100, vid: 'V100' } },
    { entity: 'activities', values: { id: 5 } },
  ];

  // 高层 Builder：生成 LegacyIdMapRecord（source entity → legacyId → newId → publicId → metadata）
  const { maps, byEntity } = buildMappings(plan, rows);
  assert(maps.length === 2, 'CREATE_MAPPING', 'buildMappings 生成 2 条映射');
  const userMap = maps.find((m) => m.legacyTable === 'v1.users' && m.legacyId === '100');
  assert(!!userMap, 'CREATE_MAPPING', 'users 映射存在');
  if (userMap) {
    assert(userMap.legacyId === '100', 'CREATE_MAPPING', 'legacyId 正确保存');
    assert(userMap.newId === 100, 'CREATE_MAPPING', '整数 legacy id 1:1 沿用 (newId=100)');
    assert(userMap.legacyCode === 'V100', 'CREATE_MAPPING', 'legacyCode 元数据正确保存');
    assert(userMap.newTable === 'users', 'CREATE_MAPPING', 'newTable 正确保存');
    assert(ULID_RE.test(userMap.publicId ?? ''), 'CREATE_MAPPING', 'publicId(ULID) 正确生成');
  }
  const actMap = maps.find((m) => m.legacyTable === 'v1.activities' && m.legacyId === '5');
  assert(!!actMap && actMap.newId === 5, 'CREATE_MAPPING', 'activities 映射 newId 正确');
  assert(byEntity.users === 1 && byEntity.activities === 1, 'CREATE_MAPPING', 'byEntity 计数正确');

  // 引擎层 register：创建映射并落内存 store，reverse 校验 store.peek
  const store = new InMemoryIdMappingStore();
  const engine = new IdMappingEngine(store);
  const id = await engine.registerResolved('volunteers', 'V200', 'users', 7);
  assert(id === 7, 'CREATE_MAPPING', 'registerResolved 返回 newId=7');
  assert(engine.resolve('volunteers', 'V200', 'users') === 7, 'CREATE_MAPPING', 'resolve 反查 newId=7');
  const peeked = store.peek({ legacyTable: 'volunteers', legacyId: 'V200', newTable: 'users' });
  assert(!!peeked && peeked.newId === 7, 'CREATE_MAPPING', 'store.peek 持久化记录正确');
}

// ===========================================================================
// T02 LOOKUP
// ===========================================================================
async function testLookup(): Promise<void> {
  const store = new InMemoryIdMappingStore();
  const engine = new IdMappingEngine(store);
  await engine.registerResolved('t', 'legacy-1', 't', 11);
  // 正向：legacy → new
  assert(engine.resolve('t', 'legacy-1', 't') === 11, 'LOOKUP', '正向 legacy→new 反查正确');

  // 可空反查：空输入 / 缺失 → null
  assert(engine.tryResolve('t', null, 't') === null, 'LOOKUP', 'tryResolve(null) → null');
  assert(engine.tryResolve('t', '', 't') === null, 'LOOKUP', 'tryResolve("") → null');
  assert(engine.tryResolve('t', 'missing', 't') === null, 'LOOKUP', 'tryResolve 缺失 → null');

  // 未命中：resolve 必须抛错（fail-fast 既定行为）
  let threw = false;
  try {
    engine.resolve('t', 'nope', 't');
  } catch {
    threw = true;
  }
  assert(threw, 'LOOKUP', 'resolve 未命中按规定抛错 (fail-fast)');

  // 正式 contract 是否支持 new→legacy 反向查找？
  // IdMappingEngine 仅暴露 resolve/tryResolve（legacy→new），无 reverse 接口；
  // 因此 new→legacy 属“正式 contract 不支持”，按任务约定不强行断言，仅记录。
  ok('LOOKUP', 'reverse(new→legacy) 非合同能力：正式 IdMappingEngine 未提供，跳过（不构成 FAIL）');
}

// ===========================================================================
// T03 IDEMPOTENCY
// ===========================================================================
async function testIdempotency(): Promise<void> {
  const store = new InMemoryIdMappingStore();
  const engine = new IdMappingEngine(store);
  const first = await engine.registerResolved('t', 'k', 't', 1);
  assert(first === 1, 'IDEMPOTENCY', '首次注册返回 newId=1');
  const second = await engine.registerResolved('t', 'k', 't', 999); // 不同 newId
  assert(second === 1, 'IDEMPOTENCY', '重复注册返回【首次】newId=1（幂等）');
  assert(engine.size() === 1, 'IDEMPOTENCY', '内存仅 1 条映射（未重复写入）');
  const peeked = store.peek({ legacyTable: 't', legacyId: 'k', newTable: 't' });
  assert(!!peeked && peeked.newId === 1, 'IDEMPOTENCY', 'store 中 newId 仍为首次值');
  assert(engine.resolve('t', 'k', 't') === 1, 'IDEMPOTENCY', '幂等后反查结果稳定');

  // buildMappings 确定性（非 ULID 字段在重复调用下稳定一致）
  const plan: MappingPlan = {
    entities: [{ entity: 'users', legacyIdField: 'id', newTable: 'users' }],
    foreignKeys: [],
    defaultTeamId: 1,
  };
  const rows: SourceRow[] = [
    { entity: 'users', values: { id: 3 } },
    { entity: 'users', values: { id: 4 } },
  ];
  const a = buildMappings(plan, rows).maps;
  const b = buildMappings(plan, rows).maps;
  const stable = a.every((m, i) => {
    const n = b[i];
    return n && m.legacyTable === n.legacyTable && m.legacyId === n.legacyId && m.newTable === n.newTable && m.newId === n.newId;
  });
  assert(stable, 'IDEMPOTENCY', 'buildMappings 重复调用：legacy→new 映射稳定一致（ULID 随机位除外）');
}

// ===========================================================================
// T04 ULID
// ===========================================================================
function testUlid(): void {
  const engine = new IdMappingEngine(new InMemoryIdMappingStore());
  const N = 5000;
  const seen = new Set<string>();
  let badFormat = 0;
  for (let i = 0; i < N; i++) {
    const u = engine.newPublicId();
    if (!ULID_RE.test(u)) badFormat++;
    seen.add(u);
  }
  assert(badFormat === 0, 'ULID', `${N} 个 ULID 格式全部合法（Crockford 26 位）`);
  assert(seen.size === N, 'ULID', `${N} 个 ULID 全部唯一（无重复）`);
}

// ===========================================================================
// T05 IN-MEMORY STORAGE（直接测试正式 InMemoryIdMappingStore）
// ===========================================================================
async function testInMemoryStorage(): Promise<void> {
  const store = new InMemoryIdMappingStore();
  const recA = { legacyTable: 'a', legacyId: '1', newTable: 'a', newId: 10 };
  const recB = { legacyTable: 'a', legacyId: '2', newTable: 'a', newId: 20 };
  await store.save(recA);
  await store.save(recB);
  const all = await store.loadAll();
  assert(all.length === 2, 'INMEMORY_STORAGE', 'save×2 → loadAll=2');

  // duplicate behavior：相同 key 覆盖，不新增行
  await store.save({ ...recA, newId: 10 });
  const all2 = await store.loadAll();
  assert(all2.length === 2, 'INMEMORY_STORAGE', '重复 save 同 key 不新增行（仍为 2）');

  // peek 命中
  const hit = store.peek({ legacyTable: 'a', legacyId: '1', newTable: 'a' });
  assert(!!hit && hit.newId === 10, 'INMEMORY_STORAGE', 'peek 命中返回正确记录');

  // missing key behavior
  const miss = store.peek({ legacyTable: 'a', legacyId: '999', newTable: 'a' });
  assert(miss === undefined, 'INMEMORY_STORAGE', 'peek 缺失 key 返回 undefined');

  // 经引擎 warm 后 resolve 仍可用
  const eng = new IdMappingEngine(store);
  const n = await eng.warm();
  assert(n === 2, 'INMEMORY_STORAGE', '引擎 warm 加载计数=2');
  assert(eng.resolve('a', '1', 'a') === 10, 'INMEMORY_STORAGE', 'warm 后 resolve 正确');
}

// ===========================================================================
// T06 D1 STORAGE BACKEND（测试正式 D1IdMappingStore + Mock D1）
// ===========================================================================
async function testD1Storage(): Promise<void> {
  const mock = new MockD1Database();
  const store = new D1IdMappingStore(mock);
  const engine = new IdMappingEngine(store);

  // write mapping（经正式 save → INSERT OR IGNORE，bind 4 参数）
  const id = await engine.registerResolved('users', '100', 'users', 5);
  assert(id === 5, 'D1_STORAGE', 'register 经 D1 落库返回 newId=5');
  assert(mock.rowCount() === 1, 'D1_STORAGE', 'D1 已落库 1 行');

  // 引擎层幂等：重复 register 同 key 不再写库
  await engine.registerResolved('users', '100', 'users', 5);
  assert(mock.rowCount() === 1, 'D1_STORAGE', '引擎重复注册不重复写库（仍为 1 行）');

  // D1 层 idempotent path：store.save 直接两次（INSERT OR IGNORE 去重）
  await store.save({ legacyTable: 'users', legacyId: '200', newTable: 'users', newId: 6 });
  await store.save({ legacyTable: 'users', legacyId: '200', newTable: 'users', newId: 6 });
  assert(mock.rowCount() === 2, 'D1_STORAGE', 'D1 INSERT OR IGNORE 去重（同 key 不新增）');

  // 验证 bind 参数真实回写（legacyTable/legacyId/newTable/newId 全部正确）
  const r1 = mock.debugRows().find((r) => r.legacyId === '100');
  assert(!!r1 && r1.legacyTable === 'users' && r1.newTable === 'users' && r1.newId === 5, 'D1_STORAGE', 'bind 参数正确回写 D1 state');

  // lookup mapping（经正式 loadAll → SELECT，字段别名对齐）
  const eng2 = new IdMappingEngine(store);
  const n = await eng2.warm();
  assert(n === 2, 'D1_STORAGE', 'D1 warm 加载计数=2');
  assert(eng2.resolve('users', '100', 'users') === 5, 'D1_STORAGE', 'D1 SELECT 回查 resolve 正确');

  // 质量门：对错误 SQL 必须使测试失败（mock 主动抛错）
  await assertAsync(
    Promise.resolve().then(() => new MockD1PreparedStatement(mock, 'DELETE FROM legacy_id_maps')),
    'D1_STORAGE',
    'mock 拒绝未知 SQL（DELETE）',
  );

  // 质量门：run() 错误绑定参数个数必须抛错
  await assertAsync(
    (async () => {
      const insStmt = mock.prepare(
        'INSERT OR IGNORE INTO legacy_id_maps (legacy_table, legacy_id, new_table, new_id, created_at) VALUES (?, ?, ?, ?, unixepoch())',
      );
      insStmt.bind('only', 'two');
      await insStmt.run();
    })(),
    'D1_STORAGE',
    'mock 拒绝错误绑定参数个数（应为 4）',
  );
}

// ===========================================================================
// T07 FOREIGN KEY RESOLUTION（直接测试正式 resolveForeignKeys）
// ===========================================================================
function testForeignKeyResolution(): void {
  const plan: MappingPlan = {
    entities: [
      { entity: 'users', legacyIdField: 'id', newTable: 'users' },
      { entity: 'teams', legacyIdField: 'id', newTable: 'teams' },
      { entity: 'activities', legacyIdField: 'id', newTable: 'activities' },
    ],
    foreignKeys: [
      { fromEntity: 'activities', field: 'team_id', toEntity: 'teams', nullable: false },
      { fromEntity: 'activities', field: 'creator_id', toEntity: 'users', nullable: true },
    ],
    defaultTeamId: 1,
    namespace: 'v1',
  };
  const rows: SourceRow[] = [
    { entity: 'users', values: { id: 10 } },
    { entity: 'users', values: { id: 11 } },
    { entity: 'teams', values: { id: 1 } },
    { entity: 'teams', values: { id: 2 } },
    { entity: 'activities', values: { id: 100, team_id: 1, creator_id: 10 } }, // 已知 FK ×2
    { entity: 'activities', values: { id: 101, team_id: 2, creator_id: null } }, // 可空 FK 缺失
    { entity: 'activities', values: { id: 102, team_id: 999, creator_id: 11 } }, // 必需 FK 缺失
  ];
  const { maps } = buildMappings(plan, rows);
  const res = resolveForeignKeys(plan, rows, maps);

  // known FK（多字段）：team_id 三条全部命中（含 activity101 的 team_id=2），creator_id 命中 activity100/102 = 4
  assert(res.resolved === 4, 'FK_BEHAVIOR', '已知 FK 解析数=4（team_id×3 + creator_id×1）');
  const a100team = res.resolutions.find((r) => r.fromLegacyId === '100' && r.field === 'team_id');
  assert(!!a100team && a100team.status === 'RESOLVED' && a100team.newId === 1 && !!a100team.publicId, 'FK_BEHAVIOR', '活动100 team_id→teams.newId=1 且 publicId 正确');
  const a100creator = res.resolutions.find((r) => r.fromLegacyId === '100' && r.field === 'creator_id');
  assert(!!a100creator && a100creator.status === 'RESOLVED' && a100creator.newId === 10, 'FK_BEHAVIOR', '活动100 creator_id→users.newId=10');

  // nullable FK（缺失 → SKIPPED）
  const a101creator = res.resolutions.find((r) => r.fromLegacyId === '101' && r.field === 'creator_id');
  assert(!!a101creator && a101creator.status === 'SKIPPED', 'FK_BEHAVIOR', '可空 creator_id 缺失 → SKIPPED');

  // required FK（缺失 → FAILED）
  const a102team = res.resolutions.find((r) => r.fromLegacyId === '102' && r.field === 'team_id');
  assert(!!a102team && a102team.status === 'FAILED', 'FK_BEHAVIOR', '必需 team_id 缺失 → FAILED');
  // 同行的 creator_id 已知 → 仍 RESOLVED（不被同行 FAILED 拖累）
  const a102creator = res.resolutions.find((r) => r.fromLegacyId === '102' && r.field === 'creator_id');
  assert(!!a102creator && a102creator.status === 'RESOLVED' && a102creator.newId === 11, 'FK_BEHAVIOR', '活动102 同行 creator_id 仍 RESOLVED(newId=11)');

  assert(res.skipped === 1, 'FK_BEHAVIOR', 'skipped 计数=1');
  assert(res.failed === 1, 'FK_BEHAVIOR', 'failed 计数=1');
}

// ===========================================================================
// T08 MOCK FK（明确 mock legacy 关系 + 真实 assertion）
// ===========================================================================
function testMockFk(): boolean {
  const plan: MappingPlan = {
    entities: [
      { entity: 'users', legacyIdField: 'id', newTable: 'users' },
      { entity: 'activity_signups', legacyIdField: 'id', newTable: 'activity_signups' },
    ],
    foreignKeys: [{ fromEntity: 'activity_signups', field: 'user_id', toEntity: 'users', nullable: false }],
    defaultTeamId: 1,
  };
  const rows: SourceRow[] = [
    { entity: 'users', values: { id: 100 } }, // legacy parent
    { entity: 'users', values: { id: 101 } },
    { entity: 'activity_signups', values: { id: 500, user_id: 100 } }, // 子：引用 user 100
    { entity: 'activity_signups', values: { id: 501, user_id: 999999 } }, // 子：引用不存在的 user
  ];
  const { maps } = buildMappings(plan, rows);
  const res = resolveForeignKeys(plan, rows, maps);

  // 找到 user 100 的新 ID（buildMappings 1:1 沿用 → newId=100）
  const user100Map = maps.find((m) => m.legacyTable === 'users' && m.legacyId === '100');
  const expectedNewId = user100Map ? user100Map.newId : null;

  // 子 signup 500 → user_id=100 必须解析成 user 的 new ID
  const c500 = res.resolutions.find((r) => r.fromLegacyId === '500');
  const resolvedOk = !!c500 && c500.status === 'RESOLVED' && c500.newId === expectedNewId && !!c500.publicId;
  assert(resolvedOk, 'MOCK_FK', `signup 500 的 user_id=100 解析为 user 的 newId=${expectedNewId}`);

  // 子 signup 501 → user_id=999999（无 mapping）→ 必需 FK 缺失 → FAILED
  const c501 = res.resolutions.find((r) => r.fromLegacyId === '501');
  const missingOk = !!c501 && c501.status === 'FAILED' && c501.newId === null;
  assert(missingOk, 'MOCK_FK', 'signup 501 的 user_id=999999（无映射）按规定 FAILED');

  const mockFkPass = resolvedOk && missingOk;
  if (mockFkPass) ok('MOCK_FK', 'MOCK_FK_TEST=PASS', 'mock FK 正向解析 + 缺失 FK 行为均正确');
  else bad('MOCK_FK', 'MOCK_FK_TEST=FAIL', 'mock FK 断言未全部通过');
  return mockFkPass;
}

// ===========================================================================
// T09 DUPLICATE / COLLISION（直接测试正式 checkCollisions）
// ===========================================================================
function testDuplicateCollision(): void {
  const emptyRes: ForeignKeyResolution[] = [];

  // A：同 legacy ID → 同 new ID（重复写入）
  const aMaps: LegacyIdMapRecord[] = [
    { legacyTable: 't', legacyId: '1', legacyCode: null, newTable: 't', newId: 5, publicId: 'A1' },
    { legacyTable: 't', legacyId: '1', legacyCode: null, newTable: 't', newId: 5, publicId: 'A2' },
  ];
  const a = checkCollisions(aMaps, emptyRes);
  assert(a.oldIdDuplicates.length === 1, 'DUPLICATE_COLLISION', 'A: 同 legacy→同 new 触发 oldIdDuplicates');
  assert(a.hasBlocking, 'DUPLICATE_COLLISION', 'A: 属阻断性冲突（DUPLICATE）');

  // B：同 legacy ID → 不同 new ID（数据冲突）
  const bMaps: LegacyIdMapRecord[] = [
    { legacyTable: 't', legacyId: '1', legacyCode: null, newTable: 't', newId: 5, publicId: 'B1' },
    { legacyTable: 't', legacyId: '1', legacyCode: null, newTable: 't', newId: 6, publicId: 'B2' },
  ];
  const b = checkCollisions(bMaps, emptyRes);
  assert(b.oldIdDuplicates.length === 1, 'DUPLICATE_COLLISION', 'B: 同 legacy→不同 new 触发 oldIdDuplicates');
  assert(b.hasBlocking, 'DUPLICATE_COLLISION', 'B: 属阻断性冲突（COLLISION）');

  // C：不同 legacy ID → 同 new ID（无相同 key，无相同 code/ULID）
  const cMaps: LegacyIdMapRecord[] = [
    { legacyTable: 't', legacyId: '1', legacyCode: null, newTable: 't', newId: 5, publicId: 'C1' },
    { legacyTable: 't', legacyId: '2', legacyCode: null, newTable: 't', newId: 5, publicId: 'C2' },
  ];
  const c = checkCollisions(cMaps, emptyRes);
  assert(c.oldIdDuplicates.length === 0, 'DUPLICATE_COLLISION', 'C: 不同 legacy→同 new 不触发 oldIdDuplicates');
  assert(c.hasBlocking === false, 'DUPLICATE_COLLISION', 'C: 按正式 contract 属 ALLOWED（无阻断冲突）');
}

// ===========================================================================
// T10 VERIFY ENGINE（直接测试正式 verifyMappings）
// ===========================================================================
function testVerifyEngine(): void {
  const plan: MappingPlan = {
    entities: [
      { entity: 'users', legacyIdField: 'id', newTable: 'users' },
      { entity: 'teams', legacyIdField: 'id', newTable: 'teams' },
    ],
    foreignKeys: [],
    defaultTeamId: 1,
  };
  const rows: SourceRow[] = [
    { entity: 'users', values: { id: 1 } },
    { entity: 'users', values: { id: 2 } },
    { entity: 'teams', values: { id: 1 } },
  ];
  const { maps } = buildMappings(plan, rows);

  // 完整一致：maps 完整覆盖 source rows，无 FAILED FK
  const fullRes = resolveForeignKeys(plan, rows, maps); // 无 FK，全部无 FAILED
  const v1 = verifyMappings(plan, rows, maps, fullRes.resolutions);
  assert(v1.pass === true, 'VERIFY_ENGINE', '一致映射 → verify.pass=true');
  assert(v1.entityChecks.every((e) => e.pass), 'VERIFY_ENGINE', '所有实体 source→target 数量一致');
  assert(v1.fkCheck.pass === true, 'VERIFY_ENGINE', '无 FAILED FK → fkCheck.pass=true');

  // 缺失映射：maps 删掉一条 users → 实体数量不一致
  const missingMaps = maps.filter((m) => !(m.legacyTable === 'users' && m.legacyId === '1'));
  const v2 = verifyMappings(plan, rows, missingMaps, fullRes.resolutions);
  assert(v2.pass === false, 'VERIFY_ENGINE', '缺失映射 → verify.pass=false');
  const usersCheck = v2.entityChecks.find((e) => e.entity === 'users');
  assert(!!usersCheck && usersCheck.pass === false, 'VERIFY_ENGINE', 'users 实体 sourceCount≠targetCount');

  // 不一致（FK 丢失）：构造一条 FAILED resolution
  const failedRes: ForeignKeyResolution[] = [
    { fromEntity: 'teams', fromLegacyId: '1', field: 'x', toEntity: 'users', oldRef: '999', newId: null, publicId: null, status: 'FAILED', reason: 'test' },
  ];
  const v3 = verifyMappings(plan, rows, maps, failedRes);
  assert(v3.fkCheck.pass === false && v3.pass === false, 'VERIFY_ENGINE', '存在 FAILED FK → fkCheck.pass=false → verify.pass=false');
}

// ===========================================================================
// T11 RESUME STABILITY（测试正式 runMigration / serialize / deserialize）
// ===========================================================================
async function testResumeStability(): Promise<void> {
  const plan: MappingPlan = {
    entities: [
      { entity: 'users', legacyIdField: 'id', newTable: 'users' },
      { entity: 'teams', legacyIdField: 'id', newTable: 'teams' },
    ],
    foreignKeys: [],
    defaultTeamId: 1,
  };
  const rows: SourceRow[] = [
    { entity: 'users', values: { id: 1 } },
    { entity: 'users', values: { id: 2 } },
    { entity: 'teams', values: { id: 1 } },
  ];

  // 全量运行
  const full = await runMigration(plan, rows);
  assert(full.report.mapped === 3, 'RESUME_STABILITY', '全量 mapped=3');

  // 部分运行（仅 build）
  const partial = await runMigration(plan, rows, { stopAfter: 'build' });
  assert(
    partial.state.completedPhases.length === 1 && partial.state.completedPhases[0] === 'build',
    'RESUME_STABILITY',
    'stopAfter=build 仅完成 build 阶段',
  );
  // 序列化 → 反序列化 → resume
  const serialized = serializeState(partial.state);
  const restored = deserializeState(serialized);
  const resumed = await runMigration(plan, rows, { resumeState: restored });

  // mapping 不丢失
  assert(resumed.report.mapped === partial.report.mapped, 'RESUME_STABILITY', 'resume 后 mapped 不丢失（=partial）');
  // 已有 mapping 不重建成不同 ID（build 阶段被跳过，复用 partial 的 maps 含原 ULID）
  const stable = JSON.stringify(resumed.maps) === JSON.stringify(partial.maps);
  assert(stable, 'RESUME_STABILITY', '已有 mapping 在 resume 中未被重建为不同 ID（含 ULID 完全一致）');
  assert(resumed.state.completedPhases.length === 4, 'RESUME_STABILITY', 'resume 补齐至 4 阶段');

  // 反序列化版本校验：非法版本必须抛错
  let threw = false;
  try {
    deserializeState(JSON.stringify({ ...restored, version: 999 }));
  } catch {
    threw = true;
  }
  assert(threw, 'RESUME_STABILITY', 'deserializeState 版本不匹配按规定抛错');
}

// ===========================================================================
// 入口
// ===========================================================================
async function main(): Promise<void> {
  // 同步 / 异步组统一 await
  await testCreateMapping();
  await testLookup();
  await testIdempotency();
  testUlid();
  await testInMemoryStorage();
  await testD1Storage();
  testForeignKeyResolution();
  testMockFk();
  testDuplicateCollision();
  testVerifyEngine();
  await testResumeStability();

  // 汇总（按 group 聚合 PASS/FAIL）
  const groups = [
    'CREATE_MAPPING',
    'LOOKUP',
    'IDEMPOTENCY',
    'ULID',
    'INMEMORY_STORAGE',
    'D1_STORAGE',
    'FK_BEHAVIOR',
    'MOCK_FK',
    'DUPLICATE_COLLISION',
    'VERIFY_ENGINE',
    'RESUME_STABILITY',
  ];
  console.log('==================================================');
  console.log('# P11-F8-2B Dedicated Test Suite — Results');
  console.log('==================================================');
  let totalPass = 0;
  let totalFail = 0;
  for (const g of groups) {
    const gc = checks.filter((c) => c.group === g);
    const gp = gc.filter((c) => c.pass).length;
    const gf = gc.filter((c) => !c.pass).length;
    totalPass += gp;
    totalFail += gf;
    const status = gf === 0 ? 'PASS' : 'FAIL';
    console.log(`${g}=${status} (${gp}/${gc.length} checks)`);
    for (const c of gc) {
      console.log(`   ${c.pass ? 'OK  ' : 'FAIL'} ${c.name}${c.detail ? ' :: ' + c.detail : ''}`);
    }
  }
  console.log('--------------------------------------------------');
  console.log(`DEDICATED_PASS_COUNT=${totalPass}`);
  console.log(`DEDICATED_FAIL_COUNT=${totalFail}`);
  console.log('==================================================');

  if (totalFail > 0) {
    console.error('P11-F8-2B DEDICATED TEST GATE: FAIL');
    process.exit(1);
  } else {
    console.log('P11-F8-2B DEDICATED TEST GATE: PASS');
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
