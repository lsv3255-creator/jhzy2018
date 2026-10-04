/**
 * 证书资格策略 + 接收者守卫（POST-R5-P5 实现）。
 *
 * 定位：本文件实现 CERT-R3B 发证核心所【要求注入】的 EligibilityPolicy 与 RecipientGuard 实现。
 * 此前 CERT-R3B 仅定义接口（fail-closed：缺省即拒绝，绝不默认放行）；本文件补齐
 * ACTIVITY / SERVICE 两套真实资格规则，并按域分派的 CompositeEligibilityPolicy，
 * 以及「系统账号拒绝」的 DefaultRecipientGuard。
 *
 * 纪律（与全仓一致）：
 * - 政策只做【读】查询，绝不写库。
 * - 租户隔离由调用方在 request 中携带的 teamId 经 SQL 参数化过滤收口
 *   （activity_participations / service_records 均无独立 team_id 列，team 经
 *    signup→activity / session 派生；此处显式 `a.team_id = ?` / `sr.team_id = ?` 绑定）。
 * - 不硬编码任何具体 user id（如 1676）：系统账号由上层以 systemUserIds 显式传入。
 * - 不发明「签到/时长」业务语义之外的规则；资格口径严格遵循设计文档 37（P4 结论）。
 *
 * 资格口径（doc 37）：
 *   ACTIVITY：存在 status=1 的 activity_participations（→ signup → activity 属本团队）
 *             + 该参与存在 attendance_sessions.status=2（已签退）
 *             + 无 blocking anomaly（attendance_anomalies.status IN (1,2)）。
 *   SERVICE ：存在 service_records（status=2 且 settlement_status=1 EFFECTIVE）
 *             + 无 blocking anomaly。
 */

import type { D1Database } from '@cloudflare/workers-types';
import { CertificateSource } from '../domain/certificate';
import type { EligibilityPolicy, RecipientGuard } from './certificate-issuance-service';

/** 政策构造依赖：仅需要一个 D1 读句柄（不参与租户 scope guard，team 由入参过滤）。 */
export interface EligibilityPolicyDeps {
  db: D1Database;
}

// =========================================================================
// ActivityEligibilityPolicy
// =========================================================================

export class ActivityEligibilityPolicy implements EligibilityPolicy {
  constructor(private readonly deps: EligibilityPolicyDeps) {}

  async check(req: {
    recipientUserId: number;
    teamId: number;
    domainSource: CertificateSource;
    sourceId: number;
  }): Promise<{ eligible: true } | { eligible: false; reason: string }> {
    const { recipientUserId, teamId, sourceId } = req;

    // ① 该用户在本活动是否存在「活跃参与 + 已签退」考勤会话
    const attended = await this.deps.db
      .prepare(
        `SELECT 1 AS x
           FROM activity_participations p
           JOIN activity_signups s ON s.id = p.signup_id
           JOIN activities a ON a.id = s.activity_id
           JOIN attendance_sessions att ON att.participation_id = p.id
          WHERE s.user_id = ?
            AND s.activity_id = ?
            AND a.team_id = ?
            AND p.status = 1
            AND att.status = 2
          LIMIT 1`,
      )
      .bind(recipientUserId, sourceId, teamId)
      .first<{ x: number }>();

    if (attended == null) {
      return { eligible: false, reason: 'ACTIVITY_NOT_ATTENDED' };
    }

    // ② blocking anomaly（status IN (1,2) = OPEN / CONFIRMED）一律阻断
    const blocked = await this.deps.db
      .prepare(
        `SELECT 1 AS x
           FROM attendance_anomalies an
           JOIN attendance_sessions att ON att.id = an.session_id
           JOIN activity_participations p ON p.id = att.participation_id
           JOIN activity_signups s ON s.id = p.signup_id
           JOIN activities a ON a.id = s.activity_id
          WHERE s.user_id = ?
            AND s.activity_id = ?
            AND a.team_id = ?
            AND an.status IN (1, 2)
          LIMIT 1`,
      )
      .bind(recipientUserId, sourceId, teamId)
      .first<{ x: number }>();

    if (blocked != null) {
      return { eligible: false, reason: 'ATTENDANCE_ANOMALY_BLOCKING' };
    }

    return { eligible: true };
  }
}

// =========================================================================
// ServiceEligibilityPolicy
// =========================================================================

export class ServiceEligibilityPolicy implements EligibilityPolicy {
  constructor(private readonly deps: EligibilityPolicyDeps) {}

  async check(req: {
    recipientUserId: number;
    teamId: number;
    domainSource: CertificateSource;
    sourceId: number;
  }): Promise<{ eligible: true } | { eligible: false; reason: string }> {
    const { recipientUserId, teamId, sourceId } = req;

    // ① service_record 已签退完成（status=2）且结算有效（settlement_status=1 EFFECTIVE）
    const eligibleRow = await this.deps.db
      .prepare(
        `SELECT 1 AS x
           FROM service_records sr
           JOIN attendance_sessions att ON att.id = sr.session_id
          WHERE sr.id = ?
            AND sr.user_id = ?
            AND sr.team_id = ?
            AND sr.status = 2
            AND sr.settlement_status = 1
          LIMIT 1`,
      )
      .bind(sourceId, recipientUserId, teamId)
      .first<{ x: number }>();

    if (eligibleRow == null) {
      return { eligible: false, reason: 'SERVICE_RECORD_NOT_EFFECTIVE' };
    }

    // ② blocking anomaly（status IN (1,2) = OPEN / CONFIRMED）一律阻断
    const blocked = await this.deps.db
      .prepare(
        `SELECT 1 AS x
           FROM attendance_anomalies an
           JOIN attendance_sessions att ON att.id = an.session_id
           JOIN service_records sr ON sr.session_id = att.id
          WHERE sr.id = ?
            AND sr.user_id = ?
            AND sr.team_id = ?
            AND an.status IN (1, 2)
          LIMIT 1`,
      )
      .bind(sourceId, recipientUserId, teamId)
      .first<{ x: number }>();

    if (blocked != null) {
      return { eligible: false, reason: 'ATTENDANCE_ANOMALY_BLOCKING' };
    }

    return { eligible: true };
  }
}

// =========================================================================
// CompositeEligibilityPolicy —— 按域概念分派到具体政策
// =========================================================================

export class CompositeEligibilityPolicy implements EligibilityPolicy {
  private readonly map: Map<CertificateSource, EligibilityPolicy>;

  constructor(entries: Partial<Record<CertificateSource, EligibilityPolicy>>) {
    this.map = new Map(
      Object.entries(entries).map(([k, v]) => [k as CertificateSource, v as EligibilityPolicy]),
    );
  }

  async check(req: {
    recipientUserId: number;
    teamId: number;
    domainSource: CertificateSource;
    sourceId: number;
  }): Promise<{ eligible: true } | { eligible: false; reason: string }> {
    const policy = this.map.get(req.domainSource);
    if (policy == null) {
      return { eligible: false, reason: 'UNSUPPORTED_SOURCE' };
    }
    return policy.check(req);
  }
}

// =========================================================================
// DefaultRecipientGuard —— 系统账号拒绝（fail-closed）
// =========================================================================

/**
 * 系统账号拒绝守卫。systemUserIds 由上层显式传入（如 env.CERT_SYSTEM_USER_IDS），
 * 【不】在代码内硬编码任何具体账号 id。空集合 = 不拒绝任何接收者（由调用方决定
 * 是否配置系统账号名单）；缺省即放行属可接受默认，因为「是否配置系统账号」是部署策略，
 * 而非 fail-open 漏洞（核心仍强制 recipientGuard 必须被注入）。
 */
export class DefaultRecipientGuard implements RecipientGuard {
  private readonly denylist: Set<number>;

  constructor(systemUserIds: number[]) {
    this.denylist = new Set(systemUserIds.filter((n) => Number.isInteger(n) && n > 0));
  }

  isDisallowedRecipient(userId: number): boolean {
    return this.denylist.has(userId);
  }
}
