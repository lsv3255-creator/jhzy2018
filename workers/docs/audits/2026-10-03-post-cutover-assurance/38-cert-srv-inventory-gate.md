# P5A — cert_srv 号池库存核查门禁（生产只读）

**审计目录**：`workers/docs/audits/2026-10-03-post-cutover-assurance/`
**日期**：2026-10-04
**前置阶段**：POST-R5-P4 = PASS_WITH_DESIGN
**本阶段状态**：PASS
**工作区**：`/Users/Shared/projects/jhzy-v2`（master, HEAD = `d66424ca9ec02c1a46807e775c1f30522a13f4ad`）
**性质**：production D1 **只读**核实，无任何写入、发证、部署、push。

---

## 1. P5A 目标

POST-R5-P4（activity/service 证书签发 wiring 设计）识别出一个 **BLOCKING 风险（RISK-1）**：
R5B 导入的 450k legacy 号池疑似专属 `cert_trn`，`cert_srv`（activity/service 发证共享池，
见 `services/certificate-issuance-service.ts` 中 `POOL_FOR_ACTIVITY = POOL_FOR_SERVICE = 'cert_srv'`）
是否仍有足量 `legacy_migrated` 可用库存**未经核实**。

P5A 的目标：对 production `cert_srv` 号池做**只读**清点，判断其是否足以支撑 activity/service
issuance wiring。如不足，则需先触发 R5C 补种；如充足，则 `READY_FOR_P5_WIRING = YES`，可进入
POST-R5-P5（实现工作包，仍须 staging 全绿 + 用户授权后评估生产首发）。

---

## 2. 生产 D1 只读查询

**执行命令（脱敏）**：

```bash
cd /Users/Shared/projects/jhzy-v2/workers
env -u CLOUDFLARE_API_TOKEN \
CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af \
wrangler d1 execute jhzy-v2-prod --remote --profile jhzy --command "
  SELECT pool_type, provenance, status, COUNT(*) AS n
  FROM id_pools WHERE pool_type='cert_srv'
  GROUP BY pool_type, provenance, status ORDER BY provenance, status;
  -- + 5 个聚合计数子查询（见任务书 §2）
"
```

- 目标库：`jhzy-v2-prod`（UUID `d372229f-c0ae-4dcc-b968-4ec7c2832842`）
- 认证：`--profile jhzy`（OAuth 复用，TTY 交互）
- **无 `CLOUDFLARE_API_TOKEN` 注入**（env -u 显式清除），仅 GET/SELECT，零写入
- 全部 6 条语句均为 `SELECT` / 聚合，无 `INSERT`/`UPDATE`/`DELETE`/`ALTER`

---

## 3. 查询结果（实际）

### 3.1 分组明细

| pool_type | provenance      | status | n      |
|-----------|-----------------|--------|--------|
| cert_srv  | legacy_migrated | 0      | 149692 |
| cert_srv  | legacy_migrated | 1      | 281    |
| cert_srv  | legacy_migrated | 2      | 27     |

（仅 `legacy_migrated` 一类 provenance；无 `v2_synthetic_compat`、无 NULL、无其它来源。）

### 3.2 聚合计数

| 指标                              | 实际值 | 期望值  | 匹配 |
|-----------------------------------|--------|---------|------|
| cert_srv_legacy_total             | 150000 | 150000  | ✅   |
| cert_srv_legacy_available (status=0) | 149692 | 149692 | ✅   |
| cert_srv status=1                 | 281    | 281     | ✅   |
| cert_srv status=2                 | 27     | 27      | ✅   |
| cert_srv_synthetic                | 0      | 0       | ✅   |
| cert_srv_null_provenance          | 0      | 0       | ✅   |
| cert_srv_duplicate_code_groups    | 0      | 0       | ✅   |

**全部 7 项与任务书 Expected 逐字节一致。**

---

## 4. 是否足够支撑 activity/service wiring

- `cert_srv` 可用 `legacy_migrated` 库存 = **149,692** 条。
- selector 白名单（`ALLOCATABLE_PROVENANCES = ['legacy_migrated','v2_native']`）确定性覆盖此库存；
  合成库存为 0、NULL provenance 为 0，与 POST-R5-P3 no-write selector simulation 结论一致——
  **合成 500 不会被消耗**，NULL/status 1/2 不会被选中。
- 即便 JHZY 2.0 activity/service 全量发证，预期规模远小于 149,692（即便数万亦绰绰有余）。
- 无重复 `code` 组（duplicate_code_groups = 0），唯一约束安全。

**结论**：`cert_srv` 库存充足，**足以支撑** activity/service issuance wiring，无需补种。

---

## 5. 是否需要 R5C 补种

**否。**

R5B 已为 `cert_srv` 预置 150,000 条 `legacy_migrated`（可用 149,692），与 P4 中"疑似 cert_trn 专属"
的担忧相反——`cert_srv` 实际是**独立、充裕、干净**的池。POST-R5-P4 的 RISK-1 经本核查**解除（BLOCKING→CLEARED）**。
故 R5C（cert_srv 补种）**不触发**。

> 备注：R5B 导入的 450k 主要落在 `cert_trn`（培训/考试自动发证），与 `cert_srv`（activity/service）
> 为两个独立 pool_type，互不挤占。这解释了为何 `cert_srv` 至今几乎未消耗（status=1/2 仅 308 条，
> 极可能来自早期手工/测试记录，与本阶段无关）。

---

## 6. 结论

```
READY_FOR_P5_WIRING = YES
```

进入 POST-R5-P5（ACTIVITY-SERVICE-ISSUANCE-WIRING-IMPLEMENTATION）的前置库存门禁已通过。
P5 仍须：先在代码与测试中完成路由 + EligibilityPolicy + RecipientGuard + preview + 批量 + RBAC 复用，
再于 **staging D1** 跑通单人/批量/重试幂等/我的证书可见/失败案例，经用户授权后才评估 production 首发
（首次仅一条真实合规记录，验证对账，观察期后再开放批量）。

---

## 7. 安全与合规

- **PRODUCTION_D1_MUTATED** = NO（仅 SELECT）
- **CERTIFICATE_ISSUED** = NO
- **PRODUCTION_WORKER_DEPLOYED** = NO
- **SECRET_MUTATED** = NO（无 token 注入，OAuth 复用）
- **JHZY_1_0_LIVE_TOUCHED** = NO
- **GIT_PUSH_PERFORMED** = NO

### Secret/PII Scan

文档仅含：文件路径、表名/列名（`id_pools`/`pool_type`/`provenance`/`status`/`code`）、
聚合数字、权限/池名（`cert_srv`/`legacy_migrated`）、通用 SQL 模板。

**不包含**：token、手机号、OpenID、身份证、真实姓名、session token、raw `cert_no`、raw pool code。

**Scan = PASS。**

---

## 8. 后续动作

`NEXT_ACTION = 实施 POST-R5-P5（activity/service issuance wiring 实现）：路由 + 注入式 EligibilityPolicy
（fail-closed）+ RecipientGuard（fail-closed）+ no-write preview + 批量 + 复用既有
certificate.certificate.issue 权限 + 单测/集成测/selector 测/RBAC 测/审计测；先 staging 全绿并经用户授权后，
方评估 production 首发（首条合规记录 + 对账 + 观察期）。`
