/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ETL Engine · 自测（F8-4）
 * ---------------------------------------------------------------------------
 * 构造模拟 V1 数据，跑通：Extract → Transform → Batch → Checkpoint → Resume，
 * 并断言 Statistics（Extracted/Transformed/Skipped/Failed/Elapsed）与
 * 证书三表合并 / Activity→Occurrence 拆分 / 批大小 100·500·1000 / rollback。
 * 不连接任何真实数据库。
 * ---------------------------------------------------------------------------
 */
import { EtlPipeline } from './pipeline';
import type { EtlConfig } from './pipeline';
import { MockV1Extractor } from './extract';
import { InMemoryCheckpointStore, HistoryCheckpointStore } from './checkpoint';
import type { BatchSize, ReferenceData } from './types';

function buildMockData(): Record<string, Array<Record<string, unknown>>> {
  const data: Record<string, Array<Record<string, unknown>>> = {};

  // 有效志愿者 id 集合（排除故意制造 failed/skipped 的 V3(null id) 与 V7(null openid)），
  // 用于 FK 引用，避免级联 skip 干扰断言。
  const VALID_IDS = Array.from({ length: 250 }, (_, i) => i + 1).filter((x) => x !== 3 && x !== 7);
  const vid = (k: number): number => VALID_IDS[(k - 1) % VALID_IDS.length];

  const volunteers: Record<string, unknown>[] = [];
  for (let i = 1; i <= 250; i++) {
    volunteers.push({
      id: i === 3 ? null : i, // i=3 → transform 抛错 → failed
      volunteer_id: `V${i}`,
      openid: i === 7 ? null : `openid_${i}`, // i=7 → 缺 openid → skipped
      phone: `139${String(10000000 + i).slice(-8)}`,
      real_name: `志愿${i}`,
      id_card: i % 5 === 0 ? null : `1101011990${String(i).padStart(4, '0')}071${i % 10}`,
      gender: i % 2 === 0 ? 1 : 2,
      birthday: `1990-${String(i % 12 + 1).padStart(2, '0')}-15`,
      address: `北京市海淀区${i}号`,
      emergency_contact: `家属${i}`,
      emergency_phone: `138${String(20000000 + i).slice(-8)}`,
      total_points: i * 10,
      current_points: i * 5,
      total_service_hours: i,
      is_trained: i % 3 === 0 ? 1 : 0,
      status: 1,
      create_time: '2023-01-15 10:00:00',
      last_login_time: '2024-06-01 12:00:00',
    });
  }
  data.volunteers = volunteers;

  data.teams = [
    { id: 1, name: '交通引导队', description: '引导', created_at: '2023-01-01 00:00:00' },
    { id: 2, name: '环保队', description: '环境', created_at: '2023-01-01 00:00:00' },
    { id: 3, name: '敬老队', description: '敬老', created_at: '2023-01-01 00:00:00' },
  ];

  data.user_teams = [
    { user_id: 1, team_id: 1, role: '管理员', status: 1, join_time: '2023-02-01 00:00:00' },
    { user_id: 2, team_id: 1, role: '队员', status: 1, join_time: '2023-02-01 00:00:00' },
    { user_id: 5, team_id: 2, role: '队员', status: 1, join_time: '2023-02-01 00:00:00' },
    { user_id: 6, team_id: 3, role: '管理员', status: 1, join_time: '2023-02-01 00:00:00' },
    { user_id: 9, team_id: 2, role: '队员', status: 1, join_time: '2023-02-01 00:00:00' },
  ];

  const activities: Record<string, unknown>[] = [];
  for (let i = 1; i <= 10; i++) {
    activities.push({
      id: i,
      title: `活动${i}`,
      category: i % 2 === 0 ? 'jiaotong-yindao' : 'huanbao',
      description: `描述${i}`,
      location: `地点${i}`,
      location_lat: 39.9,
      location_lng: 116.4,
      signin_radius: 200,
      max_participants: 50,
      current_participants: i,
      points_reward: 10,
      point_coefficient: 1,
      max_daily_points: 50,
      min_service_minutes: 30,
      min_service_hours: 1,
      enable_certificate: 1,
      status: 1,
      is_published: 1,
      created_by: 1,
      created_at: '2024-01-01 00:00:00',
      updated_at: '2024-01-02 00:00:00',
      start_time: '2024-03-01 09:00:00',
      end_time: '2024-03-01 17:00:00',
      registration_deadline: '2024-02-25 00:00:00',
      recruit_end: '2024-02-28 00:00:00',
      recurrence_pattern: i % 4 === 0 ? 'weekly' : 'once',
    });
  }
  data.activities = activities;

  const signups: Record<string, unknown>[] = [];
  for (let i = 1; i <= 20; i++) {
    signups.push({
      id: i,
      activity_id: (i % 10) + 1,
      volunteer_id: `V${vid(i)}`, // 仅引用有效志愿者，避免级联 skip
      status: 1,
      review_status: 0,
      signup_time: '2024-02-20 10:00:00',
    });
  }
  data.activity_signups = signups;

  const attendance: Record<string, unknown>[] = [];
  for (let i = 1; i <= 15; i++) {
    attendance.push({
      id: i,
      signup_id: i,
      volunteer_id: `V${vid(i)}`, // 仅引用有效志愿者，避免级联 skip
      activity_id: (i % 10) + 1,
      duration_minutes: 120,
      checkin_time: '2024-03-01 09:30:00',
      checkout_time: '2024-03-01 11:30:00',
      status: 2,
      certificate_id: null,
    });
  }
  data.attendance_records = attendance;

  const exam: Record<string, unknown>[] = [];
  for (let i = 1; i <= 12; i++) {
    exam.push({
      record_id: i,
      volunteer_id: `V${vid(i)}`, // 仅引用有效志愿者，避免级联 skip
      name: `培训证书${i}`,
      score: 90 + i,
      cert_code: `EXAM${i}`,
      issued_at: '2024-05-01 00:00:00',
    });
  }
  data.exam_certificates = exam;

  const service: Record<string, unknown>[] = [];
  for (let i = 1; i <= 8; i++) {
    service.push({
      id: i,
      volunteer_id: `V${vid(i + 20)}`, // 仅引用有效志愿者，避免级联 skip
      activity_id: (i % 10) + 1,
      service_hours: 5,
      service_date: '2024-04-01',
      issued_at: '2024-04-02 00:00:00',
      cert_code: `SVC${i}`,
      activity_title: `活动${i}`,
    });
  }
  data.activity_service_certificates = service;

  const general: Record<string, unknown>[] = [];
  for (let i = 1; i <= 5; i++) {
    general.push({
      id: i,
      volunteer_id: `V${vid(i + 30)}`, // 仅引用有效志愿者，避免级联 skip
      type_id: 1,
      volunteer_name: `通用${i}`,
      activity_name: `活动G${i}`,
      issue_date: '2024-06-01',
      certificate_no: `GEN${i}`,
      status: 1,
    });
  }
  data.certificates = general;

  const points: Record<string, unknown>[] = [];
  for (let i = 1; i <= 30; i++) {
    points.push({
      id: i,
      user_id: vid((i % 50) + 1), // 仅引用有效志愿者，避免级联 skip
      points: i % 3 === 0 ? -5 : 10,
      type: i % 2 === 0 ? 'exchange' : 'activity',
      source: 'weapp',
      year: 2024,
      description: `积分${i}`,
      created_at: '2024-07-01 00:00:00',
    });
  }
  data.points_transactions = points;

  return data;
}

function expectedTargetRows(data: Record<string, Array<Record<string, unknown>>>): number {
  const okVolunteers = data.volunteers.filter((v) => v.id != null && v.openid != null).length;
  return (
    okVolunteers * 6 + // users+user_profiles+volunteer_profiles+user_identities(wechat_openid)+user_identities(phone)+points_accounts
    data.teams.length * 1 +
    data.user_teams.length * 1 +
    data.activities.length * 2 + // activities + activity_occurrences
    data.activity_signups.length * 1 +
    data.attendance_records.length * 2 + // attendance_sessions + service_records
    data.exam_certificates.length * 1 +
    data.activity_service_certificates.length * 1 +
    data.certificates.length * 1 +
    data.points_transactions.length * 1
  );
}

function expectedTransformed(data: Record<string, Array<Record<string, unknown>>>): number {
  const okVolunteers = data.volunteers.filter((v) => v.id != null && v.openid != null).length;
  return (
    okVolunteers +
    data.teams.length +
    data.user_teams.length +
    data.activities.length +
    data.activity_signups.length +
    data.attendance_records.length +
    data.exam_certificates.length +
    data.activity_service_certificates.length +
    data.certificates.length +
    data.points_transactions.length
  );
}

export async function selfTestEtl(): Promise<{ pass: boolean; checks: string[] }> {
  const checks: string[] = [];
  let pass = true;
  const fail = (m: string): void => {
    pass = false;
    checks.push('FAIL: ' + m);
  };
  const ok = (m: string): void => {
    checks.push('OK: ' + m);
  };

  const data = buildMockData();
  const totalExtracted = Object.values(data).reduce((s, a) => s + a.length, 0);
  const expectedSkipped = data.volunteers.filter((v) => v.id != null && v.openid == null).length;
  const expectedFailed = data.volunteers.filter((v) => v.id == null).length;
  const extractor = new MockV1Extractor(data);
  const ref: ReferenceData = {
    categoryMap: { 'jiaotong-yindao': 1, huanbao: 2 },
    certTemplateMap: { training: 1, activity: 2, honor: 3 },
  };
  const nowEpoch = Math.floor(Date.parse('2026-01-01T00:00:00+08:00') / 1000);
  const mkConfig = (batchSize: BatchSize, store: EtlConfig['checkpointStore']): EtlConfig => ({
    batchSize,
    encKey: 'selftest-enc-key',
    hmacKey: 'selftest-hmac-key',
    platformRootTeamId: 999,
    platformAdminUserId: 1,
    nowEpoch,
    referenceData: ref,
    checkpointStore: store,
  });

  // ===== 测试 1：批大小 100 全链路 + 统计 =====
  {
    const res = await new EtlPipeline(extractor, mkConfig(100, new InMemoryCheckpointStore())).run();
    if (res.stats.extracted !== totalExtracted) fail(`extracted 应为 ${totalExtracted}，实际 ${res.stats.extracted}`);
    else ok(`extracted=${res.stats.extracted} 全量`);
    if (res.stats.transformed !== expectedTransformed(data))
      fail(`transformed 应为 ${expectedTransformed(data)}，实际 ${res.stats.transformed}`);
    else ok(`transformed=${res.stats.transformed}`);
    if (res.stats.skipped !== expectedSkipped) fail(`skipped 应为 ${expectedSkipped}，实际 ${res.stats.skipped}`);
    else ok(`skipped=${res.stats.skipped}`);
    if (res.stats.failed !== expectedFailed) fail(`failed 应为 ${expectedFailed}，实际 ${res.stats.failed}`);
    else ok(`failed=${res.stats.failed}`);
    if (res.stats.targetRows !== expectedTargetRows(data))
      fail(`targetRows 应为 ${expectedTargetRows(data)}，实际 ${res.stats.targetRows}`);
    else ok(`targetRows=${res.stats.targetRows}`);
    if (!(res.stats.elapsedMs >= 0)) fail('elapsedMs 异常');
    else ok(`elapsedMs=${res.stats.elapsedMs}ms`);

    const volBatches = res.batches.filter((b) => b.sourceTable === 'volunteers');
    if (volBatches.length !== 3) fail(`volunteers 分批(100)应为 3，实际 ${volBatches.length}`);
    else ok('volunteers 分批=3 (100/100/50)');
    if (volBatches[0].count === 0) fail('首批为空');
    else ok('首批非空');

    const userIds = res.batches.flatMap((b) => b.items.filter((i) => i.table === 'users').map((i) => i.row.id));
    if (new Set(userIds).size !== userIds.length) fail('users.id 出现重复');
    else ok('users.id 唯一（无重复映射）');

    const certItems = res.batches.flatMap((b) => b.items.filter((i) => i.table === 'certificates'));
    if (certItems.length !== 12 + 8 + 5) fail(`证书三表合并应=25，实际 ${certItems.length}`);
    else ok('证书三表合并=25（exam12+service8+general5）');

    const occ = res.batches.flatMap((b) => b.items.filter((i) => i.table === 'activity_occurrences'));
    if (occ.length !== 10) fail(`Activity→Occurrence 拆分应=10，实际 ${occ.length}`);
    else ok('Activity→Occurrence 拆分=10');

    const certNos = certItems.map((i) => i.row.cert_no);
    if (new Set(certNos).size !== certNos.length) fail('cert_no 重复');
    else ok('cert_no 唯一（合并后无冲突）');

    if (!Array.isArray(res.batches)) fail('Load 未输出 Batch[]');
    else ok('Load 输出 Batch[]（未写库）');
  }

  // ===== 测试 2：批大小 500 / 1000 =====
  for (const bs of [500, 1000] as BatchSize[]) {
    const res = await new EtlPipeline(extractor, mkConfig(bs, new InMemoryCheckpointStore())).run();
    const volBatches = res.batches.filter((b) => b.sourceTable === 'volunteers');
    const expectedBatches = bs >= 250 ? 1 : Math.ceil(250 / bs);
    if (volBatches.length !== expectedBatches) fail(`volunteers 分批(${bs})应为 ${expectedBatches}，实际 ${volBatches.length}`);
    else ok(`volunteers 分批(${bs})=${volBatches.length}`);
    if (res.stats.extracted !== totalExtracted) fail(`批大小 ${bs} extracted 不一致`);
    else ok(`批大小 ${bs} 统计一致`);
  }

  // ===== 测试 3：Checkpoint + Resume =====
  {
    const fresh = await new EtlPipeline(extractor, mkConfig(100, new InMemoryCheckpointStore())).run();
    const hist = new HistoryCheckpointStore();
    const p1 = new EtlPipeline(extractor, mkConfig(100, hist));
    const r1 = await p1.run();
    const midIdx = 5;
    const cpMid = hist.at(midIdx);
    if (!cpMid) {
      fail('未记录中间检查点');
    } else {
      const early = r1.batches.slice(0, cpMid.batchesCount);
      const p2 = new EtlPipeline(extractor, mkConfig(100, new InMemoryCheckpointStore()));
      const r2 = await p2.run(cpMid);
      const combined = early.concat(r2.batches);
      if (combined.length !== fresh.batches.length)
        fail(`resume 合并批数 ${combined.length} != 全新 ${fresh.batches.length}`);
      else ok(`resume 合并批数一致(${combined.length})`);

      const fields: Array<'extracted' | 'transformed' | 'skipped' | 'failed' | 'targetRows'> = [
        'extracted',
        'transformed',
        'skipped',
        'failed',
        'targetRows',
      ];
      for (const f of fields) {
        if (r2.stats[f] !== fresh.stats[f]) fail(`resume ${f} 不一致(${r2.stats[f]} != ${fresh.stats[f]})`);
        else ok(`resume ${f} 一致(${fresh.stats[f]})`);
      }
      if (r2.checkpoint.idMaps.length !== fresh.checkpoint.idMaps.length)
        fail(`resume idMaps 恢复不一致(${r2.checkpoint.idMaps.length} != ${fresh.checkpoint.idMaps.length})`);
      else ok(`resume IdMapping 恢复一致(${fresh.checkpoint.idMaps.length})`);

      const combinedUsers = combined.flatMap((b) => b.items.filter((i) => i.table === 'users').map((i) => i.row.id));
      if (new Set(combinedUsers).size !== combinedUsers.length) fail('resume 合并后 users.id 重复');
      else ok('resume 合并无重复用户');
    }
  }

  // ===== 测试 4：Rollback =====
  {
    const hist = new HistoryCheckpointStore();
    const p3 = new EtlPipeline(extractor, mkConfig(100, hist));
    await p3.run();
    const cpFirst = hist.at(0);
    if (!cpFirst) {
      fail('rollback 测试缺少检查点');
    } else {
      await p3.rollbackTo(cpFirst);
      if (p3.currentBatches.length !== cpFirst.batchesCount)
        fail(`rollback 批数应为 ${cpFirst.batchesCount}，实际 ${p3.currentBatches.length}`);
      else ok(`rollback 截断批次至 ${cpFirst.batchesCount}`);
      if (p3.currentStats.extracted !== cpFirst.stats.extracted)
        fail(`rollback extracted 应为 ${cpFirst.stats.extracted}`);
      else ok('rollback 统计回退');
      // IdMappingEngine.register 幂等：回滚不缩减缓存，仅保证 cpFirst 已登记映射不丢失
      if (p3.idMapSize < cpFirst.idMaps.length)
        fail(`rollback 后 idMap(${p3.idMapSize}) 小于 cpFirst(${cpFirst.idMaps.length})`);
      else ok(`rollback IdMapping 不丢失(${p3.idMapSize} >= ${cpFirst.idMaps.length})`);

      // rollback 后 resume 应能补齐到全新一致
      const r3b = await p3.run(cpFirst);
      if (r3b.stats.extracted !== totalExtracted) fail('rollback 后 resume 未补齐');
      else ok('rollback 后 resume 补齐至全新一致');

      // resume 后最终 IdMapping 集合应与全新全量一致（证明回滚+续跑幂等收敛）
      const freshRun = await new EtlPipeline(extractor, mkConfig(100, new InMemoryCheckpointStore())).run();
      if (r3b.checkpoint.idMaps.length !== freshRun.checkpoint.idMaps.length)
        fail(`rollback+resume idMaps(${r3b.checkpoint.idMaps.length}) 与全新(${freshRun.checkpoint.idMaps.length}) 不一致`);
      else ok(`rollback+resume IdMapping 与全新一致(${freshRun.checkpoint.idMaps.length})`);
    }
  }

  return { pass, checks };
}

// 直接运行时执行（tsc→CJS 后用 node 运行；require.main === module 表示被直接执行）
declare const require: any;
declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  selfTestEtl()
    .then((r) => {
      for (const c of r.checks) console.log(c);
      if (!r.pass) {
        console.error('ETL SELF TEST FAILED');
        throw new Error('ETL SELF TEST FAILED');
      }
      console.log('ETL SELF TEST PASSED');
    })
    .catch((e) => {
      console.error(e);
      throw e;
    });
}
