/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ID Mapping Engine 共享类型与常量
 * ---------------------------------------------------------------------------
 * 本文件仅含类型与常量声明，无运行时副作用，被 Builder / Resolver /
 * Collision Checker / Verify Engine / Resume Runner 共同引用。
 *
 * 设计边界（对应 P11-F8-2B 要求）：
 *  - 全部逻辑由声明式 MappingPlan 驱动，引擎内部【不硬编码】任何 old_id↔new_id 关系。
 *  - 引擎仅做内存计算与状态序列化，不发起 D1 写入、不部署、不改生产库。
 * ---------------------------------------------------------------------------
 */

/** 实体名（逻辑名，对应 V1 源表/JSON key，如 'users' / 'activities'） */
export type EntityName = string;

/** 实体映射描述（声明式，由调用方依据 docs/migration/01-data-mapping-spec.md 提供） */
export interface EntityDescriptor {
  /** 逻辑实体名 */
  entity: EntityName;
  /** 源行中承载旧整数主键的字段名（可为空，引擎将分配新 id） */
  legacyIdField: string;
  /** 可选：业务编码字段（如 cert_no / volunteer_id），用于 legacy_code 一致性校验 */
  legacyCodeField?: string;
  /** V2 目标表名 */
  newTable: string;
  /** 是否生成 ULID public_id（默认 true；纯关联表可设 false） */
  generatePublicId?: boolean;
}

/** 外键描述（声明式） */
export interface ForeignKeyDescriptor {
  /** 携带该外键的实体 */
  fromEntity: EntityName;
  /** 源行中承载旧引用 id 的字段名 */
  field: string;
  /** 被引用实体 */
  toEntity: EntityName;
  /** 可空外键：缺失或无法解析时 SKIP 而非 FAIL（默认 false） */
  nullable?: boolean;
}

/** 迁移计划（声明式总入口） */
export interface MappingPlan {
  entities: EntityDescriptor[];
  foreignKeys: ForeignKeyDescriptor[];
  /** 平台根团队 id（V1 无团队概念数据的归属；依据 spec D2 决策） */
  defaultTeamId: number;
  /** 可选命名空间前缀（写入 legacy_table，便于多源区分） */
  namespace?: string;
}

/** 一条 V1 源数据行 */
export interface SourceRow {
  entity: EntityName;
  values: Record<string, unknown>;
}

/** 生成的 legacy_id_maps 记录（与 0001 legacy_id_maps 列对齐，附加 public_id） */
export interface LegacyIdMapRecord {
  legacyTable: string;
  legacyId: string;
  legacyCode: string | null;
  newTable: string;
  newId: number;
  publicId: string | null;
}

/** 外键解析结果 */
export interface ForeignKeyResolution {
  fromEntity: EntityName;
  fromLegacyId: string | null;
  field: string;
  toEntity: EntityName;
  oldRef: string | null;
  newId: number | null;
  publicId: string | null;
  status: 'RESOLVED' | 'SKIPPED' | 'FAILED';
  reason?: string;
}

/** 冲突报告（Collision Checker 输出） */
export interface MigrationConflictReport {
  /** old_id 重复（同 legacyTable+legacyId+newTable 下指向多个 newId） */
  oldIdDuplicates: Array<{ legacyTable: string; legacyId: string; newIds: number[] }>;
  /** legacy_code 冲突（同一非空 legacyCode 映射到不同 newId） */
  legacyCodeConflicts: Array<{ legacyCode: string; newIds: number[]; entities: string[] }>;
  /** ULID 冲突（publicId 重复） */
  ulidConflicts: Array<{ publicId: string; occurrences: number }>;
  /** FK 丢失（不可空外键无法解析） */
  fkLoss: ForeignKeyResolution[];
  /** 是否存在阻断性冲突（old_id 重复 / ULID 冲突 / FK 丢失） */
  hasBlocking: boolean;
}

/** 实体级校验（Verify Engine） */
export interface EntityVerifyCheck {
  entity: EntityName;
  sourceCount: number;
  targetCount: number;
  pass: boolean;
}

/** 外键级校验（Verify Engine） */
export interface FkVerifyCheck {
  total: number;
  resolved: number;
  skipped: number;
  failed: number;
  pass: boolean;
}

/** 验证引擎结果 */
export interface VerifyResult {
  entityChecks: EntityVerifyCheck[];
  fkCheck: FkVerifyCheck;
  pass: boolean;
}

/** 映射报告（六维计数 + 分实体维度） */
export interface MappingReport {
  mapped: number;
  skipped: number;
  conflict: number;
  resolved: number;
  failed: number;
  byEntity: Record<string, { mapped: number; skipped: number; conflict: number; resolved: number; failed: number }>;
  conflictReport: MigrationConflictReport | null;
  verify: VerifyResult | null;
}

/** 可序列化迁移状态（支持 --resume 断点续传） */
export interface MigrationState {
  version: number;
  completedPhases: string[];
  processedEntities: string[];
  maps: LegacyIdMapRecord[];
  resolutions: ForeignKeyResolution[];
  report: MappingReport | null;
  updatedAt: string;
}

/** 复合键分隔符（避免 legacyId 含普通分隔符导致歧义） */
export const MAP_KEY_SEP = '';
