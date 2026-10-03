/**
 * Certificate Domain Contract（CERT-R2 权威类型契约）。
 *
 * 职责边界（CERT-R2）：
 *   - 仅承载「域类型 + 纯函数 + 接口/契约」；不含任何运行时写逻辑。
 *   - 写逻辑（shared CertificateIssuanceService.issue 等）在 CERT-R3 实现；
 *     本轮不修改 exam.ts（考试发卡路径行为保持不变）。
 *   - 该文件不被任何既有模块 import，仅作为后续包（CERT-R3+）的权威类型来源；
 *     独立 typecheck 通过即视为编译安全。
 *
 * 与 CERT-R1 的对应：
 *   - 活动/服务幂等键 = (user_id, source_type, source_id) WHERE status=1，由
 *     migration 0045 的 uq_cert_user_source 在 DB 层兜底（仅 activity）；
 *     真实发放由 CERT-R3 的 issue() 原语以 SQL NOT EXISTS 谓词在应用层先行校验，
 *     对齐 exam.ts submitAndMaybeIssueAtomically 的模式。
 *   - cert_kind / issue_reason / issued_by / revoke_* 由 0045 新增列承载。
 */

// ===== Source（源；双层模型，PERSISTED COMPATIBILITY + DOMAIN SEMANTICS）=====
//
// 【第 1 层】PERSISTED SOURCE COMPATIBILITY（持久化兼容层）
//   既有 CHECK：source_type IN (NULL, 'course', 'exam', 'activity', 'manual')
//   生产现实（2026-10-03 只读核验，413 行）：
//     - course 358 / activity 55；全部 413 行 source_id 均为 NULL
//     - 全部 413 行 status=1（active）
//     - 存量行没有「权威 source identity」，属 legacy/service 种子形状
//   本层纪律：CERT-R2 【不新增、不修改、不删除】任何 source_type 取值。
//
// 【第 2 层】DOMAIN SOURCE SEMANTICS（域语义层）
//   域枚举给出「概念上的源」，与持久化解耦；不因域模型想要更干净的 enum
//   就发明新的 persisted source_type（会破坏存量兼容与 CHECK 约束）。
//
export type PersistedSourceType = 'course' | 'exam' | 'activity' | 'manual' | null;

/**
 * 域层暴露的「概念源」，与持久化 source_type 解耦。
 *
 * 映射表（DOMAIN → PERSISTED）：
 *   TRAINING_EXAM → 'exam'
 *   COURSE        → 'course'
 *   ACTIVITY      → 'activity'
 *   MANUAL        → 'manual'
 *   SERVICE       → 'activity'   ← 生产现实：service 复用 'activity'，
 *                                  以 cert_no 前缀 'JHCRT-SRV-*' 区分
 *
 * SERVICE 不获得独立 source_type 的理由：
 *   1) 生产历史/服务行已存在于既有 'activity' 语义下；新增取值需重估 CHECK
 *      并触及 413 行，违背 ADDITIVE / NON-DESTRUCTIVE 原则。
 *   2) CERT-R2 明确不臆造新 persisted 枚举值。
 *   3) 前缀 'JHCRT-SRV-*' 已足以区分 service 与 activity 证书。
 *
 * 注意：SERVICE 与 ACTIVITY 复用同一 persisted 值，故 uq_cert_user_source
 * （谓词锁定 source_type='activity'）自动同时覆盖二者的幂等防护。
 */
export enum CertificateSource {
  TRAINING_EXAM = 'exam',
  COURSE = 'course',
  ACTIVITY = 'activity',
  MANUAL = 'manual',
  SERVICE = 'activity', // 生产现实：service 复用 source_type='activity'
}

/**
 * 持久化取值 → 域概念的显式映射（供 CERT-R3 反查与报表使用）。
 *
 * ⚠ 注意：DOMAIN → PERSISTED 是【多对一】（ACTIVITY 与 SERVICE 共享 'activity'），
 * 故不能用 `Record<CertificateSource, ...>` 对象字面量——那会产生重复键（TS1117）。
 * 因此本映射以「域概念清单」数组表达，允许不同域概念映射到同一持久化值。
 */
export const DOMAIN_TO_PERSISTED_SOURCE: ReadonlyArray<{
  domain: CertificateSource;
  persisted: Exclude<PersistedSourceType, null>;
}> = Object.freeze([
  { domain: CertificateSource.TRAINING_EXAM, persisted: 'exam' },
  { domain: CertificateSource.COURSE, persisted: 'course' },
  { domain: CertificateSource.ACTIVITY, persisted: 'activity' },
  { domain: CertificateSource.MANUAL, persisted: 'manual' },
  { domain: CertificateSource.SERVICE, persisted: 'activity' },
]);

/** 某个域概念对应的持久化 source_type 取值。 */
export function persistedSourceFor(domain: CertificateSource): Exclude<PersistedSourceType, null> {
  const hit = DOMAIN_TO_PERSISTED_SOURCE.find((m) => m.domain === domain);
  if (!hit) throw new Error(`unknown certificate source domain: ${domain}`);
  return hit.persisted;
}

/** 某个持久化取值所覆盖的全部域概念（'activity' → [ACTIVITY, SERVICE]）。 */
export function domainSourcesFor(persisted: Exclude<PersistedSourceType, null>): CertificateSource[] {
  return DOMAIN_TO_PERSISTED_SOURCE.filter((m) => m.persisted === persisted).map((m) => m.domain);
}

/**
 * 该持久化行是否具备「权威 source identity」（可参与成就级唯一性）。
 * 存量 legacy/service 行 source_id 为 NULL → 不具备，故不受 uq_cert_user_source 约束。
 */
export function hasAuthoritativeSourceIdentity(sourceId: number | null): boolean {
  return sourceId !== null;
}


// ===== Kind（种类；certificates.cert_kind 列）=====
export enum CertificateKind {
  PARTICIPANT = 'participant', // 真实参与者（默认；历史 413 行均映射为此）
  ACCEPTANCE = 'acceptance', // 管理端验收证书；不创建考勤/服务时长/积分/考试；排除出真实统计
}

// ===== Issuance reason（发证原因；certificates.issue_reason 列，可 NULL=legacy）=====
export enum IssuanceReason {
  NORMAL = 'normal',
  REISSUE = 'reissue',
  ADMIN_ACCEPTANCE = 'admin_acceptance',
  MIGRATION = 'migration',
  LEGACY = 'legacy', // 历史行 issue_reason=NULL 在域层映射为 LEGACY
}

// ===== File / PDF lifecycle（CERT-R2 仅契约；无新增列）=====
// 由 certificates.file_id 推导：NULL + 历史 = NOT_REQUIRED；NULL + 新发 = PENDING；
// 非 NULL = READY。FAILED 不落列：证书保持 status=1 有效，failure_code 记入
// certificate_logs（见 CERT-R1 §29 状态机策略）。
export enum CertificateFileStatus {
  NOT_REQUIRED = 'not_required',
  PENDING = 'pending',
  READY = 'ready',
  FAILED = 'failed',
}

/** 由证书行推导文件状态（file_id 为 NULL 时按语境区分 NOT_REQUIRED / PENDING）。 */
export function deriveFileStatus(fileId: number | null, isNewlyIssued: boolean): CertificateFileStatus {
  if (fileId != null) return CertificateFileStatus.READY;
  return isNewlyIssued ? CertificateFileStatus.PENDING : CertificateFileStatus.NOT_REQUIRED;
}

// ===== Core records / requests / results =====
export interface CertificateRecord {
  id: number;
  publicId: string;
  certNo: string;
  certType: string;
  sourceType: PersistedSourceType;
  sourceId: number | null;
  userId: number;
  teamId: number;
  certKind: CertificateKind;
  issueReason: IssuanceReason | null;
  issuedBy: number | null;
  holderName: string | null;
  issuerName: string | null;
  fileId: number | null;
  status: number;
  issuedAt: number;
}

export interface CertificateIssueRequest {
  userId: number; // 规范 users.id；发放前 assertNotSystemUser
  teamId: number;
  sourceType: PersistedSourceType;
  sourceId: number | null;
  certType: 'training' | 'activity' | 'honor';
  templateId: number;
  certKind: CertificateKind;
  issuanceReason?: IssuanceReason;
  operatorId: number; // 执行发放的管理员
  skipPdf?: boolean; // 是否跳过 PDF 生成（默认 false；PDF 在 CERT-R4 实现）
}

export interface CertificateIssueResult {
  certificatePublicId: string;
  certNo: string;
  status: number;
}

export interface CertificateEligibilityResult {
  eligible: Array<{ userId: number; sourceId: number | null }>;
  ineligible: Array<{ userId: number; sourceId: number | null; reason: string }>;
  alreadyIssued: Array<{ userId: number; sourceId: number | null }>;
}

export interface CertificateBatchSummary {
  batchPublicId: string;
  status: number;
  total: number;
  eligible: number;
  ineligible: number;
  alreadyIssued: number;
  issued: number;
  failed: number;
  skipped: number;
}

// ===== Number allocator contract（§11 / §H；CERT-R2 仅接口/契约）=====
//
// ACTIVITY_NUMBER_FORMAT_DECISION = DEFERRED_TO_CERT_R3
//
// 理由（基于 2026-10-03 生产只读证据）：
//   1) id_pools.pool_type CHECK = ('cert_trn','cert_srv','cert_hon','volunteer')
//      —— 不含 'cert_act'；INSERT 'cert_act' 会违反 CHECK。禁止重建 id_pools
//      （重建违反 ADDITIVE / NON-DESTRUCTIVE），禁止修改其 CHECK。
//   2) 生产 55 张 service 证书使用字母数字 cert_no 前缀 'JHCRT-SRV-*'，
//      并非 id_pools 的 pool code 模式 → 现状并非「缺一个池」那么简单。
//   3) 检索既有权威产品规则：未发现已确立的 activity 证书对外编号规则。
//      CERT-R1 曾提议 CACT%06d，但该提议与生产现实（CHECK 无 cert_act、
//      service 用 JHCRT-SRV-*）冲突，且 CERT-R1 自身将其标为 design-only。
//      → 不构成「EXISTING_RULE_FOUND」。
//   故 CERT-R2 【不选择】任何新的对外可见 activity 证书前缀，避免臆造对外契约。
//   CERT-R3 决策二选一：
//     选项 A = 新迁移扩展 id_pools CHECK 新增 'cert_act'/'cert_svc' 并播种池
//     选项 B = 对齐生产既有 'JHCRT-SRV-*' 字母数字约定
//
// 现状：training 发放仍使用既有 cert_trn 池（CTRN%06d），本轮完全不变。
export type CertNumberPoolType = 'cert_trn' | 'cert_act' | 'cert_svc' | 'cert_hon';

export interface CertificateNumberAllocator {
  /**
   * 在给定事务内原子地选取并消费一个编号（与 exam.ts pickCertTrnCandidate 同模式）：
   * 候选行在「与 cert INSERT 同一 db.batch」内消耗，冲突回滚，不烧号。
   * CERT-R3 实现；本轮仅声明契约，不实现任何 pool 播种。
   */
  allocate(poolType: CertNumberPoolType, txn: { run(sql: string, bind: unknown[]): Promise<{ changes: number }> }): Promise<string | null>;
}

// ===== Shared issuance service contract（§13；CERT-R3 实现，本轮仅接口/边界）=====
export interface CertificateIssuanceService {
  // 预览资格（dry-run 投影，无写）：返回 eligible / ineligible / alreadyIssued
  previewEligibility(req: {
    sourceType: PersistedSourceType;
    sourceId: number | null;
    teamId: number;
  }): Promise<CertificateEligibilityResult>;
  // 单一接收者发放（权威原语；batch 亦逐接收者调用本方法）
  issue(req: CertificateIssueRequest): Promise<CertificateIssueResult>;
  // reissue / revoke 在 CERT-R5/R8 定义；本轮仅声明边界
}

// ===== Acceptance safety guard（§18）=====
export function isAcceptance(record: { certKind: CertificateKind }): boolean {
  return record.certKind === CertificateKind.ACCEPTANCE;
}

/** 系统账号守卫：发放前拒绝 users.is_system = 1 的接收者（如平台系统账号 id 1676）。 */
export function assertNotSystemUser(userId: number, isSystem: boolean): void {
  if (isSystem) {
    throw new Error(`certificate issuance rejected: recipient user ${userId} is a system account`);
  }
}
