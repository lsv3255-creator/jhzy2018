/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ETL Engine · Checkpoint（F8-4）
 * ---------------------------------------------------------------------------
 * 五、Checkpoint：每批保存状态，支持 resume（断点续传）与 rollback（回滚）。
 *  - CheckpointStore 抽象后端（库内置内存版；真实迁移可注入文件/D1 后端）。
 *  - 序列化：JSON；状态含 processed 偏移、IdMappingEngine 的 legacy_id_maps、
 *    cert 计数器、usedCertNos、issues、已出批次数。
 * ---------------------------------------------------------------------------
 */
import type { CheckpointStore, EtlCheckpointState } from './types';

/** 内存检查点存储（自测 / 进程内续跑；真实迁移请注入持久化后端） */
export class InMemoryCheckpointStore implements CheckpointStore {
  private state: EtlCheckpointState | null = null;

  save(state: EtlCheckpointState): void {
    this.state = JSON.parse(JSON.stringify(state)) as EtlCheckpointState;
  }

  load(): EtlCheckpointState | null {
    return this.state ? (JSON.parse(JSON.stringify(this.state)) as EtlCheckpointState) : null;
  }

  clear(): void {
    this.state = null;
  }
}

/** 记录全部检查点历史（自测验证 resume/rollback 用） */
export class HistoryCheckpointStore implements CheckpointStore {
  private history: EtlCheckpointState[] = [];

  save(state: EtlCheckpointState): void {
    this.history.push(JSON.parse(JSON.stringify(state)) as EtlCheckpointState);
  }

  load(): EtlCheckpointState | null {
    return this.history.length ? (JSON.parse(JSON.stringify(this.history[this.history.length - 1])) as EtlCheckpointState) : null;
  }

  /** 取第 i 个检查点（0-based） */
  at(index: number): EtlCheckpointState | null {
    const s = this.history[index];
    return s ? (JSON.parse(JSON.stringify(s)) as EtlCheckpointState) : null;
  }

  get length(): number {
    return this.history.length;
  }

  clear(): void {
    this.history = [];
  }
}

export function serializeCheckpoint(state: EtlCheckpointState): string {
  return JSON.stringify(state);
}

export function deserializeCheckpoint(raw: string): EtlCheckpointState {
  const obj = JSON.parse(raw) as EtlCheckpointState;
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.idMaps) || !obj.stats) {
    throw new Error('deserializeCheckpoint: 非法检查点对象');
  }
  if (obj.version !== 1) {
    throw new Error(`deserializeCheckpoint: 版本不匹配（期望 1，实际 ${obj.version}）`);
  }
  return obj;
}
