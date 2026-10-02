/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ETL Engine · 共享类型（F8-4）
 * ---------------------------------------------------------------------------
 * 本文件仅含类型/常量声明，无运行时副作用。
 * 设计边界：ETL 仅【读取】V1 MySQL、【输出】Batch[]（不写 V2/D1）；
 *           所有 ID 重映射经 IdMappingEngine，禁止硬编码旧→新关系。
 * ---------------------------------------------------------------------------
 */
import type { IdMappingRecord } from '../id-mapping-engine';

/** 最小 SQL 查询客户端（解耦真实 MySQL 驱动，便于自测注入 Mock） */
export interface SqlQueryClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** 分表抽取参数（支持 offset/limit 以实现断点续传） */
export interface V1ExtractOptions {
  offset?: number;
  limit?: number;
}

/** V1 抽取器接口：按源表名抽取行 */
export interface V1Extractor {
  /** 本抽取器支持的源表清单（逻辑名，见 ETL_TABLE_ORDER） */
  readonly sourceTables: string[];
  extractTable(table: string, opts?: V1ExtractOptions): Promise<Array<Record<string, unknown>>>;
}

/** V1 逻辑源表 → 真实 MySQL 表 + 稳定排序键（保证 offset 续传确定性） */
export const V1_TABLE_MAP: Record<string, { real: string; orderBy: string }> = {
  volunteers: { real: 'volunteers', orderBy: 'id' },
  users: { real: 'users', orderBy: 'id' },
  teams: { real: 'teams', orderBy: 'id' },
  user_teams: { real: 'user_teams', orderBy: 'user_id, team_id' },
  activities: { real: 'jhzy_activities', orderBy: 'id' },
  activity_signups: { real: 'jhzy_activity_signups', orderBy: 'id' },
  attendance_records: { real: 'jhzy_attendance_records', orderBy: 'id' },
  exam_certificates: { real: 'exam_certificates', orderBy: 'record_id' },
  activity_service_certificates: { real: 'activity_service_certificates', orderBy: 'id' },
  certificates: { real: 'certificates', orderBy: 'id' },
  points_transactions: { real: 'points_transactions', orderBy: 'id' },
};

/**
 * ETL 处理顺序（依赖序）：先建用户/团队映射，再处理引用它们的活动/报名/考勤/证书/积分。
 * 注：user_teams 与 certificates(通用) 虽未在用户最初枚举的 8 表中显式列出，
 *     但为完整实现 01-spec 的「teams→team_members」「证书三表合并」必须纳入抽取范围。
 */
export const ETL_TABLE_ORDER: string[] = [
  'volunteers',
  'users',
  'teams',
  'user_teams',
  'activities',
  'activity_signups',
  'attendance_records',
  'exam_certificates',
  'activity_service_certificates',
  'certificates',
  'points_transactions',
];

/** 迁移问题记录（数据质量 / 决策项） */
export interface MigrationIssue {
  sourceTable: string;
  sourceId: string;
  field?: string;
  message: string;
  severity: 'warn' | 'error';
}

/** 参考数据源（V2 静态配置注入，不硬编码于引擎内） */
export interface ReferenceData {
  /** V1 activity.category 代码 → V2 activity_categories.id */
  categoryMap: Record<string, number>;
  /** cert_type → V2 certificate_templates.id */
  certTemplateMap: Record<string, number>;
}

/** 单条目标记录（V2 待插入行） */
export interface BatchItem {
  table: string;
  row: Record<string, unknown>;
}

/** 一个批次（按源表 + 源行区间切分） */
export interface Batch {
  index: number;
  sourceTable: string;
  sourceOffsetStart: number;
  sourceOffsetEnd: number;
  items: BatchItem[];
  count: number;
}

/** ETL 运行统计（六维 + 分表维度 + 目标行数） */
export interface EtlStats {
  extracted: number;
  transformed: number;
  skipped: number;
  failed: number;
  elapsedMs: number;
  targetRows: number;
  byTable: Record<string, { extracted: number; transformed: number; skipped: number; failed: number }>;
}

/** 可序列化检查点（支持 resume / rollback） */
export interface EtlCheckpointState {
  version: number;
  /** 当前正在处理的源表在 ETL_TABLE_ORDER 中的下标 */
  tableIndex: number;
  sourceTable: string;
  /** 当前源表下一批起点偏移 */
  sourceOffset: number;
  stats: EtlStats;
  /** 已登记的 legacy_id_maps（用于续跑时恢复 IdMappingEngine） */
  idMaps: IdMappingRecord[];
  certIdCounter: number;
  usedCertNos: string[];
  issues: MigrationIssue[];
  /** 截至本检查点已产出的批次数（供 rollback 截断） */
  batchesCount: number;
  updatedAt: string;
}

/** 检查点存储后端抽象（真实迁移可注入文件/D1 后端；库内置内存版） */
export interface CheckpointStore {
  save(state: EtlCheckpointState): void | Promise<void>;
  load(): EtlCheckpointState | null | Promise<EtlCheckpointState | null>;
  clear(): void | Promise<void>;
}

/** 单行转换结果 */
export interface TransformOutcome {
  targets: BatchItem[];
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
}

/** 批大小（仅允许 100 / 500 / 1000） */
export type BatchSize = 100 | 500 | 1000;

/** ETL 运行结果 */
export interface EtlResult {
  batches: Batch[];
  stats: EtlStats;
  checkpoint: EtlCheckpointState;
  issues: MigrationIssue[];
}
