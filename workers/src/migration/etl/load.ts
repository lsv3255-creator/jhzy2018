/**
 * 嘉禾志愿 2.0 —— V1→V2 迁移：ETL Engine · Load（F8-4）
 * ---------------------------------------------------------------------------
 * 三、Load：仅【输出】Batch[]，绝不写数据库。
 *  Loader 收集每批转换产物并切分为 Batch（按 batchSize 控制每批源行数）。
 * ---------------------------------------------------------------------------
 */
import type { Batch, BatchItem } from './types';

export class Loader {
  private batches: Batch[] = [];

  constructor(private readonly batchSize: number) {}

  /** 将一批目标记录打包为一个 Batch（空批返回 null 不入列） */
  addBatch(
    sourceTable: string,
    offsetStart: number,
    offsetEnd: number,
    items: BatchItem[],
  ): Batch | null {
    if (items.length === 0) return null;
    const b: Batch = {
      index: this.batches.length,
      sourceTable,
      sourceOffsetStart: offsetStart,
      sourceOffsetEnd: offsetEnd,
      items,
      count: items.length,
    };
    this.batches.push(b);
    return b;
  }

  /** 当前累计批次数 */
  count(): number {
    return this.batches.length;
  }

  /** 全部批次（Load 的唯一产物） */
  all(): Batch[] {
    return this.batches;
  }

  /** 截断到指定批次数（rollback 用） */
  truncateTo(n: number): void {
    this.batches = this.batches.slice(0, n);
  }

  /** 清空（重置用） */
  reset(): void {
    this.batches = [];
  }
}
