/**
 * CertificateNumberAllocator（CERT-R3B 实现）—— 号池抽象与条件消费。
 *
 * 架构决策（承 CERT-R3A / CERT-R3A-FIX 冻结契约）：
 *
 * 1) 池策略：ACTIVITY / SERVICE 共用 `cert_srv`（V1.0 服务证书语义，且在既有
 *    id_pools CHECK 内 → 零迁移、零表重建）。**不新建 cert_act**。
 *
 * 2) 编号来源：allocator【消费 id_pools 中预生成的 code】，**不自行构造编号字符串**。
 *    这与既有 cert_trn 行为一致（0022 播种 500 条 `CTRN%06d`，运行时只消费）。
 *    → 因此对外可见格式完全由「未来种子迁移写什么」决定，本模块不编码任何前缀。
 *
 * 3) EXTERNAL NUMBER FORMAT = DEFERRED：
 *    无权威 V2 activity/service 对外格式，故本模块【不】冻结 CSRV%06d 或任何前缀。
 *
 * 4) 池未播种时的确定性行为：返回 `POOL_UNAVAILABLE`，**绝不静默回退到 cert_trn**
 *    （回退会把活动/服务证书混入培训编号段，破坏语义与统计口径）。
 *
 * 5) 唯一性与不可重分配：
 *    - 消费是【条件 UPDATE】：`pool_type + code + status=0 AND EXISTS(cert)`；
 *    - 消费与证书 INSERT 在同一 D1 batch → 证书未生成则号不被烧；
 *    - 允许空洞（gaps），永不重复、永不重分配。
 *
 * 6) 事务边界：allocator【不】自己开事务。它只提供
 *    「探测（事务外只读）」+「构造条件消费语句（交由调用方放入同一 batch）」，
 *    由 CertificateIssuanceService 编排为单一原子 batch。
 */

import type { CertNumberPoolType } from '../domain/certificate';
import type {
  CertificateIssuanceRepository,
  PoolConsumeOutcome,
} from '../repository/certificate-issuance';

/** 号池类型 → 域用途映射（training 与 activity/service 严格分离）。 */
export const POOL_FOR_TRAINING: CertNumberPoolType = 'cert_trn';
export const POOL_FOR_ACTIVITY: CertNumberPoolType = 'cert_srv';
export const POOL_FOR_SERVICE: CertNumberPoolType = 'cert_srv';

/**
 * 分配结果（确定性、可机读）。
 * - OK：已选定 code（尚未消费；消费在同 batch 内完成）
 * - POOL_UNAVAILABLE：池不存在或无 status=0 候选（未播种 / 已耗尽）
 * - POOL_EXHAUSTED：池存在但全部已消费（与 UNAVAILABLE 区分以便运维定位）
 */
export type AllocationResult =
  | { ok: true; poolType: CertNumberPoolType; code: string }
  | { ok: false; reason: 'POOL_UNAVAILABLE' | 'POOL_EXHAUSTED' };

/** 消费结果分类（与仓储 statement 的 changes 语义对齐）。 */
export type ConsumptionResult = 'CONSUMED' | 'UNAVAILABLE' | 'CONFLICT';

export class PoolCertificateNumberAllocator {
  constructor(private readonly repo: CertificateIssuanceRepository) {}

  /**
   * 探测（事务外只读）：选定一个可用的预生成编号。
   *
   * 确定性失败：
   *   - 池无任何行            → POOL_UNAVAILABLE（尚未播种）
   *   - 池有行但无 status=0   → POOL_EXHAUSTED（已全部消费）
   * 这两个分支让调用方能给出可区分的运维结论，而不是笼统失败。
   */
  async allocate(poolType: CertNumberPoolType): Promise<AllocationResult> {
    const code = await this.repo.peekPoolCode(poolType);
    if (code != null) return { ok: true, poolType, code };
    // 区分「池不存在」与「池已耗尽」：仅探测存在性，不消费。
    const anyRow = await this.repo.peekAnyPoolRow(poolType);
    return anyRow ? { ok: false, reason: 'POOL_EXHAUSTED' } : { ok: false, reason: 'POOL_UNAVAILABLE' };
  }

  /**
   * 构造消费语句（**不执行**）。调用方必须把它与证书 INSERT 放入同一
   * `db.batch()`，以获得「证书未生成则不烧号」的原子保证。
   */
  buildConsumption(args: {
    poolType: CertNumberPoolType;
    code: string;
    assignedTo: number;
    now: number;
    issuedCertPublicId: string;
  }): { sql: string; params: unknown[] } {
    return this.repo.buildPoolConsumeStatement(args);
  }

  /** 把 batch 返回的 changes 解释为确定性消费结果。 */
  interpretConsumption(changes: number): ConsumptionResult {
    if (changes > 0) return 'CONSUMED';
    // 条件未命中：可能是并发抢占（CONFLICT）或候选失效（UNAVAILABLE）。
    // 二者对调用方均为「本次未烧号」，需重试或换候选，不退化为回退其它池。
    return 'CONFLICT';
  }
}
