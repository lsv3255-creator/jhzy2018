# 23 — CERT-R3B: Shared Certificate Issuance Core

> 前置 Gate：CERT-R2 = CLOSED · CERT-R3A = CLOSED · CERT-R3A-FIX = CLOSED（commit `78a55ac`）
> 权威实现文档：`docs/certificate/certificate-issuance-core.md`
> 上游契约：`certificate-domain-contract.md` · `certificate-issuance-boundary.md`
> 模式：**LOCAL SOURCE IMPLEMENTATION + LOCAL TESTING**
> **禁止**：远端迁移 APPLY / 部署 / 路由 / UI / 真实发证 / PDF / R2 / RBAC 变更 / 触碰 JHZY 1.0 / push

---

## 0. CERT-R3B-FIX（2026-10-03）— fail-closed 加固 + 原子性证明

> 本节记录 CERT-R3B 之后的修正。上文 §12 的 `EXTERNAL_NUMBER_FORMAT_DECISION`
> 与 §9 的边界描述**已由本节取代**（分析历史保留，不改写）。

### 0.1 修正 1：资格依赖 fail-open → **fail-closed**

| | 初版 | 现版 |
| --- | --- | --- |
| `eligibility` | 可选，缺省 `ALLOW_ALL_ELIGIBILITY` | **必填**；缺失 → 构造抛 `POLICY_NOT_CONFIGURED`；运行期 → `ELIGIBILITY_POLICY_UNAVAILABLE` |
| 策略显式拒绝 | — | `NOT_ELIGIBLE` 且**零副作用**（无证书 / 无编号消耗 / 无成功审计） |

**风险定性**：初版缺省放行意味着「未接入资格政策时，真实 ACTIVITY/SERVICE 证书被
**无条件发放**」—— 绕过资格校验，属**安全缺陷**而非仅设计瑕疵。

**仍不发明业务规则**：核心不硬编码考勤/时长门槛，只强制「必须有人负责」。

### 0.2 修正 2：接收者守卫 fail-open → **fail-closed**

| | 初版 | 现版 |
| --- | --- | --- |
| `recipientGuard` | 可选，`null` 即放行 | **必填**；缺失 → 构造抛 `POLICY_NOT_CONFIGURED`；运行期 → `RECIPIENT_GUARD_UNAVAILABLE` |
| 硬编码 1676 | 无（正确） | **仍无** —— 保持不硬编码任何具体 id |

### 0.3 原子性证明（未发现缺陷，故未改动事务设计）

**编号选定**：`peekPoolCode()` = 只读 `SELECT code FROM id_pools WHERE pool_type=?
AND status=0 ORDER BY id ASC LIMIT 1`（事务外，**不立即消费**）。

> **CERT-R3D-FIX 增补（分配资格）**：候选谓词在 `pool_type + status=0` 之外
> 新增 `provenance IN ('legacy_migrated','v2_native')`（fail-closed 白名单，
> 经 `allocatableProvenanceSql()` 生成）。合成兼容库存
> （`v2_synthetic_compat`）保留但**不可分配**；NULL/未知同样不可分配。
> `ORDER BY id ASC` 仅在合格集合内部定序。详见
> `docs/certificate/legacy-id-pool-migration.md` §2.1。


**`db.batch` 语句顺序（3 条）**：

| 序 | 语句 | 守卫 |
| --- | --- | --- |
| 1 | `INSERT INTO certificates` | 无 WHERE（唯一键冲突 → 整批回滚） |
| 2 | `UPDATE id_pools SET status=1, assigned_to=?, assigned_at=?` | `pool_type+code+status=0` **AND** `EXISTS(证书 public_id AND status=1)` |
| 3 | `INSERT INTO certificate_logs` | `SELECT c.id FROM certificates c WHERE c.public_id=? AND c.status=1`（read-your-writes） |

**`meta.changes` 解读**：`results[0]` → 证书是否插入；`results[1]` → 号是否消费。
`certInserted=false` → 并发抢占 → 重查 → `ALREADY_ISSUED`。

**并发「同候选号 X」证明**：

| 命题 | 依据 | 结论 |
| --- | --- | --- |
| X 不会被成功分配两次 | `id_pools UNIQUE(pool_type,code)` + 语句 2 的 `status=0`（第二请求 changes=0）+ `cert_no UNIQUE` | ✅ |
| 失败竞争不留下不一致消耗 | 语句 2 以 `EXISTS(证书)` 为前置；证书未生成 → 号不烧；三者同批回滚 | ✅ |
| 证书 INSERT 失败不报成功 | `certInserted=false` → `CERTIFICATE_INSERT_FAILED` / `ALREADY_ISSUED`，绝不 `ISSUED` | ✅ |
| 审计失败不报成功 | 审计同批；失败整批回滚；另有 `countIssueAudit()` 复核 → `AUDIT_FAILED` | ✅ |
| 重试收敛 | 幂等命中 → `ALREADY_ISSUED`；池空 → `NUMBER_POOL_EXHAUSTED`；均不发新号 | ✅ |
| 已消费号永不重分配 | `status=1` 后不再被 `peekPoolCode` 选中；无路径改回 `0` | ✅ |

### 0.4 编号格式状态更正

```
EXTERNAL NUMBER_FORMAT_DECISION = DEFERRED_PENDING_CERT_R3C
```

原 `DEFERRED_TO_CERT_R3B` 措辞失效（CERT-R3B 已完成）。本 Gate 未发现权威 V2
活动/服务对外格式 → **保持真 deferred**，且**未冻结任何前缀**（分配器只消费
`id_pools.code`，不构造字符串）。**下一决策 Gate = CERT-R3C**（`cert_srv` 种子
与其格式须同 Gate，否则池内 code 形态将事实上成为对外格式）。

### 0.5 测试增量

44 → **63 断言**：新增 fail-closed（资格 5 项 + 守卫 3 项）与并发证明（9 项，
含静态约束证明 + 动态争抢 + 同号二次分配被 DB 拒绝）。

---


| 项 | 要求 | 实测 |
| --- | --- | --- |
| pwd | `/Users/Shared/projects/jhzy-v2` | ✅ |
| branch | `master` | ✅ |
| HEAD | `78a55acf53e3fab6e5bc9fa263d25d5cfa09cd8e` | ✅ 精确一致 |
| staged | 0 | ✅ 0 |
| tracked `.var` | 0 | ✅ 0 |
| 无关脏基线 | 记录即可 | `workers/` 44 · `miniprogram/` 287 |

> 本 Gate **未触碰**无关脏文件（结束时仍为 44 / 287）。

---

## 2. 考试路径非回归基线（§5 / §19）

**追踪结论**（`src/repository/exam.ts:594-758`，`submitAndMaybeIssueAtomically`）：

| 关注点 | 现状 |
| --- | --- |
| 号池消费 | 5 条语句之末，`UPDATE id_pools ... WHERE pool_type='cert_trn' AND status=0 AND EXISTS(cert)` |
| 证书 INSERT | 条件 `INSERT ... SELECT`，守卫含 `NOT EXISTS(active cert)` + 池可用 |
| 幂等机制 | 三重：`NOT EXISTS` 谓词 + `uq_cert_user_paper`（`exam_paper_id` 维度）+ `cert_no UNIQUE` |
| 发证条件 | `passed=1` AND `needIssue`（池候选 + public_id + templateId 齐备） |
| 响应行为 | `sessionChanges===0` → session 仍 `status=1` 则 `retryRequired=true` |

**EXAM_PATH_MODIFIED = NO**（`git status` 确认 `exam.ts` 未改动）。
本核心**不 import** `exam.ts`，仅复用其 D1 惯用法与「证书未生成则不烧号」守卫模式。
两者幂等维度**正交**：考试用 `exam_paper_id`，本核心用 `source_type+issue_source+source_id`。

---

## 3. 实现中发现并修正的两个真实缺陷（本 Gate 最重要产出）

### 3.1 `CertificateSource.SERVICE` 枚举值碰撞（阻断级，已修正）

- **现象**：测试 C/E 暴露 —— 为 SERVICE 发放时 `issue_source` 被写成 `'activity'`，
  跨命名空间同 `source_id` 被误判重复。
- **根因**：`SERVICE = 'activity'` 与 `ACTIVITY = 'activity'` **值相同** →
  `find(m => m.domain === domain)` 对 SERVICE 永远命中 ACTIVITY 条目 →
  **域概念运行时无法区分**，`issue_source` 机制被域枚举自身架空。
- **修正**：`SERVICE = 'service'`（域层可区分）；持久化 `source_type` 仍为 `'activity'`
  （`DOMAIN_TO_PERSISTED_SOURCE` 映射）。既有 413 行与索引谓词不受影响。
- **回归风险**：全仓核验该枚举此前**仅被本 Gate 新模块/测试消费** → 零回归。

### 3.2 `users.is_system` / `users.team_id` 并不存在（已修正）

- **schema 事实**：`users`（0001）**无** `is_system`、**无** `team_id`；
  `is_system` 实际在 **`teams`** 表，语义为「团队是否系统团队」，与「接收者是否系统账号」不同。
- **修正**：`findRecipient()` 只查真实列（`id, status`，`deleted_at IS NULL`）；
  系统账号判定改为**注入式 `RecipientGuard`**（默认放行），核心不硬编码任何具体 id。

> 这两项均由**真实 schema 执行**暴露，非 mock 假设 —— 印证 §21「必须跑在真实约束上」的价值。

---

## 4. 原子性模型（§12）

单 `db.batch()` 内三条语句（详见实现文档 §1）：

| 序 | 语句 | 守卫 |
| --- | --- | --- |
| 1 | `INSERT certificates` | 唯一键冲突即整批回滚 |
| 2 | `UPDATE id_pools SET status=1` | `pool_type+code+status=0` AND `EXISTS(证书 public_id)` → **证书未生成则不烧号** |
| 3 | `INSERT certificate_logs` | `SELECT id FROM certificates WHERE public_id=?`（read-your-writes） |

**原子**：号池消费 · 证书 INSERT · 审计 INSERT
**不原子**：资格判定（batch 前预检，幂等由 DB 唯一索引兜底）· PDF/R2（冻结契约规定事务外）

不使用显式 `BEGIN/COMMIT`；**不伪造** D1 无法保证的事务抽象。

---

## 5. 号池依赖（§6 / §7）

```
ACTIVITY_POOL_POLICY = candidate reuse of cert_srv（V1.0 服务证书语义，CHECK 内，零迁移）
SERVICE_POOL_POLICY  = 同上（共用编号段）
EXTERNAL_NUMBER_FORMAT_DECISION = DEFERRED（不冻结任何前缀）
```

- 分配器**消费 `id_pools` 预生成 code**，不构造编号字符串 → 对外格式由未来种子决定。
- **未播种** `cert_srv` → 活动/服务发放确定性返回 `NUMBER_POOL_UNAVAILABLE`，
  **绝不回退 `cert_trn`**（回退会污染培训编号段）。
- 区分 `POOL_UNAVAILABLE`（未播种）与 `POOL_EXHAUSTED`（已耗尽）以便运维定位。

---

## 6. 幂等实现（§11）

- 应用层预检按**四列命名空间键**（跨命名空间天然不命中）。
- **DB 唯一索引为最终裁决者**，不依赖仅预检 SELECT。
- UNIQUE 竞态 → 重新查询 → 确定性地返回 `ALREADY_ISSUED`，**号未烧**（整批回滚）。

---

## 7. 错误契约（§16）

`ISSUED` · `ALREADY_ISSUED` · `NOT_ELIGIBLE` · `RECIPIENT_NOT_FOUND` · `SOURCE_NOT_FOUND`
· `SOURCE_ID_REQUIRED` · `UNSUPPORTED_SOURCE` · `NUMBER_POOL_UNAVAILABLE` · `NUMBER_POOL_EXHAUSTED`
· `NUMBER_ALLOCATION_FAILED` · `CERTIFICATE_INSERT_FAILED` · `AUDIT_FAILED` · `INVALID_REQUEST`
· **`ELIGIBILITY_POLICY_UNAVAILABLE`** · **`RECIPIENT_GUARD_UNAVAILABLE`**（CERT-R3B-FIX 新增，fail-closed）

预期业务结果**不抛异常、不进 catch**；内部异常时批次已回滚，绝不产生假成功。
缺配置属**接线错误**，在**构造期**即抛 `POLICY_NOT_CONFIGURED`（不降级为运行期结果）。

---

## 8. 本地验证（§20 / §21 / §22）

测试通过 `tsc`（项目 tsconfig）编译**真实源码**后动态 import，配合最小 D1 适配器
在 `node:sqlite` 隔离沙箱上执行 —— **跑在真实 0045 修正后 schema 上，非 mock**。

| 验证项 | 结果 |
| --- | --- |
| CERT-R3B 核心测试（A–T + fail-closed + 并发证明） | **63 pass / 0 fail**（CERT-R3B-FIX 后；初版 44） |
| 真实 0045 应用（含 `issue_source`） | ✅ schema 断言确认非 mock |
| 四列 `uq_cert_user_source` 生效 | ✅ |
| `tsc --noEmit`（项目配置） | ✅ exit 0 |
| `wrangler deploy --dry-run` | ✅ 构建成功，未部署 |
| 既有 CERT-R2 fixture 回归 | ✅ **57 pass / 0 fail** |

**§21 关键断言**：schema 确实含 `issue_source`；四列索引已生效。
**§20 核心用例**：A/B/C/D/E/F/G/H/I/J/K/L/M/N/O/P/Q/R/S/T 全覆盖。

---

## 9. 边界遵守（§10 / §17 / §18）

- **授权**：核心不做 RBAC；仅校验发放域不变量。未授予 `platform_operator` 发放权，无 RBAC 变更。
- **资格**：注入式 `EligibilityPolicy`，默认放行（未批准政策不硬编码）。
- **PDF/文件**：`fileStatus=PENDING`；无 PDF 生成、无 R2。
- **批量**：单接收者原语可被批量逐个调用，语义一致；未实现批量引擎。
- **PII**：请求与审计均无 PII；`holder_name`/`issuer_name`/`snapshot` 一律 NULL。

---

## 10. 明确保留的遗留（§24）

0045 预发/生产 APPLY · `cert_srv` 种子（若需要）· 对外编号格式 · HTTP 管理路由 ·
批量引擎 · 资格政策 · PDF 渲染器 · R2 上传 · 我的证书 PDF 改造 · 公开验真修复 ·
前端/管理 UI · 考试迁移到共享服务 · 验收证书发放实现

---

## 11. STOP 条件核查（§27）

| 条件 | 触发？ |
| --- | --- |
| 0045 需再次变更 | ❌ 未变（本 Gate 仅改 TS 与测试） |
| 仅为实现核心而需新迁移 | ❌ 未创建新迁移 |
| `cert_srv` 需不安全表重建 | ❌ 未播种、未改 CHECK |
| 命名空间契约再度含糊 | ❌ 已修正并测试锁定 |
| 原子发放无法安全表达 | ❌ 已用现有 `db.batch` 模式表达 |
| 需改考试行为才能工作 | ❌ `exam.ts` 零改动 |
| 需变更真实生产数据 | ❌ 无任何远端写入 |
| 需发明新授权政策 | ❌ 改为注入式守卫，未发明政策 |

**未触发任何 STOP 条件。**

---

## 12. FINAL RETURN（§28）

```
CERT_R3B_START_HEAD = 78a55acf53e3fab6e5bc9fa263d25d5cfa09cd8e
WORKSPACE_GATE = PASS
FROZEN_CONTRACT_LOADED = YES
EXAM_BASELINE_TRACED = YES (exam.ts:594-758, submitAndMaybeIssueAtomically)

NUMBER_ALLOCATOR_IMPLEMENTED = YES
ALLOCATOR_BACKEND = consumes pre-generated id_pools codes (no string construction;
                    identical mechanism to existing cert_trn)

ACTIVITY_POOL_POLICY = candidate reuse of cert_srv (not seeded, not modified)
SERVICE_POOL_POLICY  = same cert_srv pool (shared number space)
EXTERNAL_NUMBER_FORMAT_DECISION = DEFERRED_TO_CERT_R3B (no prefix frozen)

SHARED_ISSUANCE_SERVICE_IMPLEMENTED = YES
SUPPORTED_DOMAIN_SOURCES = ACTIVITY, SERVICE (TRAINING_EXAM intentionally excluded)
ISSUE_SOURCE_DERIVATION = derived from domain source via issueSourceFor(); never
                         caller-arbitrary (caller cannot pass issue_source)
ELIGIBILITY_BOUNDARY = injectable EligibilityPolicy, default ALLOW_ALL (no invented rule)
AUTHORIZATION_BOUNDARY = no RBAC in core; validates issuance-domain invariants only
                         (operator/team structure, active template, recipient guard);
                         no platform_operator expansion; no RBAC mutation
IDEMPOTENCY_IMPLEMENTATION = 4-column namespace key pre-check + DB uq_cert_user_source
                             as final guard; UNIQUE race normalized to ALREADY_ISSUED
CROSS_NAMESPACE_COLLISION_TEST = PASS
ATOMICITY_MODEL = single db.batch (number consume + cert INSERT + audit INSERT);
                  conditional guards; no fake transaction; PDF/R2 outside TX
NUMBER_GAP_POLICY = gaps allowed; never duplicate; never reassign; no fallback pool
AUDIT_ATOMICITY = audit INSERT inside the same batch; issuance reports ISSUED only
                  after audit existence verified
PDF_FILE_BOUNDARY = no generation; fileStatus=PENDING per frozen contract
BATCH_COMPATIBILITY = single-recipient primitive is the shared entry point;
                      no separate batch issuance logic
EXAM_PATH_MODIFIED = NO
EXAM_NON_REGRESSION = PASS (CERT-R2 fixture 57/0; exam.ts untouched)

CERTIFICATE_CORE_TESTS = PASS    PASS_COUNT = 44    FAIL_COUNT = 0
TYPECHECK = PASS    WORKER_DRY_RUN = PASS    0045_LOCAL_TESTED = YES
0045_STAGING_APPLIED = NO    0045_PRODUCTION_APPLIED = NO    CERT_SRV_SEEDED = NO

PRODUCTION_D1_MUTATED = NO    STAGING_D1_MUTATED = NO    REAL_CERTIFICATE_ISSUED = NO
WORKER_DEPLOYED = NO    SECRET_MUTATED = NO    RBAC_MUTATED = NO
SECRET_PII_SCAN = PASS

CHANGED_FILES =
  workers/src/domain/certificate.ts                                (M: SERVICE enum fix)
  workers/src/repository/certificate-issuance.ts                   (A: new)
  workers/src/services/certificate-number-allocator.ts             (A: new)
  workers/src/services/certificate-issuance-service.ts             (A: new)
  workers/tests/cert_r3b_issuance_core.test.mjs                    (A: new)
  workers/docs/certificate/certificate-issuance-core.md            (A: new)
  workers/docs/audits/.../23-cert-r3b-shared-issuance-core.md      (A: new)

UNRELATED_FILE_CHANGED = NO (workers/ 44 + miniprogram/ 287 untouched)
GIT_COMMIT_PERFORMED = NO    GIT_PUSH_PERFORMED = NO    JHZY_1_0_TOUCHED = NO

READY_FOR_CERT_R3B_SELECTIVE_COMMIT = YES
CERT_R3B_STATUS = PASS_WITH_FINDINGS
  (findings: 2 real defects found & fixed — SERVICE enum value collision,
   users.is_system/team_id non-existence; both proven by real-schema execution)

NEXT_ACTION = STOP. Await review before selective commit. Do not begin
              cert_srv seeding, route wiring, batch engine, or PDF work.
```

---

## 13. STOP

CERT-R3B 完成。未提交、未推送、未应用迁移、未部署、未发证。
