/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ETL Engine · Pipeline（F8-4）
 * ---------------------------------------------------------------------------
 * 编排 Extract → Transform → Load 全链路：
 *  - 按 ETL_TABLE_ORDER 顺序处理（保证 FK 映射先建后用）。
 *  - 分批（batchSize ∈ {100,500,1000}），每批产出 Batch[] 并经 Loader 收集。
 *  - 每批后写 Checkpoint（offset / IdMappingEngine 状态 / 统计 / cert 计数）。
 *  - 支持 resume（断点续传）与 rollback（回滚到指定检查点）。
 *  - 全程不写 V2/D1；仅输出 Batch[] 与统计。
 * ---------------------------------------------------------------------------
 */
import { IdMappingEngine, InMemoryIdMappingStore } from '../id-mapping-engine';
import type { IdMappingRecord } from '../id-mapping-engine';
import { Loader } from './load';
import { Transformer } from './transform';
import type { TransformContext } from './transform';
import {
  ETL_TABLE_ORDER,
  type Batch,
  type BatchSize,
  type CheckpointStore,
  type EtlCheckpointState,
  type EtlResult,
  type EtlStats,
  type MigrationIssue,
  type ReferenceData,
  type TransformOutcome,
  type V1Extractor,
} from './types';

export interface EtlConfig {
  /** 批大小，仅允许 100 / 500 / 1000 */
  batchSize: BatchSize;
  /** PII AES 密钥（对应 V2 Secret DELIVERY_IDENTITY_ENC_KEY） */
  encKey: string;
  /** HMAC 密钥（对应 V2 Secret IDENTITY_HMAC_KEY） */
  hmacKey: string;
  /** 平台迁移根团队 id（spec §1.2 platform_root） */
  platformRootTeamId: number;
  /** created_by 等缺失时的兜底用户 id */
  platformAdminUserId?: number;
  /** 派生活动状态用的“当前时间” epoch 秒（默认取运行时刻） */
  nowEpoch?: number;
  /** V2 静态参考配置（分类 / 证书模板映射），注入而非硬编码 */
  referenceData: ReferenceData;
  /** 检查点存储后端 */
  checkpointStore: CheckpointStore;
}

function emptyStats(): EtlStats {
  return {
    extracted: 0,
    transformed: 0,
    skipped: 0,
    failed: 0,
    elapsedMs: 0,
    targetRows: 0,
    byTable: {},
  };
}

export class EtlPipeline {
  private readonly store: InMemoryIdMappingStore;
  private readonly idMap: IdMappingEngine;
  private readonly transformer: Transformer;
  private readonly loader: Loader;
  private stats: EtlStats;
  private issues: MigrationIssue[];
  private readonly certIdState: { counter: number; used: Set<string> };
  private readonly ctx: TransformContext;

  constructor(
    private readonly extractor: V1Extractor,
    private readonly config: EtlConfig,
  ) {
    this.store = new InMemoryIdMappingStore();
    this.idMap = new IdMappingEngine(this.store);
    this.issues = [];
    this.certIdState = { counter: 0, used: new Set<string>() };
    this.stats = emptyStats();
    this.ctx = {
      idMap: this.idMap,
      encKey: config.encKey,
      hmacKey: config.hmacKey,
      platformRootTeamId: config.platformRootTeamId,
      platformAdminUserId: config.platformAdminUserId ?? config.platformRootTeamId,
      nowEpoch: config.nowEpoch ?? Math.floor(Date.now() / 1000),
      ref: config.referenceData,
      issues: this.issues,
      certIdState: this.certIdState,
    };
    this.transformer = new Transformer(this.ctx);
    this.loader = new Loader(config.batchSize);
  }

  /** 运行全链路；可传入检查点续跑（resume） */
  async run(resume?: EtlCheckpointState | null): Promise<EtlResult> {
    const start = Date.now();

    // 注册 platform_root 系统团队映射（spec §1.2 / §3），幂等。
    await this.idMap.registerResolved('__SYSTEM__', 'platform_root', 'teams', this.config.platformRootTeamId);

    let tableIndex = 0;
    let sourceOffset = 0;
    if (resume) {
      await this.restoreFromCheckpoint(resume);
      tableIndex = resume.tableIndex;
      sourceOffset = resume.sourceOffset;
    }

    for (let ti = tableIndex; ti < ETL_TABLE_ORDER.length; ti++) {
      const table = ETL_TABLE_ORDER[ti];
      if (!this.extractor.sourceTables.includes(table)) continue;
      const startOffset = resume && ti === tableIndex ? sourceOffset : 0;
      await this.processTable(table, startOffset);
    }

    this.stats.elapsedMs = Date.now() - start;
    const finalCp = await this.buildCheckpoint(ETL_TABLE_ORDER.length, 0);
    await this.config.checkpointStore.save(finalCp);
    return {
      batches: this.loader.all(),
      stats: this.stats,
      checkpoint: finalCp,
      issues: this.issues,
    };
  }

  private async processTable(table: string, startOffset: number): Promise<void> {
    const tableIndex = ETL_TABLE_ORDER.indexOf(table);
    let offset = startOffset;
    while (true) {
      const rows = await this.extractor.extractTable(table, { offset, limit: this.config.batchSize });
      if (rows.length === 0) break;

      const batchItems = [];
      const batchStart = offset;
      for (const row of rows) {
        this.stats.extracted++;
        this.bumpTable(table, 'extracted');
        let outcome: TransformOutcome;
        try {
          outcome = await this.transformer.transformRow(table, row);
        } catch (e) {
          outcome = { targets: [], status: 'failed', reason: (e as Error).message };
        }
        if (outcome.status === 'ok') {
          this.stats.transformed++;
          this.bumpTable(table, 'transformed');
          for (const t of outcome.targets) batchItems.push(t);
          this.stats.targetRows += outcome.targets.length;
        } else if (outcome.status === 'skipped') {
          this.stats.skipped++;
          this.bumpTable(table, 'skipped');
          if (outcome.reason) {
            this.issues.push({ sourceTable: table, sourceId: String(row.id ?? ''), message: outcome.reason, severity: 'warn' });
          }
        } else {
          this.stats.failed++;
          this.bumpTable(table, 'failed');
          this.issues.push({
            sourceTable: table,
            sourceId: String(row.id ?? ''),
            message: outcome.reason ?? 'failed',
            severity: 'error',
          });
        }
      }

      this.loader.addBatch(table, batchStart, batchStart + rows.length - 1, batchItems);
      offset += rows.length;
      const cp = await this.buildCheckpoint(tableIndex, offset);
      await this.config.checkpointStore.save(cp);
      if (rows.length < this.config.batchSize) break;
    }
  }

  /** 回滚到指定检查点：恢复 IdMappingEngine / 统计 / cert 状态 / issues，并截断已出批次 */
  async rollbackTo(cp: EtlCheckpointState): Promise<void> {
    await this.restoreFromCheckpoint(cp);
    this.loader.truncateTo(cp.batchesCount);
  }

  private async restoreFromCheckpoint(cp: EtlCheckpointState): Promise<void> {
    for (const rec of cp.idMaps as IdMappingRecord[]) {
      await this.idMap.register(rec);
    }
    this.stats = JSON.parse(JSON.stringify(cp.stats)) as EtlStats;
    this.certIdState.counter = cp.certIdCounter;
    this.certIdState.used = new Set(cp.usedCertNos);
    this.issues = cp.issues.slice();
    this.ctx.issues = this.issues; // 同步给 Transformer
  }

  private async buildCheckpoint(tableIndex: number, sourceOffset: number): Promise<EtlCheckpointState> {
    const idMaps = await this.store.loadAll();
    return {
      version: 1,
      tableIndex,
      sourceTable: ETL_TABLE_ORDER[tableIndex] ?? '',
      sourceOffset,
      stats: JSON.parse(JSON.stringify(this.stats)) as EtlStats,
      idMaps,
      certIdCounter: this.certIdState.counter,
      usedCertNos: [...this.certIdState.used],
      issues: this.issues.slice(),
      batchesCount: this.loader.count(),
      updatedAt: new Date().toISOString(),
    };
  }

  private bumpTable(table: string, kind: 'extracted' | 'transformed' | 'skipped' | 'failed'): void {
    const e =
      this.stats.byTable[table] ??
      (this.stats.byTable[table] = { extracted: 0, transformed: 0, skipped: 0, failed: 0 });
    e[kind]++;
  }

  // ---- 观测用 getter（自测 / 调试） ----
  get currentBatches(): Batch[] {
    return this.loader.all();
  }
  get idMapSize(): number {
    return this.idMap.size();
  }
  /** STEP 3.11C 诊断快照（跨表共享 / 歧义 / 收敛计数 / 身份核算）。 */
  get transformerDiagnostics() {
    return this.transformer.diagnosticsSnapshot();
  }
  get currentStats(): EtlStats {
    return this.stats;
  }
}
