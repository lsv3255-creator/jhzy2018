# POST-R5-T1 — 测试发证闭环（2.0 Production D1，TEST ONLY）

> 任务：在嘉禾志愿 2.0 生产 D1（jhzy-v2-prod）上跑通「TEST 数据 → 资格预览 → 发放 1 张 TEST 证书 → 验证 → 作废」的闭环。
> 纪律红线：**1.0 绝对不触碰**（不连 api.jhzyfw.com、任何 1.0 库、任何 1.0 接口、任何 1.0 文件）。

---

## 0. 1.0 / 2.0 口径（本轮更新）

| 维度 | 嘉禾志愿 1.0 | 嘉禾志愿 2.0 |
|---|---|---|
| 性质 | 真实业务生产系统（冻结，禁止触碰） | 独立新系统 / 测试验收系统 |
| 真实业务发证 | 仍在 1.0 | 不在 2.0（2.0 仅跑 TEST 发证） |
| 本任务对 2.0 的授权 | — | 允许写 2.0 **production D1** 的 **TEST** 数据；允许发放 **1 张 TEST** 证书；**不允许**真实业务证书、批量、**不允许 push**、**不允许改 secrets**、**不允许部署 Worker**（除非另行授权） |

- **ONE_DOT_ZERO_TOUCHED = NO**：本轮所有命令仅指向 `jhzy-v2-prod`（账号 8770e4917f904aed5df91c883cf058af / profile `jhzy`）。从未连接 `api.jhzyfw.com` 或任何 1.0 主机 / 数据库 / 接口。
- **PRODUCTION_D1_MUTATED = YES_TEST_ONLY**：仅以 `T1_TEST_DO_NOT_USE_REAL` 标记写入 2.0 production D1 的 TEST 数据 + 1 张 TEST 证书（随后作废）。
- **REAL_BUSINESS_CERTIFICATE_ISSUED = NO**。

---

## 1. Step 1 — Repo gate

- `git rev-parse --show-toplevel` → `/Users/Shared/projects/jhzy-v2`（正确仓库，非 1.0 工作区）
- `git rev-parse HEAD` → `cebb42c7cd4ad7014859da324bf726721d0b7364`
- branch → `master`
- `git status --short` → 存在若干预修改文件（`miniprogram/`、`docs/`、`api-v2/` 等），**均为既有、非本次产生**；本轮仅 `git status` 查看，**未 clean / 未 stash / 未 reset / 未改动任何业务代码**。
- 最终仅 stage 本审计文档（+ `audits/scripts/` 下的脱敏模板脚本），**不 stage 任何业务代码**。
- 提交 SHA 见文末 `DOC_COMMIT_SHA`；**GIT_PUSH_PERFORMED = NO**。

## 2. Step 2 — Runtime health gate（smoke host）

`curl -i https://v2-smoke.signivra.com/health`（HTTP/2 200）：

```json
{"status":"ok","worker":"jhzy-v2-worker","environment":"production","d1Binding":"present","schema":{"migrationsApplied":46},"time":1791115116}
```

| 检查项 | 期望 | 实际 | 结果 |
|---|---|---|---|
| HTTP 状态 | 200 | 200 | ✅ |
| status | ok | ok | ✅ |
| environment | production | production | ✅ |
| d1Binding | present | present | ✅ |
| migrationsApplied | 46 | 46 | ✅ |

Health gate **PASSED**。

## 3. Step 3 — Schema / route 只读确认

- 发证 route：`POST /api/v2/activities/:activityId/participants/:participantId/certificate/issue`（src/routes/activities.ts:682）。
- 预览 route：`POST /api/v2/activities/:activityId/certificates/preview`（src/routes/activities.ts:529）。
- 两路由均受 `requirePermission('certificate.certificate.issue')` + **team 作用域**（`tenant.teamId != null`）保护 → **HTTP 发证需要真实 admin token**。本机无安全 admin token，故 HTTP route 未走通（见 §6 / §7）。
- 核心发证逻辑：`CertificateIssuanceService.issue` / `previewEligibility`（src/services/certificate-issuance-service.ts）。
- 活动资格策略：`ActivityEligibilityPolicy`（src/services/certificate-eligibility-policies.ts）——要求 `activity_participations.status=1` → `attendance_sessions.participation_id=p.id AND status=2`，且无 `attendance_anomalies.status IN (1,2)` 阻断异常。
- 写路径（权威）：`CertificateIssuanceRepository.issueBatch`（src/repository/certificate-issuance.ts）——单原子 batch：`certificates INSERT` → `id_pools` 条件消费（以 `EXISTS(certificates.public_id,status=1)` 为守卫）→ `certificate_logs INSERT`（由证书行派生）。
- 关键表结构（运行时，migrationsApplied=46）：
  - `certificates`：含 `cert_kind`（participant/acceptance）、`issued_by`、`issue_reason`、`revoked_at`、`revoked_by`、`revoke_reason`、`issue_source`（activity/service，命名空间判别器）；`uq_cert_user_source` 唯一索引 `(user_id,source_type,issue_source,source_id) WHERE status=1 AND source_type='activity' AND issue_source IS NOT NULL AND source_id IS NOT NULL`。
  - `id_pools`：含 `provenance`（legacy_migrated / v2_synthetic_compat / v2_native / NULL，fail-closed 白名单）；`UNIQUE(code)`；活动/服务发证复用 `pool_type='cert_srv'` 池。
  - `certificate_logs`：含 `result`(success/failure)、`failure_code`、`batch_id`；`action` ∈ issue/revoke/reissue/regenerate。
  - `attendance_sessions`：含 `participation_id`（迁移 0014 增补）。
  - `activity_participations`：含 `public_id`（ULID）、`signup_id`、`occurrence_id`、`status`（1=assigned/2=cancelled）。
  - `activity_occurrences`：`activity_participations.occurrence_id` 的 FK 来源。

## 4. Step 4 — Before snapshot（production D1，只读）

| 指标 | 值 |
|---|---|
| certificates_count | **413** |
| id_pools_total | **450,500** |
| cert_srv_available_legacy（`pool_type='cert_srv' AND provenance='legacy_migrated' AND status=0`） | **149,692** |
| certificate_logs_count | **0** |
| service_records_count | **0** |

ID 上限（安全哨兵基准）：users 1676 · teams 1 · activities 226 · occurrences 72 · signups 370 · participations 372 · attendance 240 · templates 3 · certificates 413。→ 本轮 TEST 哨兵 id 空间 990001–990009 全部高于生产上限，**零碰撞风险**。

## 5. Step 5 — 创建 2.0 TEST 数据（production D1 写入，TEST ONLY）

统一标记：`T1_TEST_DO_NOT_USE_REAL`。文本列（`users.nickname` / `teams.name` / `activities.title` / `certificate_templates.name`）直接带标记；`signup/participation/attendance` 经 FK 继承 TEST 作用域，并以哨兵 id 空间 990001–990009 隔离。

| 实体 | 内部 id | public_id（ULID，TEST） | 关键字段 |
|---|---|---|---|
| users | 990001 | `ZZVDTWK1AXYKBF8RPHAGW2ZZA2` | nickname=`T1_TEST_DO_NOT_USE_REAL`，status=1（无 PII 列填充） |
| teams | 990002 | `HC37MNTA21CJTCH5FHHEPCNPZ7` | name=`T1_TEST_DO_NOT_USE_REAL_team`，owner=990001，is_system=0 |
| activities | 990003 | `G92NH9A4VX5WATWAFZABQBJ1VH` | title=`T1_TEST_DO_NOT_USE_REAL activity`，team=990002，status=1 |
| activity_occurrences | 990004 | `AQ5NXG7YTGVW0JYYAAK683WS80` | activity=990003，status=1 |
| activity_signups | 990005 | — | activity=990003，user=990001，status=1 |
| activity_participations | 990006 | `VZ9X5S5JZ2CXXH6FS4PGM4KTP2` | signup=990005，occurrence=990004，status=1 |
| attendance_sessions | 990007 | — | signup=990005，activity=990003，user=990001，team=990002，**participation_id=990006**，status=2（已签退），无 blocking anomaly |
| certificate_templates | 990008 | — | name=`T1_TEST_DO_NOT_USE_REAL_template`，cert_type=activity，status=1 |

> 注：首次 `wrangler d1 execute --file` 因报告阶段被 SIGTERM 中断，但 8 行 TEST 数据已提交；重试时 `users.id` 主键冲突即证明数据已存在。所有 8 行均经 `WHERE id BETWEEN 990001 AND 990009` 复核存在。
> **无任何真实姓名 / 手机号 / OpenID / 身份证 / 登录态写入。**

## 6. Step 6 — Preview（资格验证）

- HTTP 预览：无安全 admin token → **PREVIEW_HTTP = SKIPPED_NO_SAFE_AUTH**（未为预览创建真实登录 session）。
- 等价逻辑验证（D1 只读，镜像 `ActivityEligibilityPolicy`）：
  - attended（政策①）：`SELECT 1 ... att.participation_id=p.id AND p.status=1 AND att.status=2` → **命中（eligible by attendance）**。
  - blocking anomaly（政策②）：`attendance_anomalies.status IN (1,2)` → **空（无阻断）**。
  - source entity exists（activity 990003）→ 存在；recipient user 990001 存在且未软删除。
- **PREVIEW_RESULT = ELIGIBLE_TRUE**（TEST 接收者具备活动发证资格）。

## 7. Step 7 — Issue（发放 1 张 TEST 证书）

- HTTP 单人 issue route：**未走通**（无安全 admin token，且无部署授权）。
- INTERNAL_SERVICE（真实服务代码）：以本地 P_R5 集成测试（§10）离线验证 `CertificateIssuanceService` 真实代码路径 PASS，但**非对 production D1 的实时调用**。
- D1_FALLBACK（production D1 实际写入，本任务主路径）：依据 `issueBatch` 精确复刻同一原子 batch：
  1. `certificates` INSERT（id=990009，public_id=`CYDSBABK8ABXXEYAAR4A7EQWWP`，cert_no=`JHCR****FT3J`(见下)，verify_code=`8TRCZ0YCYHMMM1YNXJXP192ATN`，template_id=990008，user_id=990001，team_id=990002，cert_type=activity，**source_type=activity / issue_source=activity / source_id=990003**，cert_kind=participant，issued_by=990001，status=1）。
  2. `id_pools` 条件消费（`pool_type='cert_srv' AND code=<选中码> AND status=0 AND provenance IN ('legacy_migrated','v2_native') AND EXISTS(证书 public_id,status=1)`）。
  3. `certificate_logs` INSERT（由证书行派生，action=issue，result=success）。
- 选中空闲 `legacy_migrated` `cert_srv` 号：`pool_id=25775`，脱敏码 `JHCR****FT3J`（raw pool code 已按任务要求剔除；原始码仅留存于未提交的 `/tmp/54-t1-step7-issue.sql`，不在本仓库内）。
- 实际执行：`wrangler d1 execute jhzy-v2-prod --remote --profile jhzy`（命令阶段 SIGTERM，但 DB 已提交；经读查询复核确认）。
- **ISSUE_RESULT = ISSUED**（TEST 证书 id 990009，status=1）。
- **ISSUE_PATH = D1_FALLBACK**（诚实标注：**HTTP route 未覆盖**）。

## 8. Step 8 — After snapshot（issue 后立即查询）+ Step 9 验证

| 指标 | Before | After（issue 后） | 预期 | 结果 |
|---|---|---|---|---|
| certificates_count | 413 | **414** | +1 | ✅ |
| id_pools_total | 450,500 | 450,500 | 不变 | ✅ |
| cert_srv_available_legacy | 149,692 | **149,691** | -1 | ✅ |
| certificate_logs_count | 0 | **1** | +1 | ✅ |
| service_records_count | 0 | 0 | 不变 | ✅ |

新 TEST 证书明细（D1 只读核验 = Step 9 的 mine/detail 替代验证；无安全 token 故未走 HTTP mine/detail）：
- id=990009，public_id=`CYDSBABK8ABXXEYAAR4A7EQWWP`（可用于 `/certificates/:public_id` 详情路径），cert_no=`JHCR****FT3J`（脱敏），verify_code=`8TRCZ0YCYHMMM1YNXJXP192ATN`。
- user_id=**990001**（TEST 接收者）✅ · team_id=990002 · template_id=990008。
- source_type=**activity** / issue_source=**activity** / source_id=**990003**（命名空间正确）✅。
- cert_kind=participant · issue_reason=normal · issued_by=990001 · **status=1**（issue 后）· issued_at=1791116463。
- 消费号池：id=25775，pool_type=cert_srv，status=**1**（已分配），assigned_to=990001。
- 审计：certificate_logs（certificate_id=990009）action=**issue**，reason=normal，operator_id=990001，result=**success**，failure_code=NULL，batch_id=NULL。

**MINE_OR_DETAIL_VERIFICATION = D1_READ_ONLY_PASS**（证书记录存在、接收者正确、命名空间正确、status 正确、public_id 可用于详情路径）。

## 9. Step 10 — Cleanup / void 决策

- 系统具备安全作废/撤销能力：`certificates.status=2`（revoked）+ `certificate_logs.action='revoke'`。
- 执行：`certificates` id=990009 → `status=2, revoked_at=<now>, revoked_by=990001, revoke_reason='T1_TEST_CLEANUP'`；并追加 `certificate_logs` action=revoke / reason=T1_TEST_CLEANUP / result=success。
- **不强行回收证书编号**（系统未提供安全的号池回收接口）；被消费的 legacy 号保留为已分配状态。
- 最终态：certificate 990009 **status=2（已撤销）**，certificate_logs_count=2（issue + revoke），cert_total=414（行保留、已撤销），cert_srv_avail=149,691（号池仍 -1，未回收）。
- **CLEANUP_STATUS = REVOKED（TEST_ARTIFACT_RETAINED = 已撤销留存，未硬删、未回收编号）**。

## 10. 补充 — INTERNAL_SERVICE 代码路径本地验证（非 production）

为证明真实发证代码（非仅 D1 复刻）正确，运行项目自带本地集成测试（离线、不触 production）：
`node tests/p_r5_activity_service_issuance.test.mjs` → **P_R5 RESULT: 40/40 PASS**。
覆盖：RBAC（401/403/租户隔离 404）、活动资格预览（eligible / 未签退 NOT_ELIGIBLE / 阻断异常 ATTENDANCE_ANOMALY_BLOCKING）、单人发证 ISSUED + 本地证书/审计落库 + 不建 batch、批量幂等、服务发证命名空间（source_type=activity/issue_source=service）、本人自发证 403。→ 真实 `CertificateIssuanceService` 代码路径可信。

## 11. Secret / PII scan（Step 12）

- 本文档**不含**：token / 手机号 / OpenID / 身份证 / 真实姓名 / session token / raw cert_no / raw pool code。
- 允许项均已使用：`TEST public_id`、`TEST internal id`（990001–990009）、`masked certificate number`（JHCR****FT3J）、聚合计数。
- 真实 cert_no 仅出现在 `/tmp/54-t1-step7-issue.sql`（执行即用、未提交）；提交物见 §12。

## 12. 提交物（Step 13）

- `workers/docs/audits/2026-10-03-post-cutover-assurance/54-t1-test-certificate-issuance-closed-loop.md`（本文件）
- `workers/docs/audits/2026-10-03-post-cutover-assurance/scripts/54-t1-generate-values.py`（TEST 值生成器，无真实凭证）
- `workers/docs/audits/2026-10-03-post-cutover-assurance/scripts/54-t1-values.json`（生成值，仅 TEST id/ULID，无 PII）
- `workers/docs/audits/2026-10-03-post-cutover-assurance/scripts/54-t1-step5-data.sql`（TEST 数据 INSERT，脱敏注释、无真实凭证）
- `workers/docs/audits/2026-10-03-post-cutover-assurance/scripts/54-t1-build-issue.py`（issue SQL 生成器）
- `workers/docs/audits/2026-10-03-post-cutover-assurance/scripts/54-t1-step7-issue.template.sql`（**脱敏**版 issue SQL，cert_no 以 `<TEST_CERT_NO_PLACEHOLDER>` 占位）
- `workers/docs/audits/2026-10-03-post-cutover-assurance/scripts/54-t1-step7-values.json`（TEST public_id / verify_code / masked cert_no / internal id，无 PII）
- **不 stage 任何业务代码**；**不 push**。

---

## 13. 最终状态汇总

```
POST_R5_T1_STATUS = COMPLETED_CLOSED_LOOP
ONE_DOT_ZERO_TOUCHED = NO
TWO_DOT_ZERO_TEST_DATA_CREATED = YES (8 行哨兵数据 + 1 张 TEST 证书[已撤销])
PREVIEW_RESULT = ELIGIBLE_TRUE (HTTP=SKIPPED_NO_SAFE_AUTH; 等价逻辑+D1 验证)
ISSUE_RESULT = ISSUED (TEST 证书 id=990009, 随后撤销)
ISSUE_PATH = D1_FALLBACK  (HTTP route 未覆盖：无安全 admin token；INTERNAL_SERVICE=本地 P_R5 代码路径 40/40 PASS)
CERTIFICATE_CREATED = YES (id=990009, 已撤销)
CERTIFICATE_PUBLIC_ID = CYDSBABK8ABXXEYAAR4A7EQWWP
CERTIFICATE_NUMBER_MASKED = JHCR****FT3J
ID_POOL_CONSUMED = YES (pool_id=25775, pool_type=cert_srv, 状态=已分配, 未回收)
BEFORE_CERTIFICATES_COUNT = 413
AFTER_CERTIFICATES_COUNT = 414
BEFORE_CERT_SRV_AVAILABLE = 149692
AFTER_CERT_SRV_AVAILABLE = 149691
MINE_OR_DETAIL_VERIFICATION = D1_READ_ONLY_PASS
CLEANUP_STATUS = REVOKED (TEST_ARTIFACT_RETAINED: 已撤销留存, 编号未回收)
PRODUCTION_D1_MUTATED = YES_TEST_ONLY
REAL_BUSINESS_CERTIFICATE_ISSUED = NO
GIT_PUSH_PERFORMED = NO
DOC_COMMIT_SHA = <见 git 提交后回填>
SECRET_PII_SCAN = PASS (无 token/手机号/OpenID/身份证/真实姓名/session/raw cert_no/raw pool code)
NEXT_ACTION = 取得安全 team_admin TEST token 或 wrangler dev --remote 测试态，以闭环真实 HTTP issue route；并建独立 TEST 清理/撤销工具
```

## 14. 下一步建议（NEXT_ACTION 详述）

1. **HTTP route 覆盖缺口（主要）**：本轮因无安全 admin token 且未授权部署 Worker，真实 `POST /api/v2/activities/:activityId/participants/:participantId/certificate/issue` 未被执行；仅以 `D1_FALLBACK` 复刻其写路径 + 本地 P_R5 测试证明代码正确。**建议下一轮**：在获得授权的 team-scoped admin TEST token（或 `wrangler dev --remote` + 测试态租户上下文）后，对 production D1 的同一 TEST 数据执行真实 HTTP issue，闭合 HTTP route 验证。
2. **TEST 清理工具**：建议新增独立的 TEST 数据/证书清理脚本（按 `T1_TEST_DO_NOT_USE_REAL` 标记 + 哨兵 id 空间批量定位、撤销/归档），避免未来遗留 TEST 痕迹。
3. **号池消耗说明**：本轮消耗 1 个 legacy `cert_srv` 编号（已分配、未回收），属测试成本；若需回收，需先确认系统是否提供安全的号池回退接口（当前未提供）。
