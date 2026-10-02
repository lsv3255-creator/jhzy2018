/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ID Mapping Engine · Resume Runner + Report
 * ---------------------------------------------------------------------------
 * 五、Resume：runMigration(plan, rows, { resumeState, onCheckpoint, stopAfter })
 *   编排 build → resolve → collision → verify 四阶段；
 *   每阶段完成后写入 checkpoint（onCheckpoint），支持 --resume 从已完成阶段续跑。
 *
 * 六、Report：finalize 组装 MappingReport（Mapped / Skipped / Conflict / Resolved / Failed
 *           + 分实体维度 + 冲突报告 + 验证结果）。
 *
 * 设计边界：仅做内存计算与状态序列化（JSON），不写入 D1、不部署、不改生产库。
 * ---------------------------------------------------------------------------
 */
import type {
  MappingPlan,
  SourceRow,
  LegacyIdMapRecord,
  ForeignKeyResolution,
  MigrationState,
  MappingReport,
  MigrationConflictReport,
  VerifyResult,
} from './mapping-types';
import { buildMappings } from './mapping-builder';
import { resolveForeignKeys } from './foreign-key-resolver';
import { checkCollisions } from './collision-checker';
import { verifyMappings } from './verify-engine';

const STATE_VERSION = 1;

export type MigrationPhase = 'build' | 'resolve' | 'collision' | 'verify';
const PHASE_ORDER: MigrationPhase[] = ['build', 'resolve', 'collision', 'verify'];

export interface RunOptions {
  /** 断点续传：传入此前序列化的状态，runner 跳过已完成阶段 */
  resumeState?: MigrationState | null;
  /** 每完成一个阶段后回调（用于持久化 checkpoint，实现 --resume 落盘） */
  onCheckpoint?: (state: MigrationState) => void | Promise<void>;
  /** 仅执行到指定阶段即中断返回（调试/分批用） */
  stopAfter?: MigrationPhase;
}

export interface RunResult {
  state: MigrationState;
  maps: LegacyIdMapRecord[];
  resolutions: ForeignKeyResolution[];
  conflictReport: MigrationConflictReport;
  verify: VerifyResult;
  report: MappingReport;
}

function emptyState(): MigrationState {
  return {
    version: STATE_VERSION,
    completedPhases: [],
    processedEntities: [],
    maps: [],
    resolutions: [],
    report: null,
    updatedAt: new Date().toISOString(),
  };
}

function emptyReport(): MappingReport {
  return {
    mapped: 0, skipped: 0, conflict: 0, resolved: 0, failed: 0,
    byEntity: {}, conflictReport: null, verify: null,
  };
}

function touch(state: MigrationState): void {
  state.updatedAt = new Date().toISOString();
}

function phaseIndex(p: MigrationPhase): number {
  return PHASE_ORDER.indexOf(p);
}

/** 序列化状态为 JSON 字符串（--resume 持久化） */
export function serializeState(state: MigrationState): string {
  return JSON.stringify(state);
}

/** 反序列化（带版本校验） */
export function deserializeState(raw: string): MigrationState {
  const obj = JSON.parse(raw) as MigrationState;
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.completedPhases) || !Array.isArray(obj.maps)) {
    throw new Error('deserializeState: 非法状态对象');
  }
  if (obj.version !== STATE_VERSION) {
    throw new Error(`deserializeState: 状态版本不匹配（期望 ${STATE_VERSION}，实际 ${obj.version}）`);
  }
  return obj;
}

function entityKeyOf(plan: MappingPlan, legacyTable: string): string {
  if (plan.namespace && legacyTable.startsWith(`${plan.namespace}.`)) {
    return legacyTable.slice(plan.namespace.length + 1);
  }
  return legacyTable;
}

function assembleReport(
  state: MigrationState,
  plan: MappingPlan,
  conflict: MigrationConflictReport,
  verify: VerifyResult,
): MappingReport {
  const mapped = state.maps.length;
  const resolved = state.resolutions.filter((r) => r.status === 'RESOLVED').length;
  const skipped = state.resolutions.filter((r) => r.status === 'SKIPPED').length;
  const failed = state.resolutions.filter((r) => r.status === 'FAILED').length;
  const conflictCount =
    conflict.oldIdDuplicates.length +
    conflict.legacyCodeConflicts.length +
    conflict.ulidConflicts.length +
    conflict.fkLoss.length;

  const byEntity: MappingReport['byEntity'] = {};
  const bump = (key: string, kind: 'mapped' | 'resolved' | 'skipped' | 'failed' | 'conflict'): void => {
    const e = byEntity[key] ?? (byEntity[key] = { mapped: 0, skipped: 0, conflict: 0, resolved: 0, failed: 0 });
    e[kind]++;
  };
  for (const m of state.maps) bump(entityKeyOf(plan, m.legacyTable), 'mapped');
  for (const r of state.resolutions) {
    const key = entityKeyOf(plan, r.fromEntity);
    if (r.status === 'RESOLVED') bump(key, 'resolved');
    else if (r.status === 'SKIPPED') bump(key, 'skipped');
    else bump(key, 'failed');
  }
  for (const d of conflict.oldIdDuplicates) bump(entityKeyOf(plan, d.legacyTable), 'conflict');
  for (const c of conflict.legacyCodeConflicts) for (const e of c.entities) bump(entityKeyOf(plan, e), 'conflict');
  for (const f of conflict.fkLoss) bump(entityKeyOf(plan, f.fromEntity), 'conflict');

  return { mapped, skipped, conflict: conflictCount, resolved, failed, byEntity, conflictReport: conflict, verify };
}

function finalize(state: MigrationState, plan: MappingPlan, rows: SourceRow[]): RunResult {
  const conflictReport = state.report?.conflictReport ?? checkCollisions(state.maps, state.resolutions);
  const verify = state.report?.verify ?? verifyMappings(plan, rows, state.maps, state.resolutions);
  const report = assembleReport(state, plan, conflictReport, verify);
  state.report = report;
  return { state, maps: state.maps, resolutions: state.resolutions, conflictReport, verify, report };
}

/**
 * MigrationRunner：编排四阶段，支持 --resume 续跑与分阶段中断。
 * 不写入数据库、不发起网络请求——纯内存计算 + 状态序列化。
 */
export async function runMigration(
  plan: MappingPlan,
  rows: SourceRow[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const state: MigrationState = opts.resumeState
    ? { ...opts.resumeState, completedPhases: [...opts.resumeState.completedPhases] }
    : emptyState();

  const stopIdx = opts.stopAfter ? phaseIndex(opts.stopAfter) : PHASE_ORDER.length;

  const checkpoint = async (): Promise<void> => {
    touch(state);
    if (opts.onCheckpoint) await opts.onCheckpoint(state);
  };

  // ---- Phase 1: build ----
  if (!state.completedPhases.includes('build')) {
    const { maps } = buildMappings(plan, rows);
    state.maps = maps;
    state.completedPhases.push('build');
    await checkpoint();
  }
  if (phaseIndex('build') >= stopIdx) return finalize(state, plan, rows);

  // ---- Phase 2: resolve ----
  if (!state.completedPhases.includes('resolve')) {
    const { resolutions } = resolveForeignKeys(plan, rows, state.maps);
    state.resolutions = resolutions;
    state.completedPhases.push('resolve');
    await checkpoint();
  }
  if (phaseIndex('resolve') >= stopIdx) return finalize(state, plan, rows);

  // ---- Phase 3: collision ----
  if (!state.completedPhases.includes('collision')) {
    const conflictReport = checkCollisions(state.maps, state.resolutions);
    state.report = state.report ?? emptyReport();
    state.report.conflictReport = conflictReport;
    state.completedPhases.push('collision');
    await checkpoint();
  }
  if (phaseIndex('collision') >= stopIdx) return finalize(state, plan, rows);

  // ---- Phase 4: verify ----
  if (!state.completedPhases.includes('verify')) {
    const verify = verifyMappings(plan, rows, state.maps, state.resolutions);
    state.report = state.report ?? emptyReport();
    state.report.verify = verify;
    state.completedPhases.push('verify');
    await checkpoint();
  }

  return finalize(state, plan, rows);
}

/**
 * 自测：覆盖 Builder / Resolver / Collision / Verify / Resume 全部组件，
 * 不触碰任何外部存储。供迁移 runner 启动前 sanity check 调用。
 */
export async function selfTestEngine(): Promise<{ pass: boolean; checks: string[] }> {
  const checks: string[] = [];
  let pass = true;
  const fail = (m: string): void => {
    pass = false;
    checks.push('FAIL: ' + m);
  };

  const plan: MappingPlan = {
    entities: [
      { entity: 'users', legacyIdField: 'id', legacyCodeField: 'volunteer_id', newTable: 'users' },
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
    { entity: 'users', values: { id: 10, volunteer_id: 'V10' } },
    { entity: 'users', values: { id: 11, volunteer_id: 'V11' } },
    { entity: 'teams', values: { id: 1 } },
    { entity: 'teams', values: { id: 2 } },
    { entity: 'activities', values: { id: 100, team_id: 1, creator_id: 10 } },
    { entity: 'activities', values: { id: 101, team_id: 2, creator_id: null } },
  ];

  const res = await runMigration(plan, rows);
  if (res.report.mapped !== 6) fail(`mapped 应为 6，实际 ${res.report.mapped}`);
  else checks.push('OK: Builder 批量建立 6 条映射');
  if (res.report.resolved !== 3) fail(`resolved 应为 3（team_id×2 + creator_id×1），实际 ${res.report.resolved}`);
  else checks.push('OK: Resolver 解析 3 个外键');
  if (res.report.skipped !== 1) fail(`skipped 应为 1（可空 creator_id 缺失），实际 ${res.report.skipped}`);
  else checks.push('OK: 可空 FK 缺失 -> SKIPPED');
  if (res.report.failed !== 0) fail(`failed 应为 0，实际 ${res.report.failed}`);
  else checks.push('OK: 无 FK 丢失');
  if (res.conflictReport.hasBlocking) fail('应无阻断性冲突');
  else checks.push('OK: Collision Checker 无阻断冲突');
  if (!res.verify.pass) fail('Verify 应 PASS');
  else checks.push('OK: Verify Engine 源/目标数量一致且 FK 可解析');
  if (res.state.completedPhases.length !== 4) fail(`应完成 4 阶段，实际 ${res.state.completedPhases.length}`);
  else checks.push('OK: 四阶段全部完成');

  // --- 冲突场景：old_id 重复 ---
  const dupPlan: MappingPlan = { ...plan, foreignKeys: [] };
  const dupRows: SourceRow[] = [
    { entity: 'users', values: { id: 5 } },
    { entity: 'users', values: { id: 5 } },
  ];
  const dupRes = await runMigration(dupPlan, dupRows);
  if (dupRes.conflictReport.oldIdDuplicates.length === 0) fail('应检测到 old_id 重复');
  else checks.push('OK: Collision Checker 检测 old_id 重复');

  // --- 冲突场景：不可空 FK 丢失 ---
  const fkPlan: MappingPlan = {
    entities: [{ entity: 'activities', legacyIdField: 'id', newTable: 'activities' }],
    foreignKeys: [{ fromEntity: 'activities', field: 'team_id', toEntity: 'teams', nullable: false }],
    defaultTeamId: 1,
    namespace: 'v1',
  };
  const fkRows: SourceRow[] = [{ entity: 'activities', values: { id: 1, team_id: 999 } }];
  const fkRes = await runMigration(fkPlan, fkRows);
  if (fkRes.report.failed !== 1 || fkRes.conflictReport.fkLoss.length !== 1) fail('应检测到不可空 FK 丢失');
  else checks.push('OK: Collision Checker 检测 FK 丢失');

  // --- Resume 场景 ---
  const part = await runMigration(plan, rows, { stopAfter: 'build' });
  if (!part.state.completedPhases.includes('build') || part.state.completedPhases.length !== 1) {
    fail('stopAfter=build 应仅完成 build');
  } else checks.push('OK: stopAfter 中断于 build');

  const serialized = serializeState(part.state);
  const restored = deserializeState(serialized);
  const resumed = await runMigration(plan, rows, { resumeState: restored });
  if (resumed.report.mapped !== 6) fail(`resume 后 mapped 应为 6，实际 ${resumed.report.mapped}`);
  else checks.push('OK: --resume 续跑完成且结果一致');
  if (resumed.state.completedPhases.length !== 4) fail('resume 应补齐至 4 阶段');
  else checks.push('OK: Resume 补齐剩余阶段');

  return { pass, checks };
}
