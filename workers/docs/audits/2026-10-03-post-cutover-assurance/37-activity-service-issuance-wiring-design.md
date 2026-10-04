# 37 · Activity / Service 证书签发入口 Wiring 设计（POST-R5-P4）

- 工作包：`POST-R5-P4-ACTIVITY-SERVICE-ISSUANCE-WIRING-DESIGN`
- 上游：`POST-R5-P3 no-write selector simulation = PASS`
- 性质：**设计 / 源码审计 / 接口设计 / 权限·幂等·资格校验设计 / 测试计划 / 文档**。本工作包**不修改任何业务代码、不写生产 D1、不发证、不部署 Worker、不 push**。
- 权威库：`/Users/Shared/projects/jhzy-v2`（HEAD = `cca1976c49e3a1b8baede253c7d9980a774ea906`，branch `master`）。
- 本文档结论：**当前不可直接 production activity/service 发证（NO）**；下一步实现工作包 = `POST-R5-P5-ACTIVITY-SERVICE-ISSUANCE-WIRING-IMPLEMENTATION`。

---

## 1. 背景

R5B 已把 450k legacy 证书号池迁移进生产 D1（`jhzy-v2-prod`），selector 安全性经 P3 no-write 仿真证实（白名单 `legacy_migrated`/`v2_native`，排除 `v2_synthetic_compat`/NULL/status≠0）。

证书域已具备**权威单一接收者发证原语** `CertificateIssuanceService`（CERT-R3B），但：

- 该原语**只声明、未挂载**（全仓零 `new CertificateIssuanceService`）；
- 它依赖**注入式** `EligibilityPolicy` 与 `RecipientGuard`，二者当前**无任何实现**（构造期 fail-closed，缺一则拒绝一切发放）；
- 没有任何 HTTP 路由把活动/服务参与者桥接到该原语。

本设计补齐「路由 → 权限 → 资格 → 接收者守卫 → 原语 → 审计/幂等/号池」这条链路的设计，供 P5 实现。

---

## 2. 当前状态（源码审计结果）

| 项 | 状态 | 证据 |
|---|---|---|
| 发证原语 `CertificateIssuanceService` | 已声明，**未挂载** | `services/certificate-issuance-service.ts:155` 仅 `export class`；全仓 `new CertificateIssuanceService` = 0 命中 |
| 原子写仓储 `CertificateIssuanceRepository.issueBatch` | 已实现（cert INSERT + 号池条件消费 + 审计 INSERT，同 batch） | `repository/certificate-issuance.ts:214` |
| 号池分配 `PoolCertificateNumberAllocator` | 已实现 | `services/certificate-number-allocator.ts:53` |
| `POOL_FOR_ACTIVITY` / `POOL_FOR_SERVICE` | 均为 `'cert_srv'`（共享池，零迁移） | `certificate-number-allocator.ts:37-38` |
| 命名空间派生 `issueSourceFor` | ACTIVITY→`'activity'` / SERVICE→`'service'` | `domain/certificate.ts:139-155` |
| 号池选择白名单 `ALLOCATABLE_PROVENANCES` | `['legacy_migrated','v2_native']`（fail-closed） | `domain/certificate.ts:298-301` |
| 幂等键 / 唯一索引 `uq_cert_user_source` | `(user_id,source_type,issue_source,source_id)` + 谓词 | `migrations/0045_certificate_domain_contract.sql:81` |
| `certificate_batches` 表（批量结果/可观测） | 已存在（operator_id/source_id/各计数/started_at/completed_at） | `migrations/0045_certificate_domain_contract.sql:115` |
| `certificate_logs` 审计列 | 已含 `batch_id` / `result` / `failure_code` | `migrations/0045_certificate_domain_contract.sql:106-108` |
| 现有签发权限 `certificate.certificate.issue` | **已 seed（risk 3）**，授予 `platform_super_admin`/`team_admin`/`team_owner`；**当前无任何路由使用（dead）** | `migrations/0003_seed_permissions.sql:53,176,258,332` |
| 活动参与者来源 | `activity_signups`（报名）+ `activity_participations`（排班/考勤）两条线 | `routes/activities.ts` / `routes/participations.ts` |
| 服务记录来源 | `service_records`（每条绑定单个 `user_id`，`settlement_status` 0/1/2） | `repository/service-records.ts:43-51,174` |
| RBAC 裁决 | `requirePermission(code)` → `authorizePermissionDecision`；**code 不在 `permissions` 表 → 500** | `services/permission-provider.ts:65-71,139-153` |
| 现有「活动/服务签发」路由 | **不存在** | `app.ts:90-101` 无 `certificates/issue` 类挂载 |

### 源码审计关键结论

1. **挂载缺口**：`CertificateIssuanceService` 已实现但未实例化 → 没有任何运行路径调用它。这是「不能直接 production 发证」的首要原因。
2. **策略缺口**：原语要求注入 `EligibilityPolicy` + `RecipientGuard`（构造期 `POLICY_NOT_CONFIGURED` 抛错，fail-closed）。当前全仓**无这两个接口的实现**，故即便挂载，未注入策略也会拒绝一切发放（安全侧，但仍不能发证）。
3. **号池缺口（待核实，见 RISK-1）**：R5B 导入的 450k legacy 主要为 `cert_trn` 历史库存；`cert_srv` 是否已有足量 `legacy_migrated` 库存**未经核实**，若为空则 activity/service 发证会命中 `POOL_UNAVAILABLE`。
4. **SERVICE 无聚合实体**：代码库只有 `service_records`（逐志愿者记录），没有「services」聚合表/路由。故「`/admin/services/:serviceId`」聚合形态 **不适用**，服务发证应以 `service_records` 为粒度。

---

## 3. 目标 API（设计）

> 统一前缀 `/api/v2/admin/...`，全部 `requirePermission('certificate.certificate.issue')`（复用既有等价管理员权限，见 §4）。
> 路径形态与既有 `routes/activities.ts`、`routes/service-records.ts` 一致（`:id` 为 public_id，参数路由注册在字面量段之后）。

### A. Activity（活动）

```
# 批量 / 统一发放：对该活动全部合格参与者发证
POST /api/v2/admin/activities/:activityId/certificates/issue
  body: { template_id?: number, dry_run?: boolean, issue_reason?: string }
  → 202 + CertificateBatchSummary（异步/长任务可选；MVP 同步循环亦可）

# 单人发放 / 补发
POST /api/v2/admin/activities/:activityId/participants/:participantId/certificate/issue
  body: { template_id?: number, issue_reason?: string }
  → 200 { outcome, certificate_public_id?, cert_no?, reason? }

# 发放前预览（no-write）
POST /api/v2/admin/activities/:activityId/certificates/preview
  → 200 { eligible, ineligible, already_issued, expected_pool_consumption, failures:[...] }
```

- `:activityId` = `activities.public_id`（ULID）。
- `:participantId` = 参与者身份标识（**规范来源见 §5C**）；路由**服务端**解析为 `(user_id, activity_id)`，绝不接受请求体传入 user_id。

### B. Service（服务）

```
SERVICE_ROUTE_STATUS = NEEDS_MODEL_CONFIRMATION
  （代码库无 services 聚合实体；服务发证单位为 service_records。下方采用 service_records 粒度。）

# 单人发放 / 补发（服务记录 → 其归属志愿者）
POST /api/v2/admin/service-records/:serviceRecordPublicId/certificate/issue
  body: { template_id?: number, issue_reason?: string }
  → 200 { outcome, certificate_public_id?, cert_no?, reason? }

# 批量发放（一组服务记录）
POST /api/v2/admin/service-records/certificates/issue
  body: { service_record_public_ids: string[], template_id?: number, dry_run?: boolean }
  → 202 + CertificateBatchSummary

# 发放前预览（no-write）
POST /api/v2/admin/service-records/certificates/preview
  body: { service_record_public_ids: string[] }
  → 200 { eligible, ineligible, already_issued, expected_pool_consumption, failures:[...] }
```

- `:serviceRecordPublicId` = `service_records.public_id`（支持 legacy `L############` 形态，沿用 `routes/service-records.ts:79` 正则）。
- 接收者 `user_id` = `service_records.user_id`（**服务端**从行读取，绝不接受请求体传入）。
- 用户指令中的聚合形态 `POST /api/v2/admin/services/:serviceId/...` **标记 NOT_APPLICABLE**：无 services 聚合表；如未来引入「服务批次」聚合实体，再单独扩展。

### C. 参与者身份解析（Activity）

- **规范参与者来源 = `activity_participations`**（与考勤 checkin/checkout 同源，`routes/activities.ts:288` 的 checkin 即以 `participation_public_id` 为键）。
- `:participantId` 解析顺序（P5 实现时冻结其一，避免双源漂移）：
  - 优先按 `activity_participations.public_id` 解析 → 取绑定 `user_id`；
  - 兼容按 `activity_signups.id`（整数）解析 → 取 `user_id`。
- **RecipientGuard / EligibilityPolicy 必须拿到权威 `user_id`**（来自 DB 行），不得由请求体任何 name/phone 字段推导（见 §6）。

---

## 4. 权限设计

- **复用既有等价管理员权限** `certificate.certificate.issue`（已 seed，risk 3，授予 `platform_super_admin`/`team_admin`/`team_owner`）：
  - 满足用户指令「仅 platform_super_admin / platform_operator **或已存在等价管理员权限**可操作」——`certificate.certificate.issue` 即「已存在等价管理员权限」。
  - **免新增权限迁移**，降低 P5 范围（RBAC 已就绪）。
- 端点统一 `requirePermission('certificate.certificate.issue')`（中间件在 handler 前裁决，未认证 401 / 无授权 403 / code 未知 500——但本 code 已知，故不会 500）。
- **普通用户（volunteer）**：无此权限 → 403，不可发证。
- **本人不可自发证**：路由在调用原语前显式校验 `recipientUserId !== operatorUserId`，否则 403 `SELF_ISSUE_FORBIDDEN`（独立于 `RecipientGuard`，属授权层规则）。
- **审计 `operator_user_id`**：`operatorUserId = auth.userId`（authContextMiddleware 注入；`routes/certificates.ts:64` 同形用法），写入 `certificates.issued_by` 与 `certificate_logs.operator_id` 与 `certificate_batches.operator_id`。
- **失败时不得部分绕过权限**：权限在路由入口（中间件）一次性裁决；批量循环内每个接收者仍各自经过原语的 `RecipientGuard` + `EligibilityPolicy`（fail-closed），权限不会被「批量」绕过。

> 备选（若强制「仅平台级」）：引入 `certificate.activity.issue` / `certificate.service.issue`（risk 3），经新迁移 `0047_*` 仅授予 `platform_super_admin`/`platform_operator`（仿 `migrations/0044_notification_reminder_permission.sql` 范式）。本设计**默认复用既有 `certificate.certificate.issue`**，该备选仅作收紧权限时的增量。

---

## 5. EligibilityPolicy（资格校验，不得伪造记录）

接口契约已存在（`services/certificate-issuance-service.ts:115` `EligibilityPolicy.check`）。P5 须提供**具体实现**（当前零实现）。设计约束：

### Activity 资格（建议 `ActivityEligibilityPolicy`）

对每个 `(recipientUserId, activityId)`：
1. `activity` 必须存在（`activities` 行，非 draft/deleted，团队内可见）——否则 `SOURCE_NOT_FOUND`。
2. `participant` 必须存在且**属于该 activity**——否则 `RECIPIENT_NOT_FOUND` / `NOT_ELIGIBLE`。
3. 完成状态合格：建议取 `activity_participations` 活跃 + 考勤 `checkout` 完成（`status=2`，见 `repository/service-records.ts:320` 同形「已签退」语义）+ 无 blocking 考勤异常（`attendance_anomalies.status IN (1,2)` 阻断，见 `repository/service-records.ts:296`）。
4. 业务规则门槛（培训/考核）由政策显式给出；**不满足 → fail-closed**，绝不默认放行。
5. 缺字段 / 状态未知 → `NOT_ELIGIBLE`（fail-closed）。

### Service 资格（建议 `ServiceEligibilityPolicy`）

对每个 `service_records.id`：
1. `service_records` 必须存在且团队内可见——否则 `SOURCE_NOT_FOUND`。
2. `settlement_status = EFFECTIVE(1)`（可消费；`UNVERIFIED(0)`/`REVOKED(2)` 拒）——否则 `NOT_ELIGIBLE`。
3. `status` 完成（已签退 `=2`）、无 blocking 异常——否则 `NOT_ELIGIBLE`。
4. 缺字段 / 未知 → fail-closed。

### 铁律
- **不为验收伪造**服务时长、积分、考勤、培训/考核结果。政策只读既有真实字段判定。
- 政策**缺省即拒绝**（原语构造已 fail-closed：`POLICY_NOT_CONFIGURED`）。
- 政策**不发明**业务数值；只做「是否满足既有真实状态」的布尔判定。

---

## 6. RecipientGuard（接收者守卫）

接口契约已存在（`services/certificate-issuance-service.ts:144` `RecipientGuard.isDisallowedRecipient`）。P5 须提供具体实现。设计约束：

1. **`user_id` 存在**：原语 `repo.findRecipient(userId)` 已校验 `users` 存在且未软删（`repository/certificate-issuance.ts:173`）。
2. **`user_id` 与 participant 绑定一致**：路由解析出的 `user_id` 必须 == 参与者/服务记录行上的 `user_id`（服务端权威；请求体不得携带 user_id）。
3. **不得从姓名/手机号猜 user_id**：接收者 `user_id` 100% 由 DB 行推导，请求体只传 `participantId` / `serviceRecordPublicId`。
4. **历史 unresolved 身份不得发证**：若 `user_id` 指向「未解析/孤儿」身份（如 legacy 未绑定映射），守卫拒绝（`RECIPIENT_NOT_FOUND`）。
5. **系统账号拒绝**：V2 `users` 表无 `is_system` 列（`repository/certificate-issuance.ts:166` 已证实）；系统账号语义由注入策略表达。建议 `DefaultRecipientGuard` 经**配置**（env / 常量，非硬编码 id）持有系统账号/系统团队判定，拒绝其作为接收者。
6. fail-closed：守卫缺省 → `RECIPIENT_GUARD_UNAVAILABLE`（原语已强制）。

---

## 7. 幂等与唯一约束

- **应用层预检**：原语 `findActiveByNamespace({user_id,source_type,issue_source,source_id})`（`repository/certificate-issuance.ts:133`）。
- **DB 唯一索引**：`uq_cert_user_source`（`migrations/0045`）= `(user_id,source_type,issue_source,source_id)`，`WHERE status=1 AND source_type='activity' AND issue_source IS NOT NULL AND source_id IS NOT NULL`。
  - ACTIVITY 键：`('activity','activity',activities.id)`；SERVICE 键：`('activity','service',service_records.id)`——**两命名空间互不冲突**（CERT-R3A 已证）。
- **并发兜底**：`issueBatch` 内证书 INSERT 以 `NOT EXISTS(同键 active)` 守卫；唯一冲突异常归一为 `ALREADY_ISSUED`（不重发、不烧号）。
- **批量重试安全**：已发 → `ALREADY_ISSUED`（跳过，0 消耗）；可对同一集合安全重跑（幂等）。
- **不重复消耗 id_pools**：号池消费以 `EXISTS(certificates public_id=本批)` 为守卫，证书未生成则不烧号（`repository/certificate-issuance.ts:109`）。
- **不重复写 certificates**：唯一索引 + 应用预检双重保证。

---

## 8. 号池与 selector

- ACTIVITY/SERVICE 共用 `cert_srv`（`POOL_FOR_ACTIVITY=POOL_FOR_SERVICE='cert_srv'`，`certificate-number-allocator.ts:37-38`）。
- 选择器 `allocatableProvenanceSql` 强制 `provenance IN ('legacy_migrated','v2_native')`（`domain/certificate.ts:313`），确定性排除：
  - `v2_synthetic_compat`（500 条合成兼容库存，**绝不分配**）；
  - `NULL` / 未知字面量（fail-closed，白名单谓词天然不命中）。
- 候选在「合格集合内」`ORDER BY id ASC` 定序（不承担语义优先级）。
- **RISK-1（BLOCKING 待核实）**：R5B 导入的 450k legacy 是否为 `cert_trn` 专属？`cert_srv` 是否已有足量 `legacy_migrated` 库存**未经核实**。若 `cert_srv` 为空 → 发证命中 `POOL_UNAVAILABLE`。**P5 staging 第一步必须是 read-only `SELECT COUNT(*) FROM id_pools WHERE pool_type='cert_srv' AND status=0 AND provenance IN ('legacy_migrated','v2_native')`**；若不足，须先经独立迁移（建议命名 `R5C`）补种 `cert_srv` legacy 库存，方可开放发证。

---

## 9. Dry-run / Preview（发放前预览，不写）

- 端点：`.../certificates/preview`（§3）。
- 实现：对每个候选接收者调用原语 `previewEligibility({recipientUserId,teamId,domainSource,sourceId})`（`services/certificate-issuance-service.ts:370`，**纯读投影**）。
- 返回：
  - `eligible` / `ineligible` / `already_issued` 计数与明细；
  - `expected_pool_consumption`（= eligible 数，且 ≤ cert_srv 可用量）；
  - `failures: [{recipientUserId, reason}]`（资格/源/已发原因）。
- **不实际写入**任何 `certificates` / `id_pools` / `certificate_logs`。
- 批量发放 `body.dry_run=true` 时走同一条预览路径并返回，不进入 `issue()`。

---

## 10. Audit Log（审计字段）

复用既有表，无需新列（除可选 `request_id` 投影，见下）：

| 字段 | 来源 | 落点 |
|---|---|---|
| `operator_user_id` | `auth.userId` | `certificates.issued_by` + `certificate_logs.operator_id` + `certificate_batches.operator_id` |
| operation source | `domainSource` → `source_type`/`issue_source` | `certificates.source_type`/`issue_source`/`source_id` |
| `issue_reason` | 请求体（可选，默认 `normal`） | `certificates.issue_reason` + `certificate_logs.reason` |
| `batch_id` | `generateUlid()` | `certificate_logs.batch_id` + `certificate_batches.public_id` |
| `started_at` / `completed_at` | 批量起止 | `certificate_batches` |
| `success_count` / `fail_count` / `skipped_count` | 批量统计 | `certificate_batches.issued/failed/skipped`（+ eligible/ineligible/already_issued） |
| `failure_reason` | 原语 outcome | `certificate_logs.failure_code` + `result='failure'` |
| `request_id` / `trace_id` | `requestIdMiddleware` 注入的 requestId | 建议写入 `certificate_logs` 新列 `trace_id`（**P5 可选增量迁移**；预览阶段可用日志透出） |
| `dry_run` 标记 | 请求 `dry_run` | 预览端点不写；若未来持久化 dry-run 结果，落 `certificate_batches` 新列（可选） |

- 审计是成功契约一部分：原语 `issueBatch` 后 `countIssueAudit` 缺失 → `AUDIT_FAILED`（不报 ISSUED）。

---

## 11. 测试计划

- **unit · EligibilityPolicy**
  - Activity：participant 不存在 / 不属于 activity / 未完成考勤 / 有 blocking 异常 / 缺字段 → 均 `NOT_ELIGIBLE`；合格 → eligible。
  - Service：`settlement_status` 非 EFFECTIVE / 未签退 / 有异常 → `NOT_ELIGIBLE`；合格 → eligible。
  - fail-closed：policy 未注入 → `ELIGIBILITY_POLICY_UNAVAILABLE`。
- **unit · RecipientGuard**
  - 系统账号 / 孤儿身份 / user_id 与 participant 不一致 → 拒绝；正常志愿者 → 通过。
  - fail-closed：guard 未注入 → `RECIPIENT_GUARD_UNAVAILABLE`。
- **unit · Idempotency**
  - 同一 `(user,source_type,issue_source,source_id)` 二次 `issue()` → `ALREADY_ISSUED`；`id_pools` 仅消耗一次；`certificates` 仅一行。
- **unit · Source namespace**
  - ACTIVITY 写 `issue_source='activity'` + `source_id=activities.id`；SERVICE 写 `issue_source='service'` + `source_id=service_records.id`；二者键不冲突（分别可发）。
- **integration · single issue**（staging）：activity 单人 / service 单人发证 → 返回 `ISSUED` + 正确 `cert_no` + `certificate_logs` 一行 + `id_pools` 消耗 1。
- **integration · batch issue**（staging）：混合 eligible/ineligible/already_issued → `certificate_batches` 计数正确，仅 eligible 落证。
- **integration · retry does not duplicate**：重跑同一批 → 已发项 `ALREADY_ISSUED`，总量不变。
- **selector · synthetic not consumed**：`cert_srv` 仅 `legacy_migrated` 被消费；`v2_synthetic_compat`（500）/NULL/status≠0 永不命中（复用 `cert_r3d_legacy_pool.test.mjs` 断言集）。
- **RBAC · tests**：`requirePermission('certificate.certificate.issue')` 下 volunteer→403、platform_super_admin→放行、未认证→401；本人自发证→403 `SELF_ISSUE_FORBIDDEN`。
- **audit · tests**：每条 ISSUED 必有 `certificate_logs` 行（`action='issue'`，`operator_id` 非空，`batch_id` 关联）；`AUDIT_FAILED` 路径不报 ISSUED。
- **no-write · preview tests**：`/preview` 与 `dry_run=true` 后 `certificates`/`id_pools`/`certificate_logs` 行数零变化。
- 测试基础设施沿用 `workers/tests/*.mjs`（node --test + 本地 `node:sqlite` / D1 兼容 fixture）。

---

## 12. Staging Validation Plan

1. **仅 staging D1**（绝不污染 production）。
2. 先用 **真实脱敏测试活动 / 测试服务记录** fixture（或 staging 既有数据），不引入生产 PII。
3. **RISK-1 先行核实**：read-only 统计 `cert_srv` 可用 legacy 量；不足则先补种（R5C）再继续。
4. 验证单人发证（activity + service 各一）→ `ISSUED` + 号池 -1 + 审计 +1。
5. 验证批量发证（含 eligible/ineligible/already_issued 混合）→ `certificate_batches` 计数正确。
6. 验证「我的证书可见」：`GET /certificates/mine`（接收者本人）能看到新证（`CertificateService.mine`）。
7. 验证详情/验真打开：`GET /certificates/:publicId` 与 `/certificates/verify`（PDF 若 PENDING 属已知冻结态，详情仍应可开；见 RISK-6）。
8. 验证失败案例：无权限 403 / 活动不存在 `SOURCE_NOT_FOUND` / 参与者不存在 `RECIPIENT_NOT_FOUND` / 不满足资格 `NOT_ELIGIBLE` / 已发 `ALREADY_ISSUED` / 号池耗尽 `NUMBER_POOL_EXHAUSTED`。
9. 全部 staging 用例绿，且对账（号池消耗 == 发证数 == 审计数）一致，方可进入生产发布评估。

---

## 13. Production Rollout Plan

1. **只有 staging 全绿后才 production deploy**。
2. 生产首次仅做**一条真实合规记录**（用户授权后、人工触发、单接收者、非批量）。
3. 验证：生产对账（号池 -1 == certificates +1 == certificate_logs +1）、接收者「我的证书」可见、验真可查。
4. **观察期**（建议 ≥ 数日 / 若干真实记录）无异常后，再开放批量入口。
5. 批量生产发放须在维护窗口 + 用户明确授权下进行，逐接收者可重试、可部分失败复盘。
6. 本工作包（P4）**不执行任何上述生产动作**。

---

## 14. Risks

- **RISK-1（BLOCKING）`cert_srv` legacy 库存未核实**：R5B 导入 450k 疑似 `cert_trn` 专属；`cert_srv` 若无 `legacy_migrated` 库存则发证 `POOL_UNAVAILABLE`。→ staging 第一步 read-only 统计；不足则先 R5C 补种。
- **RISK-2 原语未挂载**：`CertificateIssuanceService` 全仓零实例化 → P5 须在路由组合根构造并注入 `repo`/`eligibility`/`recipientGuard`。
- **RISK-3 策略零实现**：`EligibilityPolicy` / `RecipientGuard` 无实现 → P5 必须落地 `Activity`/`Service` 两套策略 + `DefaultRecipientGuard`，否则 fail-closed 拒绝一切发放。
- **RISK-4 权限范围偏宽**：复用 `certificate.certificate.issue` 同时授予 `team_admin`/`team_owner`（不止平台级）。用户指令「或已存在等价管理员权限」已许可；若须严格平台级，改引入 `certificate.activity.issue`/`certificate.service.issue`（新迁移 0047）。
- **RISK-5 SERVICE 无聚合实体**：`/admin/services/:serviceId` 聚合形态不适用；服务发证以 `service_records` 为粒度（本文设计已改）。
- **RISK-6 PDF 未实现（CERT-R4）**：新发证书 `file_status=PENDING`；详情/验真可开，但 PDF 下载可能不完整。Staging 须容忍 PENDING。
- **RISK-7 活动参与者来源双线**：`signups` 与 `participations` 并存；P5 须冻结规范来源（建议 `activity_participations`，与考勤同源），避免双源漂移。

---

## 15. Recommended Next Action

- **当前是否可直接 production activity/service 发证：NO。**
- **原因**：route wiring（§3）/ EligibilityPolicy（§5）/ RecipientGuard（§6）/ audit（§10）/ preview（§9）均未接线；`CertificateIssuanceService` 未挂载、策略零实现、号池待核实（RISK-1）。
- **下一步实现工作包**：`POST-R5-P5-ACTIVITY-SERVICE-ISSUANCE-WIRING-IMPLEMENTATION`
  - 在代码与测试中完成（路由 + 策略 + 守卫 + 预览 + 批量 + RBAC 复用 + 测试计划），**不直接 production 发证**；
  - 含 staging 验证（§12）与 RISK-1 核实/补种；
  - 通过后再进入 §13 生产发布评估（需用户授权）。

---

## 16. 执行纪律确认（本工作包）

- `PRODUCTION_D1_MUTATED = NO`（仅 read-only 源码审计 + 文档）
- `CERTIFICATE_ISSUED = NO`
- `PRODUCTION_WORKER_DEPLOYED = NO`
- `SECRET_MUTATED = NO`
- `JHZY_1_0_LIVE_TOUCHED = NO`
- `GIT_PUSH_PERFORMED = NO`
- 仅 `git add` + `git commit` 本文档（不 push）。

---

## 17. Final Return 摘要

```
POST_R5_P4_STATUS = PASS_WITH_DESIGN
START_HEAD = cca1976c49e3a1b8baede253c7d9980a774ea906
END_HEAD = <commit 后更新>
COMMIT_SHA = <本文档提交 SHA>
CURRENT_PRODUCTION_ACTIVITY_SERVICE_ISSUANCE = NO
RECOMMENDED_NEXT_WORK_PACKAGE = POST-R5-P5-ACTIVITY-SERVICE-ISSUANCE-WIRING-IMPLEMENTATION
SECRET_PII_SCAN = PASS (文档无手机号/OpenID/身份证/真实姓名/session token/API token/raw cert_no/raw pool code)
PRODUCTION_D1_MUTATED = NO
CERTIFICATE_ISSUED = NO
PRODUCTION_WORKER_DEPLOYED = NO
SECRET_MUTATED = NO
JHZY_1_0_LIVE_TOUCHED = NO
GIT_PUSH_PERFORMED = NO
NEXT_ACTION = 实施 POST-R5-P5（代码+测试+staging 验证，含 cert_srv 库存核实/补种），经用户授权后再评估生产首发
```
