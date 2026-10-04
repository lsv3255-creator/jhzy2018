# 39 · Activity / Service 证书签发入口 Wiring 实现（POST-R5-P5）

- 工作包：`POST-R5-P5-ACTIVITY-SERVICE-ISSUANCE-WIRING-IMPLEMENTATION`
- 上游：`POST-R5-P4` 设计（doc 37）= PASS；实现依据 doc 37 §3 目标 + 本项目真实路由风格修正。
- 性质：**实现 / 测试 / 回归 / 文档**。仅本地 D1（node:sqlite）验证；**绝不**触碰 production。
- 权威库：`/Users/Shared/projects/jhzy-v2`（HEAD = `82875567143eda654888553e5c1008e7e3859f75`，branch `master`）。
- 提交：`feat(certificates): wire activity service issuance`（**仅 stage P5 文件，未 push**）。

---

## 0. 纪律声明（铁律，全程遵守）

| 禁令 | 状态 |
|---|---|
| 调用 production 发证接口 | ❌ 未调用 |
| 插入 production certificates | ❌ 未插入 |
| 更新 production id_pools（烧号） | ❌ 未更新 |
| 写 production certificate_logs | ❌ 未写 |
| 部署 production Worker | ❌ 未部署 |
| 改 production secrets | ❌ 未改 |
| 碰 JHZY 1.0 live | ❌ 未碰 |
| push 到远端 | ❌ 未 push |
| 伪造服务时长/积分/考勤/培训记录 | ❌ 未伪造 |
| 无关修复 | ❌ 未做 |

全部验证在 `node:sqlite` 本地 shim 完成；测试运行后进程退出，不残留任何 production 副作用。

---

## 1. 实际落地路由（与 doc 37 §3 的偏差）

> **关键偏差**：doc 37 §3 采用 aspirational 形态 `/api/v2/admin/...`（带 `/admin/` 前缀）。
> 本项目真实路由约定 **无 `/admin/` 前缀**：activities 挂在 `/api/v2/activities`，service-records 挂在 `/api/v2/service-records`（见 `app.ts` 实际挂载）。
> 实现按**真实约定**接线（不带 `/admin/`），以保持与既有 `routes/activities.ts` / `routes/service-records.ts` 风格一致。权限仍复用既有 `certificate.certificate.issue`，不因前缀改变而新增权限。

### A. Activity（活动）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v2/activities/:activityId/certificates/preview` | 批量资格预览（no-write） |
| POST | `/api/v2/activities/:activityId/certificates/issue` | 批量发放（建 `certificate_batches` 账本） |
| POST | `/api/v2/activities/:activityId/participants/:participantId/certificate/issue` | 单人/补发（IDOR 防护：服务端解析接收者） |

- `:activityId` = `activities.public_id`（ULID）。
- `:participantId` = `activity_participations.public_id`；路由**服务端**经 `findByPublicIdWithSignup` 解析为 `(signup_user_id, activity_id)`，绝不接受请求体传入 `user_id`。

### B. Service（服务）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v2/service-records/:serviceRecordPublicId/certificate/preview` | 资格预览（no-write） |
| POST | `/api/v2/service-records/:serviceRecordPublicId/certificate/issue` | 单人发放 |

- `:serviceRecordPublicId` = `service_records.public_id`（ULID 或 `L[0-9]{12}`）。
- 服务端经 `ServiceRecordRepository.findRowByPublicId(srPublicId, teamId)` 取 numeric `sr.id` + `sr.user_id`，杜绝越权。

### 请求/响应契约

- 预览 body：`{ templateId:number, recipientUserIds?:number[] }`（服务预览仅需 `templateId`）。
- 批量发放 body：`{ templateId:number, recipientUserIds:number[] }`。
- 响应信封：`ok(c, data)` → `{ code:0, message:'OK', data, requestId, timestamp }`；错误经 `fail(c, err)` → AppError（401/403/404/500）。
- 批量发放返回：`{ activityId, templateId, batchId, summary:{requested,issued,alreadyIssued,notEligible,failed}, issued[], alreadyIssued[], notEligible[], failed[] }`。

---

## 2. RBAC 与租户隔离

- 所有路由首行：`requirePermission('certificate.certificate.issue')`（已 seed → `platform_super_admin` / `team_admin` / `team_owner`）。
- 语义：未认证 → 401（AUTH_REQUIRED）；无权限角色（如 `volunteer`）→ 403（FORBIDDEN）；权限 code 不存在 → 500。
- 租户隔离：`certificates` / `certificate_logs` 为 `TEAM_SCOPED` → 平台角色 `teamId=null` 时 `ensureTableRead` 抛 `TEAM_SCOPE_REQUIRED`（403）。
- 因此 HTTP 测试一律使用 `team_admin` / `team_owner` 上下文（带 `x-test-team`）。跨团队访问活动 → 404（L 用例）。

---

## 3. 资格策略（EligibilityPolicy）与接收者守卫（RecipientGuard）

- `ActivityEligibilityPolicy`：`activities.status=1` 参与 + `attendance_sessions.status=2`（已签退）+ 无 blocking anomaly（`attendance_anomalies.status IN (1,2)`）。
  - reason：`ACTIVITY_NOT_ATTENDED`（未签退）、`ATTENDANCE_ANOMALY_BLOCKING`（阻断异常）。
- `ServiceEligibilityPolicy`：`service_records.status=2` + `settlement_status=1`（已结算）+ 无 blocking anomaly。
  - reason：`SERVICE_RECORD_NOT_EFFECTIVE`、`ATTENDANCE_ANOMALY_BLOCKING`。
- `CompositeEligibilityPolicy`：按 `CertificateSource`（ACTIVITY / SERVICE）分派。
- `DefaultRecipientGuard`：`systemUserIds` denylist（**从环境变量 `CERT_SYSTEM_USER_IDS` 注入，不硬编码**）；拦截系统账号作为接收者。
- `CertificateIssuanceService`（CERT-R3B）构造期 fail-closed：缺 `EligibilityPolicy` 或 `RecipientGuard` → 抛 `POLICY_NOT_CONFIGURED`。

### 本人自发证（独立于 RecipientGuard）

- 若 `operatorUserId === recipientUserId` → 403 `SELF_ISSUE_FORBIDDEN`（单人活动 / 服务 / 批量均适用；批量中本人入 `failed` 桶）。

---

## 4. 幂等 / 号池 / 命名空间

- 幂等键：`(user_id, source_type, issue_source, source_id)`；谓词 `WHERE status=1 AND source_type='activity' AND issue_source IS NOT NULL AND source_id IS NOT NULL`（migration 0045 `uq_cert_user_source`）。
- 命名空间派生：`issueSourceFor(ACTIVITY)='activity'`、`issueSourceFor(SERVICE)='service'`、`persistedSourceFor(SERVICE)='activity'`（SERVICE 共享 `cert_srv` 池）。
- 号池：`POOL_FOR_ACTIVITY='cert_srv'`、`POOL_FOR_SERVICE='cert_srv'`（共用，零迁移）。
- 可分配 provenance 白名单：`['legacy_migrated','v2_native']`（fail-closed，排除 `v2_synthetic_compat` 与 NULL）。
- 批量账本：`certificate_batches`（operator_id / source_id / 各计数 / started_at / completed_at）；单人发放**不建** batch（C-DB 用例验证）。

---

## 5. 文件变更（P5 范围）

| 文件 | 状态 | 角色 |
|---|---|---|
| `workers/src/routes/activities.ts` | M | 活动 3 条发证路由 + 权限/租户/IDOR 防护 |
| `workers/src/routes/service-records.ts` | M | 服务 2 条发证路由 + 权限/租户防护 |
| `workers/src/repository/certificate-batches.ts` | NEW | `CertificateBatchRepository`（绕过 scope guard，直接经基类 `run`/`first`） |
| `workers/src/services/certificate-eligibility-policies.ts` | NEW | Activity/Service 资格策略 + 组合策略 + DefaultRecipientGuard |
| `workers/src/services/certificate-issuance-factory.ts` | NEW | `buildCertificateIssuanceService(db, ctx, systemUserIds)` 组合根 |
| `workers/tests/p_r5_activity_service_issuance.test.mjs` | NEW | 集成测试 A–L（40 检查） |
| `workers/docs/audits/.../39-activity-service-issuance-wiring-implementation.md` | NEW | 本文档 |

> 注：`app.ts` 本次**未改**（其 diff 属 P11-WP2/WP3/P6-2/P11-WP4 等其他工作包）。`CertificateIssuanceService` 原语（CERT-R3B）属前期 gate，本次未改动。
> `certificate_batches` 表由 migration 0045 既有提供；本任务仅新增 repo 读写，无新 migration。

---

## 6. 测试覆盖（A–L，40/40 PASS）

| 组 | 覆盖 |
|---|---|
| A | RBAC：未认证 401 / 无权限 403 / 团队角色 200 / 平台无 team 403 |
| B | 活动预览：eligible / 未签退 NOT_ELIGIBLE / 阻断异常 ANOMALY_BLOCKING |
| C | 单人发证：ISSUED + 证书/审计落库 + 不建 batch |
| D | 批量：已发→ALREADY_ISSUED，不合格→NOT_ELIGIBLE，账本计数正确 |
| E | 幂等：再次单人 → ALREADY_ISSUED |
| F | 服务预览：eligible |
| G | 服务发证：ISSUED + 命名空间 (source_type=activity, issue_source=service, source_id=sr.id) |
| H | 服务幂等：再次 → ALREADY_ISSUED |
| I/J | 本人自发证：活动 & 服务均 → 403 SELF_ISSUE_FORBIDDEN |
| K | 本地恰好 2 张证书（1 activity + 1 service，同一接收者） |
| L | 跨团队活动 → 404 |

运行：`cd workers && node tests/p_r5_activity_service_issuance.test.mjs` → `P_R5 RESULT: 40/40 PASS`。

---

## 7. 回归结果

| 套件 | 结果 |
|---|---|
| `npm run typecheck`（tsc --noEmit） | ✅ 0 错误 |
| `cert_r3b_issuance_core.test.mjs` | ✅ 63/0 |
| `cert_r3d_legacy_pool.test.mjs` | ✅ 79/0 |
| `cert_r5a_import_runner_wiring.test.mjs` | ✅ 51/0 |
| `p_r5_activity_service_issuance.test.mjs`（新） | ✅ 40/0 |

> 注：`npm test`（scripts/validate_local_d1.mjs）在本仓库基线即失败——该脚本仅应用 migration 0001–0013 后报 `no such table: roles`，属**预存脚本局限**（未应用完整 46 条 migration），与 P5 无关；P5 测试已通过 `buildP11Db` 完整应用 0001–0046 证明 schema 正确。未对此脚本做任何改动（纪律：不做无关修复）。

---

## 8. Secret / PII 扫描

对 5 个源文件 + 测试做扫描：

- secret 关键字（password / secret / api_key / access_token / authorization / bearer / private_key，非注释行）：**0 命中**。
- PII 手机号（`1[3-9]\d{9}`）：**0 命中**。
- 硬编码系统账号 ID：`DefaultRecipientGuard` 不硬编码（1676 等）；`systemUserIds` 经 `CERT_SYSTEM_USER_IDS` 环境变量注入。**0 命中**。
- 号池 provenance 仅 `'legacy_migrated'`（测试种子），未触及 `v2_synthetic_compat`/NULL。

结论：P5 代码无 secret/PII 泄漏风险。

---

## 9. 生产写保护（再次确认）

- 全部发证经 `CertificateIssuanceRepository.issueBatch` 写入**本地** `node:sqlite` 实例（`buildP11Db` 创建于临时文件）。
- 无任何 `fetch` / `wrangler` / production D1 binding 调用；测试进程退出即弃库。
- 未发现任何指向 `jhzy-v2-prod` / 生产 API 的网络调用。

---

## 10. 提交

```
git add <仅 §5 七个 P5 文件>
git commit -m "feat(certificates): wire activity service issuance"
# 未 push（纪律要求，待管理员显式授权）
```

HEAD 冻结基线 `82875567143eda654888553e5c1008e7e3859f75` 在提交前后未变（仅新增本地 commit，不前进远端）。
