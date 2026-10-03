# 证书发放核心实现（Certificate Issuance Core）— CERT-R3B

> 本文档描述 CERT-R3B 已落地的共享发证核心实现。
> 上游冻结契约：`certificate-domain-contract.md` · `certificate-issuance-boundary.md`
> 审计报告：`docs/audits/2026-10-03-post-cutover-assurance/23-cert-r3b-shared-issuance-core.md`
> 模式：LOCAL SOURCE IMPLEMENTATION + LOCAL TESTING（**无路由、无部署、无真实发证**）

---

## 0. 实现范围

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 仓储原语 | `src/repository/certificate-issuance.ts` | 号池探测/条件消费、幂等探测、源实体校验、原子 batch |
| 编号分配器 | `src/services/certificate-number-allocator.ts` | 池抽象、确定性分配失败、消费语句构造 |
| 共享发证服务 | `src/services/certificate-issuance-service.ts` | 权威单接收者发证原语 + 资格预览 |
| 域契约（已修正） | `src/domain/certificate.ts` | `CertificateSource.SERVICE` 值修正（见 §2） |
| 本地测试 | `tests/cert_r3b_issuance_core.test.mjs` | **63 断言**，覆盖 A–T 矩阵 + fail-closed + 并发证明 |

**不含**：HTTP 路由、Hono 注册、批量引擎、PDF 渲染、R2 上传、RBAC 变更、考试迁移。

---

## 1. 原子性模型（实测达成）

D1 的 `db.batch()` 是官方保证的原子单元。核心把三件事放进**同一个 batch**：

| 序 | 语句 | 守卫（缺一不可） |
| --- | --- | --- |
| 1 | `INSERT INTO certificates` | 无条件插入（**唯一键冲突即整批回滚**） |
| 2 | `UPDATE id_pools SET status=1` | `pool_type + code + status=0` **AND** `EXISTS(证书 public_id)` → 证书未生成则不烧号 |
| 3 | `INSERT INTO certificate_logs` | `SELECT id FROM certificates WHERE public_id=?` → read-your-writes |

**原子范围**
- ✓ 号池消费 · ✓ 证书 INSERT · ✓ 审计 INSERT（三者同事务）
- ✗ 资格判定（batch 前预检；幂等由 DB 唯一索引兜底）
- ✗ PDF / R2（冻结契约规定完全在事务外）

**不使用**显式 `BEGIN/COMMIT`（D1 不支持），**不伪造** D1 无法保证的事务抽象。

---

## 1b. CERT-R3B-FIX：fail-closed 依赖（CORE 强制「必须有人负责」）

> 修正背景：初版两项依赖**缺省即放行**（fail-open），等于「未接入资格/守卫时
> 真实 ACTIVITY/SERVICE 证书被无条件发放」——属安全缺陷。

| 依赖 | 初版 | **现版（fail-closed）** |
| --- | --- | --- |
| `eligibility` | 可选，缺省 `ALLOW_ALL_ELIGIBILITY` | **必填**；缺失 → 构造抛 `POLICY_NOT_CONFIGURED`；运行期再防御性判定 → `ELIGIBILITY_POLICY_UNAVAILABLE` |
| `recipientGuard` | 可选，`null` 即放行 | **必填**；缺失 → 构造抛 `POLICY_NOT_CONFIGURED`；运行期 → `RECIPIENT_GUARD_UNAVAILABLE` |

核心**仍不发明**任何资格业务规则（不硬编码考勤/时长门槛），也**不硬编码**任何
系统账号 id（如 1676）—— 只强制「必须有人负责」。策略显式拒绝时返回 `NOT_ELIGIBLE`
且**无任何副作用**（无证书、无编号消耗、无成功审计）。

新增确定性结果：`ELIGIBILITY_POLICY_UNAVAILABLE` · `RECIPIENT_GUARD_UNAVAILABLE`。

---

## 1c. 事务编排（精确语句顺序）与并发证明

### 编号选定
`peekPoolCode(poolType)` = `SELECT code FROM id_pools WHERE pool_type=? AND status=0
ORDER BY id ASC LIMIT 1`（**只读、事务外**）。取到 `X` 后**不立即消费**。

> **CERT-R3D-FIX 增补（分配资格）**：候选谓词在 `pool_type + status=0` 之外
> 新增 `provenance IN ('legacy_migrated','v2_native')`（fail-closed 白名单，
> 经 `allocatableProvenanceSql()` 生成）。合成兼容库存
> （`v2_synthetic_compat`）保留但**不可分配**；NULL/未知同样不可分配。
> `ORDER BY id ASC` 仅在合格集合内部定序。详见
> `docs/certificate/legacy-id-pool-migration.md` §2.1。


### db.batch 语句顺序（权威，共 3 条）

| 序 | 语句 | 条件 / 守卫 |
| --- | --- | --- |
| **1** | `INSERT INTO certificates` | 无 WHERE（**唯一键冲突即整批回滚**） |
| **2** | `UPDATE id_pools SET status=1, assigned_to=?, assigned_at=?` | `pool_type=? AND code=? AND status=0` **AND** `EXISTS(SELECT 1 FROM certificates WHERE public_id=? AND status=1)` |
| **3** | `INSERT INTO certificate_logs` | `SELECT c.team_id, c.id ... FROM certificates c WHERE c.public_id=? AND c.status=1`（read-your-writes） |

`meta.changes` 解读：`results[0].meta.changes>0` → 证书已插入；`results[1]` → 号已消费。
`certInserted=false` → 判定为并发抢占 → 重新查询 → 归一为 `ALREADY_ISSUED`。

### 整批回滚的触发条件
- 语句 1：`cert_no UNIQUE` 冲突 / `uq_cert_user_source` 冲突（并发同成就）
- 语句 2/3：外键或列约束失败（如审计表结构缺列）
→ D1 `batch` 为原子单元，**任一语句失败则三条全部不生效**。

### 并发「同一候选号 X」证明

| 命题 | 依据 | 结论 |
| --- | --- | --- |
| X 不会被成功分配两次 | 双重约束：`id_pools UNIQUE(pool_type,code)` + 语句 2 的 `status=0` 条件（第二请求 `changes=0`）；且 `certificates.cert_no UNIQUE` 保证同号不可能绑定两张证书 | ✅ |
| 失败的竞争批次不会留下不一致消耗 | 语句 2 以 `EXISTS(证书)` 为前置；证书未生成 → 号不被烧；三者同批回滚 | ✅ |
| 证书 INSERT 失败不会报成功 | `certInserted=false` → 返回 `CERTIFICATE_INSERT_FAILED`（或竞态归一 `ALREADY_ISSUED`），绝不 `ISSUED` | ✅ |
| 审计失败不会报成功 | 审计在同批内；失败即整批回滚；另有 `countIssueAudit()` 复核，缺失返回 `AUDIT_FAILED` | ✅ |
| 重试收敛 | 命中幂等键 → `ALREADY_ISSUED`；池耗尽 → `NUMBER_POOL_EXHAUSTED`；均**不发新号** | ✅ |
| 已消费号永不重分配 | `status=1` 后不再被 `peekPoolCode` 选中；无任何路径把 `status=1` 改回 `0` | ✅ |

> 结论：**未发现原子性缺陷**，故未改动事务设计（STRATEGY C 保持）。

---

**现象**：测试 C/E 暴露 —— 为 SERVICE 发放证书时，持久化的 `issue_source` 是
`'activity'` 而非 `'service'`，导致跨命名空间同 `source_id` 被误判为重复。

**根因**：`SERVICE = 'activity'` 与 `ACTIVITY = 'activity'` **枚举值相同**，
故 `DOMAIN_TO_ISSUE_SOURCE.find(m => m.domain === domain)` 对 SERVICE 永远命中
---

## 2. 实现中发现并修正的两个真实缺陷

### 2.1 `CertificateSource.SERVICE` 枚举值碰撞（阻断级）

> 这正是 `issue_source` 列被引入的原因，但域枚举自身却让该机制失效。
> CERT-R2 冻结时未暴露，因为此前无任何代码真正按域区分过。

**修正**：`SERVICE = 'service'`（域层可区分），持久化 `source_type` 仍为 `'activity'`
（由 `DOMAIN_TO_PERSISTED_SOURCE` 映射）。既有 413 行与 `uq_cert_user_source` 谓词**不受影响**。

**回归风险**：经全仓核验，该枚举此前**仅被 CERT-R3B 新模块与测试消费**，无既有调用点，
故零回归。

### 2.2 `users.is_system` / `users.team_id` 并不存在

**现象**：测试 J 报 `no such column: team_id`。

**schema 事实**：`users` 表（0001）**无** `is_system`、**无** `team_id`；
`is_system` 实际位于 **`teams`** 表，语义是「该团队是否系统团队」，
与「接收者是否系统账号」不是同一件事。

**修正**：`findRecipient()` 只查真实列（`id, status`）；
「系统账号不得作为真实成就接收者」改为**注入式 `RecipientGuard`**，
核心**不硬编码任何具体 id** —— 该判定属授权/业务政策。
**CERT-R3B-FIX 追加**：该守卫由「缺省放行」改为**必填 fail-closed**（见 §1b）。

---

## 3. 编号分配器

```
ALLOCATOR_BACKEND = 消费 id_pools 中【预生成】的 code（与既有 cert_trn 行为一致）
EXTERNAL NUMBER FORMAT = DEFERRED_PENDING_CERT_R3C
```

> **CERT-R3B-FIX 状态更正**：原文写作 `DEFERRED_TO_CERT_R3B`，但 CERT-R3B **已完成**，
> 该措辞已失效。重新界定为：
> - **仍然 deferred**：本 Gate 未发现任何权威 V2 活动/服务对外编号格式；
>   V2 唯一运行格式是 `cert_trn` 的 `CTRN%06d`（0022 播种），
>   V1.0 的 `JHCRT-*` 未在 V2 落地且历史已现 cert_no 碰撞。
> - **未冻结任何前缀**：分配器只**消费** `id_pools.code`，不构造编号字符串，
>   故对外格式完全由「未来种子迁移写什么」决定。**未编码 `CSRV%06d` 或任何前缀。**
> - **下一决策 Gate = CERT-R3C**（`cert_srv` 种子迁移与其格式决策须同 Gate 进行，
>   否则池内 code 形态将事实上成为对外格式）。

- 分配器**不构造编号字符串** → 对外格式完全由「未来种子迁移写什么」决定，
  本模块**未冻结任何前缀**（未编码 `CSRV%06d` 或其它）。
- 池映射：`ACTIVITY → cert_srv`，`SERVICE → cert_srv`（共用 V1.0 服务证书语义池）。
- **不播种** `cert_srv`、**不改** `id_pools`、**不新建** `cert_act`。
- 确定性失败：
  | 情形 | 结果 |
  | --- | --- |
  | 池无任何行（未播种） | `NUMBER_POOL_UNAVAILABLE` |
  | 池有行但无 `status=0`（已耗尽） | `NUMBER_POOL_EXHAUSTED` |
  | 条件消费未命中（并发抢占） | `CONFLICT`（重试，不换池） |
- **绝不回退 `cert_trn`**：回退会把活动/服务证书混入培训编号段，破坏语义与统计口径。

---

## 4. 幂等实现

命名空间安全键（严格对齐 0045 修正后契约）：

```
ACTIVITY: source_type='activity', issue_source='activity', source_id=activities.id
SERVICE : source_type='activity', issue_source='service',  source_id=service_records.id
```

- **应用层预检**：`findActiveByNamespace()` 按四列键查询（跨命名空间天然不命中）。
- **DB 最终裁决**：`uq_cert_user_source` 唯一索引。**不依赖仅靠预检 SELECT**。
- **竞态归一**：捕获 UNIQUE 冲突 → 重新查询 → 确定性地返回 `ALREADY_ISSUED`，
  不退化为 500，且**号未烧**（整批回滚）。

---

## 5. 错误 / 结果契约

预期业务结果**不抛异常、不进 catch**：

| 结果 | 语义 |
| --- | --- |
| `ISSUED` | 发放成功 |
| `ALREADY_ISSUED` | 同一成就有 active 证书（含并发竞态归一） |
| `NOT_ELIGIBLE` | 注入的资格策略拒绝 |
| `RECIPIENT_NOT_FOUND` / `SOURCE_NOT_FOUND` | 接收者/源实体不存在 |
| `SOURCE_ID_REQUIRED` | 成就类证书缺 `source_id` |
| `UNSUPPORTED_SOURCE` | 非本 Gate 支持的域源 |
| `NUMBER_POOL_UNAVAILABLE` / `NUMBER_POOL_EXHAUSTED` | 号池确定性不可用 |
| `INVALID_REQUEST` | 结构非法 / 模板无效 / 守卫拒绝 |
| `CERTIFICATE_INSERT_FAILED` / `AUDIT_FAILED` | 内部异常（批次已回滚） |

---

## 6. 边界（承冻结契约）

- **授权**：核心**不做 RBAC 判定**（路由层负责）。只校验发放域不变量
  （操作者/团队结构合法、模板有效、接收者守卫）。**未授予** `platform_operator` 发放权。
- **资格**：**注入式** `EligibilityPolicy`，默认放行 —— 未批准的资格政策不得硬编码。
- **PDF/文件**：成功发放后 `fileStatus = PENDING`；无 PDF 生成、无 R2 操作。
- **批量**：单接收者原语可被批量逐个调用，**语义完全一致**；不另写批量发证逻辑。
- **考试**：**未修改** `exam.ts`（STRATEGY C）。其幂等仍由 `uq_cert_user_paper`
  （`exam_paper_id` 维度）承担，与本核心的四列命名空间键**正交**。
- **PII**：请求与审计**均不含** PII；`holder_name`/`issuer_name`/`snapshot` 一律写 NULL。

---

## 7. 已知遗留（不在本 Gate）

- `cert_srv` 种子迁移（池为空 → 活动/服务发放返回 `NUMBER_POOL_UNAVAILABLE`）
- 对外编号格式决策
- HTTP 路由 / 批量引擎 / 资格政策 / PDF 渲染 / R2 上传
- 公开验真修复（`VERIFY_STATUS_FILTER_MISSING`、`SERVICE_ACTIVITY_JOIN_AMBIGUITY`）
- 考试迁移到共享服务
