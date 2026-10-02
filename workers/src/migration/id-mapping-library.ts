/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ID Mapping Engine（聚合入口）
 * ---------------------------------------------------------------------------
 * 升级自 P11-F8-2 的 id-mapping-engine.ts（核心存储 + ULID 复用见该文件）。
 * 本文件 re-export 全部子模块能力，并提供友好入口 runIdMapping。
 *
 * 组件清单（对应 P11-F8-2B 要求）：
 *   - Builder          ：buildMappings            （mapping-builder.ts）
 *   - Resolver         ：resolveForeignKeys        （foreign-key-resolver.ts）
 *   - Collision Checker：checkCollisions           （collision-checker.ts）
 *   - Verify Engine    ：verifyMappings            （verify-engine.ts）
 *   - Resume           ：runMigration + serialize/deserialize（migration-resume.ts）
 *   - Report           ：MappingReport（runMigration 返回 + finalize 组装）
 *
 * 设计边界：全部逻辑由声明式 MappingPlan 驱动；引擎内部不硬编码 old↔new 关系；
 *           仅做内存计算与状态序列化，不写入 D1、不部署、不改生产库。
 * ---------------------------------------------------------------------------
 */
export * from './mapping-types';
export * from './mapping-builder';
export * from './foreign-key-resolver';
export * from './collision-checker';
export * from './verify-engine';
export * from './migration-resume';
// PII Encryption Engine（F8-3）
export * from './pii-encryption-engine';
// 兼容旧入口（核心 store / resolve / ULID）
export * from './id-mapping-engine';
// P11-F8-4：ETL Engine（Extract / Transform / Load / Checkpoint / Resume / Rollback）
export * from './etl/index';

import { runMigration as _runMigration, type RunOptions, type RunResult } from './migration-resume';
import type { MappingPlan, SourceRow } from './mapping-types';

/** 友好入口：build → resolve → collision → verify 全链路（支持 --resume） */
export function runIdMapping(plan: MappingPlan, rows: SourceRow[], opts?: RunOptions): Promise<RunResult> {
  return _runMigration(plan, rows, opts);
}
