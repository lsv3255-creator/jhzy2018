/**
 * CertificateIssuanceService（CERT-R3B 实现）—— 共享发证核心。
 *
 * 定位：唯一权威的「单一接收者发证原语」。批量发放将来逐接收者调用本方法，
 * **不另写批量专用发证逻辑**（BATCH_BOUNDARY 冻结契约）。
 *
 * 本 Gate 的硬边界：
 *   - 【不暴露 HTTP 路由】不 import Hono / 不注册 route（由后续独立 Gate 接线）。
 *   - 【不迁移考试】不 import exam.ts、不改其事务边界（EXAM NON-REGRESSION）。
 *   - 【不生成 PDF / 不上传 R2】文件状态按冻结契约停留在 PENDING。
 *   - 【不发明资格政策】资格由注入的 EligibilityPolicy 决定；**缺省即拒绝**
 *     （fail-closed，CERT-R3B-FIX）——未接入政策时真实证书绝不被发放。
 *   - 【不做 RBAC 判定】授权由路由层负责；本服务只校验「发放域不变量」
 *     （操作者已认证、teamId 结构合法、接收者守卫、命名空间派生）。
 *
 * 业务结果契约（确定性、可机读；预期业务结果不抛异常、不进 catch）：
 *   ISSUED | ALREADY_ISSUED | NOT_ELIGIBLE | RECIPIENT_NOT_FOUND | SOURCE_NOT_FOUND
 *   | SOURCE_ID_REQUIRED | UNSUPPORTED_SOURCE | NUMBER_POOL_UNAVAILABLE
 *   | NUMBER_POOL_EXHAUSTED | NUMBER_ALLOCATION_FAILED | CERTIFICATE_INSERT_FAILED
 *   | AUDIT_FAILED | INVALID_REQUEST
 */

import {
  CertificateKind,
  CertificateSource,
  IssuanceReason,
  deriveFileStatus,
  issueSourceFor,
  persistedSourceFor,
  type CertificateFileStatus,
  type IssueSource,
  type IssuanceReason as IssuanceReasonT,
} from '../domain/certificate';
import {
  CertificateIssuanceRepository,
  type PoolConsumeOutcome,
} from '../repository/certificate-issuance';
import {
  PoolCertificateNumberAllocator,
  POOL_FOR_ACTIVITY,
  POOL_FOR_SERVICE,
  type AllocationResult,
} from './certificate-number-allocator';
import { generateUlid } from '../utils/crypto';

// ===== 请求 / 结果（CERT-R3B 实现侧；不含 PII）=====

/**
 * 发证请求。
 * 纪律：不含 holder_name / issuer_name / 手机号 / 身份证等任何 PII；
 * holder/issuer 如需展示，由后续读侧从 users 派生，不在写入请求中携带。
 */
export interface IssuanceRequest {
  /** 规范 users.id（非 PII）。 */
  recipientUserId: number;
  /** 团队上下文（TEAM_SCOPED 写入需要）。 */
  teamId: number;
  /** 域源（不是持久化取值）。issue_source 由域派生，不接受调用方任意指定。 */
  domainSource: CertificateSource;
  /** 成就类必填；ACCEPTANCE 必须为 null。 */
  sourceId: number | null;
  /** 证书种类（本 Gate 支持 participant 真实成就；acceptance 仅契约）。 */
  certKind: CertificateKind;
  /** 发证原因（默认 normal）。 */
  issuanceReason?: IssuanceReasonT;
  /** 模板 id（必填，列 NOT NULL + FK）。 */
  templateId: number;
  /** 执行发放的操作者（路由层已鉴权；此处仅作 issued_by 与审计）。 */
  operatorUserId: number;
  /** 批量上下文（可空；写入 certificate_logs.batch_id）。 */
  batchPublicId?: string | null;
}

export type IssuanceOutcome =
  | 'ISSUED'
  | 'ALREADY_ISSUED'
  | 'NOT_ELIGIBLE'
  | 'RECIPIENT_NOT_FOUND'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_ID_REQUIRED'
  | 'UNSUPPORTED_SOURCE'
  | 'NUMBER_POOL_UNAVAILABLE'
  | 'NUMBER_POOL_EXHAUSTED'
  | 'NUMBER_ALLOCATION_FAILED'
  | 'CERTIFICATE_INSERT_FAILED'
  | 'AUDIT_FAILED'
  // CERT-R3B-FIX：fail-closed 专用确定性结果（缺配置即拒绝，绝不默认放行）
  | 'ELIGIBILITY_POLICY_UNAVAILABLE'
  | 'RECIPIENT_GUARD_UNAVAILABLE'
  | 'INVALID_REQUEST';

export interface IssuanceResult {
  outcome: IssuanceOutcome;
  /** 仅 ISSUED / ALREADY_ISSUED 时有值。 */
  certificatePublicId?: string;
  certificateNo?: string;
  fileStatus?: CertificateFileStatus;
  /** 已存在证书时回显其幂等键（不含 PII）。 */
  namespace?: { sourceType: string; issueSource: IssueSource; sourceId: number };
}

// ===== 资格策略注入（fail-closed；本 Gate 不发明业务规则）=====

/**
 * 资格策略。**CERT-R3B-FIX：默认失败（fail-closed）。**
 *
 * 修正背景：此前默认 `ALLOW_ALL_ELIGIBILITY`（缺省即放行），这意味着
 * 「未接入资格政策」时真实 ACTIVITY/SERVICE 证书会被【无条件发放】——
 * 即绕过资格校验的发证，属安全缺陷。
 *
 * 现行为：未注入 policy → 构造期即抛 POLICY_NOT_CONFIGURED；
 * 注入后严格按其判定执行（true/false 均由 policy 显式给出，核心不猜测）。
 * 核心【不发明】任何资格业务规则（如考勤/时长门槛），只强制「必须有人负责」。
 */
export interface EligibilityPolicy {
  check(req: {
    recipientUserId: number;
    teamId: number;
    domainSource: CertificateSource;
    sourceId: number;
  }): Promise<{ eligible: true } | { eligible: false; reason: string }>;
}

/**
 * 拒绝一切的占位策略（fail-closed 默认值）。
 * 保留导出仅为显式测试「policy 明确拒绝」路径；生产不应使用它代替真实政策。
 */
export const DENY_ALL_ELIGIBILITY: EligibilityPolicy = {
  async check() {
    return { eligible: false, reason: 'ELIGIBILITY_POLICY_UNAVAILABLE' };
  },
};

/**
 * 接收者守卫（注入式，**fail-closed**）。
 *
 * CERT-R3B-FIX 修正：此前 `recipientGuard` 缺省为 `null` 即【放行】，
 * 意味着未接入守卫时系统账号可被发证 —— 同样属 fail-open 缺陷。
 * 现行为：缺省 → 确定性拒绝（INVALID_REQUEST / RECIPIENT_GUARD_UNAVAILABLE）。
 *
 * 仍【不硬编码】任何具体 user id（如 1676）：「谁是系统账号」属授权/业务政策，
 * 由上层显式实现守卫；核心只强制「必须有人负责」。
 */
export interface RecipientGuard {
  isDisallowedRecipient(userId: number): boolean;
}

// ===== 本 Gate 支持的域源（冻结范围）=====

const SUPPORTED_DOMAIN_SOURCES: ReadonlySet<CertificateSource> = new Set<CertificateSource>([
  CertificateSource.ACTIVITY,
  CertificateSource.SERVICE,
]);

export class CertificateIssuanceService {
  private readonly repo: CertificateIssuanceRepository;
  private readonly allocator: PoolCertificateNumberAllocator;
  private readonly eligibility: EligibilityPolicy;
  private readonly recipientGuard: RecipientGuard;

  /**
   * CERT-R3B-FIX：两处依赖均【必填】，缺失即抛（fail-closed）。
   * 修正前二者可选且缺省放行 —— 未接入资格/守卫时真实证书会被无条件发放。
   * 抛错优于返回失败：缺配置属**接线错误**（程序员错误），应在启动/构造期暴露。
   */
  constructor(args: {
    repo: CertificateIssuanceRepository;
    eligibility: EligibilityPolicy;
    recipientGuard: RecipientGuard;
  }) {
    if (!args.eligibility) throw new Error('POLICY_NOT_CONFIGURED: eligibility policy is required');
    if (!args.recipientGuard) throw new Error('POLICY_NOT_CONFIGURED: recipientGuard is required');
    this.repo = args.repo;
    this.allocator = new PoolCertificateNumberAllocator(args.repo);
    this.eligibility = args.eligibility;
    this.recipientGuard = args.recipientGuard;
  }

  /**
   * 权威发证原语。批量将来逐接收者调用本方法，语义完全一致。
   *
   * 执行顺序（验证 → 资格 → 幂等 → 分配 → 原子 batch → 审计核验）：
   *   1. 结构验证（不触库）
   *   2. 接收者存在性 + 系统账号守卫
   *   3. 源实体存在性（多态 source_id 的应用层权威校验）
   *   4. 资格策略（注入，默认放行）
   *   5. 命名空间幂等预检（DB 唯一索引仍是最终裁决者）
   *   6. 号池探测（不消费）
   *   7. 单个 D1 batch：证书 INSERT + 号池条件消费 + 审计 INSERT
   *   8. 审计存在性核验（缺失则不得报 ISSUED）
   */
  async issue(req: IssuanceRequest): Promise<IssuanceResult> {
    // ---- 1. 结构验证 ----
    if (!Number.isInteger(req.recipientUserId) || req.recipientUserId <= 0) {
      return { outcome: 'INVALID_REQUEST' };
    }
    if (!Number.isInteger(req.operatorUserId) || req.operatorUserId <= 0) {
      return { outcome: 'INVALID_REQUEST' };
    }
    if (!Number.isInteger(req.teamId) || req.teamId <= 0) {
      return { outcome: 'INVALID_REQUEST' };
    }
    if (!SUPPORTED_DOMAIN_SOURCES.has(req.domainSource)) {
      return { outcome: 'UNSUPPORTED_SOURCE' };
    }
    if (!Number.isInteger(req.templateId) || req.templateId <= 0) {
      return { outcome: 'INVALID_REQUEST' };
    }
    // 模板必须存在且启用（certificates.template_id 为 NOT NULL + FK；
    // 此处显式校验以给出确定性业务结果，而非依赖 DB 约束报错）
    const tpl = await this.repo.findActiveTemplate(req.templateId);
    if (tpl == null) return { outcome: 'INVALID_REQUEST' };

    // 命名空间由【域源派生】，不接受调用方任意指定（防止跨命名空间错写）
    const issueSource = issueSourceFor(req.domainSource);
    const sourceType = persistedSourceFor(req.domainSource);
    if (issueSource == null) return { outcome: 'UNSUPPORTED_SOURCE' };

    // 成就类证书必须有权威 source_id（否则幂等保护形同虚设）
    if (req.sourceId == null || !Number.isInteger(req.sourceId) || req.sourceId <= 0) {
      return { outcome: 'SOURCE_ID_REQUIRED' };
    }
    const sourceId = req.sourceId;

    // ---- 2. 接收者存在性 + 接收者守卫（fail-closed） ----
    const recipient = await this.repo.findRecipient(req.recipientUserId);
    if (recipient == null) return { outcome: 'RECIPIENT_NOT_FOUND' };
    // 守卫必填（构造期已强制），此处再做一次防御性判定，确保 fail-closed 不会被绕过。
    if (typeof this.recipientGuard?.isDisallowedRecipient !== 'function') {
      return { outcome: 'RECIPIENT_GUARD_UNAVAILABLE' };
    }
    if (this.recipientGuard.isDisallowedRecipient(req.recipientUserId)) {
      return { outcome: 'INVALID_REQUEST' };
    }

    // ---- 3. 源实体存在性（多态校验） ----
    if (!(await this.repo.sourceEntityExists(issueSource, sourceId))) {
      return { outcome: 'SOURCE_NOT_FOUND' };
    }

    // ---- 4. 资格策略（必填；fail-closed） ----
    if (typeof this.eligibility?.check !== 'function') {
      return { outcome: 'ELIGIBILITY_POLICY_UNAVAILABLE' };
    }
    const elig = await this.eligibility.check({
      recipientUserId: req.recipientUserId,
      teamId: req.teamId,
      domainSource: req.domainSource,
      sourceId,
    });
    if (!elig.eligible) return { outcome: 'NOT_ELIGIBLE' };

    // ---- 5. 命名空间幂等预检（DB UNIQUE 仍是最终裁决者） ----
    const existing = await this.repo.findActiveByNamespace({
      userId: req.recipientUserId,
      sourceType,
      issueSource,
      sourceId,
    });
    if (existing != null) {
      return {
        outcome: 'ALREADY_ISSUED',
        certificatePublicId: existing.public_id,
        certificateNo: existing.cert_no,
        fileStatus: deriveFileStatus(null, false),
        namespace: { sourceType, issueSource, sourceId },
      };
    }

    // ---- 6. 号池探测（不消费；不回退到其它池） ----
    const poolType = req.domainSource === CertificateSource.SERVICE ? POOL_FOR_SERVICE : POOL_FOR_ACTIVITY;
    const alloc: AllocationResult = await this.allocator.allocate(poolType);
    if (!alloc.ok) {
      return {
        outcome: alloc.reason === 'POOL_EXHAUSTED' ? 'NUMBER_POOL_EXHAUSTED' : 'NUMBER_POOL_UNAVAILABLE',
      };
    }

    // ---- 7. 单个原子 batch ----
    const certPublicId = generateUlid();
    const verifyCode = generateUlid();
    const now = Math.floor(Date.now() / 1000);
    const issuanceReason: IssuanceReasonT = req.issuanceReason ?? IssuanceReason.NORMAL;

    let batchResult: { certInserted: boolean; poolConsumed: boolean };
    try {
      batchResult = await this.repo.issueBatch({
        poolType: alloc.poolType,
        poolCode: alloc.code,
        certPublicId,
        certNo: alloc.code,
        verifyCode,
        templateId: req.templateId,
        userId: req.recipientUserId,
        teamId: req.teamId,
        certType: 'activity',
        sourceType,
        issueSource,
        sourceId,
        certKind: req.certKind,
        issueReason: issuanceReason,
        operatorId: req.operatorUserId,
        now,
        batchPublicId: req.batchPublicId ?? null,
      });
    } catch (e) {
      // UNIQUE 冲突（并发抢占同一成就）→ 确定性地归一为 ALREADY_ISSUED，
      // 不退化为 500，也不重发编号（号未烧，因整个 batch 回滚）。
      if (isUniqueViolation(e)) {
        const raced = await this.repo.findActiveByNamespace({
          userId: req.recipientUserId,
          sourceType,
          issueSource,
          sourceId,
        });
        if (raced != null) {
          return {
            outcome: 'ALREADY_ISSUED',
            certificatePublicId: raced.public_id,
            certificateNo: raced.cert_no,
            fileStatus: deriveFileStatus(null, false),
            namespace: { sourceType, issueSource, sourceId },
          };
        }
        return { outcome: 'ALREADY_ISSUED', namespace: { sourceType, issueSource, sourceId } };
      }
      return { outcome: 'CERTIFICATE_INSERT_FAILED' };
    }

    // 并发抢占：证书未插入（幂等键被占）→ 同样归一为 ALREADY_ISSUED
    if (!batchResult.certInserted) {
      const raced = await this.repo.findActiveByNamespace({
        userId: req.recipientUserId,
        sourceType,
        issueSource,
        sourceId,
      });
      if (raced != null) {
        return {
          outcome: 'ALREADY_ISSUED',
          certificatePublicId: raced.public_id,
          certificateNo: raced.cert_no,
          fileStatus: deriveFileStatus(null, false),
          namespace: { sourceType, issueSource, sourceId },
        };
      }
      // 证书未插入但也查不到 active 行：号池条件消费成功而证书失败不应发生
      // （号消费以 EXISTS(cert) 为守卫）。此分支为异常态，保守报插入失败。
      return { outcome: 'CERTIFICATE_INSERT_FAILED' };
    }

    // ---- 8. 审计核验（审计是成功契约的一部分） ----
    const auditCount = await this.repo.countIssueAudit(certPublicId);
    if (auditCount < 1) return { outcome: 'AUDIT_FAILED' };

    return {
      outcome: 'ISSUED',
      certificatePublicId: certPublicId,
      certificateNo: alloc.code,
      // 冻结契约：新发证书无 PDF → PENDING；PDF 生成属 POST_TX，不在本 Gate
      fileStatus: deriveFileStatus(null, true),
      namespace: { sourceType, issueSource, sourceId },
    };
  }

  /**
   * 资格预览（只读投影，无写）。批量将来用它做「可发 / 已发 / 不可发」分桶。
   * 与 issue() 共用同一命名空间与资格策略，保证预览与实际发证口径一致。
   */
  async previewEligibility(req: {
    recipientUserId: number;
    teamId: number;
    domainSource: CertificateSource;
    sourceId: number;
  }): Promise<{ eligible: boolean; alreadyIssued: boolean; reason?: string }> {
    if (!SUPPORTED_DOMAIN_SOURCES.has(req.domainSource)) {
      return { eligible: false, alreadyIssued: false, reason: 'UNSUPPORTED_SOURCE' };
    }
    const issueSource = issueSourceFor(req.domainSource);
    const sourceType = persistedSourceFor(req.domainSource);
    if (issueSource == null) {
      return { eligible: false, alreadyIssued: false, reason: 'UNSUPPORTED_SOURCE' };
    }
    if (!(await this.repo.sourceEntityExists(issueSource, req.sourceId))) {
      return { eligible: false, alreadyIssued: false, reason: 'SOURCE_NOT_FOUND' };
    }
    const existing = await this.repo.findActiveByNamespace({
      userId: req.recipientUserId,
      sourceType,
      issueSource,
      sourceId: req.sourceId,
    });
    if (existing != null) return { eligible: false, alreadyIssued: true };
    if (typeof this.eligibility?.check !== 'function') {
      return { eligible: false, alreadyIssued: false, reason: 'ELIGIBILITY_POLICY_UNAVAILABLE' };
    }
    const elig = await this.eligibility.check({
      recipientUserId: req.recipientUserId,
      teamId: req.teamId,
      domainSource: req.domainSource,
      sourceId: req.sourceId,
    });
    return elig.eligible
      ? { eligible: true, alreadyIssued: false }
      : { eligible: false, alreadyIssued: false, reason: elig.reason };
  }
}

/** 判定异常是否为 DB 唯一约束冲突（跨 SQLite/D1 措辞）。 */
function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed|constraint failed: UNIQUE|SQLITE_CONSTRAINT/i.test(msg);
}

export type { PoolConsumeOutcome, AllocationResult };
