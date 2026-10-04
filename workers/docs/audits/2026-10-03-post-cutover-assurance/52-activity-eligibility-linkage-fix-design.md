# 52 · Activity 资格策略联动修复设计（P9A）

> 关联任务：`POST-R5-P9A-ACTIVITY-ELIGIBILITY-LINKAGE-FIX-DESIGN`
> 前序：`47` deploy · `48` workers.dev smoke · `49` route 可行性 · `50` runtime smoke · `51` 首证授权门(GATED/NONE)
> 日期：2026-10-04
> 纪律：纯设计门 · **不改代码** / 不改 migration / 不改 wrangler / 不写 production D1 / 不部署 Worker / 不调 issue route / 不发证 / 不建测试数据 / 不 push / 不碰 JHZY 1.0

---

## 0. 验收摘要（Final Return 占位）

```
POST_R5_P9A_STATUS              = DONE / DESIGN_ONLY
RUNTIME_HEALTH                 = PASS（/health 200, migrationsApplied=46）
D1_DIAGNOSTIC                  = 见 §3（participation_id 100% NULL；signup_id 100% 填充）
CURRENT_POLICY_CANDIDATES      = 0
SIGNUP_ID_POLICY_CANDIDATES    = 235
RECOMMENDED_FIX                = A（代码改 policy join signup_id，不回填 D1）
READY_FOR_P9B_FIX_IMPLEMENTATION = YES
DOC_COMMIT_SHA                 = <pending commit>
SECRET_PII_SCAN                = CLEAN
CODE_CHANGED                   = NO
PRODUCTION_D1_MUTATED          = NO
CERTIFICATE_ISSUED             = NO
WORKER_DEPLOYED                = NO
GIT_PUSH_PERFORMED             = NO
JHZY_1_0_TOUCHED               = NO
NEXT_ACTION                    = P9B 在 clean worktree 实现方案 A 最小修复（仅改 ActivityEligibilityPolicy + 必要测试）
```

---

## 1. P9 背景（为什么需要本设计）

`POST-R5-P9` 首证授权门（doc 51）结论：**GATED / NO_ELIGIBLE_CANDIDATE**，核心发现：

- `service_records_count = 0` → SERVICE 路径无候选。
- 部署的 `ActivityEligibilityPolicy` 以 `attendance_sessions.participation_id = activity_participations.id` 联结判定「活跃参与 + 已签退」。
- 但生产 `attendance_sessions.participation_id` **240/240 全为 NULL**，`signup_id` 240/240 全填充。
- → 策略主查询联结永远为空 → 所有参与者被判 `ACTIVITY_NOT_ATTENDED` → NOT_ELIGIBLE → 合格候选 = 0。
- 诊断显示若改以 `signup_id` 联结，合格 (user,activity) 对 = 235。

这是一个**部署策略与生产关系型数据形状的联动缺口**，不在 P9 scope 内修复。本任务（P9A）仅设计修复方案，不产生任何改动。

---

## 2. Runtime Health Gate（PASS）

`curl -i https://v2-smoke.signivra.com/health`（2026-10-04 本轮执行）：

```
HTTP/2 200
{"status":"ok","worker":"jhzy-v2-worker","environment":"production","d1Binding":"present","schema":{"migrationsApplied":46},"time":1791113514}
```

| 字段 | 值 | 判定 |
|---|---|---|
| HTTP 状态码 | 200 | ✅ |
| status | ok | ✅ |
| environment | production | ✅ |
| d1Binding | present | ✅ |
| migrationsApplied | 46 | ✅ 与基线一致 |

门通过，进入源码审计与方案设计。

---

## 3. Production D1 只读诊断（NO MUTATION）

本轮在 `jhzy-v2-prod` 真实只读 SELECT（仅 SELECT，无任何写入）。

### 3.1 考勤联结形状

| 指标 | 值 | 说明 |
|---|---|---|
| `attendance_total` | 240 | 考勤会话总数 |
| `attendance_participation_id_null` | 240 | **100% NULL** |
| `attendance_participation_id_not_null` | 0 | 无一行填充 |
| `attendance_signup_id_null` | 0 | — |
| `attendance_signup_id_not_null` | 240 | **100% 填充** |
| `signed_out_by_signup` | 235 | status=2 且 signup_id 填充 |
| `signed_out_by_participation` | 0 | status=2 且 participation_id 填充（恒 0，因 participation_id 全 NULL） |
| `anomalies_total` | 0 | 无任何 anomaly 行 |
| `blocking_anomalies` | 0 | 无任何阻断（status IN (1,2)） |

### 3.2 候选对比（方案 A 现状 vs 方案 B 备选）

| 查询 | 值 | 说明 |
|---|---|---|
| A 部署策略（participation_id join）· 合格 (user,activity) 对 | **0** | 当前生产 0 候选 |
| A 部署策略 · 去重后候选数 | **0** | — |
| B signup_id join · 合格 (user,activity) 对 | **235** | 改联结即可解锁 |
| B signup_id join · 新命名空间已发 | 0 | 无历史冲突 |
| B signup_id join · 去重后候选 | **235** | 全部可用作 P10 候选 |

`attendance_anomalies = 0` 确认根因是**数据联动缺口而非业务异常**（无 blocking 需排除）。

```
D1_DIAGNOSTIC = CONFIRMED_LINKAGE_GAP（participation_id 全 NULL / signup_id 全填充）
```

---

## 4. 源码审计（实际文件 + 行号引用）

> 本任务全程只读；下列行号为当前生产部署对应源码（`HEAD = 0297550c`）。

### 4.1 当前资格策略（`services/certificate-eligibility-policies.ts`）

`ActivityEligibilityPolicy.check`（第 41–94 行）两条查询均以 `participation_id` 联结：

- ① 第 50–65 行：`JOIN attendance_sessions att ON att.participation_id = p.id WHERE ... p.status=1 AND att.status=2`
- ② 第 72–87 行（anomaly 检查）：`JOIN activity_participations p ON p.id = att.participation_id`

→ 因为生产 `att.participation_id` 全 NULL，① 永远 0 命中 → `ACTIVITY_NOT_ATTENDED`。

`ServiceEligibilityPolicy`（第 101–154 行）不受影响（它经 `service_records.session_id` 联结，与 `participation_id` 无关），SERVICE 路径当前仅因 `service_records=0` 无候选，与本次缺口无关。

### 4.2 单人发证路由（`routes/activities.ts:679-738`）

- 解析：`activityPublicId` → `resolveActivity`；`participantPublicId` → `findByPublicIdWithSignup`（见 4.4）→ `signup_user_id` 作 `recipientUserId`；`activity.id` 作 `sourceId`。
- 防 IDOR：第 701 行 `if (part.activity_id !== activity.id) throw notFound`。
- 自证守卫：第 704 行 `if (recipientUserId === auth.userId) throw forbidden('SELF_ISSUE_FORBIDDEN')`。
- 调用：`svc.issue({ recipientUserId, teamId, domainSource: CertificateSource.ACTIVITY, sourceId: activity.id, certKind: CertificateKind.PARTICIPANT, ... })`（第 717–725 行）。

### 4.3 发文仓库（`repository/certificate-issuance.ts`）

- 幂等：`findActiveByNamespace`（第 133–148 行）严格按四列键 `user_id/source_type/issue_source/source_id` 查 `certificates` 表 → **与 attendance 联结方式无关**，方案 A 不影响幂等。
- 号池 selector：`buildPoolConsumeStatement`（第 109–125 行）+ `allocatableProvenanceSql()`（provenance 白名单）→ **与 attendance 无关**，方案 A 不影响号池选择。
- `issueBatch`（第 214–296 行）写路径：证书 INSERT + 号池消费 + 审计 INSERT 同批；不影响资格查询。

### 4.4 参与仓库（`repository/participation.ts`）

- `findByPublicIdWithSignup`（第 232–247 行）：返回 `signup_user_id` 与 `activity_id`，供路由解析 recipient 与归属校验。**这正是「participation → signup」的现有权威投影**，证明其 data model 下 participation 必经 signup 关联 user/activity**。
- 该文件无任何「attendance → participation」反查，印证 `attendance_sessions.participation_id` 在生产数据侧未维护。

### 4.5 命名空间与测试（domain / tests）

- `domain/certificate.ts`：`CertificateSource.ACTIVITY = 'activity'`、`CertificateKind.PARTICIPANT`；source namespace 冻结为 `(source_type='activity', issue_source='activity', source_id=activities.id)`。方案 A 不改 namespace。
- `tests/p_r5_activity_service_issuance.test.mjs`：
  - 第 106–127 行 fixture 为合格对象（volC=user6）**同时填充 `participation_id`（=partIdC）与 `signup_id=4`** → 当前两种策略都能通过，**未覆盖生产真实形状**。
  - 第 3f 段（第 131–135 行）服务记录 fixture 用 `participation_id = null`（signup_id=6 填充）→ 证明生产形状（participation_id NULL、signup_id 填充）在测试侧存在但仅用于 SERVICE，ACTIVITY 合格 fixture 未复现该形状。
  - → **方案 A 必须新增「生产形状」回归测试**（attendance_sessions.signup_id populated、participation_id NULL）以捕获本缺口；否则本地测试永远发现不了。

### 4.6 审计结论

| 关注点 | 方案 A 是否影响 | 依据 |
|---|---|---|
| source namespace | 否 | routes/activities.ts:717-721、domain/certificate.ts 不变 |
| idempotency | 否 | certificate-issuance.ts:133-148 查 certificates 表 |
| 号池 selector | 否 | certificate-issuance.ts:109-125 provenance 白名单 |
| SELF_ISSUE 守卫 | 否 | routes/activities.ts:704 仍生效 |
| SERVICE 路径 | 否 | ServiceEligibilityPolicy 不经 participation_id |
| 租户隔离 | 否（须保留 `a.team_id=?`） | 策略 WHERE 仍含 a.team_id |
| P5 现有 fixture | 仍通过 | 其 signup_id 也填充，方案 A join 命中 |

---

## 5. 方案比较

### 方案 A：代码修复（ActivityEligibilityPolicy 改以 signup_id 联结）

**最小改点（设计，非执行）**：`services/certificate-eligibility-policies.ts` 的 `ActivityEligibilityPolicy.check` 两处联结：

- ① `JOIN attendance_sessions att ON att.participation_id = p.id`
  → `JOIN attendance_sessions att ON att.signup_id = s.id`
- ② anomaly：`JOIN activity_participations p ON p.id = att.participation_id`
  → `JOIN activity_participations p ON p.signup_id = s.id`（并可选 `AND p.status = 1` 收紧）

**必须保留的不变量（fail-closed，不得放宽）**：
- `p.status = 1`（参与活跃）
- `att.status = 2`（已签退）
- `an.status IN (1,2)` → 阻断
- `s.activity_id = ?`（signup 确属本活动）
- `s.user_id = ?`（signup user == recipient）
- `a.team_id = ?`（租户隔离）
- 缺失联结即 `ACTIVITY_NOT_ATTENDED`（default-deny）

**优点**：
- 对齐生产真实数据形状（signup_id 100% 填充，participation_id 100% NULL）。
- **不写 production D1**（零数据变更，风险最低）。
- 经 clean worktree 改代码 + 回归测试 + 重新部署 Worker 即可生效。
- 解锁 235 个真实合规候选（P9E 重跑可得）。
- 不影响幂等 / 号池 / 命名空间 / SERVICE 路径。

**缺点**：
- 需代码修复、测试、重新部署（P9B/P9C/P9D）。
- 必须保证不放松资格（见上「必须保留的不变量」）。

### 方案 B：数据回填 attendance_sessions.participation_id

**做法**：以 `signup_id → activity_participations.id` 映射回填 `participation_id`，使现有代码无需改。

**优点**：
- 现有代码无需改。

**缺点**：
- **写 production D1，风险高**（违反「不改 production D1」优先原则）。
- 需精确映射 `signup_id → participation.id`（一个 signup 可能多 participation 行，映射需业务规则）。
- 可能改变历史考勤的解释口径（参与与签到会话的语义绑定）。
- 需完整备份 + 测试库 dry-run + 升级 SQL + 回滚策略。
- 不推荐作为首选。

### 推荐

```
RECOMMENDED_FIX = A
理由：对齐生产真实数据形状、零 D1 写入、经部署即可解锁 235 候选、不影响幂等/号池/命名空间；
     方案 B 写 D1 风险过高，仅作为兜底（且仍需测试库验证 + 回滚）。
```

---

## 6. 测试计划（针对方案 A）

> 仅在 P9B 实现阶段执行，本任务不写测试。

### 6.1 新增「生产形状」回归 fixture（关键）

在 `tests/p_r5_activity_service_issuance.test.mjs` 或新测试文件补种：
- 参与行 `activity_participations(signup_id, ... , status=1)`
- **`attendance_sessions(signup_id=<填充>, participation_id=NULL, status=2)`** ← 复现生产真实形状
- 断言：该 recipient 在 preview 中 `eligible=true`（方案 A 修复后）；当前部署策略下 `NOT_ELIGIBLE`（捕获缺口）。

### 6.2 单元 / 集成覆盖

| 用例 | 期望 |
|---|---|
| production-like fixture（signup_id 填，participation_id NULL）· eligible | pass |
| missing signup_id（signup_id NULL） | NOT_ELIGIBLE |
| 未签退（att.status != 2） | NOT_ELIGIBLE |
| blocking anomaly（an.status IN (1,2)） | ATTENDANCE_ANOMALY_BLOCKING |
| participant 属于本活动（s.activity_id 校验） | 跨活动 404 |
| recipient user == signup user（s.user_id 校验） | 否则拒绝 |
| self-issue 仍禁止 | 403 SELF_ISSUE_FORBIDDEN |
| idempotency 不变 | 再次发证 → ALREADY_ISSUED |
| SERVICE 路径不受影响 | 仍按 service_records.session_id |
| selector 不变 | synthetic/NULL/status 1/2 不消费（fail-closed） |
| 现有 P5 40/40 | 继续通过（其 signup_id 也填） |

### 6.3 回归命令

- `node tests/p_r5_activity_service_issuance.test.mjs` → 全绿（含新增生产形状用例）
- `npm run typecheck`
- P6B client team-context contract（若涉及 participation 投影）
- 部署后 health smoke（P9D）
- **P9E 重跑候选门** 之前必须 green

---

## 7. 部署计划（仅设计，不执行）

| 阶段 | 内容 | 禁令 |
|---|---|---|
| P9B | clean worktree 实现方案 A 最小修复：仅改 `ActivityEligibilityPolicy` 两处联结 + 必要测试（新增生产形状 fixture） | 不改 schema / 不写 D1 / 不部署 |
| P9C | clean worktree production deploy 授权文本（单独授权） | 仅授权，不自动部署 |
| P9D | production deploy + health smoke + D1 零变更复核 | 不发证 |
| P9E | 重跑 P9 candidate gate（预期 ACTIVITY 候选 = 235，READY=YES） | 不发证 |
| P10 | 首条真实合规发证授权门（单一已核验候选，一次单人 issue） | 仅一经授权后执行 |

---

## 8. 风险清单

1. **方案 A 不可放宽资格**：必须保留 `p.status=1` + `att.status=2` + `an.status IN (1,2)` 阻断 + `s.activity_id` + `s.user_id` + `a.team_id` 全部谓词；default-deny 不变。
2. **数据回填（方案 B）风险显著更高**：写 production D1、映射歧义、历史解释改变，需备份/dry-run/回滚，**不推荐首选**。
3. **任何真实发证仍需单独 P10 授权**：本设计与 P9B/P9D 均**不发证**。
4. **P9E 前必须 green**：方案 A 部署后须先重跑候选门确认 235 候选 + 零误判，再进入 P10。
5. **号池消费不可逆**：P10 一旦发证即消费 1 个 cert_srv 号池且证书不可 git 回滚，须 P10 前 before/after snapshot。
6. **参与多 occurrence 语义**：一个 signup 可有多 participation 行；方案 A 经 signup_id 聚合「该用户本活动所有签退会话」，与生产 `activity_signups` 对 (user,activity) 唯一约束一致，语义正确。

---

## 9. 当前决策

```
READY_FOR_P9B_FIX_IMPLEMENTATION = YES
```

依据：
- 根因证据充分（D1 诊断 + 源码审计双重确认：participation_id 100% NULL，signup_id 100% 填充）。
- 方案 A 为纯代码修复，零 D1 写入，对齐生产真实形状，解锁 235 候选。
- 不影响幂等 / 号池 / 命名空间 / SERVICE 路径 / 租户隔离 / 自证守卫（源码审计 §4.6 逐项确认）。
- 测试计划明确（含缺失的「生产形状」回归 fixture），可在 P9B 闭环。

```
RECOMMENDED_FIX = A（不回填 D1）
```

---

## 10. 禁令与纪律核验

| 禁令 | 结果 |
|---|---|
| 不修改 workers/src | ✅ 0 修改 |
| 不修改 migrations | ✅ 0 修改 |
| 不修改 wrangler 配置 | ✅ 0 修改 |
| 不调任何 POST issue route | ✅ 0 调用 |
| 不插入 production certificates | ✅ 未插入 |
| 不更新 production id_pools | ✅ 未更新 |
| 不回填 attendance_sessions.participation_id | ✅ 未回填 |
| 不创建测试数据（生产） | ✅ 仅在测试设计描述，未写 |
| 不伪造考勤/服务/积分/完成 | ✅ 未伪造 |
| 不部署 Worker | ✅ 未部署 |
| 不改 DNS/route | ✅ 未改 |
| 不改 secrets | ✅ 未改 |
| 不 push | ✅ 未 push |
| 不碰 JHZY 1.0 live | ✅ 未访问 |

```
CODE_CHANGED = NO
PRODUCTION_D1_MUTATED = NO
CERTIFICATE_ISSUED = NO
WORKER_DEPLOYED = NO
GIT_PUSH_PERFORMED = NO
JHZY_1_0_TOUCHED = NO
```

---

## 11. 必含项核对清单

- [x] P9 背景（联动缺口）
- [x] runtime smoke status（PASS）
- [x] D1 diagnostic counts（§3）
- [x] source audit（§4，实际文件路径 + 行号）
- [x] 方案 A/B 对比（§5）
- [x] 推荐方案 A（不回填 D1）
- [x] testing plan（§6，含生产形状回归）
- [x] deployment plan（§7，P9B→P9C→P9D→P9E→P10）
- [x] risk list（§8）
- [x] current decision（READY_FOR_P9B_FIX_IMPLEMENTATION = YES）
- [x] no code changed / no D1 mutation / no cert issued / no deploy / no push
- [x] Secret/PII scan（CLEAN，见 §12）

---

## 12. Secret/PII 扫描

doc 52 仅含：aggregate counts、public_id 占位（`partPubC` 等测试变量名）、internal numeric id 摘要（user_id=6 等为测试 fixture 说明，非生产 PII）。

扫描结果（提交前 `grep`）：
- token / `cfut_` / `Bearer` / JWT：NONE
- 手机号 `1[3-9][0-9]{9}`：NONE
- OpenID `\bo[A-Za-z0-9_-]{28}\b`：NONE
- 身份证 `[0-9]{17}[0-9Xx]`：NONE
- 真实姓名 / 可识别个人身份：NONE
- raw cert_no / raw pool_code / session token：NONE

```
SECRET_PII_SCAN = CLEAN
```

---

## 13. 遗留 / NEXT_ACTION

1. **P9B**（待独立授权）：clean worktree 实现方案 A 最小修复——仅改 `ActivityEligibilityPolicy.check` 两处联结为 `att.signup_id = s.id`，并新增「生产形状」回归 fixture（attendance_sessions.signup_id 填、participation_id NULL）。
2. P9B 后：本地 `npm run typecheck` + `node tests/p_r5_activity_service_issuance.test.mjs` 全绿（含新增用例）+ 现有 P5 40/40 通过。
3. **P9C/P9D**（待授权）：clean worktree 部署 + 生产 health smoke + D1 零变更复核（不发证）。
4. **P9E**（待授权）：重跑 P9 候选门，预期 ACTIVITY 候选 = 235，READY_FOR_FIRST_REAL_ISSUANCE_AUTHORIZATION = YES。
5. **P10**（待授权）：首条真实合规发证（单一候选、一次单人 issue、before/after snapshot）。
6. SERVICE 路径仍 `service_records=0` 不可用，P10 首证只能走 ACTIVITY。
