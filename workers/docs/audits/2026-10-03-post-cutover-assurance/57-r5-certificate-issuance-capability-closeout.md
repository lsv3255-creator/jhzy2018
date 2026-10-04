# POST-R5 · R5 证书发放能力阶段总收口（Capability Closeout）

> 关联阶段：`47` deploy · `48` workers.dev smoke(BLOCKED) · `49` route 可行性(FEASIBLE) ·
> `50` 自有域名 runtime smoke(PASS) · `51` 首证授权门(GATED/NONE) · `52` 资格联动修复设计 ·
> `54` T1 D1_FALLBACK 发证闭环 · `55` T2 HTTP_ROUTE 发证闭环 · `56` TEST artifact 清理/留存策略
> 日期：2026-10-04
> 纪律：**不写 production D1 / 不发证 / 不调 issue route / 不部署 Worker / 不改 secrets / 不 push / 不碰 JHZY 1.0**

---

## 0. Executive Summary（执行摘要）

R5 阶段目标——**验证嘉禾志愿 2.0 证书发放能力**——已达成。核心结论：

- **2.0 production Worker 已上线并存活**（version `3cb9d6f5…` @ 100%，回滚版本 `bfff110b…` 保留）。
- **2.0 production D1 绑定正确**，`migrationsApplied=46`，无迁移漂移。
- **`cert_srv` 号池可分配可用**：通过真实代码路径（T1 的 D1 复刻 + T2 的真实 HTTP 路由）成功消费 2 个 legacy 编号。
- **完整发放链路已被真实验证**：D1 fallback 路径（T1）+ 真实 HTTP preview / single-issue / detail 路径（T2）均 PASS。
- **证书撤销/清理路径已验证**（T1/T2 经安全 D1 revoke，T3 完成留存策略定义）。
- **1.0 全程零接触**。
- **本地文档提交均未 push**。

**能力判定**：

```
R5_CAPABILITY_STATUS = VERIFIED
```

**遗留缺口**（不影响「能力已验证」结论，但阻塞「真实业务切换」）：
1. `attendance_sessions.participation_id` 100% NULL（仅 `signup_id` 填充）与部署的 `ActivityEligibilityPolicy` 联结方式不匹配 → 真实候选 0（doc 51/52）。该缺口修复（P9B）**尚未执行**（doc 53 不存在）。
2. TEST 清理工具目前为 dry-run / policy（doc 56），不是完整自动清理工具。
3. 已消耗 2 个 TEST `cert_srv` 编号不回收（系统无正式安全回收接口）。
4. 本地提交未 push。
5. 真实业务切换前仍需独立上线评审（P10 及后续）。

---

## 1. 1.0 / 2.0 口径（铁律）

| 维度 | 嘉禾志愿 1.0 | 嘉禾志愿 2.0 |
|---|---|---|
| 性质 | 真实业务生产系统（冻结，绝对禁止触碰） | 独立新系统 / 测试验收系统 |
| 真实业务发证 | 仍在 1.0 | 不在 2.0（2.0 仅跑 TEST 发证） |
| 本阶段对 2.0 的授权 | — | 验证证书发放能力；允许标记 TEST 数据/发证/撤销；允许写审计文档与脱敏脚本 |
| 红线 | 不连 `/www/wwwroot/api.jhzyfw.com/`、任何 1.0 库/接口/文件 | 不写 production D1（本轮 closeout）、不发证、不调 issue route、不部署 Worker、不回收 cert_srv、不硬删 certificates |

- **ONE_DOT_ZERO_TOUCHED = NO**：本轮（及 R5 全部子任务）所有命令仅指向 `jhzy-v2-prod`（账号 `8770e4917f904aed5df91c883cf058af` / profile `jhzy`）。从未连接 `api.jhzyfw.com` 或任何 1.0 主机 / 数据库 / 接口 / 文件。
- doc 49 已用 inventory 证明：`jhzyfw.com` **不在本 Cloudflare 账户**（在另一账户），本账户 4 个 zone 均非 1.0 hostname → 1.0 碰撞风险 0。

---

## 2. Deploy Status（部署状态）

来源：`47-production-deploy-execution-record.md`（P8C）。

| 项 | 值 | 判定 |
|---|---|---|
| Production Worker 部署 | SUCCESS（version `3cb9d6f5-11a8-4588-930d-e58dfd1b7ea7` @ 100%） | ✅ |
| 回滚版本 | `bfff110b-4787-40cb-b982-6c692e699429`（保留） | ✅ 可回滚 |
| 生产 D1 绑定 | `jhzy-v2-prod / d372229f-c0ae-4dcc-b968-4ec7c2832842` | ✅ 精确匹配 |
| Secrets | 3/3 原样保留（DELIVERY_IDENTITY_ENC_KEY / IDENTITY_HMAC_KEY / WECHAT_APP_SECRET） | ✅ |
| 部署产物纯净 | clean worktree @ `a6e259d`（SHA 精确匹配，部署后仍 0 改动） | ✅ |
| 主工作树 | 583 项 dirty 未参与打包（未 clean/stash/reset） | ✅ 隔离 |
| 部署期间 production D1 写入 | 0（10/10 表 delta=0，certificates 413→413） | ✅ ZERO_WRITE |
| 运行时 smoke（部署时） | BLOCKED（workers.dev 域级封锁，非部署失败） | ⚠ 环境限制 |

---

## 3. Runtime Status（运行时状态）

| 通道 | 结论 | 来源 |
|---|---|---|
| workers.dev 公网 smoke | BLOCKED（workers.dev 整域被本机网络策略封锁；P8F 经对照实验锁定根因） | `48` |
| 自有域名 route 可行性 | FEASIBLE；候选 `v2-smoke.signivra.com`（用户在 signivra.com zone 手工创建 DNS + route） | `49` / `50` |
| 自有域名 runtime smoke（`/health`） | **PASS**：HTTP/2 200，`status=ok`，`environment=production`，`d1Binding=present`，`migrationsApplied=46` | `50` |
| `/api/v2/certificates/mine` | SKIPPED_NO_SAFE_AUTH（生产 `sessions=0`，无安全凭证，禁止登录取 token） | `48` / `50` |

> 意义：通过自有域名 route，workers.dev 封锁被绕过，production Worker 真实边缘响应首次取得（`migrationsApplied=46` 证明部署产物与 DB schema 版本对齐，且无任何 migration 在部署后被执行）。

---

## 4. T1 / T2 / T3 结果

| 子任务 | 状态 | 关键结论 | 文档 |
|---|---|---|---|
| T1 | `COMPLETED_CLOSED_LOOP` | D1_FALLBACK 发证闭环；preview 等价逻辑 PASS；1 张 TEST 证书已撤销 | `54` |
| T2 | `COMPLETED_CLOSED_LOOP_HTTP_ROUTE` | 真实 HTTP preview/single-issue/detail 全 PASS；ISSUE_PATH=HTTP_ROUTE；1 张 TEST 证书已撤销 | `55` |
| T3 | `COMPLETED_POLICY_DEFINED_NO_WRITE_REQUIRED` | 只读盘点 + 留存策略；两 TEST 证书已 revoked、TEST 会话已失效、号池保留、无写入需要 | `56` |

### 4.1 测试证书摘要（仅 masked）

| 项 | T1 | T2 |
|---|---|---|
| CERTIFICATE_PUBLIC_ID | `CYDSBABK8ABXXEYAAR4A7EQWWP` | `01M43GMNP3Z9K0D31MK741AVQX` |
| CERTIFICATE_NUMBER_MASKED | `JHCR****FT3J` | `JHCR****BW7N` |
| cert id | 990009 | 990010 |
| consumed pool id | 25775 | 25776 |
| ISSUE_PATH | D1_FALLBACK | HTTP_ROUTE |
| status | 2 (REVOKED) | 2 (REVOKED) |
| revoke_reason | T1_TEST_CLEANUP | T2_TEST_CLEANUP |
| DOC_COMMIT_SHA | `be154281f783ef00c63e52a39798076e7fd705eb` | `8ce9c43836989a465846a578d3441d580cad36fd` |

> 两证均无 PII（holder_name / issuer_name = null），均以 revoked 态留存为审计 artifact。

### 4.2 D1 Mutation Summary（T1/T2 累计，相对 R5 部署基线）

| 指标 | 部署基线（47/50） | T1 后 | T2 后 | 当前 | 说明 |
|---|---:|---:|---:|---:|---|
| certificates_count | 413 | 414 | 415 | 415 | +2 为已撤销 TEST 证书（行保留） |
| id_pools_total | 450,500 | 450,500 | 450,500 | 450,500 | 不变 |
| cert_srv_available_legacy | 149,692 | 149,691 | 149,690 | 149,690 | −2（2 个 TEST 编号已分配，未回收） |
| certificate_logs_count | 0 | 1 | 3 | 3 | 各含 issue + revoke |
| sessions_count | 0 | 0 | 1 | 0 | T2 TEST session 已失效 |
| d1_migrations | 46 | 46 | 46 | 46 | 无 migration 执行 |

> **本轮 closeout（doc 57）未对 production D1 做任何写入**——上表为 R5 历史累计快照，仅作收口呈现。

### 4.3 Issue Path Coverage（发证路径覆盖）

| 路径 | 验证方式 | 结果 |
|---|---|---|
| 资格预览（等价逻辑 / D1 只读） | T1 `ActivityEligibilityPolicy` 镜像查询 | ELIGIBLE_TRUE |
| 资格预览（真实 HTTP route） | T2 `POST /certificates/preview` | ELIGIBLE_TRUE |
| 单人发证（D1 复刻写路径） | T1 `issueBatch` 原子 batch | ISSUED (D1_FALLBACK) |
| 单人发证（真实 HTTP route） | T2 `POST /certificate/issue` | ISSUED (HTTP_ROUTE) |
| 证书详情（真实 HTTP route） | T2 `GET /certificates/:public_id` | 200，无 PII |
| 证书撤销（安全 D1 revoke） | T1/T2/T3 | status=2 + certificate_logs action=revoke |

> 覆盖缺口说明：T1 因无安全 admin token 未走真实 HTTP route（仅 D1 复刻 + 本地 P_R5 40/40 代码路径验证），该缺口已由 T2 以真实 HTTP route 闭环补齐。

---

## 5. Artifact Retention Policy（artifact 留存策略）

来源：`56`（Step 7 正式策略）：

1. **TEST certificate**：发出后必须 revoke（`status=2` + `revoke_reason='T<x>_TEST_CLEANUP'` + `certificate_logs action='revoke'`）；**不删除**证书行；**不回收**证书编号；保留完整 `certificate_logs`。
2. **TEST session**：测试结束必须失效（`status=2`）；明文 token 仅落本地 `/tmp`，不提交仓库。
3. **TEST activity/team/user/signup/participation/attendance/template**：默认**保留**为 TEST artifact（外键 RESTRICT）；须有统一 marker（`T*_TEST_DO_NOT_USE_REAL`）+ 哨兵 id 空间（990001–990009 / 991001–991020）；彻底清理须单独设计 FK 逆序脚本。
4. **TEST id_pool**：已消耗编号**不回收**；保留 `status=1`（allocated）作审计轨迹；仅在系统提供正式安全回收接口后评估回收。
5. **TEST 文档/脚本**：必须记录 public_id、masked cert number、operator id、before/after snapshot；严禁写入 token/手机号/OpenID/身份证/真实姓名/raw cert_no/raw pool code。
6. **HTTP route 测试**：仅在必要版本回归时执行真实 HTTP issue；不再反复消耗证书号；无 HTTP revoke 路由 → 清理统一走安全 D1 revoke。

可重复清理工具：`scripts/56-test-artifact-cleanup-policy.sql`（PART A 只读/dry-run；PART B 写入段默认注释禁用，带硬边界守卫）。

---

## 6. Remaining Risks（遗留风险）

1. **【阻塞真实业务发证】资格联动缺口未修复**：部署的 `ActivityEligibilityPolicy` 以 `attendance_sessions.participation_id = activity_participations.id` 联结，而生产 `attendance_sessions.participation_id` 240/240 全 NULL（仅 `signup_id` 填充）→ 真实候选 = 0（doc 51 §5.2 / doc 52 §3）。修复路线（doc 52 推荐方案 A：代码改 join `signup_id`，零 D1 写入）**尚未实现（doc 53 不存在，P9B 未执行）**。
2. **TEST 清理工具不完整**：当前为 dry-run/policy（doc 56），非完整自动清理工具；彻底移除 TEST 团队/用户/活动需另设计 FK 逆序脚本。
3. **已消耗 TEST cert_srv 编号不回收**：2 个 legacy 编号已分配、未回收（系统无正式安全回收接口）。
4. **本地提交未 push**：R5 全部文档提交（47–57）均停留本地，未纳入远端基线。
5. **真实业务切换需独立评审**：P10 首条真实合规发证尚需独立授权 + before/after snapshot；SERVICE 路径 `service_records=0` 仍不可用。
6. **workers.dev 封锁未解除**：依赖 `v2-smoke.signivra.com` 作为公网只读 smoke 入口（doc 50 建议保留）。

---

## 7. Recommended Next Phase（建议下一阶段）

| 优先级 | 阶段 | 内容 |
|---|---|---|
| 1 | **P9B**（待授权） | clean worktree 实现方案 A 最小修复：`ActivityEligibilityPolicy.check` 两处联结改 `att.signup_id = s.id` + 新增「生产形状」回归 fixture（`participation_id NULL`、`signup_id` 填充） |
| 2 | P9C / P9D（待授权） | clean worktree 部署 + 生产 health smoke + D1 零变更复核（不发证） |
| 3 | P9E（待授权） | 重跑 P9 候选门，预期 ACTIVITY 候选 = 235，READY = YES |
| 4 | P10（待授权） | 首条真实合规发证（单一已核验候选、一次单人 issue、before/after snapshot、证书详情可见性核查） |
| 5 | TEST 清理工具（可选） | 设计 FK 逆序清理脚本；评估 cert_srv 号池正式安全回收机制 |
| 6 | 收口提交 | 视需要 push R5 文档提交（当前策略：不 push，待管理员授权） |

---

## 8. 纪律遵守确认（本轮 closeout）

| 禁令 | 结果 |
|---|---|
| 不写 production D1 | ✅ 本轮零 D1 写入（仅文档落盘） |
| 不发证 | ✅ 未创建任何证书 |
| 不调 issue route | ✅ 0 次 issue/preview/detail 调用 |
| 不部署 Worker | ✅ 未部署 |
| 不改 secrets | ✅ 未改 |
| 不 push | ✅ 未 push |
| 不触碰 JHZY 1.0 live | ✅ 未访问 MySQL / 生产服务器 / `api.jhzyfw.com` |

---

## 9. 最终状态汇总（Final Return）

```
POST_R5_CLOSEOUT_STATUS        = COMPLETED_CAPABILITY_VERIFIED
R5_CAPABILITY_STATUS           = VERIFIED
DOC_COMMIT_SHA                 = <见 git 提交后回填>
SECRET_PII_SCAN                = PASS (见 §10)
NEW_CERTIFICATE_ISSUED         = NO
ISSUE_ROUTE_CALLED             = NO
PRODUCTION_D1_MUTATED          = NO
ONE_DOT_ZERO_TOUCHED           = NO
GIT_PUSH_PERFORMED             = NO

# 关联子任务状态
T1_STATUS                      = COMPLETED_CLOSED_LOOP (D1_FALLBACK)
T2_STATUS                      = COMPLETED_CLOSED_LOOP_HTTP_ROUTE
T3_STATUS                      = COMPLETED_POLICY_DEFINED_NO_WRITE_REQUIRED
P9B_SIGNUP_LINKAGE_FIX         = NOT_DONE / SEPARATE TRACK (doc 53 不存在)

# 测试证书（仅 masked）
T1_CERT_PUBLIC_ID              = CYDSBABK8ABXXEYAAR4A7EQWWP
T1_CERT_NUMBER_MASKED          = JHCR****FT3J
T1_CERT_STATUS                 = 2 (REVOKED, retained)
T2_CERT_PUBLIC_ID              = 01M43GMNP3Z9K0D31MK741AVQX
T2_CERT_NUMBER_MASKED          = JHCR****BW7N
T2_CERT_STATUS                 = 2 (REVOKED, retained)

# D1 累计（相对部署基线）
CERTIFICATES_COUNT             = 415 (含 2 张已撤销 TEST)
CERT_SRV_AVAILABLE_LEGACY      = 149690 (2 个 TEST 编号已分配未回收)
D1_MIGRATIONS                  = 46

NEXT_ACTION                    = 见 §7：P9B 资格联动修复 → P9C/D → P9E → P10；可选 TEST 清理工具与号池回收评估
```

---

## 10. Secret / PII 扫描（Step 5）

- 本文档**不含**：token / 手机号（`1[3-9][0-9]{9}`） / OpenID / 身份证（`[0-9]{17}[0-9Xx]`） / 真实姓名 / session token / raw cert_no / raw pool code（即未脱敏的完整 `JHCRT-…` 号池码）。
- 允许项均已使用：`TEST public_id`、`TEST internal id`（哨兵空间）、`masked certificate number`（`JHCR****FT3J` / `JHCR****BW7N`）、聚合计数。
- raw 号池码（即 `JHCR****FT3J` / `JHCR****BW7N` 对应的未脱敏完整码）仅曾出现于只读终端输出，**未落盘、未写入本仓库**。

```
SECRET_PII_SCAN = PASS
```

---

## 11. 提交物（Step 6）

- `workers/docs/audits/2026-10-03-post-cutover-assurance/57-r5-certificate-issuance-capability-closeout.md`（本文件）
- 仅 stage 本文件；**不 stage 业务代码、不 stage secrets、不 stage production dump**；**不 push**。

---

*本收口文档全部结论均基于 `47`–`56` 真实命令输出与 Cloudflare API 返回值撰写；未取得任何 Worker 响应体的地方均如实标注为「不可达」而非「通过」或「失败」。*
