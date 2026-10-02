/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ETL Engine · Transform（F8-4）
 * ---------------------------------------------------------------------------
 * 二、Transform：完全按照 docs/migration/01-data-mapping-spec.md。
 * 调用：
 *   - IdMappingEngine（ID 重映射 / public_id / FK 反查；禁止硬编码旧→新 ID）
 *   - PiiEncryptionEngine（AES-256-GCM 加密 / HMAC-SHA256 / 脱敏掩码）
 * 覆盖：ID 重映射、public_id、AES/HMAC、team_id(platform_root)、时间转换、
 *       枚举转换、证书三表合并、Activity→Occurrence 拆分。
 * 注意：所有 ID 反查经 IdMappingEngine；本文件不含任何硬编码的 old↔new 关系。
 * ---------------------------------------------------------------------------
 */
import { IdMappingEngine } from '../id-mapping-engine';
import { hmacSha256Hex } from '../../utils/crypto';
import { PiiCrypto } from '../../utils/pii';
import type { BatchItem, MigrationIssue, ReferenceData, TransformOutcome } from './types';
import {
  deriveActivityStatus,
  deriveAttendanceStatus,
  genVerifyCode,
  hoursToMinutes,
  mapCertStatus,
  mapGender,
  mapReviewStatus,
  mapSignupStatus,
  mapTeamRole,
  mapVolunteerStatus,
  strOrNull,
  toInt,
  v1DateTimeToEpoch,
} from './transform-utils';

/** 转换上下文（由 Pipeline 注入；含可变的证书 ID 分配状态） */
export interface TransformContext {
  idMap: IdMappingEngine;
  encKey: string;
  hmacKey: string;
  platformRootTeamId: number;
  platformAdminUserId: number;
  nowEpoch: number;
  ref: ReferenceData;
  issues: MigrationIssue[];
  certIdState: { counter: number; used: Set<string> };
}

export class Transformer {
  /** volunteer PII 加密器：复用运行时 PiiCrypto，密钥 = IDENTITY_HMAC_KEY（C1 收敛）。 */
  private readonly pii: PiiCrypto;
  /** 运行内 (identity_type, identity_hash) → user_id 归属表（冲突检测 / 同 owner 去重）。 */
  private readonly identitySeen = new Map<string, number>();
  /** 已发射 users 行的 target user_id 集合（避免同一 canonical user 重复发射 users 行）。 */
  private readonly createdUserIds = new Set<number>();
  /**
   * 运行内 openid → 候选 canonical user_id 集合（仅内存；绝不写入 IdMappingEngine / legacy_id_maps）。
   * 用 Set 以支持歧义识别：size>1 表示同一 openid 指向多个不同 canonical user → 不得用于收敛。
   */
  private readonly identityLinks = new Map<string, Set<number>>();
  /**
   * 已占用的 target users.id —— 跨 legacy namespace（volunteers/users）全局唯一。
   * 修复 DEFECT A：即便 volunteers.id 与 users.id 数字相同，也绝不作为同一 canonical user，
   * 除非经 Rank1/Rank2 合法收敛；碰撞时为目标分配全新 id。
   */
  private readonly claimedTargets = new Set<number>();
  /** 自动分配 id 游标（仅用于解决跨表 target id 碰撞）。 */
  private nextFreshId = 1;
  /** 运行内 openid → 出现源表集合（volunteer/user），用于统计跨表共享 openid。 */
  private readonly openidTableSeen = new Map<string, Set<string>>();
  /** 诊断计数器（供 STEP 3.11C 全量重算 + 测试断言）。 */
  public readonly diagnostics = {
    validExplicitRelations: 0,
    safeOpenidConvergences: 0,
    usersConvergedByExplicit: 0,
    usersConvergedByOpenid: 0,
    usersIndependent: 0,
    identityAttempts: 0,
    sameOwnerNoop: 0,
    crossOwnerConflict: 0,
    uniqueEmitted: 0,
  };

  constructor(private readonly ctx: TransformContext) {
    this.pii = new PiiCrypto(ctx.hmacKey);
  }

  /** 按源表名派发到对应转换函数 */
  async transformRow(table: string, row: Record<string, unknown>): Promise<TransformOutcome> {
    switch (table) {
      case 'volunteers':
        return this.transformVolunteer(row);
      case 'users':
        return this.transformUser(row);
      case 'teams':
        return this.transformTeam(row);
      case 'user_teams':
        return this.transformUserTeam(row);
      case 'activities':
        return this.transformActivity(row);
      case 'activity_signups':
        return this.transformSignup(row);
      case 'attendance_records':
        return this.transformAttendance(row);
      case 'exam_certificates':
      case 'activity_service_certificates':
      case 'certificates':
        return this.transformCertificate(table, row);
      case 'points_transactions':
        return this.transformPoints(row);
      default:
        return { targets: [], status: 'skipped', reason: `未实现源表 ${table}` };
    }
  }

  /** 经 IdMappingEngine 反查用户（volunteer_id 或 volunteers.id 均可） */
  private resolveUser(key: unknown): number | null {
    if (key === null || key === undefined || key === '') return null;
    return this.ctx.idMap.tryResolve('volunteers', String(key), 'users');
  }

  /**
   * 历史 source 标识符归一化（复用 historical adapter 语义，禁止新增业务归一化）：
   *  - trim 两端空白
   *  - 去除历史 parser 已定义的外围单/双引号
   *  - 'NULL' / 'NONE' / 空字符串 → 跳过（不建身份行）
   *  - 不 lowercase、不改 phone 国家码、UTF-8 入 HMAC。
   */
  private normalizeIdentifier(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    let s = String(raw).trim();
    if (s.length >= 2) {
      const c0 = s[0];
      const c1 = s[s.length - 1];
      if ((c0 === "'" && c1 === "'") || (c0 === '"' && c1 === '"')) s = s.slice(1, -1).trim();
    }
    const up = s.toUpperCase();
    if (up === 'NULL' || up === 'NONE' || s === '') return null;
    return s;
  }

  /** 记录 openid 在某源表出现（用于跨表共享统计）。 */
  private trackOpenidSource(openidNorm: string, which: 'volunteer' | 'user'): void {
    let s = this.openidTableSeen.get(openidNorm);
    if (!s) {
      s = new Set<string>();
      this.openidTableSeen.set(openidNorm, s);
    }
    s.add(which);
  }

  /**
   * 写入运行内 openid 收敛候选（支持歧义识别）。
   * 同一 openid 出现于多个不同 canonical user → Set.size>1 → 标记歧义。
   */
  private linkOpenid(openidNorm: string, userId: number): void {
    const key = `openid:${openidNorm}`;
    let set = this.identityLinks.get(key);
    if (!set) {
      set = new Set<number>();
      this.identityLinks.set(key, set);
    }
    set.add(userId);
  }

  /**
   * 安全唯一 openid 收敛查询（DEFECT B 修复核心）：
   * 仅当该 openid 恰好指向 1 个 canonical user 时返回其 id；
   * 缺失或歧义（size≠1）→ 返回 null（绝不合并）。
   * 注意：volunteer / user 两端均经 normalizeIdentifier(openid) 写入与查询，规则完全一致。
   */
  private resolveOpenidLink(openidNorm: string): number | null {
    const set = this.identityLinks.get(`openid:${openidNorm}`);
    if (!set || set.size !== 1) return null;
    return [...set][0];
  }

  /**
   * 分配一个全局唯一的 target users.id（跨 legacy namespace）。
   * - preferred 空闲 → 沿用（保持遗留 PK 稳定，便于 FK 反查）。
   * - preferred 已被不同 legacy 行占用 → 从 nextFreshId 起分配空闲 id。
   * 这是 DEFECT A 修复的执行器：volunteers.id 与 users.id 数字相同不再自动视为同一人。
   */
  private allocateTargetUserId(preferred: number): number {
    if (!this.claimedTargets.has(preferred)) {
      this.claimedTargets.add(preferred);
      if (preferred + 1 > this.nextFreshId) this.nextFreshId = preferred + 1;
      return preferred;
    }
    while (this.claimedTargets.has(this.nextFreshId)) this.nextFreshId++;
    const id = this.nextFreshId;
    this.claimedTargets.add(id);
    this.nextFreshId++;
    return id;
  }

  /** 诊断快照（跨表共享 + 歧义 + 收敛计数 + 身份核算）。 */
  public diagnosticsSnapshot(): {
    validExplicitRelations: number;
    safeOpenidConvergences: number;
    usersConvergedByExplicit: number;
    usersConvergedByOpenid: number;
    usersIndependent: number;
    crossTableSharedOpenids: number;
    safeSharedOpenids: number;
    ambiguousOpenidGroups: number;
    identityAttempts: number;
    sameOwnerNoop: number;
    crossOwnerConflict: number;
    uniqueEmitted: number;
  } {
    let crossTable = 0;
    let safeShared = 0;
    for (const [openid, tables] of this.openidTableSeen.entries()) {
      if (tables.has('volunteer') && tables.has('user')) {
        crossTable++;
        const set = this.identityLinks.get(`openid:${openid}`);
        if (set && set.size === 1) safeShared++;
      }
    }
    let ambiguous = 0;
    for (const set of this.identityLinks.values()) {
      if (set.size > 1) ambiguous++;
    }
    return {
      validExplicitRelations: this.diagnostics.validExplicitRelations,
      safeOpenidConvergences: this.diagnostics.safeOpenidConvergences,
      usersConvergedByExplicit: this.diagnostics.usersConvergedByExplicit,
      usersConvergedByOpenid: this.diagnostics.usersConvergedByOpenid,
      usersIndependent: this.diagnostics.usersIndependent,
      crossTableSharedOpenids: crossTable,
      safeSharedOpenids: safeShared,
      ambiguousOpenidGroups: ambiguous,
      identityAttempts: this.diagnostics.identityAttempts,
      sameOwnerNoop: this.diagnostics.sameOwnerNoop,
      crossOwnerConflict: this.diagnostics.crossOwnerConflict,
      uniqueEmitted: this.diagnostics.uniqueEmitted,
    };
  }

  /**
   * 发射一条 user_identities（HMAC-SHA256(IDENTITY_HMAC_KEY, normalized)）。
   * 冲突策略（对应 UNIQUE(identity_type, identity_hash, active_marker)）：
   *  - 同 (type,hash) 已归属同一 user_id → 同 owner 去重，静默跳过（同人跨 volunteers/users 双占）。
   *  - 同 (type,hash) 归属不同 user_id → IDENTITY_OWNERSHIP_CONFLICT：quarantine（不发射、记 error），
   *    禁止 first-wins / 静默覆盖 owner / 静默 skip。
   */
  private async emitIdentity(
    targets: BatchItem[],
    user_id: number,
    identity_type: string,
    raw: unknown,
  ): Promise<void> {
    const normalized = this.normalizeIdentifier(raw);
    if (normalized === null) return;
    this.diagnostics.identityAttempts++;
    const identity_hash = await hmacSha256Hex(this.ctx.hmacKey, normalized);
    const key = `${identity_type}${identity_hash}`;
    const prev = this.identitySeen.get(key);
    if (prev !== undefined) {
      if (prev === user_id) {
        this.diagnostics.sameOwnerNoop++; // 同 owner 去重（已收敛同人，不计双占）
        return;
      }
      this.diagnostics.crossOwnerConflict++; // 跨 owner 冲突：quarantine，不发射、不 first-wins
      this.ctx.issues.push({
        sourceTable: 'user_identities',
        sourceId: String(user_id),
        field: 'identity_hash',
        severity: 'error',
        message: `IDENTITY_OWNERSHIP_CONFLICT: ${identity_type} 已归属 user ${prev}，拒绝 user ${user_id} 双占`,
      });
      return;
    }
    this.identitySeen.set(key, user_id);
    this.diagnostics.uniqueEmitted++;
    targets.push({ table: 'user_identities', row: { user_id, identity_type, identity_hash } });
  }

  // ---- §2.1 志愿者 / 用户 ----
  private async transformVolunteer(row: Record<string, unknown>): Promise<TransformOutcome> {
    const id = toInt(row.id);
    if (id === null) throw new Error('volunteers.id 缺失或非整数');
    const volunteerId = strOrNull(row.volunteer_id);
    const openid = this.normalizeIdentifier(row.openid); // DEFECT B：与 transformUser 同源归一化（不再 strOrNull 原始值）
    if (!openid) {
      return { targets: [], status: 'skipped', reason: `volunteer ${id} 缺 openid，无法建 user_identities（NOT NULL）` };
    }

    // 分配 target users.id（沿用遗留 PK；跨表数字撞号由 allocateTargetUserId 解决，绝不自动视为同一人）。
    const uid = this.allocateTargetUserId(id);
    // 注册 ID 映射：整数 PK 沿用 + volunteer_id 业务码（均指向同一 canonical user_id）。
    this.ctx.idMap.registerResolved('volunteers', String(id), 'users', uid);
    if (volunteerId) this.ctx.idMap.registerResolved('volunteers', volunteerId, 'users', uid);
    // 注册运行内 openid 收敛索引（仅内存，不污染 IdMappingEngine / legacy_id_maps）。
    if (openid) {
      this.trackOpenidSource(openid, 'volunteer');
      this.linkOpenid(openid, uid);
    }

    const publicId = this.ctx.idMap.newPublicId();
    const createdAt = v1DateTimeToEpoch(row.create_time) ?? 0;
    const targets: BatchItem[] = [];

    targets.push({
      table: 'users',
      row: {
        id: uid,
        public_id: publicId,
        nickname: null,
        cert_level: (toInt(row.is_trained) ?? 0) > 0 ? 1 : 0,
        status: mapVolunteerStatus(row.status),
        last_login_at: v1DateTimeToEpoch(row.last_login_time),
        created_at: createdAt,
        avatar_file_id: null,
      },
    });

    targets.push({
      table: 'user_profiles',
      row: {
        user_id: uid,
        gender: mapGender(row.gender),
        birthday: strOrNull(row.birthday),
        region_code: null,
        bio:
          [strOrNull(row.address) ? `地址：${row.address}` : '', (toInt(row.has_insurance) ?? 0) > 0 ? '已购保险' : '']
            .filter(Boolean)
            .join('；') || null,
        created_at: createdAt,
        updated_at: createdAt,
      },
    });

    const vp: Record<string, unknown> = {
      user_id: uid,
      cert_status: (toInt(row.is_trained) ?? 0) > 0 ? 1 : 0,
      total_minutes: hoursToMinutes(row.total_service_hours ?? row.total_hours),
    };
    const realName = strOrNull(row.real_name);
    if (realName) vp.real_name_enc = await this.pii.encryptRealName(realName);
    const phone = strOrNull(row.phone);
    if (phone) {
      vp.phone_enc = await this.pii.encryptPhone(phone);
      vp.phone_mask = this.pii.maskPhone(phone);
      // 注：phone 不再作为同人收敛 key；仅于下方 emitIdentity 作为 identity 发射。
    }
    const idCard = strOrNull(row.id_card);
    if (idCard) {
      vp.id_card_hash = await this.pii.hashIdCard(idCard);
      vp.id_card_mask = this.pii.maskIdCard(idCard);
    }
    const emName = strOrNull(row.emergency_contact);
    const emPhone = strOrNull(row.emergency_phone);
    if (emName || emPhone) {
      const json = JSON.stringify({ name: emName ?? '', phone: emPhone ?? '' });
      vp.emergency_contact_enc = await this.pii.encryptGeneric(json);
    }
    targets.push({ table: 'volunteer_profiles', row: vp });

    // 身份覆盖（C2）：wechat_openid（必有）+ phone（若有）。统一经 emitIdentity
    // → HMAC-SHA256(IDENTITY_HMAC_KEY) + 同 owner 去重 + 跨 owner 冲突 quarantine。
    this.createdUserIds.add(uid);
    await this.emitIdentity(targets, uid, 'wechat_openid', openid);
    if (phone) await this.emitIdentity(targets, uid, 'phone', phone);

    targets.push({
      table: 'points_accounts',
      row: {
        user_id: uid,
        balance: toInt(row.current_points) ?? 0,
        total_earned: 0,
        total_spent: 0,
        last_ledger_id: 0,
      },
    });

    return { targets, status: 'ok' };
  }

  // ---- §2.1b 平台用户表（users）：补齐 username / openid / phone 身份覆盖（C2） ----
  private async transformUser(row: Record<string, unknown>): Promise<TransformOutcome> {
    const id = toInt(row.id);
    if (id === null) throw new Error('users.id 缺失或非整数');
    const openid = this.normalizeIdentifier(row.openid);
    const phone = this.normalizeIdentifier(row.phone);
    const username = this.normalizeIdentifier(row.username);

    // 同人收敛（冻结 ownership 策略 D / STEP 3.11C 修复）：
    //   Rank 1：显式 users.volunteer_id（权威 explicit relation）→ 收敛到对应志愿者 canonical user_id；
    //   Rank 2：唯一无歧义 openid（运行内 identityLinks，size===1）→ 收敛；歧义(size>1)→绝不合并；
    //   Rank 3：无关联 → 获得【独立】canonical user_id（即便遗留数值 id 与志愿者撞号，也分配新 id）。
    // 注：legacynamespace 独立（volunteers:<id> 与 users:<id> 永不自动等同）；phone/username 绝不作为 merge 权威。
    let userId: number | null = null;
    const volId = this.normalizeIdentifier(row.volunteer_id);
    if (volId) userId = this.ctx.idMap.tryResolve('volunteers', volId, 'users');
    if (userId === null && openid) userId = this.resolveOpenidLink(openid);

    let targetId: number;
    if (userId !== null) {
      // 收敛到既有 canonical user
      targetId = userId;
      if (volId) {
        this.diagnostics.usersConvergedByExplicit++;
        this.diagnostics.validExplicitRelations++;
      } else {
        this.diagnostics.usersConvergedByOpenid++;
        this.diagnostics.safeOpenidConvergences++;
      }
    } else {
      // 独立 canonical user（跨表撞号由 allocateTargetUserId 分配新 id，绝不折叠）
      targetId = this.allocateTargetUserId(id);
      this.diagnostics.usersIndependent++;
    }

    // 注册【真实】source-table 映射 users:<legacyId> → canonical user_id（合法 lineage）。
    this.ctx.idMap.registerResolved('users', String(id), 'users', targetId);
    if (openid) {
      this.trackOpenidSource(openid, 'user');
      this.linkOpenid(openid, targetId); // 用收敛后的真实 targetId 写入（修复旧版写入 null 的缺陷）
    }
    // 注：phone 仅于下方 emitIdentity 作为 identity 发射；绝不作为同人收敛 key。

    const targets: BatchItem[] = [];
    if (!this.createdUserIds.has(targetId)) {
      this.createdUserIds.add(targetId);
      targets.push({
        table: 'users',
        row: {
          id: targetId,
          public_id: this.ctx.idMap.newPublicId(),
          nickname: username ?? null,
          cert_level: 0,
          status: 1,
          last_login_at: v1DateTimeToEpoch(row.last_login_time),
          created_at: v1DateTimeToEpoch(row.create_time) ?? 0,
          avatar_file_id: null,
        },
      });
    }

    if (openid) await this.emitIdentity(targets, targetId, 'wechat_openid', openid);
    if (phone) await this.emitIdentity(targets, targetId, 'phone', phone);
    if (username) await this.emitIdentity(targets, targetId, 'username', username);

    return { targets, status: 'ok' };
  }

  // ---- §2.2 团队 ----
  private async transformTeam(row: Record<string, unknown>): Promise<TransformOutcome> {
    const id = toInt(row.id);
    if (id === null) throw new Error('teams.id 缺失或非整数');
    this.ctx.idMap.registerResolved('teams', String(id), 'teams', id);
    return {
      targets: [
        {
          table: 'teams',
          row: {
            id,
            public_id: this.ctx.idMap.newPublicId(),
            name: strOrNull(row.name) ?? '未命名团队',
            logo_file_id: null,
            intro: strOrNull(row.description),
            is_system: 0,
            created_at: v1DateTimeToEpoch(row.created_at) ?? 0,
          },
        },
      ],
      status: 'ok',
    };
  }

  // ---- §2.2 团队成员（user_teams） ----
  private async transformUserTeam(row: Record<string, unknown>): Promise<TransformOutcome> {
    const teamId = toInt(row.team_id);
    const userId = this.resolveUser(row.user_id);
    if (teamId === null) throw new Error('user_teams.team_id 缺失');
    if (userId === null) {
      return { targets: [], status: 'skipped', reason: `user_teams.user_id=${row.user_id} 无法解析为 users.id` };
    }
    return {
      targets: [
        {
          table: 'team_members',
          row: {
            team_id: teamId,
            user_id: userId,
            team_role_code: mapTeamRole(row.role),
            join_status: toInt(row.status) === 2 ? 2 : 1,
            joined_at: v1DateTimeToEpoch(row.join_time),
          },
        },
      ],
      status: 'ok',
    };
  }

  // ---- §2.3 活动 + Occurrence 拆分 ----
  private async transformActivity(row: Record<string, unknown>): Promise<TransformOutcome> {
    const id = toInt(row.id);
    if (id === null) throw new Error('jhzy_activities.id 缺失');
    this.ctx.idMap.registerResolved('jhzy_activities', String(id), 'activities', id);

    const startEpoch = v1DateTimeToEpoch(row.start_time);
    const endEpoch = v1DateTimeToEpoch(row.end_time);
    const categoryId = row.category ? this.ctx.ref.categoryMap[String(row.category)] ?? null : null;
    const createdBy = this.resolveUser(row.created_by) ?? this.ctx.platformAdminUserId;
    const status = deriveActivityStatus(row, this.ctx.nowEpoch);
    const recurrence = strOrNull(row.recurrence_pattern);

    const pointsConfig = JSON.stringify({
      reward: toInt(row.points_reward) ?? 0,
      coefficient: toInt(row.point_coefficient) ?? 1,
      max_daily: toInt(row.max_daily_points) ?? 0,
      min_minutes: toInt(row.min_service_minutes) ?? 0,
      min_hours: toInt(row.min_service_hours) ?? 0,
    });
    const checkinConfig = JSON.stringify({ start: v1DateTimeToEpoch(row.checkin_start), end: v1DateTimeToEpoch(row.checkin_end) });
    const certConfig = JSON.stringify({ enabled: toInt(row.enable_certificate) === 1 });

    const activity: Record<string, unknown> = {
      id,
      public_id: this.ctx.idMap.newPublicId(),
      team_id: this.ctx.platformRootTeamId,
      category_id: categoryId,
      title: strOrNull(row.title) ?? '未命名活动',
      cover_file_id: null,
      detail: strOrNull(row.description),
      address: strOrNull(row.location),
      latitude: toInt(row.location_lat),
      longitude: toInt(row.location_lng),
      geo_radius: toInt(row.signin_radius) ?? 200,
      quota: toInt(row.max_participants) ?? 0,
      signed_count: toInt(row.current_participants) ?? 0,
      points_config: pointsConfig,
      checkin_config: checkinConfig,
      cert_config: certConfig,
      status,
      created_by: createdBy,
      created_at: v1DateTimeToEpoch(row.created_at) ?? 0,
      updated_at: v1DateTimeToEpoch(row.updated_at) ?? 0,
      signup_deadline: v1DateTimeToEpoch(row.registration_deadline) ?? v1DateTimeToEpoch(row.recruit_end),
      start_time: startEpoch,
      end_time: endEpoch,
    };

    const occurrence: Record<string, unknown> = {
      activity_id: id,
      occurrence_date: startEpoch,
      occurrence_end: endEpoch,
      status: status === 0 ? 0 : 1,
      recurrence_pattern: recurrence && recurrence !== 'once' ? recurrence : 'once',
    };

    // 递归活动（非 once）核心映射不展开，记录 issue 交 V2 调度器（spec D3）
    if (recurrence && recurrence !== 'once' && recurrence !== '') {
      this.ctx.issues.push({
        sourceTable: 'activities',
        sourceId: String(id),
        field: 'recurrence_pattern',
        message: `递归活动(${recurrence})核心映射不展开，交由 V2 调度器生成`,
        severity: 'warn',
      });
    }

    return {
      targets: [
        { table: 'activities', row: activity },
        { table: 'activity_occurrences', row: occurrence },
      ],
      status: 'ok',
    };
  }

  // ---- §2.4 报名 ----
  private async transformSignup(row: Record<string, unknown>): Promise<TransformOutcome> {
    const id = toInt(row.id);
    if (id === null) throw new Error('jhzy_activity_signups.id 缺失');
    const activityId = toInt(row.activity_id);
    if (activityId === null) throw new Error('jhzy_activity_signups.activity_id 缺失');
    const userId = this.resolveUser(row.volunteer_id) ?? this.resolveUser(row.user_id);
    if (userId === null) {
      return { targets: [], status: 'skipped', reason: `signup ${id} 无法解析 user_id(volunteer_id=${row.volunteer_id})` };
    }
    const reviewBy = this.resolveUser(row.reviewer_id);
    const remark = strOrNull(row.remark);
    const form = { remark: remark ?? '', selected_role: row.selected_role ?? null, checkin_lat: row.checkin_lat ?? null };
    return {
      targets: [
        {
          table: 'activity_signups',
          row: {
            id,
            activity_id: activityId,
            user_id: userId,
            status: mapSignupStatus(row.status),
            review_status: mapReviewStatus(row.review_status),
            review_by: reviewBy,
            review_at: v1DateTimeToEpoch(row.review_time),
            review_reason: strOrNull(row.review_notes),
            form_data: JSON.stringify(form),
            created_at: v1DateTimeToEpoch(row.signup_time) ?? 0,
          },
        },
      ],
      status: 'ok',
    };
  }

  // ---- §2.5 考勤服务 + 服务记录 ----
  private async transformAttendance(row: Record<string, unknown>): Promise<TransformOutcome> {
    const id = toInt(row.id);
    if (id === null) throw new Error('jhzy_attendance_records.id 缺失');
    const signupId = toInt(row.signup_id);
    const activityId = toInt(row.activity_id);
    const userId = this.resolveUser(row.volunteer_id);
    if (userId === null) {
      return { targets: [], status: 'skipped', reason: `attendance ${id} 无法解析 user_id(volunteer_id=${row.volunteer_id})` };
    }
    const minutes = toInt(row.duration_minutes) ?? 0;
    const checkinAt = v1DateTimeToEpoch(row.checkin_time);
    const serviceDate = checkinAt !== null ? new Date(checkinAt * 1000).toISOString().slice(0, 10) : null;
    const session: Record<string, unknown> = {
      id,
      signup_id: signupId,
      user_id: userId,
      activity_id: activityId,
      team_id: this.ctx.platformRootTeamId,
      checkin_at: checkinAt,
      checkout_at: v1DateTimeToEpoch(row.checkout_time),
      status: deriveAttendanceStatus(row),
      effective_minutes: minutes,
    };
    const service: Record<string, unknown> = {
      session_id: id,
      user_id: userId,
      team_id: this.ctx.platformRootTeamId,
      activity_id: activityId,
      minutes,
      service_date: serviceDate ? v1DateTimeToEpoch(serviceDate) : null,
      source: 'auto',
      status: 1,
      review_status: 0,
    };
    return {
      targets: [
        { table: 'attendance_sessions', row: session },
        { table: 'service_records', row: service },
      ],
      status: 'ok',
    };
  }

  // ---- §2.6 证书三表合并 ----
  private async transformCertificate(
    sourceTable: string,
    row: any,
  ): Promise<TransformOutcome> {
    let certType: string;
    let sourceType: string;
    let sourceId: unknown;
    let issuedAt: unknown;
    let holderName: string | null = null;
    let issuer: string | null = null;
    let snapshot: Record<string, unknown> = {};

    if (sourceTable === 'exam_certificates') {
      certType = 'training';
      sourceType = 'exam';
      sourceId = toInt(row.record_id);
      issuedAt = row.issued_at;
      holderName = strOrNull(row.name);
      if (row.score !== undefined && row.score !== null) snapshot.score = row.score;
    } else if (sourceTable === 'activity_service_certificates') {
      certType = 'activity';
      sourceType = 'activity';
      sourceId = toInt(row.id);
      issuedAt = row.issued_at ?? row.service_date;
      if (row.activity_title) {
        holderName = holderName ?? strOrNull(row.volunteer_name);
        snapshot.activity_title = row.activity_title;
      }
      holderName = holderName ?? strOrNull(row.volunteer_name);
    } else {
      // certificates（通用）
      certType = 'activity';
      sourceType = 'activity';
      sourceId = toInt(row.id);
      issuedAt = row.issue_date ?? row.issued_at;
      holderName = strOrNull(row.volunteer_name);
      if (row.activity_name) snapshot.activity_name = row.activity_name;
      if (row.type_id) {
        const mapped = this.ctx.ref.certTemplateMap[String(row.type_id)];
        if (mapped) certType = String(row.type_id);
      }
    }

    const volunteerKey = row.volunteer_id;
    const userId = this.resolveUser(volunteerKey);
    if (userId === null) {
      return { targets: [], status: 'skipped', reason: `cert(${sourceTable}) volunteer_id=${volunteerKey} 无法解析` };
    }

    // 分配新的证书整数 id（三表合并，避免跨表冲突）
    const newCertId = ++this.ctx.certIdState.counter;
    const primaryId = sourceId != null ? String(sourceId) : null;
    const certCode = strOrNull(row.cert_code) ?? strOrNull(row.certificate_no);
    if (primaryId) this.ctx.idMap.registerResolved(sourceTable, primaryId, 'certificates', newCertId);
    if (certCode) this.ctx.idMap.registerResolved(sourceTable, certCode, 'certificates', newCertId);

    // cert_no 唯一性（跨三表）；冲突追加后缀
    let certNo = certCode ?? `C${newCertId}`;
    if (this.ctx.certIdState.used.has(certNo)) {
      let n = 1;
      while (this.ctx.certIdState.used.has(`${certNo}-${n}`)) n++;
      certNo = `${certNo}-${n}`;
      this.ctx.issues.push({
        sourceTable,
        sourceId: String(newCertId),
        field: 'cert_no',
        message: `证书编号冲突，追加后缀: ${certNo}`,
        severity: 'warn',
      });
    }
    this.ctx.certIdState.used.add(certNo);

    const templateId = this.ctx.ref.certTemplateMap[certType] ?? 1;
    const issuedAtEpoch = v1DateTimeToEpoch(issuedAt);
    if (row.expire_date) snapshot.expire_date = row.expire_date;
    if (row.issuer) issuer = String(row.issuer);
    if (row.organizer) issuer = issuer ?? String(row.organizer);

    return {
      targets: [
        {
          table: 'certificates',
          row: {
            id: newCertId,
            cert_no: certNo,
            verify_code: genVerifyCode(),
            public_id: this.ctx.idMap.newPublicId(),
            cert_type: certType,
            source_type: sourceType,
            source_id: sourceId,
            user_id: userId,
            team_id: this.ctx.platformRootTeamId,
            template_id: templateId,
            holder_name: holderName,
            issuer_name: issuer,
            issued_at: issuedAtEpoch,
            status: mapCertStatus(row.status),
            snapshot: JSON.stringify(snapshot),
          },
        },
      ],
      status: 'ok',
    };
  }

  // ---- §2.7 积分流水 ----
  private async transformPoints(row: Record<string, unknown>): Promise<TransformOutcome> {
    const id = toInt(row.id);
    if (id === null) throw new Error('points_transactions.id 缺失');
    const userId = this.resolveUser(row.user_id);
    if (userId === null) {
      return { targets: [], status: 'skipped', reason: `points ${id} 无法解析 user_id=${row.user_id}` };
    }
    const points = Number(row.points);
    const direction = points >= 0 ? 1 : 2; // 1 收入 / 2 支出
    const amount = Math.abs(points);
    const remarkParts: string[] = [];
    if (row.source) remarkParts.push(`[${String(row.source)}]`);
    if (row.year) remarkParts.push(`year=${row.year}`);
    if (row.description) remarkParts.push(String(row.description));
    return {
      targets: [
        {
          table: 'points_ledger',
          row: {
            id,
            user_id: userId,
            amount,
            direction,
            type: strOrNull(row.type) ?? 'manual',
            remark: remarkParts.join(' ') || null,
            request_id: `mig-${id}`,
            created_at: v1DateTimeToEpoch(row.created_at) ?? 0,
          },
        },
      ],
      status: 'ok',
    };
  }
}
