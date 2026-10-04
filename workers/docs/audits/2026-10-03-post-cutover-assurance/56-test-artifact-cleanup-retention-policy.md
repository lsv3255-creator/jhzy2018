# POST-R5-T3 — TEST Artifact 清理 / 留存策略（2.0 Production D1，TEST ONLY）

> 关联：
> - T1 = `54-t1-test-certificate-issuance-closed-loop.md`（D1_FALLBACK 发证闭环）
> - T2 = `55-t2-http-route-test-issuance-closed-loop.md`（HTTP_ROUTE 发证闭环）
> 本文件：治理 T1/T2 遗留的 TEST artifact，形成 **清理 / 留存 / 作废** 策略。不发新证、不调 issue route、不触碰 1.0、不 push。

---

## 0. 项目口径（铁律）

| 维度 | 嘉禾志愿 1.0 | 嘉禾志愿 2.0 |
|---|---|---|
| 性质 | 真实业务生产系统（冻结，绝对禁止触碰） | 独立新系统 / 测试验收系统 |
| 本任务授权 | — | 只读盘点 2.0 production D1；如发现 TEST 证书未撤销 / TEST 会话未失效，允许**最小安全写入**（revoke / session 失效）；允许写 TEST cleanup 审计文档与脱敏脚本 |
| 红线 | 不连 `/www/wwwroot/api.jhzyfw.com/`、任何 1.0 库 / 接口 / 文件 | 不回收 cert_srv 编号（除非系统已有正式安全回收机制）；不硬删 certificates；不删真实业务数据 |

- **ONE_DOT_ZERO_TOUCHED = NO**：全部命令仅指向 `jhzy-v2-prod`（账号 `8770e4917f904aed5df91c883cf058af` / profile `jhzy`）。从未连接任何 1.0 主机 / 数据库 / 接口 / 文件。
- 统一 TEST 标记：`T1_TEST_DO_NOT_USE_REAL`、`T2_TEST_DO_NOT_USE_REAL`。

---

## 1. 任务目标与硬边界

**目标**：只读盘点 T1/T2 TEST artifact；判断可清理 / 必须留存；不硬删 certificates；不回收 cert_srv；清理 TEST session 或确认已失效；保留 TEST 证书为 revoked audit artifact；形成可重复 TEST cleanup 工具方案。

**硬边界（已遵守）**：
- 绝对禁止触碰 1.0（库 / 接口 / 文件 / 证书系统）。
- 不新增发证、不调用 issue route、不创建新 TEST 证书。
- 不删除真实业务数据、不硬删 certificates、不回收 cert_srv 编号（除非系统已有正式机制）。
- 不部署 Worker、不改 secrets、不 push。

**允许**：只读查询 2.0 production D1；如发现 TEST 证书未 revoked 允许安全作废；如发现 TEST session 未失效允许标记失效；允许写 TEST cleanup 审计文档与脱敏脚本。

---

## 2. T1 / T2 背景

- **T1** = `POST-R5-T1 = COMPLETED_CLOSED_LOOP`，`ISSUE_PATH = D1_FALLBACK`（无安全 admin token，未覆盖真实 HTTP route）。创建 8 行 TEST 实体（哨兵 990001–990009）+ 1 张 TEST 证书（id=990009，已撤销）。消耗 cert_srv 号池 id=25775（掩码 `JHCR****FT3J`）。
- **T2** = `POST-R5-T2 = COMPLETED_CLOSED_LOOP_HTTP_ROUTE`，真实 HTTP route 闭环。创建 10 行 TEST 实体 + 1 TEST session + 1 TEST role binding（哨兵 991001–991020）+ 1 张 TEST 证书（id=990010，已撤销）。消耗 cert_srv 号池 id=25776（掩码 `JHCR****BW7N`）。

| 项 | T1 | T2 |
|---|---|---|
| CERTIFICATE_PUBLIC_ID | CYDSBABK8ABXXEYAAR4A7EQWWP | 01M43GMNP3Z9K0D31MK741AVQX |
| CERTIFICATE_NUMBER_MASKED | JHCR****FT3J | JHCR****BW7N |
| ISSUE_PATH | D1_FALLBACK | HTTP_ROUTE |
| cert id | 990009 | 990010 |
| consumed pool id | 25775 | 25776 |
| DOC_COMMIT_SHA | be154281f783ef00c63e52a39798076e7fd705eb | 8ce9c43836989a465846a578d3441d580cad36fd |

---

## 3. Step 1 — Repo gate

- `git rev-parse --show-toplevel` → `/Users/Shared/projects/jhzy-v2`
- `git rev-parse HEAD` → `0f1529a5d1443edd84462eeabba9f3d40e25ef48`（T2 backfill 提交）
- branch → `master`
- `git status --short` → 583 条既有条目（miniprogram/、docs/ 等业务文件），**均为既有、非本次产生**；本任务**未 clean / stash / reset 主工作树**，且仅 stage 本审计文档 + `scripts/56-*`。

---

## 4. Step 2 — Runtime health gate（PASS）

`curl -i https://v2-smoke.signivra.com/health`（HTTP/2 200）：

```json
{"status":"ok","worker":"jhzy-v2-worker","environment":"production","d1Binding":"present","schema":{"migrationsApplied":46},"time":1791122072}
```

| 检查项 | 期望 | 实际 | 结果 |
|---|---|---|---|
| HTTP 状态 | 200 | 200 | ✅ |
| status | ok | ok | ✅ |
| environment | production | production | ✅ |
| d1Binding | present | present | ✅ |
| migrationsApplied | 46 | 46 | ✅ |

Health gate **PASSED**（即便失败也不影响 cleanup policy 设计；此处通过）。

---

## 5. Step 3 — 读取 T1/T2 文档（提取）

- T1 doc：`54-t1-test-certificate-issuance-closed-loop.md`
- T2 doc：`55-t2-http-route-test-issuance-closed-loop.md`
- 提取 public_id / TEST marker / 哨兵 id 空间 / issue path / cleanup status / 消耗号池 / doc commit sha（见 §2 表 + §6、§7、§9）。

---

## 6. Step 4 — Artifact Inventory（2.0 production D1，只读）

### 6.1 Certificates（按 public_id）

| id | public_id | status | source_type | issue_source | source_id | user_id | revoke_reason |
|---|---|---|---|---|---|---|---|
| 990009 | CYDSBABK8ABXXEYAAR4A7EQWWP | **2 (REVOKED)** | activity | activity | 990003 | 990001 | T1_TEST_CLEANUP |
| 990010 | 01M43GMNP3Z9K0D31MK741AVQX | **2 (REVOKED)** | activity | activity | 991004 | 991003 | T2_TEST_CLEANUP |

### 6.2 Certificate logs

| action | certificate_id | operator_id | result | failure_code |
|---|---|---|---|---|
| issue | 990009 | 990001 | success | null |
| revoke | 990009 | 990001 | success | null |
| issue | 990010 | 991002 | success | null |
| revoke | 990010 | 991002 | success | null |

### 6.3 Activities（by marker）

| 指标 | 值 |
|---|---|
| t1_test_activity_count（title LIKE %T1_TEST_DO_NOT_USE_REAL%） | 1 |
| t2_test_activity_count（title LIKE %T2_TEST_DO_NOT_USE_REAL%） | 1 |

### 6.4 Sessions（by 哨兵 user id：990001 / 991002 / 991003）

| 指标 | 值 |
|---|---|
| t1_t2_test_sessions_active（status=1） | **0** |
| t1_t2_test_sessions_total | 1（T2 session id=991010，user=991002，已 status=2） |

### 6.5 交叉核验（id_pool / 哨兵源 / 全局活跃会话 / 用户 / 团队）

| 指标 | 值 |
|---|---|
| id_pools 25775 / 25776 status | 均为 **1（已分配，保留未回收）** |
| cert_by_sentinel_source（source_id IN 990003/991004） | **2**（恰好 2 张 TEST 证书，无残留/无多余） |
| any_active_test_session_global（status=1） | **0** |
| test_users_total（990001/991002/991003） | 3 |
| test_teams_total（990002 T1 / 991001 T2） | 2 |

> 注：`id_pools.code` 为 raw 号池码（如 `JHCRT-SRV-*-VFT3J` / `JHCRT-SRV-*-8BW7N`），**按 Secret/PII 策略不落盘、不写入本仓库**；仅以掩码 `JHCR****FT3J` / `JHCR****BW7N` 与池 id 25775 / 25776 指代。

---

## 7. Step 5 — Certificate / Session / id_pool 状态判定

- **TEST certificates（A 类）**：两证均已 `status=2` 且 `revoke_reason` 含 `T1_TEST_CLEANUP` / `T2_TEST_CLEANUP` → **无需再写 certificates**。
- **TEST sessions（B 类）**：唯一 TEST 会话（id=991010，user=991002）已 `status=2` → **无需再写 sessions**。
- **TEST team/user/activity/signup/attendance/template（C 类）**：默认不硬删，标记为 TEST artifact 留存（外键 RESTRICT；删除反而破坏审计闭环；后续如需清理须单独设计 FK 逆序脚本）。
- **id_pools（D 类）**：**不回收**；保留 `status=1`（已分配）。证书号一旦分配，即便 TEST 后撤销亦保留审计轨迹，除非系统提供正式安全回收机制。

---

## 8. Step 6 — Cleanup 写入判定

- 发现需清理项：**无**。
  - 两 TEST 证书均已 revoked（status=2）。
  - 唯一 TEST 会话已失效（status=2）。
- 因无任何写入，无需执行 after snapshot（状态相对 before 无变化）。

> 若未来某轮发现 TEST 证书仍 `status=1` 或 TEST 会话仍 `status=1`，按 `scripts/56-test-artifact-cleanup-policy.sql` PART B（启用前满足全部前置条件）执行**最小安全写入**：revoke（仅当 status=1）+ 追加 `certificate_logs action='revoke'` + session 置 status=2。仍禁止回收 id_pools、禁止硬删 certificates、禁止触碰 1.0。

---

## 9. Step 7 — Cleanup / Retention Policy（正式策略）

1. **TEST certificate**：
   - 发出后必须 revoke（`status=2` + `revoke_reason='T<x>_TEST_CLEANUP'` + `certificate_logs action='revoke'`）。
   - **不删除**证书行（保留为审计 artifact）。
   - **不回收**证书编号（id_pools 保留 `status=1`）。
   - 保留完整 `certificate_logs`（issue + revoke）。
2. **TEST session**：
   - 测试结束必须失效（`status=2`）。
   - 明文 token 仅落本地 `/tmp`，不提交仓库。
3. **TEST activity / team / user / signup / participation / attendance / template**：
   - 默认**保留**为 TEST artifact（外键链路复杂，硬删易破坏审计闭环）。
   - 必须有统一 marker（`T*_TEST_DO_NOT_USE_REAL`）+ 哨兵 id 空间隔离（990001–990009 / 991001–991020）。
   - 后续如要清理，必须单独设计按 FK 逆序（child→parent）的清理脚本。
4. **TEST id_pool**：
   - 已消耗编号**不回收**；保留 `status=1`（allocated），作为审计轨迹。
   - 仅在系统提供正式、安全的号池回退接口后，方可评估回收。
5. **TEST 文档 / 脚本**：
   - 必须记录 public_id、masked cert number、operator id、before/after snapshot。
   - 严禁写入 token / 手机号 / OpenID / 身份证 / 真实姓名 / raw cert_no / raw pool code。
6. **HTTP route 测试**：
   - 仅在必要版本回归时执行真实 HTTP issue；不再反复消耗证书号。
   - 无 HTTP revoke 路由 → 清理统一走安全 D1 revoke。

---

## 10. Step 8 — 可重复 Cleanup 工具设计

- 脚本：`scripts/56-test-artifact-cleanup-policy.sql`
- 默认 **只读 / dry-run**（PART A 全 SELECT）：按 public_id、marker（title LIKE）、哨兵 user id 定位 T1/T2 artifact，并列出已消耗 id_pools（不含 raw code）。
- 写入段（PART B）**默认注释禁用**，启用前置条件与守卫：
  - 仅处理带 `T*_TEST_DO_NOT_USE_REAL` 标记 / 显式 public_id / 哨兵 id 的数据。
  - revoke 仅当 `status=1`（幂等守卫）；session 失效仅当 `status=1`。
  - 显式禁止：`DELETE FROM certificates`、`UPDATE id_pools SET status=0`（回收）、`DELETE teams/users/activities`。
  - 绝不触碰 1.0。
- 该工具可重复运行：先 PART A 盘点，确认需清理项后再按授权启用 PART B。

---

## 11. 边界遵守确认

- **ISSUE_ROUTE_CALLED = NO**：未调用任何 issue / preview / detail HTTP route（仅 T1/T2 历史记录引用）。
- **NEW_CERTIFICATE_ISSUED = NO**：未创建任何新 TEST 证书。
- **ONE_DOT_ZERO_TOUCHED = NO**：全程零 1.0 接触（构造上仅操作 `jhzy-v2-prod`）。
- **GIT_PUSH_PERFORMED = NO**：仅本地 commit，不 push。
- 不部署 Worker、不改 secrets、不回收 id_pools、不硬删 certificates、不删真实业务数据。

---

## 12. 最终状态汇总

```
POST_R5_T3_STATUS = COMPLETED_POLICY_DEFINED_NO_WRITE_REQUIRED
ONE_DOT_ZERO_TOUCHED = NO
NEW_CERTIFICATE_ISSUED = NO
ISSUE_ROUTE_CALLED = NO
T1_CERT_STATUS = 2 (REVOKED, reason=T1_TEST_CLEANUP, retained)
T2_CERT_STATUS = 2 (REVOKED, reason=T2_TEST_CLEANUP, retained)
TEST_SESSIONS_STATUS = INVALIDATED (T2 session id=991010 status=2; 0 active)
ID_POOL_RECOVERY = NO (pools 25775/25776 retained status=1)
CLEANUP_ACTION = NONE_REQUIRED (both certs already revoked; session already invalidated)
RETENTION_POLICY = DEFINED (see §9)
DOC_COMMIT_SHA = eb61901d931109fc6d056e205fee6890d78e5900
SECRET_PII_SCAN = PASS (no token/phone/OpenID/idcard/realname/session/raw cert_no/raw pool code)
GIT_PUSH_PERFORMED = NO
NEXT_ACTION = 如需彻底移除 TEST team/user/activity 等 artifact，单独设计 FK 逆序清理脚本；评估 cert_srv 号池正式安全回收机制；后续 HTTP route 回归测试仅在必要版本时执行
```

---

## 13. 下一步建议（NEXT_ACTION 详述）

1. **TEST artifact 当前状态已合规**：两 TEST 证书已 revoked 留存、TEST 会话已失效、号池已分配留存、TEST 团队/用户/活动作为标记 artifact 保留。本轮无需任何写入。
2. **可选彻底清理**：若未来需要移除 TEST team/user/activity/signup/participation/attendance/template，必须单独设计**按 FK 逆序（child→parent）**的清理脚本，并先在 staging / 只读核验后再对 production D1 执行；当前不强制。
3. **号池回收机制**：评估是否新增系统正式的 cert_srv 号池安全回退接口；当前未提供，故已消耗编号保留为审计轨迹。
4. **回归测试纪律**：后续仅在必要版本回归时执行真实 HTTP issue；不反复消耗证书号。
