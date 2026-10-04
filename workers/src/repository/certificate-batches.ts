/**
 * CertificateBatchRepository（POST-R5-P5）—— certificate_batches 写入口。
 *
 * ⚠ 范围纪律（tenant-scope.ts 事实）：
 *   certificate_batches 在 S2-3 Table Matrix 中【未登记】（not in TABLE_SCOPE）。
 *   因此本 repository【不调用】基类的 ensureTableRead（否则会抛 unknown_table）。
 *   所有读/写经基类 `run` / `first` 封装（它们本身不触发 scope guard），直接参数化绑定。
 *
 * 职责：仅承载批量发证的可观测性写（create / 状态推进 / 计数回写 / 查询）。
 * 真实的「逐接收者发证」原子写由 CertificateIssuanceService.issue 经
 * CertificateIssuanceRepository.issueBatch 执行；本表是【批量结果的汇总账本】，
 * 不参与任何单证书 INSERT / 号池消费 / 审计（避免职责重复与潜在双写）。
 *
 * 安全：本文件不含任何 PII；只记录计数与公开 id（public_id）。
 */

import { BaseRepository } from './base';

export interface CertificateBatchRow {
  id: number;
  public_id: string;
  team_id: number;
  operator_id: number;
  source_type: string;
  source_id: number | null;
  status: number;
  total: number;
  eligible: number;
  ineligible: number;
  already_issued: number;
  issued: number;
  failed: number;
  skipped: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

/** status 字典（0045）。 */
export const BATCH_STATUS = {
  PENDING: 0,
  RUNNING: 1,
  COMPLETED: 2,
  COMPLETED_WITH_FAILURES: 3,
} as const;

export class CertificateBatchRepository extends BaseRepository {
  /**
   * 创建批量账本行（status=0 PENDING）。public_id 由调用方（Service 层）生成并传入。
   * @returns 新插入行的 integer id。
   */
  async create(args: {
    publicId: string;
    teamId: number;
    operatorId: number;
    sourceType: string;
    sourceId: number | null;
    total: number;
    now: number;
  }): Promise<number> {
    const res = await this.run(
      `INSERT INTO certificate_batches
         (public_id, team_id, operator_id, source_type, source_id, status, total,
          eligible, ineligible, already_issued, issued, failed, skipped, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, 0, 0, 0, 0, ?)`,
      [
        args.publicId,
        args.teamId,
        args.operatorId,
        args.sourceType,
        args.sourceId,
        args.total,
        args.now,
      ],
    );
    return Number((res as { meta?: { last_row_id?: number } }).meta?.last_row_id ?? 0);
  }

  /** 状态推进：PENDING(0) → RUNNING(1)。 */
  async markRunning(id: number, now: number): Promise<void> {
    await this.run(
      `UPDATE certificate_batches SET status = 1, started_at = ? WHERE id = ?`,
      [now, id],
    );
  }

  /** 状态推进至终态（2=全成功 / 3=有失败），并回写全部计数。 */
  async complete(
    id: number,
    counts: {
      eligible: number;
      ineligible: number;
      alreadyIssued: number;
      issued: number;
      failed: number;
      skipped: number;
      now: number;
    },
  ): Promise<void> {
    const status = counts.failed > 0 ? BATCH_STATUS.COMPLETED_WITH_FAILURES : BATCH_STATUS.COMPLETED;
    await this.run(
      `UPDATE certificate_batches
          SET status = ?, eligible = ?, ineligible = ?, already_issued = ?,
              issued = ?, failed = ?, skipped = ?, completed_at = ?
        WHERE id = ?`,
      [
        status,
        counts.eligible,
        counts.ineligible,
        counts.alreadyIssued,
        counts.issued,
        counts.failed,
        counts.skipped,
        counts.now,
        id,
      ],
    );
  }

  /** 按 public_id 读取批量账本行（对外投影 / 轮询用）。 */
  async findByPublicId(publicId: string): Promise<CertificateBatchRow | null> {
    return this.first<CertificateBatchRow>(
      `SELECT id, public_id, team_id, operator_id, source_type, source_id, status, total,
              eligible, ineligible, already_issued, issued, failed, skipped, created_at, started_at, completed_at
         FROM certificate_batches WHERE public_id = ?`,
      [publicId],
    );
  }
}
