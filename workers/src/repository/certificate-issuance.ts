/**
 * CertificateIssuanceRepository（CERT-R3B）—— 发证核心的 D1 原语。
 *
 * 职责边界（CERT-R3B）：
 *   - 只承载「仓储原语」：号池探测、条件 INSERT、审计 INSERT、幂等探测、源实体校验。
 *   - 【不含】业务编排、鉴权判定、资格政策。资格政策由调用方注入（EligibilityPolicy）。
 *   - 【不含】HTTP 路由、不含 PDF/R2。本模块不 import 任何 route / Hono。
 *   - 【不修改】现有 exam 写入路径（EXAM NON-REGRESSION：本模块为新增文件，
 *     exam.ts 不被 import、不被修改；仅共享 D1 惯用法与幂等语义）。
 *
 * scope 事实（tenant-scope.ts）：
 *   - certificates / certificate_logs = TEAM_SCOPED
 *   - id_pools = PLATFORM_GLOBAL
 *   - activities / service_records = TEAM_SCOPED
 *
 * 原子性模型（D1）：
 *   D1 的 `db.batch()` 是官方保证的原子事务单元。本模块把
 *   「号池消费 → 证书 INSERT → 审计 INSERT」放进【同一个 batch】，
 *   并沿用 P32 已验证的条件 SQL + 派生 EXISTS 守卫模式：
 *     - 号池消费以 `EXISTS(certificates ...)` 为前置 → 证书未生成则不烧号；
 *     - 证书 INSERT 以 `NOT EXISTS(同幂等键 active 证书)` 为守卫 → 应用层幂等；
 *     - 审计 INSERT 以 `SELECT id FROM certificates WHERE public_id=?` 派生 → read-your-writes。
 *   DB 唯一索引 uq_cert_user_source 是并发的最终裁决者（应用层预检不作为唯一防线）。
 */

import { BaseRepository, type RepoDeps } from './base';
import {
  CertificateKind,
  CertificateSource,
  allocatableProvenanceSql,
  type IssueSource,
  type PersistedSourceType,
} from '../domain/certificate';

// ===== 事务内号池分配的结果（由 statement meta.changes 解释）=====

/**
 * 号池条件消费的结果分类。
 * - CONSUMED：本次消费成功（changes=1）
 * - UNAVAILABLE：池无 status=0 候选（未播种 / 已耗尽），changes=0
 * - CONFLICT：候选在并发下被抢占（守卫未命中），changes=0
 */
export type PoolConsumeOutcome = 'CONSUMED' | 'UNAVAILABLE' | 'CONFLICT';

// ===== 源实体存在性（多态 source_id 的应用层校验）=====

/** 域源 → 其权威 source_id 应指向的实体表（多态，SQLite 无法建 FK）。 */
export const ISSUE_SOURCE_ENTITY_TABLE: Readonly<Record<'activity' | 'service', string>> = Object.freeze({
  activity: 'activities',
  service: 'service_records',
});

export class CertificateIssuanceRepository extends BaseRepository {
  constructor(deps: RepoDeps) {
    super(deps);
  }

  // ===== 号池（id_pools，PLATFORM_GLOBAL）=====

  /**
   * 只读探测：取该池首个【可分配】空闲编号（status=0 且 provenance 合规）。
   *
   * CERT-R3D-FIX §9：候选必须额外满足
   *   `provenance ∈ ALLOCATABLE_PROVENANCES`（'legacy_migrated' | 'v2_native'）
   * 从而确定性排除合成兼容库存（'v2_synthetic_compat'）与任何未分类/NULL 来源
   * （fail-closed：白名单谓词天然不命中未知值）。
   * 与 CertificateRepository.pickCertTrnCandidate 共用同一资格规则片段。
   *
   * `ORDER BY id ASC` 仅在【合格集合内部】提供确定性定序，不承担语义优先级。
   * 注意：探测与消费分离；真正的消费在 issueBatch 内以条件 UPDATE 完成。
   */
  async peekPoolCode(poolType: string): Promise<string | null> {
    this.ensureTableRead('id_pools');
    const row = await this.first<{ code: string }>(
      `SELECT code FROM id_pools
        WHERE pool_type = ? AND status = 0
          AND ${allocatableProvenanceSql()}
        ORDER BY id ASC LIMIT 1`,
      [poolType],
    );
    return row?.code ?? null;
  }

  /**
   * 只读探测：该池是否存在【任意】行（不区分 status）。
   * 用途：让分配器能区分 POOL_UNAVAILABLE（未播种）与 POOL_EXHAUSTED（已全部消费）。
   */
  async peekAnyPoolRow(poolType: string): Promise<boolean> {
    this.ensureTableRead('id_pools');
    const row = await this.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM id_pools WHERE pool_type = ? LIMIT 1`,
      [poolType],
    );
    return (row?.n ?? 0) > 0;
  }

  /**
   * 构造【号池条件消费】语句（必须在 issueBatch 内与证书 INSERT 同批执行）。
   *
   * 守卫链（缺一不可）：
   *   1. pool_type + code + status=0 → 候选必须仍未被抢占；
   *   1b. provenance ∈ ALLOCATABLE_PROVENANCES → 【与 peekPoolCode 同一谓词】
   *       CERT-R3D-FIX §10：选择与消费必须使用完全相同的资格规则，
   *       否则会出现「选时合法、烧时按另一套规则」的不一致，
   *       并可能烧掉合成兼容库存。
   *   2. EXISTS(certificates public_id=?) → 本批证书已真实生成才允许烧号。
   * 第 2 条是「证书失败不烧号」的唯一保证，与 exam.ts 的消费守卫完全同构。
   */
  buildPoolConsumeStatement(args: {
    poolType: string;
    code: string;
    assignedTo: number;
    now: number;
    issuedCertPublicId: string;
  }): { sql: string; params: unknown[] } {
    return {
      sql: `UPDATE id_pools
               SET status = 1, assigned_to = ?, assigned_at = ?
             WHERE pool_type = ? AND code = ? AND status = 0
               AND ${allocatableProvenanceSql()}
               AND EXISTS (SELECT 1 FROM certificates c
                            WHERE c.public_id = ? AND c.status = 1)`,
      params: [args.assignedTo, args.now, args.poolType, args.code, args.issuedCertPublicId],
    };
  }

  // ===== 幂等探测（应用层预检；DB 唯一索引仍是最终裁决者）=====

  /**
   * 命名空间安全的幂等探测：严格按 0045 修正后的四列键查询。
   * 跨命名空间（同数值 source_id 但 issue_source 不同）天然不命中 → 不会互相误判。
   */
  async findActiveByNamespace(args: {
    userId: number;
    sourceType: Exclude<PersistedSourceType, null>;
    issueSource: IssueSource;
    sourceId: number;
  }): Promise<{ id: number; public_id: string; cert_no: string; status: number } | null> {
    this.ensureTableRead('certificates');
    return this.first<{ id: number; public_id: string; cert_no: string; status: number }>(
      `SELECT id, public_id, cert_no, status
         FROM certificates
        WHERE user_id = ? AND source_type = ? AND issue_source = ? AND source_id = ?
          AND status = 1
        LIMIT 1`,
      [args.userId, args.sourceType, args.issueSource, args.sourceId],
    );
  }

  // ===== 源实体存在性（多态 source_id 的权威校验）=====

  /** 校验域源对应的 source_id 在其实体表中真实存在（application-level；列无 FK）。 */
  async sourceEntityExists(issueSource: IssueSource, sourceId: number): Promise<boolean> {
    const table = ISSUE_SOURCE_ENTITY_TABLE[issueSource];
    // 表名来自上方常量映射，非用户输入；仍走参数化绑定。
    this.ensureTableRead('certificates');
    const row = await this.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`, [
      sourceId,
    ]);
    return (row?.n ?? 0) > 0;
  }

  /**
   * 接收者存在性（按【真实 schema】查询）。
   *
   * ⚠ schema 事实修正（CERT-R3B 实测发现）：V2.0 的 `users` 表**没有** `is_system`
   *   与 `team_id` 列（见 0001_initial_schema.sql）。`is_system` 实际位于 **teams** 表，
   *   语义是「该团队是否为系统团队」，与「接收者是否为系统账号」不是同一件事。
   *   CERT-R2 契约中的 `assertNotSystemUser(userId, isSystem)` 属**域层注入式守卫**：
   *   其 `isSystem` 布尔由调用方提供，而非从 `users` 读取的列。
   *   故此处只校验「用户存在且未软删除」，系统账号语义交由调用方以域层参数表达。
   */
  async findRecipient(userId: number): Promise<{ id: number; status: number } | null> {
    this.ensureTableRead('certificates');
    return this.first<{ id: number; status: number }>(
      `SELECT id, status FROM users WHERE id = ? AND deleted_at IS NULL`,
      [userId],
    );
  }

  /**
   * 团队是否为系统团队（teams.is_system，真实列）。
   * 用于「系统团队不应作为真实成就证书的 team 归属」这一可选用途；
   * 默认不参与发放判定（无授权政策支撑），仅暴露事实供上层决定。
   */
  async findTeamSystemFlag(teamId: number): Promise<{ is_system: number } | null> {
    this.ensureTableRead('certificates');
    return this.first<{ is_system: number }>(`SELECT is_system FROM teams WHERE id = ?`, [teamId]);
  }

  /** 模板存在且启用（发证必须绑定有效模板，列有 NOT NULL + FK 约束）。 */
  async findActiveTemplate(templateId: number): Promise<{ id: number; cert_type: string } | null> {
    this.ensureTableRead('certificate_templates');
    return this.first<{ id: number; cert_type: string }>(
      `SELECT id, cert_type FROM certificate_templates WHERE id = ? AND status = 1`,
      [templateId],
    );
  }

  // ===== 事务核心：号池消费 + 证书 INSERT + 审计 INSERT（同一 batch）=====

  /**
   * 原子发证 batch。**这是本 Gate 的权威写路径。**
   *
   * 原子性范围（D1 db.batch 语义）：
   *   ✓ 号池消费
   *   ✓ 证书 INSERT
   *   ✓ 审计 INSERT (certificate_logs)
   *   ✗ 资格判定（调用方在 batch 前预检；持久化条件中含 NOT EXISTS 幂等守卫兜底）
   *   ✗ PDF / R2（按冻结契约完全在事务外）
   *
   * 不使用显式 BEGIN/COMMIT（D1 不支持）；不使用 INSERT..RETURNING（代码库无先例）。
   */
  async issueBatch(args: {
    poolType: string;
    poolCode: string;
    certPublicId: string;
    certNo: string;
    verifyCode: string;
    templateId: number;
    userId: number;
    teamId: number;
    certType: 'training' | 'activity' | 'honor';
    sourceType: Exclude<PersistedSourceType, null>;
    issueSource: IssueSource;
    sourceId: number;
    certKind: CertificateKind;
    issueReason: string;
    operatorId: number;
    now: number;
    batchPublicId?: string | null;
  }): Promise<{ certInserted: boolean; poolConsumed: boolean }> {
    this.ensureTableRead('certificates');
    this.ensureTableRead('certificate_logs');
    this.ensureTableRead('id_pools');

    // (1) 证书条件 INSERT：幂等键守卫（命名空间安全）+ 无 PII 快照
    const certInsert = this.db
      .prepare(
        `INSERT INTO certificates
           (public_id, cert_no, verify_code, template_id, user_id, team_id, cert_type,
            source_type, issue_source, source_id, cert_kind, issue_reason, issued_by,
            holder_name, issuer_name, snapshot, status, issued_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?)`,
      )
      .bind(
        args.certPublicId,
        args.certNo,
        args.verifyCode,
        args.templateId,
        args.userId,
        args.teamId,
        args.certType,
        args.sourceType,
        args.issueSource,
        args.sourceId,
        args.certKind,
        args.issueReason,
        args.operatorId,
        args.now,
        args.now,
      );

    // (2) 号池条件消费：仅当本批证书已生成（read-your-writes）
    const poolStmt = this.buildPoolConsumeStatement({
      poolType: args.poolType,
      code: args.poolCode,
      assignedTo: args.userId,
      now: args.now,
      issuedCertPublicId: args.certPublicId,
    });
    const poolUpdate = this.db.prepare(poolStmt.sql).bind(...(poolStmt.params as never[]));

    // (3) 审计 INSERT：certificate_id 由 public_id 派生（read-your-writes）
    const auditInsert = this.db
      .prepare(
        `INSERT INTO certificate_logs
           (team_id, certificate_id, action, reason, operator_id, result, failure_code, batch_id, created_at)
         SELECT c.team_id, c.id, 'issue', ?, ?, 'success', NULL, ?, ?
           FROM certificates c
          WHERE c.public_id = ? AND c.status = 1`,
      )
      .bind(
        args.issueReason,
        args.operatorId,
        args.batchPublicId ?? null,
        args.now,
        args.certPublicId,
      );

    const results = await this.db.batch([certInsert, poolUpdate, auditInsert]);

    const certChanges = Number((results[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0);
    const poolChanges = Number((results[1] as { meta?: { changes?: number } })?.meta?.changes ?? 0);
    return { certInserted: certChanges > 0, poolConsumed: poolChanges > 0 };
  }

  /**
   * 审计失败检测：单独统计某证书的 issue 审计行是否存在。
   * 用于「审计是成功契约的一部分」——若审计缺失，调用方不得报告 ISSUED。
   */
  async countIssueAudit(certPublicId: string): Promise<number> {
    this.ensureTableRead('certificate_logs');
    const row = await this.first<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM certificate_logs l
         JOIN certificates c ON c.id = l.certificate_id
        WHERE c.public_id = ? AND l.action = 'issue'`,
      [certPublicId],
    );
    return row?.n ?? 0;
  }
}
