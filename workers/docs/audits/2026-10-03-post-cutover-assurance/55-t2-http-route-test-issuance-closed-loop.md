# POST-R5-T2：2.0 HTTP Route TEST 发证闭环审计

> 关联：T1 = `54-t1-test-certificate-issuance-closed-loop.md`（D1_FALLBACK）
> 本文件：T2 在 T1 基础上**补上真实 HTTP route 覆盖缺口**，全程走 2.0 生产 HTTP 路由。

## 0. 项目口径（铁律）

- **嘉禾志愿 1.0 = 真实业务生产系统，绝对禁止触碰**（含 `/www/wwwroot/api.jhzyfw.com/`、1.0 库/接口/文件/证书系统）。本任务全程零 1.0 接触。
- **嘉禾志愿 2.0 = 独立新系统 / 测试验收系统**，允许创建明确标记的 TEST 数据、TEST 发证、TEST 验证、TEST 清理/作废。
- 统一 TEST 标记：`T2_TEST_DO_NOT_USE_REAL`（写入 activity title、team name、template name 及 SQL 注释）。
- 允许操作：写 2.0 production D1 的 TEST 数据；创建 2.0 TEST admin / TEST session / TEST token；经 2.0 HTTP route 发放 **1 张** TEST 证书。
- 禁止：真实业务证书、批量发证、push、改 secrets、部署 Worker、用 D1_FALLBACK 冒充 HTTP route。
- 所有 TEST 数据位于哨兵 id 空间 **991001–991020**，便于后续定位与清理；无任何 PII（无真实姓名/手机号/OpenID/身份证）。

## 1. T1 背景与本任务目标

- T1 已完成：`POST-R5-T1 = COMPLETED_CLOSED_LOOP`，但 `ISSUE_PATH = D1_FALLBACK`（因无安全 admin token，未覆盖真实 HTTP route，仅以复刻写路径 + 本地 P_R5 测试佐证）。
- T2 目标：**取得/构造 2.0 TEST admin auth 上下文，只调用 2.0 HTTP route**（preview + single issue），完成 1 张 TEST 证书的 HTTP 路由发放闭环。
- T2 明确约束：**不得使用 D1_FALLBACK 伪装 HTTP route**；若最终只能 fallback，必须标记 T2 未达成。→ 本轮 **ISSUE_PATH = HTTP_ROUTE**（真实 HTTP 路由确实被调用并成功）。

## 2. Step 1 — Repo gate

- toplevel：`/Users/Shared/projects/jhzy-v2`（HEAD `94457f7`，branch `master`）。
- `git status --short` 记录为主工作树既有改动（miniprogram/、docs/production-audit/ 等大量业务文件），**本任务未 clean / stash / reset 主工作树，且仅 stage 审计文档与 scripts**。

## 3. Step 2 — Runtime health gate（PASS）

```
curl -i https://v2-smoke.signivra.com/health
→ HTTP/2 200
→ {"status":"ok","worker":"jhzy-v2-worker","environment":"production",
   "d1Binding":"present","schema":{"migrationsApplied":46},"time":...}
```
全部满足：HTTP 200 / status=ok / environment=production / d1Binding=present / migrationsApplied=46。

## 4. Step 3 — Auth / route / permission 机制（只读确认）

- 认证 = D1 服务端 Session（Bearer `s_<base64url>` → SHA-256 → `token_hash` 唯一定位），JWT 排除；`SessionService.resolve` 每请求实时加载 `user_roles`，`X-Team-Id`（数字或 ULID）选择团队上下文。
- 路由（均受 `requirePermission('certificate.certificate.issue')` + `tenant.teamId` 非空 + 团队作用域保护）：
  - 预览：`POST /api/v2/activities/:activityId/certificates/preview`，body `{templateId, recipientUserIds[]}`，`activityId` 为 **ULID**。
  - 单人发放：`POST /api/v2/activities/:activityId/participants/:participantId/certificate/issue`，`participantId` 为 **ULID**（participation public_id）；`recipient = part.signup_user_id`；**recipient ≠ auth.userId**（否则 `SELF_ISSUE_FORBIDDEN`）。
- 权限：`certificate.certificate.issue` 由 D1 `role_permissions` 授权；授予角色 = `platform_super_admin` / `team_admin` / `team_owner`。→ 本任务为 TEST admin 授予 **`team_admin`**（scope = TEST team）。
- 资格（真实 `ActivityEligibilityPolicy`，fail-closed）：`activity_participations.status=1` → `attendance_sessions.participation_id=p.id AND status=2`，且无 `attendance_anomalies.status IN (1,2)` 阻断异常。
- 真实 `CertificateIssuanceService.issue` 自身原子消费 `id_pools` `cert_srv` 编号 + 写 certificates + certificate_logs（**无需预消费号池**）。
- 无 HTTP revoke/void 路由（grep 确认），故清理走安全 D1 revoke。
- 禁止项遵守：未使用真实管理员信息、未获取/暴露真实 token、未登录/污染 1.0。

## 5. Step 4 — Before snapshot（2.0 production D1）

| 指标 | 值 |
|---|---|
| certificates_count | 414 |
| id_pools_total | 450,500 |
| cert_srv_available_legacy | 149,691 |
| certificate_logs_count | 2 |
| sessions_count | 0 |

## 6. Step 5 — T2 TEST 数据（写入 2.0 production D1，已核验哨兵空间无冲突）

全部位于哨兵 id 991001–991020，标题/名称含 `T2_TEST_DO_NOT_USE_REAL`：

| 实体 | id | 关键字段 |
|---|---|---|
| TEST team | 991001 | name=`T2_TEST_DO_NOT_USE_REAL`，owner=991002 |
| TEST admin user | 991002 | nickname=`T2_TEST_ADMIN`，status=1 |
| TEST recipient user | 991003 | nickname=`T2_TEST_RECIPIENT`，status=1 |
| TEST activity | 991004 | title=`T2_TEST_DO_NOT_USE_REAL activity`，team_id=991001，status=1 |
| TEST occurrence | 991005 | activity_id=991004，start<end，status=1 |
| TEST signup | 991006 | activity_id=991004，user_id=991003，status=1 |
| TEST participation | 991007 | public_id=`8D1ZKXZEEN4VNMPZ2B7XEV68N2`，signup_id=991006，occurrence_id=991005，status=1 |
| TEST attendance | 991008 | signup_id=991006，activity_id=991004，user_id=991003，team_id=991001，status=**2**，participation_id=**991007** |
| TEST template | 991009 | name=`T2_TEST_DO_NOT_USE_REAL template`，cert_type=activity，layout=`{}`，status=1 |
| TEST session | 991010 | user_id=991002，token_hash=SHA-256(TEST token)，expires_at=+30d，status=1 |

注意：attendance 同时填 `participation_id` 与 `signup_id`（满足当前 Worker 按 `participation_id` 判定 eligibility）；无 blocking anomaly。

## 7. Step 6 — TEST auth header 构造（安全）

- 基于 2.0 当前 auth 机制，构造 TEST admin 的鉴权上下文：
  - `sessions` 行（id=991010）：token 由本机 CSPRNG 生成（`s_` + base64url(32B)），仅存 `SHA-256(token)`；明文 token 仅落 `/tmp/55-t2-token.txt`（**不提交**）。
  - `user_roles` 行：user 991002 → `team_admin`，`scope_team_id=991001`（与 `X-Team-Id` 一致）。
- 请求头（文档仅记录掩码）：
  - `Authorization: Bearer s_****FDTk`
  - `X-Team-Id: 991001`
- 不输出完整 token；若 token 不能安全生成则 STOP —— 本轮成功生成并核验 `resolve()` 命中（preview/issue 均 200）。

## 8. Step 7 — HTTP preview（PASS）

```
POST /api/v2/activities/VXT16HD0SJEJ2B9K58P3EVAWYT/certificates/preview
Headers: Authorization: Bearer s_****FDTk · X-Team-Id: 991001 · Content-Type: application/json
Body:    {"templateId":991009,"recipientUserIds":[991003]}
→ HTTP/2 200
→ {"success":true,"data":{"activityId":"VXT16HD0SJEJ2B9K58P3EVAWYT","templateId":991009,
   "results":[{"userId":991003,"eligible":true,"alreadyIssued":false}]}}
```
**PREVIEW_HTTP_RESULT = ELIGIBLE_TRUE**（真实 HTTP 路由经 D1 Session 鉴权 + team_admin 授权 + 实时资格判定）。

## 9. Step 8 — HTTP single issue（PASS，ISSUE_PATH=HTTP_ROUTE）

```
POST /api/v2/activities/VXT16HD0SJEJ2B9K58P3EVAWYT/participants/8D1ZKXZEEN4VNMPZ2B7XEV68N2/certificate/issue
Headers: Authorization: Bearer s_****FDTk · X-Team-Id: 991001 · Content-Type: application/json
Body:    {"templateId":991009}
→ HTTP/2 200
→ {"success":true,"data":{"activityId":"VXT16HD0SJEJ2B9K58P3EVAWYT","participantId":"8D1ZKXZEEN4VNMPZ2B7XEV68N2",
   "userId":991003,"outcome":"ISSUED","certificatePublicId":"01M43GMNP3Z9K0D31MK741AVQX",
   "certificateNo":"JHCR****BW7N (masked)"}}
```
- **ISSUE_HTTP_RESULT = ISSUED**；**ISSUE_PATH = HTTP_ROUTE**（真实 HTTP 路由，非 D1_FALLBACK）。
- 仅 1 张 TEST 证书；TEST activity / participant / recipient；非真实业务证书；非批量。
- 证书号（真实值仅存 `/tmp`，不入本仓库）：掩码 `JHCR****BW7N`，由真实 HTTP route 经 `CertificateIssuanceService.issue` 原子消费 `cert_srv` 号池 + 写 certificates + certificate_logs。

## 10. Step 9 — After snapshot + TEST 证书核验

| 指标 | Before | After | 预期 | 结果 |
|---|---|---|---|---|
| certificates_count | 414 | **415** | +1 | ✅ |
| id_pools_total | 450,500 | 450,500 | 不变 | ✅ |
| cert_srv_available_legacy | 149,691 | **149,690** | −1 | ✅ |
| certificate_logs_count | 2 | **3** | +1 | ✅ |
| sessions_count | 0 | 1 | +1（TEST session） | ✅ |

新增 T2 TEST 证书明细（D1 只读核验）：
- id=**990010**，public_id=`01M43GMNP3Z9K0D31MK741AVQX`，user_id=**991003**（TEST 接收者），team_id=991001，template_id=991009，source_type=**activity** / issue_source=**activity** / source_id=**991004**，cert_kind=participant，issued_by=991002，status=**1**。
- 消耗 `cert_srv` 号池：id=25776，provenance=`legacy_migrated`，status=**1**（已分配），assigned_to=991003（掩码码 `JHCR****BW7N`）。

## 11. Step 10 — mine / detail 验证（HTTP PASS）

- `GET /api/v2/certificates/01M43GMNP3Z9K0D31MK741AVQX`（team admin + X-Team-Id: 991001）→ **HTTP/2 200**。
- 返回安全字段：`cert_type=activity`、`holder_name=null`、`issuer_name=null`、**无 PII**；`status=1`、`source_type=activity`、`activity_public_id=VXT16HD0SJEJ2B9K58P3EVAWYT`。
- **MINE_OR_DETAIL_VERIFICATION = HTTP_DETAIL_PASS**（真实 HTTP route 验证通过，且响应不泄露 PII）。

## 12. Step 11 — 清理 / 作废

- 无 HTTP revoke 路由 → 走安全 D1 revoke（镜像 route 的 certificate_logs 契约）：
  - `certificates.status = 2`，`revoked_at=now`，`revoked_by=991002`，`revoke_reason='T2_TEST_CLEANUP'`（按 public_id 定位，仅作用于该 TEST 证书）。
  - `certificate_logs` INSERT：`action='revoke'`、`result='success'`。
  - `sessions` id=991010 置 `status=2`（TEST auth 上下文失效）。
- 不回收 `cert_srv` 编号（系统无安全回退接口）；**TEST 证书以已撤销态留存**。
- TEST team / user / activity / participation / attendance / template 作为明确标记的 TEST artifact 保留（外键约束 + 显式 TEST 标记，删除反而触发 RESTRICT）；后续可经独立清理工具批量定位（见 NEXT_ACTION）。

## 13. Step 12 — Final snapshot（确认）

| 校验项 | 结果 |
|---|---|
| T2 TEST certificate status=2 revoked | ✅（revoke_reason=`T2_TEST_CLEANUP`，revoked_by=991002） |
| revoke 审计行存在 | ✅（certificate_logs `action='revoke'` = 1 行） |
| TEST session 失效 | ✅（status=2） |
| 号池编号未回收 | ✅（consumed pool status=1，保留） |
| 1.0 untouched | ✅（构造上仅操作 `jhzy-v2-prod`，未触及任何 1.0 路径） |
| 无真实业务证书 | ✅（仅 TEST recipient 991003，哨兵空间） |
| 无批量发证 | ✅（仅 1 张） |
| HTTP route 确实被调用 | ✅（preview/issue/detail 均真实 200） |
| certificates_count | 415（revoked 证书仍计数，不变） |
| cert_srv_available_legacy | 149,690（号池未回收，不变） |

## 14. 最终状态汇总

```
POST_R5_T2_STATUS = COMPLETED_CLOSED_LOOP_HTTP_ROUTE
ONE_DOT_ZERO_TOUCHED = NO
TWO_DOT_ZERO_TEST_DATA_CREATED = YES (10 行 TEST 实体 + 1 TEST session + 1 TEST role binding)
TEST_AUTH_CREATED = YES (sessions id=991010 + user_roles team_admin@991001; masked token s_****FDTk)
PREVIEW_HTTP_RESULT = ELIGIBLE_TRUE
ISSUE_HTTP_RESULT = ISSUED
ISSUE_PATH = HTTP_ROUTE
CERTIFICATE_CREATED = YES (id=990010, 已撤销)
CERTIFICATE_PUBLIC_ID = 01M43GMNP3Z9K0D31MK741AVQX
CERTIFICATE_NUMBER_MASKED = JHCR****BW7N
ID_POOL_CONSUMED = YES (pool id=25776, pool_type=cert_srv, status=1 已分配, 未回收)
BEFORE_CERTIFICATES_COUNT = 414
AFTER_CERTIFICATES_COUNT = 415
BEFORE_CERT_SRV_AVAILABLE = 149691
AFTER_CERT_SRV_AVAILABLE = 149690
MINE_OR_DETAIL_VERIFICATION = HTTP_DETAIL_PASS (GET /certificates/:public_id 200, 无 PII)
CLEANUP_STATUS = REVOKED_VIA_D1 (cert status=2, reason T2_TEST_CLEANUP; session invalidated)
FINAL_CERTIFICATE_STATUS = 2 (REVOKED, retained)
PRODUCTION_D1_MUTATED = YES_TEST_ONLY
REAL_BUSINESS_CERTIFICATE_ISSUED = NO
GIT_PUSH_PERFORMED = NO
DOC_COMMIT_SHA = 8ce9c43836989a465846a578d3441d580cad36fd
SECRET_PII_SCAN = PASS (无 full token/手机号/OpenID/身份证/真实姓名/raw cert_no/raw pool code)
NEXT_ACTION = 建独立 TEST 清理工具（按 T2_TEST_DO_NOT_USE_REAL 标记 + 哨兵 id 991001..991020 批量定位、撤销/归档）；并评估是否新增 cert_srv 号池安全回退接口以便回收本次消耗的 1 个 legacy 编号
```

## 15. 下一步建议（NEXT_ACTION 详述）

1. **HTTP route 覆盖缺口已闭合**：本轮在获得安全 TEST admin token 后，真实 `POST /api/v2/activities/:activityId/participants/:participantId/certificate/issue` 与 preview/detail 均经生产 Worker 执行成功，T1 遗留的 `D1_FALLBACK` 缺口已补上。
2. **TEST 清理工具**：建议新增独立脚本，按 `T2_TEST_DO_NOT_USE_REAL` 标记 + 哨兵 id 空间 991001–991020 批量定位 TEST 实体/证书并安全撤销或归档（当前 TEST team/user/activity 等作为标记 artifact 保留）。
3. **号池消耗说明**：本轮消耗 1 个 legacy `cert_srv` 编号（已分配、未回收），属测试成本；若需回收，需先确认/新增系统安全的号池回退接口（当前未提供）。
