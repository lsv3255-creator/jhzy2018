/**
 * Certificate Issuance 组合根工厂（POST-R5-P5）。
 *
 * 定位：把 CERT-R3B 发证核心（CertificateIssuanceService）与【本任务补齐】的
 * EligibilityPolicy / RecipientGuard 组装成一个可直接用于路由层的服务实例。
 *
 * 关键纪律（CERT-R3B-FIX：fail-closed）：
 *   - CertificateIssuanceService 构造期强制要求 repo + eligibility + recipientGuard；
 *     任一缺失即抛 POLICY_NOT_CONFIGURED（接线错误在构造期暴露，而非运行期漏发）。
 *   - 本工厂是「唯一权威组装点」：路由层只调用 buildCertificateIssuanceService，
 *     不得自行 new CertificateIssuanceService（避免漏接政策 / 守卫）。
 *
 * 生命周期：服务实例【按请求】构建（需要当前请求的 auth / tenant 上下文注入 repo.ctx，
 * 以驱动 TEAM_SCOPED 表读写 guard 与租户隔离）；不是全局单例。
 *
 * 系统账号名单（DefaultRecipientGuard）：由 env.CERT_SYSTEM_USER_IDS 注入，
 * 【不】硬编码任何具体 user id（如 1676）。
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../env';
import type { RepositoryContext } from '../types/tenant';
import { CertificateIssuanceRepository } from '../repository/certificate-issuance';
import { CertificateIssuanceService } from './certificate-issuance-service';
import { CertificateSource } from '../domain/certificate';
import {
  ActivityEligibilityPolicy,
  ServiceEligibilityPolicy,
  CompositeEligibilityPolicy,
  DefaultRecipientGuard,
} from './certificate-eligibility-policies';

/**
 * 从运行环境解析系统账号拒绝名单。
 *
 * 读取 env.CERT_SYSTEM_USER_IDS（逗号分隔的正整数列表，如 "1676,2001"）。
 * 缺省 / 空 / 非法 → 返回 []（不拒绝任何接收者；是否配置系统账号属部署策略，
 * 不是 fail-open 漏洞——核心仍强制 recipientGuard 必须被注入）。
 */
export function parseSystemUserIds(env: Env): number[] {
  const raw = (env as unknown as Record<string, unknown>).CERT_SYSTEM_USER_IDS;
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * 构建带完整依赖注入的 CertificateIssuanceService 实例。
 *
 * @param db          当前请求上下文的 D1 句柄（本地测试为 D1 shim）。
 * @param ctx         仓库上下文（auth + tenant），由路由层从 c.get('auth')/c.get('tenant') 组装。
 * @param systemUserIds 系统账号拒绝名单（来自 parseSystemUserIds(env)）。
 */
export function buildCertificateIssuanceService(
  db: D1Database,
  ctx: RepositoryContext,
  systemUserIds: number[],
): CertificateIssuanceService {
  const repo = new CertificateIssuanceRepository({ db, ctx });

  // 两套真实资格政策（按域分派）。db 只读用于资格投影，不参与租户 scope guard
  // （team 隔离由 EligibilityPolicy.check 入参 teamId 经 SQL 参数化过滤）。
  const activityPolicy = new ActivityEligibilityPolicy({ db });
  const servicePolicy = new ServiceEligibilityPolicy({ db });
  const eligibility = new CompositeEligibilityPolicy({
    [CertificateSource.ACTIVITY]: activityPolicy,
    [CertificateSource.SERVICE]: servicePolicy,
  });

  const recipientGuard = new DefaultRecipientGuard(systemUserIds);

  return new CertificateIssuanceService({ repo, eligibility, recipientGuard });
}
