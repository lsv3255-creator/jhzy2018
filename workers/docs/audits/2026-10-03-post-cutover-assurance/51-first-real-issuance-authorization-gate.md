# 51 · 首条真实合规发证授权门（P9）

> 关联任务：`POST-R5-P9-FIRST-REAL-ISSUANCE-AUTHORIZATION-GATE`
> 前序：`47` deploy · `48` workers.dev smoke(BLOCKED) · `49` route 可行性(FEASIBLE) · `50` 自有域名 runtime smoke(PASS) · P8H closeout(DONE)
> 日期：2026-10-04
> 纪律：只读门 · **不发证** / 不调 issue route / 不写 production D1 / 不建测试数据 / 不 push / 不改 secrets / 不碰 JHZY 1.0

---

## 0. 验收摘要（Final Return 占位）

```
POST_R5_P9_STATUS                  = GATED / NO_ELIGIBLE_CANDIDATE
RUNTIME_HEALTH                     = PASS
D1_BASELINE                        = NO_MUTATION（413/450500/149692/46/46/0/0/0）
SERVICE_CANDIDATE_AVAILABLE        = NO（service_records_count = 0）
ACTIVITY_CANDIDATE_AVAILABLE       = NO（部署策略下 0 合格）
FIRST_ISSUANCE_CANDIDATE           = NONE
ELIGIBILITY_RESULT                 = FAIL_NO_CANDIDATE（部署 ACTIVITY 策略 0 合格）
RECIPIENT_RESULT                   = N/A（无候选）
IDEMPOTENCY_RESULT                 = N/A（无候选；legacy 55 行 source_id=NULL 不冲突）
POOL_READY                         = YES（cert_srv_available_legacy = 149692 可分配；有候选即可消费）
PREVIEW_SMOKE                      = SKIPPED_NO_SAFE_AUTH
READY_FOR_FIRST_REAL_ISSUANCE_AUTHORIZATION = NO
AUTHORIZATION_TEXT                 = N/A（NO_ELIGIBLE_CANDIDATE_AUTHORIZATION = N/A）
ISSUE_ROUTE_CALLED                 = NO
CERTIFICATE_ISSUED                 = NO
PRODUCTION_D1_MUTATED              = NO
GIT_PUSH_PERFORMED                 = NO
JHZY_1_0_TOUCHED                   = NO
NEXT_ACTION                        = 上报 participation_id 联动缺口（策略改 join signup_id 或回填 attendance_sessions.participation_id）后重跑 P9
```

---

## 1. R5 Deploy 状态

| 项 | 值 |
|---|---|
| activity/service issuance production deploy | PASS |
| Production Worker active version | `3cb9d6f5-11a8-4588-930d-e58dfd1b7ea7` |
| Rollback version | `bfff110b-4787-40cb-b982-6c692e699429`（保留） |
| Smoke hostname | `v2-smoke.signivra.com` |
| Runtime health smoke | PASS（见 §2） |
| 部署/冒烟期间已发证 | NO |

---

## 2. Runtime Health Gate（PASS）

`curl -i https://v2-smoke.signivra.com/health` 真实返回：

```
HTTP/2 200
{"status":"ok","worker":"jhzy-v2-worker","environment":"production","d1Binding":"present","schema":{"migrationsApplied":46},"time":1791112917}
```

| 字段 | 值 | 判定 |
|---|---|---|
| HTTP 状态码 | 200 | ✅ PASS |
| status | ok | ✅ Worker 存活 |
| environment | production | ✅ 生产 |
| d1Binding | present | ✅ D1 绑定 |
| migrationsApplied | 46 | ✅ 与基线一致 |

→ 门通过，进入候选授权流程。

---

## 3. Production D1 Baseline（只读 SELECT，NO MUTATION）

| 指标 | 期望 | 实测 | Delta |
|---|---|---|---|
| certificates_count | 413 | 413 | 0 |
| id_pools_total | 450500 | 450500 | 0 |
| cert_srv_available_legacy | 149692 | 149692 | 0 |
| d1_migrations_count | 46 | 46 | 0 |
| d1_migrations_max | 46 | 46 | 0 |
| certificate_logs_count | 0 | 0 | 0 |
| service_records_count | 0 | 0 | 0 |
| sessions_count | 0 | 0 | 0 |

`sessions_count = 0` → 无外部真实登录、无测试 session。期间除 SELECT 外无任何写入。

```
D1_BASELINE = NO_MUTATION
```

---

## 4. 候选发现方法（Candidate Discovery Method）

### 4.1 资格策略口径（取自部署代码，权威）

`src/services/certificate-eligibility-policies.ts` → `ActivityEligibilityPolicy.check` 精确判定：

```
① SELECT 1 FROM activity_participations p
   JOIN activity_signups s ON s.id = p.signup_id
   JOIN activities a ON a.id = s.activity_id
   JOIN attendance_sessions att ON att.participation_id = p.id   -- ⚠ 关键点
  WHERE s.user_id = ? AND s.activity_id = ? AND a.team_id = ?
    AND p.status = 1 AND att.status = 2
  → 命中 = 已参与 + 已签退
② SELECT 1 FROM attendance_anomalies an
   JOIN attendance_sessions att ON att.id = an.session_id
   JOIN activity_participations p ON p.id = att.participation_id
   JOIN activity_signups s ON s.id = p.signup_id
   JOIN activities a ON a.id = s.activity_id
  WHERE ... AND an.status IN (1,2)
  → 命中 = 阻断（blocking anomaly）
```

`src/routes/activities.ts:679-734`（单人参与证书发放）调用
`svc.issue({ domainSource: ACTIVITY, sourceId: activity.id, recipientUserId: part.signup_user_id })`
并带 `SELF_ISSUE_FORBIDDEN` 守卫（operator ≠ recipient）。

幂等键命名空间（来自 `src/domain/certificate.ts`）：
- ACTIVITY → `source_type='activity'` / `issue_source='activity'` / `source_id=activities.id`
- legacy 413 行全部 `source_id = NULL` → **不参与**新命名空间唯一约束，天然不冲突

### 4.2 候选发现 SQL（与策略逐字对齐）

```sql
SELECT p.public_id AS participation_public_id,
       a.public_id AS activity_public_id,
       s.user_id   AS user_id,            -- 内部数值 id，非 PII
       a.team_id   AS team_id,
       a.id        AS activity_id,
       a.status    AS activity_status
FROM activity_participations p
JOIN activity_signups s ON s.id = p.signup_id
JOIN activities a ON a.id = s.activity_id
JOIN attendance_sessions att ON att.participation_id = p.id
WHERE p.status = 1 AND att.status = 2
  AND s.user_id > 0 AND a.team_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM attendance_anomalies an
                  WHERE an.session_id = att.id AND an.status IN (1,2))
  AND NOT EXISTS (SELECT 1 FROM certificates c
                  WHERE c.user_id = s.user_id AND c.source_type='activity'
                    AND c.issue_source='activity' AND c.source_id = a.id AND c.status=1)
LIMIT 15;
```

---

## 5. 候选结果（Candidate Result）= NONE

### 5.1 实测计数

| 查询 | 结果 |
|---|---|
| `attendance_anomalies` 总行数 | **0** |
| 部署 ACTIVITY 策略下的合格 (user,activity) 对数 | **0** |
| 新命名空间已发证数（`source_type='activity' AND issue_source='activity' AND status=1`） | 0 |
| legacy activity 证书（`source_type='activity' AND source_id IS NULL AND status=1`） | 55 |

→ **按部署策略，0 个合格候选**。无任何真实、合规、未重复参与记录可通过 `ActivityEligibilityPolicy`。

### 5.2 根因诊断（数据联动缺口）

| 检查 | 结果 |
|---|---|
| `attendance_sessions.participation_id` 非 NULL | **0 / 240（100% NULL）** |
| `attendance_sessions.signup_id` 非 NULL | **240 / 240（100% 填充）** |
| 若策略改以 `att.signup_id = s.id` 联结，合格 (user,activity) 对数 | **235** |

**结论**：部署的 `ActivityEligibilityPolicy` 要求 `attendance_sessions.participation_id` 被填充，
但生产考勤数据**只填充 `signup_id`、不填充 `participation_id`**（240/240 全 NULL）。
因此策略的 `① 已参与+已签退` 联结永远为空 → 所有参与者被判 `ACTIVITY_NOT_ATTENDED` → `NOT_ELIGIBLE`。

这是一个**部署策略与生产关系型数据形状之间的联动缺口**，属代码/数据缺陷或回填需求，
**不在本授权门(scope)内修复，亦不得为完成任务而伪造候选数据**。

### 5.3 服务候选

`service_records_count = 0`（§3 基线）→ SERVICE 候选不可用，`SERVICE_CANDIDATE_AVAILABLE = NO`。

---

## 6. Eligibility / Recipient / Idempotency 预检

| 维度 | 结果 |
|---|---|
| Eligibility | **FAIL_NO_CANDIDATE**：部署 ACTIVITY 策略 0 合格（根因 §5.2）；异常表为空， blockers 为联动缺口而非业务异常 |
| Recipient | N/A（无候选，不进入 recipient 核查） |
| Idempotency | N/A（无候选）；legacy 55 行 `source_id=NULL` 不落入新命名空间唯一约束，无历史冲突风险 |
| Pool | cert_srv_available_legacy = 149692，provenance 白名单(`legacy_migrated`,`v2_native`)可分配，**池就绪**——一旦有候选即可消费 1 个；synthetic/NULL provenance 不可消费（fail-closed） |

---

## 7. Preview-only Smoke

无安全真实 auth token（生产 `sessions_count = 0`，本地无 `.dev.vars`/`.env` 凭证）。

```
PREVIEW_SMOKE = SKIPPED_NO_SAFE_AUTH
```

不登录生产取 token（会写 `sessions`，违反「不写 D1 / 不建测试数据」）。
即便网络/鉴权可达，因 §5.2 根因，预览亦会返回 `NOT_ELIGIBLE`，无法产生候选。

---

## 8. 风险清单（待 P10 授权时必读）

> 本任务不发证，以下为「若未来 P10 被授权」的前置风险，非当前动作。

1. **P10 一旦授权真实发证，将写 production `certificates`**（INSERT 1 行）。
2. 将消费 1 个 `cert_srv` 号池（`id_pools` 条件 UPDATE，`status 0→1`）。
3. 将写 `certificate_logs` / batch 记录（代码在 `issueBatch` 内原子写入 + 审计核验）。
4. **不可用 `git rollback` 撤销 D1 写入**——一旦误发，只能走业务撤销/作废/审计流程。
5. 若误发，需 `certificates.revoked_at/revoked_by/revoke_reason` + 号池回补（如有），不可静默。
6. **P10 前必须再次做 before snapshot**（同 §3 八表），P10 后必须做 after snapshot 与证书详情可见性核查。
7. **当前最大风险不是发证本身，而是「候选不存在」**：若在未修复 §5.2 缺口前强行以任何方式发证，
   要么因策略 fail-closed 全部 `NOT_ELIGIBLE`（发不出），要么被迫绕过策略（违反纪律）。
   → **正确路径：先修复联动缺口（策略改 join `signup_id` 或回填 `attendance_sessions.participation_id`），再重跑 P9 得到真实候选**。

---

## 9. P10 授权文本

无合格候选 → 不生成可执行授权文本。

```
NO_ELIGIBLE_CANDIDATE_AUTHORIZATION = N/A
```

（若未来修复 §5.2 缺口并重跑 P9 得到真实候选，再按指令模板生成
`POST-R5-P10 首条真实合规发证` 授权文本，且仅允许对单一已核验候选调用一次单人 issue route。）

---

## 10. 当前决策

```
READY_FOR_FIRST_REAL_ISSUANCE_AUTHORIZATION = NO
```

理由：
- SERVICE 候选不可用（service_records = 0）
- ACTIVITY 候选在部署策略下为 0（根因：attendance_sessions.participation_id 100% NULL，策略联结失效）
- 不允许为完成任务制造测试数据或伪造参与/考勤记录

---

## 11. 禁令与纪律核验

| 禁令 | 结果 |
|---|---|
| 不调 POST /certificates/issue 等四类 issue route | ✅ 0 次调用 |
| 不插入 production certificates | ✅ 未插入 |
| 不更新 production id_pools | ✅ 未更新 |
| 不写 certificate_logs | ✅ 未写 |
| 不创建 session / 测试用户 / 测试活动 / 测试 service_record | ✅ 未创建 |
| 不伪造服务/积分/考勤/培训/完成状态 | ✅ 未伪造 |
| 不改 production D1 | ✅ 仅 SELECT |
| 不部署 Worker | ✅ 未部署 |
| 不改 DNS / route | ✅ 未改 |
| 不改 secrets | ✅ 未改 |
| 不 push | ✅ 未 push |
| 不碰 JHZY 1.0 live | ✅ 未访问 |

```
ISSUE_ROUTE_CALLED = NO
CERTIFICATE_ISSUED  = NO
PRODUCTION_D1_MUTATED = NO
GIT_PUSH_PERFORMED = NO
JHZY_1_0_TOUCHED   = NO
```

---

## 12. 必含项核对清单

- [x] R5 deploy status
- [x] runtime smoke status（PASS）
- [x] D1 baseline（NO MUTATION）
- [x] candidate discovery method（策略对齐 SQL）
- [x] candidate result（NONE + 根因诊断）
- [x] eligibility result（FAIL_NO_CANDIDATE）
- [x] recipient result（N/A）
- [x] idempotency result（N/A；legacy 不冲突）
- [x] pool readiness（149692 可分配，就绪）
- [x] preview smoke result（SKIPPED_NO_SAFE_AUTH）
- [x] risk list（§8）
- [x] P10 authorization text（N/A）
- [x] current decision（READY = NO）
- [x] no issue route / no cert issued / no D1 mutation / no push / no JHZY 1.0 touched

---

## 13. 遗留 / NEXT_ACTION

1. **上报联动缺口（最高优先）**：部署 `ActivityEligibilityPolicy` 联结 `attendance_sessions.participation_id`，
   而生产 `attendance_sessions.participation_id` 100% NULL（仅 `signup_id` 填充）。
   两条修复路线任选其一，须经独立授权与测试：
   - A. 策略改以 `att.signup_id = s.id` 联结（代码改动，需回归测试 + 重新部署 Worker）；
   - B. 回填 `attendance_sessions.participation_id`（数据迁移，须备份 + 测试库验证 + 升级 SQL）。
2. 修复后**重跑 P9** 得到真实候选（诊断显示 signup_id 路径下 235 合格对），再生成 P10 授权文本。
3. 服务候选仍不可用（service_records = 0），P10 首证只能走 ACTIVITY 路径。
4. P10 执行前必须 before/after snapshot 对照（§8）。
