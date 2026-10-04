/**
 * /api/v2/service-records —— 服务时长记录（ServiceRecord）只读 + 人工修正端点（S2-NEW-ARCH-P22-P4）。
 *
 * 授权链（DB-backed，D1PermissionProvider）：
 *   GET  /service-records/mine              → service.record.read（USER/SELF；volunteer + platform_super_admin）
 *   GET  /service-records                   → service.record.view（TEAM；owner/admin/auditor + platform 角色）
 *   GET  /service-records/:publicId         → service.record.view（TEAM）
 *   POST /service-records/:serviceRecordPublicId/adjustments  → service.record.adjust（TEAM，双人审批工作流「申请」入口）
 *   GET  /service-records/:serviceRecordPublicId/adjustments  → service.record.view OR service.record.review（TEAM）
 *   （旧的直接 POST .../:publicId/adjust 即时修正端点已移除，DIRECT_ADJUST_RUNTIME = REMOVED，见 P35-C2）
 *
 * 路由纪律（与 routes/forms.ts 一致）：**字面量段优先注册**——/mine 必须注册在 /:publicId 之前，
 * 否则会被参数路由吞掉。
 *
 * 对外投影纪律（P22-P4 §3）：响应【零内部 numeric FK】——不返回 service_records.id /
 * session_id / user_id / team_id / activity_id；关联实体只返回 public_id（ULID）。
 * 【刻意不返回 session_public_id】：attendance_sessions 无 public_id 列，不硬造。
 *
 * 租户隔离在 Repository 层收口（WHERE team_id=?）：跨团队与不存在统一 404，不构成 existence oracle。
 * platform_super_admin / platform_operator 的 TEAM 上下文行为沿用既有 middleware 语义，本路由不新造特权逻辑。
 *
 * 结算端点【不公开】：settlement 只由 attendance 状态转换内部触发（P22-P3）。
 */

import { Hono } from 'hono';
import type { Env, AppVars } from '../env';
import type { AuthContext } from '../types/auth';
import { ServiceRecordService } from '../services/service-record-service';
import { requirePermission } from '../middleware/rbac';
import { authorizePermissionDecision } from '../services/permission-provider';
import { ok, fail } from '../utils/response';
import {
  authRequired,
  invalidParam,
  forbidden,
  teamScopeRequired,
  notFound,
  AppError,
  ErrorCode,
  ErrorCodeValue,
} from '../utils/errors';
import { isUlid } from '../utils/validation';
import { buildCertificateIssuanceService, parseSystemUserIds } from '../services/certificate-issuance-factory';
import { CertificateSource, CertificateKind } from '../domain/certificate';
import { ServiceRecordRepository } from '../repository/service-records';

/**
 * P35-C3B：当前 actor 在「服务时长调整」上的能力投影。
 *
 * 【唯一来源】= 真实 permission evaluation（authorizePermissionDecision →
 * D1PermissionProvider → user_roles/roles/role_permissions/permissions），
 * 绝不按 role name 手工 hard-code，也绝不新造第二套 RBAC。
 *
 * 语义（与冻结 RBAC 目录一致）：
 *   can_submit_adjustment ← service.record.adjust
 *   can_review_adjustment ← service.record.review
 *
 * 【不是 authorization boundary】：本对象只用于前端显示层减少无效按钮；
 * 真实写端点仍各自 requirePermission 强制（越权/自审/跨团队一律后端 403 兜底）。
 */
export interface AdjustmentCapabilities {
  can_submit_adjustment: boolean;
  can_review_adjustment: boolean;
}

export async function computeAdjustmentCapabilities(
  env: Env,
  auth: AuthContext,
): Promise<AdjustmentCapabilities> {
  const [adjust, review] = await Promise.all([
    authorizePermissionDecision(env, auth, 'service.record.adjust'),
    authorizePermissionDecision(env, auth, 'service.record.review'),
  ]);
  return {
    can_submit_adjustment: adjust === 'allow',
    can_review_adjustment: review === 'allow',
  };
}

/**
 * ServiceRecord public_id 校验（本地实现，不修改 utils/validation.ts）。
 *
 * 为什么不能用 requireUlidParam：0017 对 0017 之前的存量行回填的 legacy public_id 形如
 * `'L' + 12 位零填充 id`（如 L000000000001）——'L' 刻意落在 Crockford ULID 字母表之外，
 * 用于与 runtime generateUlid() 永久隔离命名空间。这些存量行是 UNVERIFIED(0) 且对外可见，
 * 因此必须可寻址，不能被 ULID 正则误杀。
 *
 * 安全性：仅格式白名单校验；实际取值经 repository 的 `WHERE public_id = ?` 参数化绑定，
 * 不存在注入面。不存在 / 跨团队 → 404。
 */
const LEGACY_PUBLIC_ID_RE = /^L[0-9]{12}$/;

function requireServiceRecordPublicId(value: string | undefined, name: string): string {
  if (value == null || !(isUlid(value) || LEGACY_PUBLIC_ID_RE.test(value))) {
    throw invalidParam(name, 'must be a 26-char ULID or legacy L-prefixed id');
  }
  return value;
}

/**
 * POST-R5-P5：把 CertificateIssuanceService 的确定性业务结果（outcome）映射到统一失败信封。
 * 映射口径与 routes/activities.ts 的 issuanceFailure 完全一致（见该处注释）。
 */
function issuanceFailure(c: import('hono').Context, outcome: string): Response {
  const map: Record<string, { status: number; code: ErrorCodeValue }> = {
    NOT_ELIGIBLE: { status: 422, code: ErrorCode.VALIDATION_FAILED },
    RECIPIENT_NOT_FOUND: { status: 404, code: ErrorCode.NOT_FOUND },
    SOURCE_NOT_FOUND: { status: 404, code: ErrorCode.NOT_FOUND },
    SOURCE_ID_REQUIRED: { status: 400, code: ErrorCode.INVALID_PARAM },
    UNSUPPORTED_SOURCE: { status: 400, code: ErrorCode.INVALID_PARAM },
    INVALID_REQUEST: { status: 400, code: ErrorCode.INVALID_PARAM },
    ELIGIBILITY_POLICY_UNAVAILABLE: { status: 500, code: ErrorCode.INTERNAL_ERROR },
    RECIPIENT_GUARD_UNAVAILABLE: { status: 500, code: ErrorCode.INTERNAL_ERROR },
    CERTIFICATE_INSERT_FAILED: { status: 500, code: ErrorCode.INTERNAL_ERROR },
    AUDIT_FAILED: { status: 500, code: ErrorCode.INTERNAL_ERROR },
    NUMBER_POOL_UNAVAILABLE: { status: 409, code: ErrorCode.CONFLICT },
    NUMBER_POOL_EXHAUSTED: { status: 409, code: ErrorCode.CONFLICT },
    NUMBER_ALLOCATION_FAILED: { status: 500, code: ErrorCode.INTERNAL_ERROR },
  };
  const hit = map[outcome] ?? { status: 500, code: ErrorCode.INTERNAL_ERROR };
  return fail(c, new AppError(hit.code, hit.status, `certificate issuance failed: ${outcome}`));
}

/** business_service_date 过滤值校验（YYYY-MM-DD）。 */
const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function optionalBusinessDate(raw: string | undefined): string | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  if (!BUSINESS_DATE_RE.test(trimmed)) {
    throw invalidParam('business_service_date', 'must be YYYY-MM-DD');
  }
  return trimmed;
}

const serviceRecords = new Hono<{ Bindings: Env; Variables: AppVars }>();

/**
 * GET /api/v2/service-records/mine —— SELF 列表。
 *
 * 硬约束：只返回【当前认证用户本人】的记录；不接受任何指定他人的 query 参数
 * （userPublicId 等一律不解析，避免越权读取）。
 * 历史 UNVERIFIED(0) / REVOKED(2) 记录如实返回，并带明确的 settlement_status；
 * 「可见」不等于「可消费」——下游统计/积分仍只消费 EFFECTIVE(1)。
 *
 * Query（全部可选）：business_service_date=YYYY-MM-DD、limit（1..200，默认 50）
 */
serviceRecords.get('/mine', requirePermission('service.record.read'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const svc = new ServiceRecordService({
    db: c.env.DB,
    auth,
    tenant: c.get('tenant'),
  });
  const records = await svc.listMine({
    businessServiceDate: optionalBusinessDate(c.req.query('business_service_date')),
    limit: c.req.query('limit'),
  });

  return ok(c, { records });
});

/**
 * GET /api/v2/service-records —— TEAM 列表。
 * Query（全部可选）：business_service_date=YYYY-MM-DD、user_public_id=ULID、limit（1..200，默认 50）
 */
serviceRecords.get('/', requirePermission('service.record.view'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const svc = new ServiceRecordService({
    db: c.env.DB,
    auth,
    tenant: c.get('tenant'),
  });
  const records = await svc.listTeam({
    businessServiceDate: optionalBusinessDate(c.req.query('business_service_date')),
    userPublicId: c.req.query('user_public_id'),
    limit: c.req.query('limit'),
  });

  return ok(c, { records });
});

/**
 * GET /api/v2/service-records/:publicId —— TEAM 详情。
 * 跨团队与不存在统一 404（不区分）。
 */
serviceRecords.get('/:publicId', requirePermission('service.record.view'), async (c) => {
  const auth = c.get('auth');
  if (!auth.authenticated) throw authRequired();

  const publicId = requireServiceRecordPublicId(c.req.param('publicId'), 'publicId');

  const svc = new ServiceRecordService({
    db: c.env.DB,
    auth,
    tenant: c.get('tenant'),
  });
  const record = await svc.getByPublicId(publicId);

  return ok(c, { record });
});

/**
 * POST /api/v2/service-records/:serviceRecordPublicId/adjustments —— 提交修正申请（TEAM）。
 *
 * 双人审批工作流（P35-C2）的「申请」入口。权限 = service.record.adjust。
 * 旧的直接 PATCH/POST .../adjust 即时修正端点已【移除】（DIRECT_ADJUST_RUNTIME = REMOVED），
 * 任何时长修改必须经本申请 → 第二人审批 → 原子 APPLY，不再存在客户端直改通道。
 *
 * Body（严格）：{ "requested_minutes": 25, "reason": "人工核验修正" }。
 * - requested_minutes：整数、>= 0、<= 525600。
 * - reason：非空、1..500 字符。
 * - 客户端禁止提交 status / 任一 *_snapshot / requester / reviewer / team / points /
 *   settlement_status / 任何 numeric ID / 任何 approval 字段 → 400。
 */
const FORBIDDEN_ADJUSTMENT_REQUEST_FIELDS = [
  'status',
  'old_minutes_snapshot',
  'old_points_awarded_units_snapshot',
  'old_settlement_status_snapshot',
  'requester_id',
  'requester',
  'reviewer_id',
  'reviewer',
  'team_id',
  'team',
  'service_record_id',
  'service_record_public_id',
  'points_awarded_units',
  'points',
  'minutes',
  'settlement_status',
  'source',
  'id',
  'public_id',
  'trace_id',
  'operator_id',
  'approved_by',
] as const;

serviceRecords.post(
  '/:serviceRecordPublicId/adjustments',
  requirePermission('service.record.adjust'),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.authenticated) throw authRequired();

    const serviceRecordPublicId = requireServiceRecordPublicId(c.req.param('serviceRecordPublicId'), 'serviceRecordPublicId');

    let body: Record<string, unknown> = {};
    try {
      const json = await c.req.json();
      if (json != null && typeof json === 'object') body = json as Record<string, unknown>;
    } catch {
      body = {};
    }

    // 客户端禁止提交的字段：显式 400（先于业务校验）。
    for (const field of FORBIDDEN_ADJUSTMENT_REQUEST_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        throw invalidParam(field, 'must not be provided by client');
      }
    }

    const rawMinutes = body.requested_minutes;
    const rawReason = body.reason;

    if (typeof rawMinutes !== 'number' || !Number.isInteger(rawMinutes)) {
      throw invalidParam('requested_minutes', 'must be an integer');
    }
    if (typeof rawReason !== 'string') {
      throw invalidParam('reason', 'must be a string');
    }

    const svc = new ServiceRecordService({
      db: c.env.DB,
      auth,
      tenant: c.get('tenant'),
    });
    const adjustment = await svc.requestAdjustment(serviceRecordPublicId, {
      requestedMinutes: rawMinutes,
      reason: rawReason,
    });

    return ok(c, { adjustment });
  },
);

/**
 * GET /api/v2/service-records/:serviceRecordPublicId/adjustments —— 修正申请历史列表（TEAM）。
 *
 * 权限 = service.record.view OR service.record.review（最小安全 OR；不扩大权限）。
 * 返回按 requested_at DESC（newest first），投影仅含 public_id 与业务字段，
 * 绝不暴露 numeric requester_id / reviewer_id / team_id / id（§6 / §15）；
 * P35-C3B：额外返回 requester 安全公开身份（public_id + display_name）。
 *
 * P35-C3B：响应同时携带 capabilities（当前 actor 的真实 permission 能力投影），
 * 供管理端 UI 直接采用，取代此前的 legacy role 猜测。
 */
serviceRecords.get(
  '/:serviceRecordPublicId/adjustments',
  async (c) => {
    const auth = c.get('auth');
    if (!auth.authenticated) throw authRequired();

    // 权限：view OR review（二者任一即可；未知 code 由 authorizePermissionDecision 统一处理）。
    const viewDecision = await authorizePermissionDecision(c.env, auth, 'service.record.view');
    const reviewDecision = await authorizePermissionDecision(c.env, auth, 'service.record.review');
    if (viewDecision !== 'allow' && reviewDecision !== 'allow') {
      // view/review 均无授权（两 code 均属已知目录 → 按 forbidden 处理）。
      throw forbidden();
    }

    // P35-C3B：能力投影（真实 permission evaluation；非授权边界）。
    const capabilities = await computeAdjustmentCapabilities(c.env, auth);

    const serviceRecordPublicId = requireServiceRecordPublicId(c.req.param('serviceRecordPublicId'), 'serviceRecordPublicId');

    const svc = new ServiceRecordService({
      db: c.env.DB,
      auth,
      tenant: c.get('tenant'),
    });
    const adjustments = await svc.listAdjustments(serviceRecordPublicId);

    return ok(c, { adjustments, capabilities });
  },
);

// =========================================================================
// POST-R5-P5：服务记录证书发放接线（SERVICE source）
//
// 权限：certificate.certificate.issue（D1PermissionProvider 裁决）。
// 真实路由前缀（项目无 /admin/ 前缀）：/api/v2/service-records/...
//   :serviceRecordPublicId 支持 ULID 或 legacy `L` + 12 位数字（0017 回填）形态。
//
// 纪律（与活动路由一致）：
//   - teamId 必填（certificates / certificate_logs 为 TEAM_SCOPED）。
//   - 本人自发证（operatorUserId === recipientUserId）→ 403 SELF_ISSUE_FORBIDDEN。
//   - SERVICE 持久化 source_type='activity'、issue_source='service'、source_id=service_records.id
//     （由 CertificateIssuanceService 经 domain 派生，路由只提供 numeric service_records.id）。
// =========================================================================

/** POST /api/v2/service-records/:serviceRecordPublicId/certificate/preview —— 服务证书资格预览。 */
serviceRecords.post(
  '/:serviceRecordPublicId/certificate/preview',
  requirePermission('certificate.certificate.issue'),
  async (c) => {
    const auth = c.get('auth');
    const tenant = c.get('tenant');
    if (!auth.authenticated) throw authRequired();
    if (auth.userId == null) throw authRequired();
    if (tenant.teamId == null) throw teamScopeRequired();

    const srPublicId = requireServiceRecordPublicId(c.req.param('serviceRecordPublicId'), 'serviceRecordPublicId');
    const srRepo = new ServiceRecordRepository({ db: c.env.DB, ctx: { auth, tenant } });
    const sr = await srRepo.findRowByPublicId(srPublicId, tenant.teamId);
    if (sr == null) throw notFound('service_record');

    let body: Record<string, unknown> = {};
    try {
      const json = await c.req.json();
      if (json != null && typeof json === 'object' && !Array.isArray(json)) body = json as Record<string, unknown>;
    } catch {
      throw invalidParam('request', 'invalid request body');
    }
    const templateId = Number(body.templateId);
    if (!Number.isInteger(templateId) || templateId <= 0) throw invalidParam('templateId', 'must be a positive integer');

    const svc = buildCertificateIssuanceService(c.env.DB, { auth, tenant }, parseSystemUserIds(c.env));
    const r = await svc.previewEligibility({
      recipientUserId: sr.user_id,
      teamId: tenant.teamId,
      domainSource: CertificateSource.SERVICE,
      sourceId: sr.id,
    });
    return ok(c, { serviceRecordId: srPublicId, templateId, ...r });
  },
);

/** POST /api/v2/service-records/:serviceRecordPublicId/certificate/issue —— 服务证书发放。 */
serviceRecords.post(
  '/:serviceRecordPublicId/certificate/issue',
  requirePermission('certificate.certificate.issue'),
  async (c) => {
    const auth = c.get('auth');
    const tenant = c.get('tenant');
    if (!auth.authenticated) throw authRequired();
    if (auth.userId == null) throw authRequired();
    if (tenant.teamId == null) throw teamScopeRequired();

    const srPublicId = requireServiceRecordPublicId(c.req.param('serviceRecordPublicId'), 'serviceRecordPublicId');
    const srRepo = new ServiceRecordRepository({ db: c.env.DB, ctx: { auth, tenant } });
    const sr = await srRepo.findRowByPublicId(srPublicId, tenant.teamId);
    if (sr == null) throw notFound('service_record');

    const recipientUserId = sr.user_id;
    if (recipientUserId === auth.userId) throw forbidden('SELF_ISSUE_FORBIDDEN');

    let body: Record<string, unknown> = {};
    try {
      const json = await c.req.json();
      if (json != null && typeof json === 'object' && !Array.isArray(json)) body = json as Record<string, unknown>;
    } catch {
      body = {};
    }
    const templateId = Number(body.templateId);
    if (!Number.isInteger(templateId) || templateId <= 0) throw invalidParam('templateId', 'must be a positive integer');

    const svc = buildCertificateIssuanceService(c.env.DB, { auth, tenant }, parseSystemUserIds(c.env));
    const r = await svc.issue({
      recipientUserId,
      teamId: tenant.teamId,
      domainSource: CertificateSource.SERVICE,
      sourceId: sr.id,
      certKind: CertificateKind.PARTICIPANT,
      templateId,
      operatorUserId: auth.userId,
    });

    if (r.outcome === 'ISSUED' || r.outcome === 'ALREADY_ISSUED') {
      return ok(c, {
        serviceRecordId: srPublicId,
        userId: recipientUserId,
        outcome: r.outcome,
        certificatePublicId: r.certificatePublicId,
        certificateNo: r.certificateNo,
      });
    }
    return issuanceFailure(c, r.outcome);
  },
);

export default serviceRecords;
