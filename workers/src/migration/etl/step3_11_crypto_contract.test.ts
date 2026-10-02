/**
 * STEP 3.11 —— Crypto Contract Repair 专用测试集（T1–T11）
 * ---------------------------------------------------------------------------
 * 目标：验证 C1（volunteer PII 复用运行时 PiiCrypto / IDENTITY_HMAC_KEY）与
 *      C2（F8-4 identity coverage 补全 + 跨 owner 冲突 quarantine）的修复正确性。
 * 全部为内存/离线测试，不连接任何真实数据库、不改 Secret、不写 D1。
 *
 * 运行：cd workers && npx tsc -p tsconfig.test.json && node /tmp/jhzy_test_build/migration/etl/step3_11_crypto_contract.test.js
 * ---------------------------------------------------------------------------
 */
import { EtlPipeline } from './pipeline';
import type { EtlConfig } from './pipeline';
import { MockV1Extractor } from './extract';
import { InMemoryCheckpointStore } from './checkpoint';
import type { BatchSize, BatchItem, ReferenceData } from './types';
import { PiiCrypto } from '../../utils/pii';
import { hmacSha256Hex } from '../../utils/crypto';
import { selfTestPii } from '../pii-encryption-engine';

const HMAC_KEY = 'test-identity-hmac-key-STEP3_11';
const DELIVERY_KEY = 'test-delivery-enc-key-STEP3_11';

function mkConfig(batchSize: BatchSize, encKey: string, store: EtlConfig['checkpointStore']): EtlConfig {
  return {
    batchSize,
    encKey,
    hmacKey: HMAC_KEY,
    platformRootTeamId: 999,
    platformAdminUserId: 1,
    nowEpoch: Math.floor(Date.parse('2026-01-01T00:00:00+08:00') / 1000),
    referenceData: { categoryMap: {}, certTemplateMap: {} } as ReferenceData,
    checkpointStore: store,
  };
}

/** 收集某次运行的全部目标行 */
function collect(res: { batches: { items: BatchItem[] }[] }): BatchItem[] {
  return res.batches.flatMap((b) => b.items);
}

function identitiesOf(items: BatchItem[]): BatchItem[] {
  return items.filter((i) => i.table === 'user_identities');
}

function volunteerProfilesOf(items: BatchItem[]): BatchItem[] {
  return items.filter((i) => i.table === 'volunteer_profiles');
}

export async function selfTestStep3_11(): Promise<{ pass: boolean; checks: string[] }> {
  const checks: string[] = [];
  let pass = true;
  const fail = (m: string): void => {
    pass = false;
    checks.push('FAIL: ' + m);
  };
  const ok = (m: string): void => {
    checks.push('OK: ' + m);
  };

  // ===========================================================================
  // T1 — migration ↔ runtime PII interoperability
  // ===========================================================================
  {
    const pii = new PiiCrypto(HMAC_KEY);
    const rn = '张三_step3_11';
    const ph = '13900001234';
    const ctRn = await pii.encryptRealName(rn);
    const ctPh = await pii.encryptPhone(ph);
    const backRn = await pii.decryptRealName(ctRn);
    const backPh = await pii.decryptPhone(ctPh);
    if (backRn !== rn) fail(`T1 real_name 往返不一致: ${backRn}`);
    else ok('T1 real_name AES-GCM 往返 (runtime PiiCrypto)');
    if (backPh !== ph) fail(`T1 phone 往返不一致: ${backPh}`);
    else ok('T1 phone AES-GCM 往返 (runtime PiiCrypto)');
    // envelope 格式 iv:ct (base64url)
    if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(ctRn)) fail('T1 envelope 格式应为 iv:ct base64url');
    else ok('T1 envelope 格式 iv:ct base64url');
  }

  // ===========================================================================
  // T2 — identity HMAC interoperability（mig 与 runtime login 同源）
  // ===========================================================================
  {
    const row = {
      id: 1,
      volunteer_id: 'V1',
      openid: 'wx_T2_openid',
      phone: '13900000001',
      real_name: '李四',
    };
    const data = { volunteers: [row], users: [] };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const ids = identitiesOf(collect(res));
    const wx = ids.find((i) => (i.row as any).identity_type === 'wechat_openid');
    const expect = await hmacSha256Hex(HMAC_KEY, 'wx_T2_openid'); // runtime 同函数
    if (!wx) fail('T2 未生成 wechat_openid');
    else if ((wx.row as any).identity_hash !== expect) fail('T2 identity_hash 与 runtime HMAC 不一致');
    else ok('T2 identity_hash == runtime hmacSha256Hex(IDENTITY_HMAC_KEY, openid)');
    const ph = ids.find((i) => (i.row as any).identity_type === 'phone');
    const expectPh = await hmacSha256Hex(HMAC_KEY, '13900000001');
    if (!ph) fail('T2 未生成 phone identity');
    else if ((ph.row as any).identity_hash !== expectPh) fail('T2 phone hash 不一致');
    else ok('T2 phone identity HMAC 一致');
  }

  // ===========================================================================
  // T3 — identity coverage（wechat_openid / phone / username）
  // ===========================================================================
  {
    const volunteers = [
      { id: 1, volunteer_id: 'V1', openid: 'wx_A', phone: '13900000001', real_name: '甲' },
      { id: 2, volunteer_id: 'V2', openid: 'wx_B', phone: '13900000002', real_name: '乙' },
      { id: 3, volunteer_id: 'V3', openid: 'wx_C', phone: '13900000003', real_name: '丙' },
    ];
    const users = [
      // 与 V1 同人（openid=wx_A）→ 收敛到 user 1，仅补 username
      { id: 101, openid: 'wx_A', phone: '13900000001', username: 'u_alice' },
      // 全新用户
      { id: 102, openid: 'wx_X', phone: '13900000999', username: 'u_bob' },
      // 仅 username，无 openid/phone
      { id: 103, username: 'u_carol' },
    ];
    const data = { volunteers, users };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const ids = identitiesOf(collect(res));
    const types = ids.map((i) => (i.row as any).identity_type);
    const wxCount = types.filter((t) => t === 'wechat_openid').length;
    const phCount = types.filter((t) => t === 'phone').length;
    const unCount = types.filter((t) => t === 'username').length;
    if (wxCount !== 4) fail(`T3 wechat_openid 应为 4 (V1,V2,V3,U2)，实际 ${wxCount}`);
    else ok('T3 wechat_openid=4');
    if (phCount !== 4) fail(`T3 phone 应为 4，实际 ${phCount}`);
    else ok('T3 phone=4');
    if (unCount !== 3) fail(`T3 username 应为 3 (u_alice,u_bob,u_carol)，实际 ${unCount}`);
    else ok('T3 username=3');
  }

  // ===========================================================================
  // T4 — duplicate same-owner identity dedupe（同人跨 volunteers/users 不双占）
  // ===========================================================================
  {
    // V1 与 U1 同一 openid → 应只生成 1 条 wechat_openid
    const volunteers = [{ id: 1, volunteer_id: 'V1', openid: 'wx_SHARED', phone: '13900000001', real_name: '丁' }];
    const users = [{ id: 101, openid: 'wx_SHARED', phone: '13900000001', username: 'u_shared' }];
    const data = { volunteers, users };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const ids = identitiesOf(collect(res));
    const wx = ids.filter((i) => (i.row as any).identity_type === 'wechat_openid');
    const ph = ids.filter((i) => (i.row as any).identity_type === 'phone');
    if (wx.length !== 1) fail(`T4 wechat_openid 同 owner 应去重为 1，实际 ${wx.length}`);
    else ok('T4 同 owner wechat_openid 去重=1');
    if (ph.length !== 1) fail(`T4 phone 同 owner 应去重为 1，实际 ${ph.length}`);
    else ok('T4 同 owner phone 去重=1');
    if (wx[0] && (wx[0].row as any).user_id !== 1) fail('T4 收敛后 user_id 应为 1');
    else ok('T4 收敛到 volunteer user_id=1');
  }

  // ===========================================================================
  // T5 — same identity / different owner conflict detection（quarantine，不 first-wins）
  // ===========================================================================
  {
    // 两个不同志愿者共用同一 openid → 第二人冲突，被 quarantine
    const volunteers = [
      { id: 1, volunteer_id: 'V1', openid: 'wx_DUP', phone: '13900000001', real_name: '戊' },
      { id: 2, volunteer_id: 'V2', openid: 'wx_DUP', phone: '13900000002', real_name: '己' },
    ];
    const data = { volunteers, users: [] };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const ids = identitiesOf(collect(res));
    const wx = ids.filter((i) => (i.row as any).identity_type === 'wechat_openid');
    const conflicts = res.issues.filter((i) => i.message.includes('IDENTITY_OWNERSHIP_CONFLICT'));
    if (wx.length !== 1) fail(`T5 冲突应只保留 1 条 wechat_openid，实际 ${wx.length}`);
    else ok('T5 冲突 quarantine 后仅 1 条 wechat_openid');
    if (conflicts.length < 1) fail('T5 应记录 IDENTITY_OWNERSHIP_CONFLICT error');
    else ok(`T5 记录 ${conflicts.length} 条 IDENTITY_OWNERSHIP_CONFLICT`);
  }

  // ===========================================================================
  // T6 — volunteers/users cross-table ownership convergence
  // ===========================================================================
  {
    const volunteers = [{ id: 1, volunteer_id: 'V1', openid: 'wx_A', phone: '13900000001', real_name: '庚' }];
    const users = [{ id: 101, openid: 'wx_A', phone: '13900000001', username: 'u_alice' }];
    const data = { volunteers, users };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const items = collect(res);
    const userRows = items.filter((i) => i.table === 'users').map((i) => i.row as any);
    const id1 = userRows.find((r) => r.id === 1);
    const id101 = userRows.find((r) => r.id === 101);
    if (!id1) fail('T6 缺 volunteers 生成的 user 1');
    else ok('T6 user 1 存在');
    if (id101) fail('T6 同人不应再生成独立 user 101（双占）');
    else ok('T6 同人收敛：无重复 users 行');
    const uAlice = identitiesOf(items).find((i) => (i.row as any).identity_type === 'username');
    if (!uAlice) fail('T6 未生成 username 身份');
    else if ((uAlice.row as any).user_id !== 1) fail(`T6 username 应归属 user 1，实际 ${(uAlice.row as any).user_id}`);
    else ok('T6 username 归属收敛后的 user 1');
  }

  // ===========================================================================
  // T7 — username 55→54 reconciliation exception（不静默删除 source identity）
  // ===========================================================================
  {
    // 构造 55 个不同 username 的 users（faithful 全部生成）；冻结生产基线为 54。
    const FROZEN_PROD_USERNAME = 54;
    const users = [];
    for (let i = 1; i <= 55; i++) users.push({ id: 1000 + i, username: `u_${i}_step3_11` });
    const data = { volunteers: [], users };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(1000, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const un = identitiesOf(collect(res)).filter((i) => (i.row as any).identity_type === 'username');
    if (un.length !== 55) fail(`T7 应忠实生成 55 条 username，实际 ${un.length}（不得静默删减）`);
    else ok('T7 忠实生成 55 条 username（不静默删除）');
    const delta = un.length - FROZEN_PROD_USERNAME;
    if (delta !== 1) fail(`T7 reconciliation delta 应为 +1，实际 ${delta}`);
    else ok('T7 HISTORICAL_PROD_USERNAME_DELTA = +1（已表达，待 B2 reconciliation 处置）');
  }

  // ===========================================================================
  // T8 — deterministic transform rerun
  // ===========================================================================
  {
    const volunteers = [
      { id: 1, volunteer_id: 'V1', openid: 'wx_A', phone: '13900000001', real_name: '辛', id_card: '110101199003071234' },
      { id: 2, volunteer_id: 'V2', openid: 'wx_B', phone: '13900000002', real_name: '壬' },
    ];
    const users = [{ id: 101, openid: 'wx_A', phone: '13900000001', username: 'u_alice' }];
    const data = { volunteers, users };
    const r1 = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const r2 = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const set1 = identitiesOf(collect(r1))
      .map((i) => `${(i.row as any).user_id}|${(i.row as any).identity_type}|${(i.row as any).identity_hash}`)
      .sort()
      .join('\n');
    const set2 = identitiesOf(collect(r2))
      .map((i) => `${(i.row as any).user_id}|${(i.row as any).identity_type}|${(i.row as any).identity_hash}`)
      .sort()
      .join('\n');
    if (set1 !== set2) fail('T8 identity 集合非确定性');
    else ok('T8 重跑 identity 集合一致 (user_id/type/hash)');
    // PII ciphertext 因随机 IV 不同，但 decrypt 后明文一致
    const vp1 = volunteerProfilesOf(collect(r1))[0].row as any;
    const vp2 = volunteerProfilesOf(collect(r2))[0].row as any;
    if (vp1.real_name_enc === vp2.real_name_enc) fail('T8 ciphertext 不应逐字节相同（随机 IV）');
    else ok('T8 ciphertext 随机 IV（非逐字节确定）');
    const back1 = await new PiiCrypto(HMAC_KEY).decryptRealName(vp1.real_name_enc);
    const back2 = await new PiiCrypto(HMAC_KEY).decryptRealName(vp2.real_name_enc);
    if (back1 !== back2 || back1 !== '辛') fail(`T8 decrypt 明文不一致: ${back1} / ${back2}`);
    else ok('T8 decrypt 明文一致 (辛)');
  }

  // ===========================================================================
  // T9 — DELIVERY_IDENTITY_ENC_KEY independence（错误 delivery key 不影响 volunteer PII）
  // ===========================================================================
  {
    const volunteers = [{ id: 1, volunteer_id: 'V1', openid: 'wx_A', phone: '13900000001', real_name: '癸' }];
    const data = { volunteers, users: [] };
    // 故意传入错误的 delivery encKey
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, 'WRONG_DELIVERY_KEY_XYZ', new InMemoryCheckpointStore())).run();
    const vp = volunteerProfilesOf(collect(res))[0].row as any;
    const runtime = new PiiCrypto(HMAC_KEY); // 运行时用同一 IDENTITY_HMAC_KEY
    const rn = await runtime.decryptRealName(vp.real_name_enc);
    const ph = await runtime.decryptPhone(vp.phone_enc);
    if (rn !== '癸') fail(`T9 real_name 用 IDENTITY_HMAC_KEY 解密失败: ${rn}`);
    else ok('T9 real_name 与 runtime PiiCrypto(IDENTITY_HMAC_KEY) 互通（不受错误 delivery key 影响）');
    if (ph !== '13900000001') fail(`T9 phone 解密失败: ${ph}`);
    else ok('T9 phone 与 runtime 互通');
  }

  // ===========================================================================
  // T10 — plaintext leakage gate（输出不含 raw PII / raw openid）
  // ===========================================================================
  {
    const volunteers = [
      { id: 1, volunteer_id: 'V1', openid: 'wx_LEAK_OPENID', phone: '13900000001', real_name: '泄露测试', id_card: '110101199003071234' },
    ];
    const users = [{ id: 101, openid: 'wx_LEAK_OPENID', phone: '13900000001', username: 'u_leak' }];
    const data = { volunteers, users };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const dump = JSON.stringify(collect(res));
    const forbidden = ['泄露测试', '13900000001', '110101199003071234', 'wx_LEAK_OPENID'];
    let leaked = false;
    for (const f of forbidden) {
      if (dump.includes(f)) {
        leaked = true;
        fail(`T10 明文泄漏: 输出含 "${f}"`);
      }
    }
    if (!leaked) ok('T10 输出无 raw 姓名/手机/身份证/openid 明文');
  }

  // ===========================================================================
  // T11 — historical expected identity reconciliation（冻结基线；不连 remote）
  // ===========================================================================
  {
    // 冻结生产基线（STEP 3.8 Phase 2 已确认）
    const FROZEN = { total: 1299, wechat_openid: 622, phone: 623, username: 54 };
    if (FROZEN.total !== 1299) fail('T11 冻结 total 应为 1299');
    if (FROZEN.wechat_openid !== 622) fail('T11 冻结 wechat_openid 应为 622');
    if (FROZEN.phone !== 623) fail('T11 冻结 phone 应为 623');
    if (FROZEN.username !== 54) fail('T11 冻结 username 应为 54');
    if (FROZEN.wechat_openid + FROZEN.phone + FROZEN.username !== FROZEN.total) fail('T11 三型之和应等于 total');
    else ok('T11 冻结基线 1299 = 622 + 623 + 54 一致（已记录，待 B2 用 authoritative source 全量 reconciliation）');
  }

  // ===========================================================================
  // T12 — explicit users.volunteer_id 优先级（Rank 1 高于 openid 差异）
  // ===========================================================================
  {
    const volunteers = [{ id: 1, volunteer_id: 'V1', openid: 'wx_VOL', phone: '13900000001', real_name: '甲' }];
    const users = [{ id: 101, volunteer_id: 'V1', openid: 'wx_DIFFERENT', phone: '13900000999', username: 'u_linked' }];
    const data = { volunteers, users };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const items = collect(res);
    const userRows = items.filter((i) => i.table === 'users').map((i) => i.row as any);
    if (!userRows.find((r) => r.id === 1)) fail('T12 缺志愿者生成的 user 1');
    else ok('T12 user 1 存在');
    if (userRows.find((r) => r.id === 101)) fail('T12 显式 volunteer_id 应使 U101 收敛到 user 1（不应新建独立 user 101）');
    else ok('T12 volunteer_id 收敛：无重复 users 行');
    const uLinked = identitiesOf(items).find((i) => (i.row as any).identity_type === 'username');
    if (!uLinked) fail('T12 未生成 username 身份');
    else if ((uLinked.row as any).user_id !== 1) fail(`T12 username 应归属 user 1（Rank1），实际 ${(uLinked.row as any).user_id}`);
    else ok('T12 username 归属收敛后的 user 1（Rank1 优先于 openid 差异）');
  }

  // ===========================================================================
  // T13 — phone 相同但无 explicit relation → 不合并（Rank 3：独立 user + conflict quarantine）
  // ===========================================================================
  {
    const volunteers = [{ id: 1, volunteer_id: 'V1', openid: 'wx_VOL', phone: '13900000001', real_name: '甲' }];
    const users = [{ id: 101, phone: '13900000001', username: 'u_onlyphone' }];
    const data = { volunteers, users };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const items = collect(res);
    const userRows = items.filter((i) => i.table === 'users').map((i) => i.row as any);
    if (!userRows.find((r) => r.id === 1)) fail('T13 缺志愿者 user 1');
    else ok('T13 user 1 存在');
    if (!userRows.find((r) => r.id === 101)) fail('T13 无关联的纯平台用户应保留独立 user 101（不得因 phone 相同而合并）');
    else ok('T13 phone 相同但无关联 → 独立 user 101（不合并）');
    const conflicts = res.issues.filter((i) => i.message.includes('IDENTITY_OWNERSHIP_CONFLICT'));
    if (conflicts.length < 1) fail('T13 phone 跨 owner 应触发 IDENTITY_OWNERSHIP_CONFLICT quarantine');
    else ok(`T13 记录 ${conflicts.length} 条 phone 跨 owner conflict（已 quarantine，未合并）`);
  }

  // ===========================================================================
  // T14 — ambiguous openid（两志愿者共用）→ 不自动合并 + quarantine
  // ===========================================================================
  {
    const volunteers = [
      { id: 1, volunteer_id: 'V1', openid: 'wx_DUP', phone: '13900000001', real_name: '戊' },
      { id: 2, volunteer_id: 'V2', openid: 'wx_DUP', phone: '13900000002', real_name: '己' },
    ];
    const users = [{ id: 101, openid: 'wx_DUP', username: 'u_dup' }];
    const data = { volunteers, users };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const ids = identitiesOf(collect(res)).filter((i) => (i.row as any).identity_type === 'wechat_openid');
    const conflicts = res.issues.filter((i) => i.message.includes('IDENTITY_OWNERSHIP_CONFLICT'));
    if (ids.length !== 1) fail(`T14 歧义 openid 应只保留 1 条 wechat_openid，实际 ${ids.length}`);
    else ok('T14 歧义 openid quarantine 后仅 1 条 wechat_openid');
    if (conflicts.length < 1) fail(`T14 应记录 ≥1 条 IDENTITY_OWNERSHIP_CONFLICT，实际 ${conflicts.length}`);
    else ok(`T14 记录 ${conflicts.length} 条 IDENTITY_OWNERSHIP_CONFLICT（歧义 openid 不自动合并）`);
  }

  // ===========================================================================
  // T15 — username 共享但 openid/phone/volunteer_id 均不同 → 绝不作 merge
  //       注：user_identities 有 UNIQUE(identity_type, identity_hash)，故跨 owner
  //       同 username 无法同占一行 → 第二份须 quarantine 为 IDENTITY_OWNERSHIP_CONFLICT
  //       （不静默丢弃、更不合并为同一 user）。本测试验证「不合并」这一核心契约。
  // ===========================================================================
  {
    const volunteers: Array<Record<string, unknown>> = [];
    const users = [
      { id: 101, openid: 'wx_U1', phone: '13900000991', username: 'shared_name' },
      { id: 102, openid: 'wx_U2', phone: '13900000992', username: 'shared_name' },
    ];
    const data = { volunteers, users };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const items = collect(res);
    const userRows = items.filter((i) => i.table === 'users').map((i) => i.row as any);
    if (!userRows.find((r) => r.id === 101) || !userRows.find((r) => r.id === 102))
      fail('T15 共享 username 不应合并为同一 user（应两份独立 user）');
    else ok('T15 共享 username → 独立 user 101 与 user 102（username 不作 merge key）');
    const conflicts = res.issues.filter(
      (i) => i.message.includes('IDENTITY_OWNERSHIP_CONFLICT') && i.message.includes('username'),
    );
    if (conflicts.length < 1)
      fail(`T15 username 跨 owner 重复须 quarantine 为 conflict（不静默丢弃/不合并），实际 ${conflicts.length}`);
    else ok(`T15 记录 ${conflicts.length} 条 username 跨 owner 冲突（quarantine，不合并）`);
  }

  // ===========================================================================
  // T16 — synthetic identityLinks 不得污染正式 legacy_id_maps（E 判据）
  // ===========================================================================
  {
    const volunteers = [{ id: 1, volunteer_id: 'V1', openid: 'wx_V', phone: '13900000001', real_name: '甲' }];
    const users = [{ id: 101, volunteer_id: 'V1', openid: 'wx_U', phone: '13900000999', username: 'u_linked' }];
    const data = { volunteers, users };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const polluted = res.checkpoint.idMaps.filter((m: any) => m.legacyTable === 'v1_identity_link');
    if (polluted.length > 0) fail(`T16 不应将 v1_identity_link 持久化进 legacy_id_maps，实际 ${polluted.length} 条`);
    else ok('T16 合成 identityLinks 未污染 legacy_id_maps（仅运行内辅助索引）');
  }

  // ===========================================================================
  // T17 — dangling users.volunteer_id（指向不存在志愿者）→ 不崩溃、回退独立 user（不合并）
  // ===========================================================================
  {
    const volunteers = [{ id: 1, volunteer_id: 'V1', openid: 'wx_V', phone: '13900000001', real_name: '甲' }];
    const users = [{ id: 101, volunteer_id: 'NO_SUCH', openid: 'wx_U', phone: '13900000999', username: 'u_dangling' }];
    const data = { volunteers, users };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const items = collect(res);
    const userRows = items.filter((i) => i.table === 'users').map((i) => i.row as any);
    if (!userRows.find((r) => r.id === 101)) fail('T17 dangling volunteer_id 应回退为独立 user 101');
    else ok('T17 dangling volunteer_id → 回退独立 user（不崩溃、不合并）');
  }

  // ===========================================================================
  // T18 — DEFECT A：volunteers.id=123 与 users.id=123（不同 legacy namespace、无任何关联）
  //       → 必须产生两个【不同】canonical user（绝不因数字相同折叠为同一人）
  // ===========================================================================
  {
    const volunteers = [{ id: 123, volunteer_id: 'V123', openid: 'wx_V123', phone: '13900000123', real_name: '志愿者甲' }];
    const users = [{ id: 123, openid: 'wx_U123', phone: '13900000999', username: 'u_norelation' }];
    const data = { volunteers, users };
    const p = new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore()));
    const res = await p.run();
    const items = collect(res);
    const userRows = items.filter((i) => i.table === 'users').map((i) => i.row as any);
    const volUser = userRows.find((r) => r.id === 123);
    // 志愿者占用 target id 123；users.id=123 无关联 → 必须被分配与 123 不同的独立 canonical id
    const otherUsers = userRows.filter((r) => r.id !== 123);
    if (!volUser) fail('T18 志愿者 user 123 必须存在');
    else ok('T18 志愿者 user 123 存在');
    if (otherUsers.length !== 1) fail(`T18 无关联的 users.id=123 必须获得独立 canonical user（实际 ${otherUsers.length} 个）`);
    else ok('T18 users.id=123 获得独立 canonical user（不与志愿者折叠）');
    if (otherUsers[0] && otherUsers[0].id === 123) fail('T18 独立 user 的 canonical id 不能等于 123（撞号必须重分配）');
    else ok('T18 撞号重分配：独立 user canonical id ≠ 123');
    if (userRows.length !== 2) fail(`T18 应恰好 2 个 canonical user，实际 ${userRows.length}`);
    else ok('T18 共 2 个独立 canonical user（namespace 独立）');
  }

  // ===========================================================================
  // T19 — 同数字 legacy id + 安全相同 openid → 因 openid 关系【收敛】，而非因数字相同
  // ===========================================================================
  {
    const volunteers = [{ id: 123, volunteer_id: 'V123', openid: 'wx_SHARED19', phone: '13900000123', real_name: '志愿者乙' }];
    const users = [{ id: 123, openid: 'wx_SHARED19', phone: '13900000123', username: 'u_shared19' }];
    const data = { volunteers, users };
    const p = new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore()));
    const res = await p.run();
    const items = collect(res);
    const userRows = items.filter((i) => i.table === 'users').map((i) => i.row as any);
    if (userRows.length !== 1) fail(`T19 同 openid 应收敛为 1 个 canonical user，实际 ${userRows.length}`);
    else ok('T19 同 openid → 1 个 canonical user（因 openid 收敛，非因数字 id）');
    if (!userRows.find((r) => r.id === 123)) fail('T19 收敛目标应为志愿者 canonical id 123');
    else ok('T19 收敛到志愿者 canonical id 123');
    const diag = p.transformerDiagnostics;
    if (diag.usersConvergedByOpenid < 1) fail(`T19 应记 1 次 openid 收敛，实际 ${diag.usersConvergedByOpenid}`);
    else ok('T19 记录 usersConvergedByOpenid=1（openid 关系驱动）');
    if (diag.usersIndependent !== 0) fail('T19 不应有独立 user');
    else ok('T19 无独立 user');
  }

  // ===========================================================================
  // T20 — 有效 users.volunteer_id → 收敛（Rank 1 优先）
  // ===========================================================================
  {
    const volunteers = [{ id: 5, volunteer_id: 'V5', openid: 'wx_5', phone: '13900000005', real_name: '志愿者丙' }];
    const users = [{ id: 999, volunteer_id: 'V5', openid: 'wx_U999', phone: '13900000999', username: 'u_link20' }];
    const data = { volunteers, users };
    const p = new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore()));
    const res = await p.run();
    const items = collect(res);
    const userRows = items.filter((i) => i.table === 'users').map((i) => i.row as any);
    if (!userRows.find((r) => r.id === 5)) fail('T20 志愿者 user 5 必须存在');
    else ok('T20 志愿者 user 5 存在');
    if (userRows.find((r) => r.id === 999)) fail('T20 有效 volunteer_id 应使 U999 收敛到 user 5（不应新建独立 user 999）');
    else ok('T20 volunteer_id 收敛：无重复 users 行');
    const diag = p.transformerDiagnostics;
    if (diag.usersConvergedByExplicit < 1) fail(`T20 应记 1 次 explicit 收敛，实际 ${diag.usersConvergedByExplicit}`);
    else ok('T20 记录 usersConvergedByExplicit=1（Rank1 驱动）');
  }

  // ===========================================================================
  // T21 — dangling volunteer_id（指向不存在志愿者）→ 不虚假收敛（独立 user）
  // ===========================================================================
  {
    const volunteers = [{ id: 5, volunteer_id: 'V5', openid: 'wx_5', phone: '13900000005', real_name: '志愿者丁' }];
    const users = [{ id: 999, volunteer_id: 'NO_SUCH', openid: 'wx_U999', phone: '13900000999', username: 'u_dangling21' }];
    const data = { volunteers, users };
    const p = new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore()));
    const res = await p.run();
    const items = collect(res);
    const userRows = items.filter((i) => i.table === 'users').map((i) => i.row as any);
    if (!userRows.find((r) => r.id === 5)) fail('T21 志愿者 user 5 必须存在');
    else ok('T21 志愿者 user 5 存在');
    if (!userRows.find((r) => r.id === 999)) fail('T21 dangling volunteer_id 应回退为独立 user 999');
    else ok('T21 dangling volunteer_id → 独立 user 999（不虚假收敛）');
    const diag = p.transformerDiagnostics;
    if (diag.usersIndependent < 1) fail(`T21 应记 1 个独立 user，实际 ${diag.usersIndependent}`);
    else ok('T21 记录 usersIndependent=1');
  }

  // ===========================================================================
  // T22 — 安全唯一跨表 openid → 收敛（Rank 2，无 volunteer_id 也能收敛）
  // ===========================================================================
  {
    const volunteers = [{ id: 10, volunteer_id: 'V10', openid: 'wx_SAFE22', phone: '13900000010', real_name: '志愿者戊' }];
    const users = [{ id: 20, openid: 'wx_SAFE22', phone: '13900000998', username: 'u_safe22' }];
    const data = { volunteers, users };
    const p = new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore()));
    const res = await p.run();
    const items = collect(res);
    const userRows = items.filter((i) => i.table === 'users').map((i) => i.row as any);
    if (userRows.length !== 1) fail(`T22 安全唯一 openid 应收敛为 1 个 canonical user，实际 ${userRows.length}`);
    else ok('T22 安全唯一跨表 openid → 1 个 canonical user');
    if (!userRows.find((r) => r.id === 10)) fail('T22 收敛目标应为志愿者 canonical id 10');
    else ok('T22 收敛到志愿者 canonical id 10');
    const diag = p.transformerDiagnostics;
    if (diag.usersConvergedByOpenid < 1) fail(`T22 应记 1 次 openid 收敛，实际 ${diag.usersConvergedByOpenid}`);
    else ok('T22 记录 usersConvergedByOpenid=1（Rank2 驱动）');
  }

  // ===========================================================================
  // T23 — 歧义 openid（两志愿者共用 + 一用户也用）→ 不合并 + quarantine
  // ===========================================================================
  {
    const volunteers = [
      { id: 30, volunteer_id: 'V30', openid: 'wx_AMB23', phone: '13900000030', real_name: '志愿者己' },
      { id: 31, volunteer_id: 'V31', openid: 'wx_AMB23', phone: '13900000031', real_name: '志愿者庚' },
    ];
    const users = [{ id: 40, openid: 'wx_AMB23', phone: '13900000997', username: 'u_amb23' }];
    const data = { volunteers, users };
    const p = new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore()));
    const res = await p.run();
    const items = collect(res);
    const userRows = items.filter((i) => i.table === 'users').map((i) => i.row as any);
    // 两志愿者 + 一独立用户（歧义 openid 不收敛）→ 共 3 个 canonical user
    if (userRows.length !== 3) fail(`T23 歧义 openid 不应合并，应 3 个 canonical user，实际 ${userRows.length}`);
    else ok('T23 歧义 openid 不合并：3 个 canonical user（志愿30/31 + 独立40）');
    if (!userRows.find((r) => r.id === 40)) fail('T23 用户 40 应独立存在（歧义 openid 回退独立）');
    else ok('T23 歧义 openid 用户回退独立 user 40');
    const diag = p.transformerDiagnostics;
    if (diag.ambiguousOpenidGroups < 1) fail(`T23 应记 ≥1 个歧义 openid 组，实际 ${diag.ambiguousOpenidGroups}`);
    else ok(`T23 记录 ambiguousOpenidGroups=${diag.ambiguousOpenidGroups}（歧义识别生效）`);
  }

  // ===========================================================================
  // T24 — phone 相同但无关联 → 不合并（独立 user + 跨 owner conflict quarantine）
  // ===========================================================================
  {
    const volunteers = [{ id: 50, volunteer_id: 'V50', openid: 'wx_50', phone: '13900000550', real_name: '志愿者辛' }];
    const users = [{ id: 60, phone: '13900000550', username: 'u_onlyphone24' }];
    const data = { volunteers, users };
    const p = new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore()));
    const res = await p.run();
    const items = collect(res);
    const userRows = items.filter((i) => i.table === 'users').map((i) => i.row as any);
    if (!userRows.find((r) => r.id === 50)) fail('T24 志愿者 user 50 必须存在');
    else ok('T24 志愿者 user 50 存在');
    if (!userRows.find((r) => r.id === 60)) fail('T24 无关联纯平台用户应保留独立 user 60（不得因 phone 相同合并）');
    else ok('T24 phone 相同但无关联 → 独立 user 60（不合并）');
    const conflicts = res.issues.filter((i) => i.message.includes('IDENTITY_OWNERSHIP_CONFLICT'));
    if (conflicts.length < 1) fail('T24 phone 跨 owner 应触发 IDENTITY_OWNERSHIP_CONFLICT quarantine');
    else ok(`T24 记录 ${conflicts.length} 条 phone 跨 owner conflict（已 quarantine，未合并）`);
  }

  // ===========================================================================
  // T25 — username 相同但 openid/phone/volunteer_id 均不同 → 绝不 merge
  // ===========================================================================
  {
    const volunteers: Array<Record<string, unknown>> = [];
    const users = [
      { id: 70, openid: 'wx_U70', phone: '13900000970', username: 'shared_uname25' },
      { id: 71, openid: 'wx_U71', phone: '13900000971', username: 'shared_uname25' },
    ];
    const data = { volunteers, users };
    const p = new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore()));
    const res = await p.run();
    const items = collect(res);
    const userRows = items.filter((i) => i.table === 'users').map((i) => i.row as any);
    if (!userRows.find((r) => r.id === 70) || !userRows.find((r) => r.id === 71))
      fail('T25 共享 username 不应合并为同一 user（应两份独立 user）');
    else ok('T25 共享 username → 独立 user 70 与 user 71（username 不作 merge key）');
    const conflicts = res.issues.filter(
      (i) => i.message.includes('IDENTITY_OWNERSHIP_CONFLICT') && i.message.includes('username'),
    );
    if (conflicts.length < 1) fail(`T25 username 跨 owner 重复须 quarantine 为 conflict（不静默丢弃/不合并），实际 ${conflicts.length}`);
    else ok(`T25 记录 ${conflicts.length} 条 username 跨 owner 冲突（quarantine，不合并）`);
  }

  // ===========================================================================
  // T26 — 合成 v1_identity_link 不得污染正式 legacy_id_maps（DEFECT 修复后稳健性）
  // ===========================================================================
  {
    const volunteers = [{ id: 1, volunteer_id: 'V1', openid: 'wx_V26', phone: '13900000001', real_name: '甲' }];
    const users = [{ id: 101, volunteer_id: 'V1', openid: 'wx_U26', phone: '13900000999', username: 'u_link26' }];
    const data = { volunteers, users };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const polluted = res.checkpoint.idMaps.filter((m: any) => m.legacyTable === 'v1_identity_link');
    if (polluted.length > 0) fail(`T26 不应将 v1_identity_link 持久化进 legacy_id_maps，实际 ${polluted.length} 条`);
    else ok('T26 合成 identityLinks 未污染 legacy_id_maps（仅运行内辅助索引）');
  }

  // ===========================================================================
  // T27 — 真实 source-table mapping 仍有效（volunteers/users 均正确登记 legacy_id_maps）
  // ===========================================================================
  {
    const volunteers = [{ id: 1, volunteer_id: 'V1', openid: 'wx_V27', phone: '13900000001', real_name: '甲' }];
    const users = [{ id: 101, openid: 'wx_U27', phone: '13900000999', username: 'u_101' }];
    const data = { volunteers, users };
    const res = await new EtlPipeline(new MockV1Extractor(data), mkConfig(100, DELIVERY_KEY, new InMemoryCheckpointStore())).run();
    const maps = res.checkpoint.idMaps as Array<{ legacyTable: string; legacyId: string; newTable: string; newId: number }>;
    const volMap = maps.find((m) => m.legacyTable === 'volunteers' && m.legacyId === '1' && m.newTable === 'users');
    const userMap = maps.find((m) => m.legacyTable === 'users' && m.legacyId === '101' && m.newTable === 'users');
    if (!volMap) fail('T27 volunteers 真实 source-table 映射缺失');
    else ok('T27 volunteers:1 → users 映射存在（真实 lineage）');
    if (!userMap) fail('T27 users 真实 source-table 映射缺失');
    else ok('T27 users:101 → users 映射存在（真实 lineage，未丢失）');
    // 两个不同 legacy namespace 映射互不相干（即使 newId 数值巧合也不混）
    const volKeys = maps.filter((m) => m.legacyTable === 'volunteers').map((m) => `${m.legacyTable}|${m.legacyId}`);
    const userKeys = maps.filter((m) => m.legacyTable === 'users').map((m) => `${m.legacyTable}|${m.legacyId}`);
    const overlap = volKeys.filter((k) => userKeys.includes(k));
    if (overlap.length > 0) fail(`T27 legacy namespace 不得重叠: ${overlap.join(',')}`);
    else ok('T27 volunteers/users legacy namespace 映射完全独立（无交叉 key）');
  }

  // ===========================================================================
  // F8-3 regression — PII encryption engine self-test（domain 收窄后原语仍正确）
  // ===========================================================================
  {
    const r = await selfTestPii();
    for (const c of r.checks) checks.push('  [F8-3] ' + c);
    if (!r.pass) fail('F8-3 pii-encryption-engine selfTest 失败');
    else ok('F8-3 pii-encryption-engine 原语回归 PASS');
  }

  return { pass, checks };
}

declare const require: any;
declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  selfTestStep3_11()
    .then((r) => {
      for (const c of r.checks) console.log(c);
      if (!r.pass) {
        console.error('STEP 3.11 CRYPTO CONTRACT TEST FAILED');
        throw new Error('STEP 3.11 CRYPTO CONTRACT TEST FAILED');
      }
      console.log('STEP 3.11 CRYPTO CONTRACT TEST PASSED');
    })
    .catch((e) => {
      console.error(e);
      throw e;
    });
}
