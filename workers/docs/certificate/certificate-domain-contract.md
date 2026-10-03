# 证书域契约（Certificate Domain Contract）— CERT-R2 权威定义

> 本文档是 CERT-R2 的**唯一权威域契约**。所有 CERT-R3+ 的编号分配、发放原语、批量发放、
> 验收证书、PDF 生命周期、权限设计，均以本文档 + `migrations/0045_certificate_domain_contract.sql`
> + `src/domain/certificate.ts` 为准。
>
> 对应审计报告：`docs/audits/2026-10-03-post-cutover-assurance/21-cert-r2-domain-schema-contract.md`
> 前置决策：`docs/audits/2026-10-03-post-cutover-assurance/20-cert-r1-current-state-gap-decision.md`（CERT-R1 = PASS）

---

## 0. 范围与边界（CERT-R2 不做什么）

| 项 | 状态 |
| --- | --- |
| 权威 TypeScript 证书域类型 | ✅ 已建立（`src/domain/certificate.ts`） |
| source / kind / status 语义 | ✅ 已冻结 |
| 发放 / 审计 / 批量 模式基础 | ✅ 已建立（schema + 接口契约） |
| 活动/服务幂等防护契约 | ✅ 已建立（`uq_cert_user_source`） |
| 验收证书区分 | ✅ 已区分（`cert_kind=acceptance`，不创建考勤/服务时长/积分） |
| PDF / 文件生命周期字段 | ✅ 仅契约（`deriveFileStatus`，无新列） |
| 未来共享 `CertificateIssuanceService` 接口 | ✅ 仅接口（CERT-R3 实现） |
| 向后兼容既有 413 张证书 | ✅ 本地 fixture 验证（413→413） |
| **完整发放工作流（write logic）** | ❌ **不在 CERT-R2** → CERT-R3 |
| 编号池实际播种（id_pools） | ❌ **不在 CERT-R2**（仅接口，决策推迟 CERT-R3） |
| 路由 / UI / 权限角色变更 | ❌ **不在 CERT-R2**（权限仅设计，不改角色） |

---

## 1. Source 契约（双层模型）

### 1.1 第 1 层 —— PERSISTED SOURCE COMPATIBILITY（持久化兼容层）
既有 `certificates.source_type`，CHECK =
`NULL | 'course' | 'exam' | 'activity' | 'manual'`。

生产现实（2026-10-03 只读核验，413 行聚合）：
- `course` 358 / `activity` 55；**全部 413 行 `source_id` 均为 NULL**
- 全部 413 行 `status=1`（active，0 revoked）
- 存量行不具备「权威 source identity」，属 legacy/service 种子形状

**纪律**：CERT-R2 **不新增、不修改、不删除**任何 `source_type` 取值。**不因域模型想要更干净的
enum 就发明新的 persisted source_type。**

### 1.2 第 2 层 —— DOMAIN SOURCE SEMANTICS（域语义层）

| 域枚举 | → 持久化 source_type | 说明 |
| --- | --- | --- |
| `TRAINING_EXAM` | `'exam'` | 培训/考试证书（P32 既有） |
| `COURSE` | `'course'` | 课程证书（历史 358 张主体） |
| `ACTIVITY` | `'activity'` | 活动证书 |
| `MANUAL` | `'manual'` | 手动/后台补发 |
| `SERVICE` | `'activity'` | **生产现实**：service 复用 `'activity'`，以 `cert_no` 前缀 `JHCRT-SRV-*` 区分 |

> 映射为**多对一**（`ACTIVITY` 与 `SERVICE` 共享 `'activity'`）。`src/domain/certificate.ts`
> 以数组 + `persistedSourceFor()` / `domainSourcesFor()` 表达，**不用对象字面量**（避免 TS1117
> 重复键 —— 该冲突由 typecheck 实际捕获并修复）。
>
> **SERVICE 不获独立 source_type 的理由**：(1) 新增取值需重估 CHECK 并触及 413 行，违背
> ADDITIVE/NON-DESTRUCTIVE；(2) CERT-R2 不臆造新 persisted 枚举；(3) `JHCRT-SRV-*` 前缀已足够区分。
>
> **推论**：因二者复用同一 persisted 值，`uq_cert_user_source`（谓词锁定
> `source_type='activity'`）**自动同时覆盖** activity 与 service 的幂等防护。

---

## 2. Kind 契约（种类）

**持久化列**：`certificates.cert_kind TEXT NOT NULL DEFAULT 'participant'
CHECK (cert_kind IN ('participant','acceptance'))`（migration 0045 M1）。

| 值 | 含义 | 约束 |
| --- | --- | --- |
| `participant` | 真实参与者证书（**默认**；历史 413 行映射为此，语义真实，不伪造） | 可联动考勤/服务时长/积分（后续发行逻辑决定） |
| `acceptance` | 管理端**验收证书** | **绝不**创建考勤/服务时长/积分/考试行；必须 `issue_reason='admin_acceptance'`；排除出真实参与者统计 |

域判定函数：`isAcceptance(record)`（`certKind === ACCEPTANCE`）。

---

## 3. Issuance Reason 契约（发证原因，不与 source_type / kind 混淆）

**持久化列**：`certificates.issue_reason TEXT`（可 NULL）。

`IssuanceReason` 枚举：

| 值 | 含义 |
| --- | --- |
| `normal` | 正常发放（满足资格自动/手动发放） |
| `reissue` | 补发（原证书丢失/损坏；不新增资格，仅重发编号） |
| `admin_acceptance` | 管理端验收（配合 `cert_kind=acceptance`） |
| `migration` | 数据迁移/历史导入 |
| `legacy` | **域层**映射：历史行 `issue_reason=NULL` 在域层映射为 `legacy`（不写库） |

> **纪律**：`issue_reason` 是**独立维度**，不得与 `source_type`、`cert_kind` 混淆。
> 验收证书必须同时 `cert_kind=acceptance` 且 `issue_reason=admin_acceptance`。

---

## 4. Status / File-State 契约

### 4.1 证书业务状态（`certificates.status`，既有 CHECK 1|2）
- `1` = 有效（active）
- `2` = 已撤销（revoked，配合 `revoked_at`/`revoked_by`/`revoke_reason`）

### 4.2 文件/PDF 生命周期（**CERT-R2 仅契约，无新列**）
由 `certificates.file_id` 推导（`deriveFileStatus`）：

| 状态 | 条件 |
| --- | --- |
| `not_required` | `file_id IS NULL` 且为历史/无需 PDF 的证书（如 legacy） |
| `pending` | `file_id IS NULL` 且为**新发放**（等待 PDF 生成，CERT-R4 实现） |
| `ready` | `file_id IS NOT NULL`（PDF 已生成并落 R2） |
| `failed` | PDF 生成失败 —— **不落列**；证书保持 `status=1` 有效，失败码记入 `certificate_logs.failure_code`（见 CERT-R1 §29 状态机策略） |

---

## 5. 活动/服务幂等防护契约（Idempotency）

### 5.1 EXACT_0045_INDEX_CONTRACT（精确索引契约）

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_cert_user_source
  ON certificates(user_id, source_type, source_id)
  WHERE status = 1 AND source_type = 'activity' AND source_id IS NOT NULL;
```

| 维度 | 定义 |
| --- | --- |
| **columns** | `(user_id, source_type, source_id)` |
| **predicate** | `WHERE status = 1 AND source_type = 'activity' AND source_id IS NOT NULL` |
| **覆盖 source_type** | 仅 `'activity'`（含复用 `'activity'` 的 service）。**排除** `course` / `exam` / `manual` / `NULL` |
| **status 行为** | `status CHECK(1,2)`，1=active / 2=revoked。谓词仅锁 `status=1`；已撤销(2)证书不参与唯一性 → 撤销后可对同一成就重发（策略由 schema 推导，非假设） |
| **NULL 行为** | 显式排除 `source_id IS NULL`。无权威 source identity 的行永不进入索引、不受约束、不阻塞迁移 |
| **legacy 兼容** | 生产 413 张证书 `source_id` **全为 NULL**，全部落在谓词之外 → 索引可安全创建，0 行历史数据被改动 |

> **为何不裸用 `UNIQUE(user_id, source_type, source_id)`**：那会把无 source identity 的
> legacy/service 行（`source_id IS NULL`）纳入约束语义。本索引**只保护具备权威 source
> identity 的成就行**，legacy 行完全不受影响。

### 5.2 生产只读核验（2026-10-03，`rows_written=0`）

| 核验项 | 结果 |
| --- | --- |
| 按**精确索引谓词**的 `(user_id, source_id)` 冲突组 | **`FINAL_PRED_CONFLICTS = 0`** |
| 413 张证书中 `source_id IS NOT NULL` 的行数 | **0**（全部为 NULL） |
| 8 组历史 `(user, exam_paper)` 重复 | 属 `exam_paper_id` 维度，不在索引列/谓词内，0 行被改动 |

> 结论：索引创建**不会**触达 §31 STOP 条件。冲突数为 0，是因为**非 NULL 冲突集本身为空**
> （存量行均无权威 source identity），而非因为冲突已被解决。

### 5.3 应用层（CERT-R3 的 `issue()` 原语）
以 `NOT EXISTS (certificates WHERE user_id=? AND source_type=? AND source_id=? AND status=1
AND source_id IS NOT NULL)` 谓词在事务内先行校验，对齐 `exam.ts submitAndMaybeIssueAtomically` 模式。

---

## 6. 编号分配契约（§11 / §H，CERT-R2 仅接口）

**ACTIVITY_NUMBER_FORMAT_DECISION = `DEFERRED_TO_CERT_R3`**

理由（基于生产只读证据）：
1. `id_pools.pool_type CHECK = ('cert_trn','cert_srv','cert_hon','volunteer')` —— **不含
   `cert_act`**。CERT-R2 **禁止**重建 `id_pools`、**禁止**修改其 CHECK、**禁止**播种 `cert_act`。
2. 生产 55 张 service 证书使用字母数字 `cert_no` 前缀 `JHCRT-SRV-*`，并非 `id_pools` pool
   code 模式 → 现状不是「缺一个池」，而是两套编号体系并存。
3. 未发现已确立的 activity 证书对外编号规则。CERT-R1 曾提议 `CACT%06d`，但该提议与生产现实
   冲突且被 CERT-R1 自身标为 design-only，**不构成 `EXISTING_RULE_FOUND`**。

故 CERT-R2 **不选择**任何新的对外可见 activity 证书前缀。现状 training 发放仍用既有
`cert_trn` 池（`CTRN%06d`），**完全不变**。

```ts
export type CertNumberPoolType = 'cert_trn' | 'cert_act' | 'cert_svc' | 'cert_hon';
export interface CertificateNumberAllocator {
  allocate(poolType: CertNumberPoolType, txn: {
    run(sql: string, bind: unknown[]): Promise<{ changes: number }>;
  }): Promise<string | null>;
}
```

**CERT-R3 决策二选一**：
- 选项 A = 新迁移扩展 `id_pools` CHECK 新增 `cert_act`/`cert_svc` 并播种池
- 选项 B = 对齐生产既有 `JHCRT-SRV-*` 字母数字约定

---

## 7. 审计契约（Audit，复用既有表）

- **复用** `certificate_logs`（不新建审计表）。action CHECK：`issue|revoke|reissue|regenerate`。
- migration 0045 M4 扩展列：
  - `batch_id TEXT`：关联 `certificate_batches.public_id`（**非 FK**，避免建表顺序依赖）。
  - `result TEXT CHECK (result IS NULL OR result IN ('success','failure'))`：单次发放结果。
  - `failure_code TEXT`：失败码（如 `PDF_GEN_FAILED`）。
- 验收证书写入审计时必须带 `reason='admin_acceptance'`（复用既有 action=issue + 新增 reason 列）。

---

## 8. 批量发放契约（Batch，最小表）

**仅建表 + 计数**，不存储逐接收者 PII 快照（符合 §15）。

```sql
CREATE TABLE IF NOT EXISTS certificate_batches (
  id, public_id UNIQUE, team_id, operator_id,
  source_type, source_id,
  status CHECK(0..3),  -- 0 PENDING / 1 RUNNING / 2 COMPLETED / 3 COMPLETED_WITH_FAILURES
  total, eligible, ineligible, already_issued, issued, failed, skipped,
  created_at, started_at, completed_at
);
```

- 批量发放在 CERT-R3 由 `CertificateIssuanceService.issue()` 逐接收者调用（共享同一原语）。
- 计数用于批量结果屏与失败重试判定。

---

## 9. 模板契约（Template，冻结）

- 复用 `certificate_templates`。migration 0045 **不改动**模板表。
- 冻结 `template_id` / `version`：CERT-R3 发放时按 `(source_type, cert_kind)` 解析当前生效模板，
  不在此轮扩展。

---

## 10. 验收证书安全契约（§18）

1. 验收证书必须 `cert_kind='acceptance'` 且 `issue_reason='admin_acceptance'`。
2. 验收发放**禁止**创建任何考勤/服务时长/积分/考试行。
3. 验收证书排除出「真实参与者统计」与「服务时长汇总」。
4. 验收发放人必须是具 `certificate.certificate.issue` 权限的管理员（权限设计见 CERT-R1 §26，本轮不改角色）。

---

## 11. 向后兼容契约（legacy 413）

- 413 张生产证书（course 358 / activity 55）在 0045 应用后：
  - **业务列零修改**：`cert_no` / `user_id` / `team_id` / `source_type` / `source_id` /
    `status` / `cert_type` 均不变（fixture 以迁移前绑定快照比对证明 0 mutation）。
  - 新增列取默认值：`cert_kind='participant'`（真实语义）、`issue_reason=NULL`（域层映射
    `legacy`）、`issued_by=NULL`、`revoked_*=NULL`、`file_id` 保持原值。
  - **全部 413 行 `source_id` 为 NULL** → 全部落在新索引谓词之外，不受约束、不阻塞迁移。
- 本地 fixture 验证：`413 → 413`，`cert_no` 不变，user/source 绑定 0 mutation，8 组 dup
  保留，legacy NULL-source 行保留。

---

## 12. 共享发放服务接口（§13，CERT-R3 实现，本轮仅边界）

```ts
export interface CertificateIssuanceService {
  previewEligibility(req: {
    sourceType: PersistedSourceType; sourceId: number | null; teamId: number;
  }): Promise<CertificateEligibilityResult>;
  issue(req: CertificateIssueRequest): Promise<CertificateIssueResult>;
  // reissue / revoke 在 CERT-R5/R8 定义；本轮仅声明边界
}
```

- `issue()` 是**权威原语**，批量亦逐接收者调用。
- 调用前必须 `assertNotSystemUser(userId, isSystem)`（拒绝 `users.is_system=1`，如平台系统账号 1676）。
- 必须可被 `exam.ts submitAndMaybeIssueAtomically` **无改动事务边界**地复用（CERT-R1 §29 回归契约）。

---

## 13. 系统账号守卫

```ts
export function assertNotSystemUser(userId: number, isSystem: boolean): void {
  if (isSystem) throw new Error(`certificate issuance rejected: recipient user ${userId} is a system account`);
}
```

任何发放路径（exam 复用 / 批量 / 单发 / 验收）在写 `certificates` 前必须调用。

---

## 14. 与 CERT-R1 决策的一致性

| CERT-R1 决策 | CERT-R2 落地 |
| --- | --- |
| M1 cert_kind/issued_by/issue_reason/revoke_* | ✅ 0045 M1 |
| M2 uq_cert_user_source | ✅ 0045 M2（经生产只读核验安全） |
| M3 播种 cert_act/cert_svc 池 | ⚠️ **偏离**：本轮不播种（理由：id_pools CHECK 无 cert_act；生产用 JHCRT-SRV-* 非 pool 模式）。仅落接口，决策推迟 CERT-R3（见 §6） |
| M4 certificate_logs 扩展 | ✅ 0045 M4 |
| M5 certificate_batches 表 | ✅ 0045 M5 |
| 提取共享 issue 原语 | ⏭️ CERT-R3（本轮仅接口，§12） |
| 验收证书区分 | ✅ §2 / §10 |
| 系统账号守卫 | ✅ §13 |
| 考试发卡回归契约 | ✅ 0045 不改动 exam.ts；fixture 验证 5 步 INSERT 列清单不变 |
