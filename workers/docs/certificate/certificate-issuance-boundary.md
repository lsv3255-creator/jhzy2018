# 证书发放边界（Certificate Issuance Boundary）— CERT-R3A 架构决策冻结

> 本文档是 CERT-R3A（READ-ONLY ARCHITECTURE DECISION Gate）的权威决策冻结。
> CERT-R3B 实现必须严格遵循本文档；任何偏离需独立 Gate。
>
> 基线：WORKSPACE `/Users/Shared/projects/jhzy-v2` · BRANCH `master` · HEAD `c698e6677d1f8f7d1e7c6d402b09f837e12cf64e`
> 前置：CERT-R2 = CLOSED/PASS（commit `c698e667`）· 审计 `21-cert-r2-domain-schema-contract.md`
> 模式：**READ-ONLY ARCHITECTURE DECISION** — 无实现、无迁移、无部署、无发证。
>
> 领域契约：`certificate-domain-contract.md` · 域类型：`src/domain/certificate.ts` · 迁移：`migrations/0045_certificate_domain_contract.sql`
>
> ---
>
> ## ⚠ 后续变更告示（CERT-R3A-FIX，2026-10-03）— 本文档部分结论已被修正
>
> 本文档 §9.3 所述「0045 需源修订」**已在本 Gate 执行完成**。以下三点为**当前真相**，
> 与下文 §4.3 / §4.2 / §7 的原始措辞**不一致**，以本告示为准（分析历史保留，不改写）：
>
> | 项 | 本文档原始表述 | **当前真相（CERT-R3A-FIX 已实施）** |
> | --- | --- | --- |
> | 索引键 | `(user_id, source_type, source_id)` | **`(user_id, source_type, issue_source, source_id)`** |
> | 索引谓词 | `... AND source_id IS NOT NULL` | **`... AND issue_source IS NOT NULL AND source_id IS NOT NULL`** |
> | 判别器 | 「schema gap，待修」 | **已修**：`certificates.issue_source` 列（ADD COLUMN + CHECK） |
> | 编号格式 | 建议 `CSRV%06d`（§4.3） | **不冻结**：`EXTERNAL NUMBER FORMAT = DEFERRED_TO_CERT_R3B` |
> | 池策略 | OPTION_A（复用 `cert_srv`） | 保留，但降级为**候选**：`candidate reuse of cert_srv` |
>
> 实施细节：见 `certificate-domain-contract.md` §1.3（三层不变量）与 §5.1（精确索引契约）。
> 验证：fixture **57 pass / 0 fail**（含命名空间碰撞矩阵）；typecheck PASS；dry-run build PASS。
> 0045 仍 **NOT_APPLIED**（staging / production 均未应用）。

---

## 0. TL;DR — 三个最关键结论

| # | 结论 | 影响 |
| --- | --- | --- |
| 1 | **`ID_POOLS_REBUILD_REQUIRED = NO`**。用既有 `cert_srv` 承载 activity/service 编号，可在**零迁移**下完成 | CERT-R3B 可直接实现分配器 |
| 2 | **ACTIVITY/SERVICE 存在真实碰撞风险**：`service_records.id` 与 `activities.id` 数值空间重叠，0045 索引会把「活动#5」与「服务记录#5」判为同一成就 | **0045 需在远端 APPLY 前修正**（见 §25） |
| 3 | **DB 层无法区分 ACTIVITY 与 SERVICE**：`cert_type` CHECK 无 `service` 值，生产 55 行全为 `cert_type='activity'`，仅靠 `cert_no` 前缀区分 | 需一个判别维度（见 §11） |

---

## 1. 编号体系现状（§5 全仓追踪结果）

### 1.1 V1.0 历史体系（权威历史证据）

来源：`docs/嘉禾志愿V2.0 Phase0.4.1数据迁移前置核查报告V1.0.md` §8.2（V1.0 生产实测）

| `id_type` | available | assigned | reserved | 语义 |
| --- | --- | --- | --- | --- |
| `cert_trn` | 179,669 | 331 | — | **培训证书**编号 |
| `cert_srv` | 149,692 | 281 | 27 | **服务证书**编号 |
| `cert_hon` | 9,998 | 2 | — | **荣誉证书**编号 |
| `cert_skl` | 10,000 | — | — | 技能证书编号（**V2 未继承**） |
| `volunteer` | 99,252 | 748 | — | 志愿者编号 |

> V1.0 是**预生成编号池**设计（`status: available/assigned/reserved` + `batch_id` + `assigned_to`），
> 配套 `certificate_id_usage_log` 审计表。`id_value` 长度分布 24/17 位，**无 18 位** → 不含身份证。

### 1.2 V1.0 实际对外编号格式（权威历史格式）

来源：`docs/production-audit/P9_WP4E_R2_CERTIFICATE_CONFLICT_POLICY_DECISION_20260921.md`

```
JHCRT-TRN-<ULID8>-<ULID6>     培训证书
JHCRT-SRV-<ULID8>-<ULID6>     服务证书
```

- 分隔符为连字符；三段式（`JHCRT` / 类型 / 两段 ULID 派生串）。
- ⚠ **本节仅记录格式结构，不复制任何真实证书编号**（见文末 §14 声明）。

### 1.3 V2.0 现状（生产只读核验，`rows_written=0`）

```
SELECT pool_type, status, COUNT(*) FROM id_pools GROUP BY pool_type, status;
→ cert_trn | status=0 | 500      （唯一存在的池，全部空闲）
```

| pool_type | 声明于 CHECK | 生产行数 | 运行时消费者 | 判定 |
| --- | --- | --- | --- | --- |
| `cert_trn` | ✅ | **500（status=0）** | `exam.ts` + `certificate.ts:pickCertTrnCandidate` | **CURRENTLY_USED_BY_RUNTIME** |
| `cert_srv` | ✅ | **0** | **无** | **RESERVED**（V1.0 曾用于服务证书，V2 未播种、未消费） |
| `cert_hon` | ✅ | **0** | **无** | **RESERVED**（V1.0 曾用于荣誉证书，V2 未播种、未消费） |
| `volunteer` | ✅ | **0** | **无** | **RESERVED**（志愿者编号，与证书域无关） |
| `cert_act` | ❌ **不在 CHECK** | — | — | **不存在**（CERT-R2 已确认禁止新增） |
| `cert_skl` | ❌ 不在 CHECK | — | — | **V2 未继承** |

> 全仓搜索确认：`cert_srv` / `cert_hon` / `volunteer` 三个标识**仅出现在** `0001` 的 CHECK 约束、
> `0022` 种子守卫、CERT-R2 文档与 fixture 中，**零运行时消费代码**。
> → 它们是 **RESERVED（预留未用）**，不是 HISTORICAL_ONLY（历史专用），也非 UNKNOWN。

---

## 2. TRAINING 编号分配现状（§6 精确追踪）

### 2.1 现行路径（唯一在用的发放路径）

```
ExamService.submit (src/services/exam-service.ts:222)
  └─ certRepo.pickCertTrnCandidate()            ← 只读探测
       SELECT code FROM id_pools
        WHERE pool_type='cert_trn' AND status=0
        ORDER BY id ASC LIMIT 1                   （src/repository/certificate.ts:295-298）
  └─ ExamRepository.submitAndMaybeIssueAtomically(...)  ← 原子 batch（src/repository/exam.ts:594-758）
```

### 2.2 原子性结构（5 条语句，1 个 `db.batch`）

| # | 语句 | 守卫条件 |
| --- | --- | --- |
| 1 | `UPDATE exam_answers` ×N | session 仍 `status=1`；`needIssue` 时附「池可用 **OR** active cert 已存在」 |
| 2 | `UPDATE exam_sessions → status=3` | `status=1` **AND**（池可用 **OR** active cert 已存在） |
| 3 | `INSERT INTO certificates` | `SELECT` 谓词：session `status=3 AND passed=1` **AND** `NOT EXISTS(active cert)` **AND** 池可用 |
| 4 | `INSERT INTO certificate_logs` | `SELECT c.id WHERE c.public_id=? AND c.status=1`（read-your-writes） |
| 5 | `UPDATE id_pools SET status=1` | `pool_type='cert_trn' AND code=? AND status=0` **AND** `EXISTS(certificates.public_id=? AND status=1)` |

### 2.3 关键结论

- **格式构造**：`CTRN%06d`，在 `0022` 播种时一次性生成 500 条（`printf('CTRN%06d', x)`），**运行时不做格式构造**。
- **原子性**：编号消费与证书 INSERT 在**同一 `db.batch`** → 同事务语义。池消耗以「本批证书已生成」为条件，故证书插入失败时**不烧号**。
- **幂等**：三重保障 —— `NOT EXISTS` 谓词（应用层）+ `uq_cert_user_paper`（DB 索引）+ `cert_no UNIQUE`。
- **失败语义**：`sessionChanges===0` → 若 session 仍 `status=1` 则返回 `retryRequired=true`（池竞争，需重试）；否则视为幂等重放。
- **池耗尽**：`pickCertTrnCandidate` 返回 `null` → `needIssue=false` → 走 else 分支（仅完成 session，不发证）；上层映射 `EXAM_POOL_EXHAUSTED`。

### 2.4 复用性判定

```
TRAINING_ALLOCATOR_REUSABILITY = EXTRACTION_REQUIRED
```

理由：
- **不可 DIRECT 复用**：现有逻辑硬编码 `pool_type='cert_trn'` 字面量（5 处）+ 硬编码 `exam_paper_id` 幂等维度 + 依赖 `exam_sessions` 已 `status=3` 的前置状态。
- **不可 ADAPTER 复用**：池类型与幂等维度都不是参数化维度；adapter 需同时改写 5 条 SQL 的语义。
- **判定**：可**提取**「条件消费池编号」这一原语（`UPDATE id_pools ... WHERE pool_type=? AND code=? AND status=0 AND EXISTS(cert)`），
  但**考试编排逻辑必须留在 exam.ts**（见 §17 STRATEGY C）。

---

## 3. SERVICE / HONOR 编号历史（§7）

### 3.1 三类证据分离

| 证据类别 | 内容 | 可否升格为运行时规则 |
| --- | --- | --- |
| **CURRENT RUNTIME RULE** | **无**。V2.0 运行时零消费 `cert_srv`/`cert_hon` | — |
| **HISTORICAL IMPORT FORMAT** | V1.0 `JHCRT-TRN-*` / `JHCRT-SRV-*`（ULID 派生三段式）；V1.0 曾以 `cert_srv` 池承载服务证书编号 | **不可直接升格**（见 3.2） |
| **DESIGN-ONLY DOCUMENTATION** | CERT-R1 `CACT%06d`（新池 `cert_act`）；架构基线「荣誉证书——管理员手动授予（留痕）」 | **不可升格**（design-only） |

### 3.2 为何不把历史格式升格为新运行时规则

1. **CHECK 阻断**：`cert_srv` 在 CHECK 内但**生产池为空**；用历史 ULID 派生格式需**逐条生成**而非池消费，丧失「预生成池 + 原子消费」的既有并发模型。
2. **与现状断裂**：V2.0 现行唯一运行格式是 `CTRN%06d`（`id_pools` pool code 模式）。历史 `JHCRT-*` 是 V1.0 PHP 生成、迁移时作 `cert_no` 字面量带入的**存量值**，不是可续用的分配机制。
3. **P9 冲突史**：`JHCRT-SRV-*` / `JHCRT-TRN-*` 在迁移中已产生 5 例 `cert_no` 碰撞（`same cert_no, different person/activity`），全部按 `ARCHIVE_ONLY` 处理 —— 说明该格式存在**历史唯一性缺陷**，不宜作为新规则地基。
4. **CERT-R1 自身定性**：`CACT%06d` 被 CERT-R1 标为 design-only 且与生产现实冲突。

> 结论：`HISTORICAL_SERVICE_FORMAT` 仅作**兼容性理解**，不构成新规则。

---

## 4. ACTIVITY 编号格式决策（§8 解决 CERT-R2 的 DEFERRED）

### 4.1 候选方案逐维评估

| 维度 | OPTION A<br>复用 `cert_srv` | OPTION B<br>新建 `cert_act` 池 | OPTION C<br>语义类共享分配器 |
| --- | --- | --- | --- |
| 现有 schema 兼容 | ✅ **CHECK 已允许** | ❌ 违反 CHECK | ✅ 仅用既有池 |
| 需要迁移 | **NO** | **YES**（须扩 CHECK → 重建表） | **NO** |
| 碰撞安全 | ✅ 独立池段 | ✅ | ⚠ 见 §25 碰撞分析 |
| 可读性 | ✅ `JHCRT-SRV-*` 段可辨识 | ✅ | ✅ |
| 未来扩展 | ⚠ 活动/服务同池后不可再分 | ✅ 最灵活 | ✅ |
| 历史兼容 | ✅ 复用 V1.0 语义 | ⚠ 新造语义 | ✅ |
| 事务安全 | ✅ 池消费原子性直接复用 | ✅ | ✅ |
| 运维复杂度 | ✅ **最低**（零新对象） | ⚠ 迁移 + 播种 + 运维 | ✅ |
| 人为可读前缀 | ✅ 与 V1.0 一致 | — | ✅ |

### 4.2 冻结决策

```
ACTIVITY_NUMBER_STRATEGY = OPTION_A（复用既有 cert_srv 池承载 activity/service 编号）
ACTIVITY_NUMBER_FORMAT    = 由 cert_srv 池的 code 形态决定；池为空，需在 CERT-R3B
                            以「与 CTRN 同构的确定性种子」播种（见 §4.3）
SERVICE_NUMBER_STRATEGY   = OPTION_A（同一 cert_srv 池；SERVICE 与 ACTIVITY 共用编号段）
ID_POOLS_REBUILD_REQUIRED = NO
```

**理由**：
- `cert_srv` 是 V1.0 **既有的服务证书语义池**（历史权威），复用它**零迁移**实现分配器。
- 新建 `cert_act` 需扩展 CHECK → **重建 `id_pools` 表**，直接违反 CERT-R2 冻结的不变式与强偏好。
- 活动与服务**共用** `cert_srv` 编号段是可接受的：二者在业务上同属「志愿服务成就」，
  且**判别不依赖编号段**（见 §11），编号段仅保证唯一性与可读性。

### 4.3 播种形态决策（重要）

**不得**直接沿用 V1.0 的 `JHCRT-SRV-<ULID>` 形态作为池 code（理由见 §3.2）。
冻结：**`cert_srv` 池 code 采用与 `cert_trn` 同构的确定性前缀序列**，形如 `CSRV%06d`，
由 CERT-R3B 的**独立种子迁移**（非 0045）以 `WHERE NOT EXISTS(...)` 幂等守卫播种。

> ⚠ 该种子**不是** 0045 的一部分，0045 保持 SOURCE FROZEN。播种属 CERT-R3B/后续独立迁移 Gate。
> CERT-R3A 仅冻结「同构前缀 + 幂等守卫」这一形态要求，不写入任何 SQL。

### 4.4 ACCEPTANCE 编号决策（§10）

```
ACCEPTANCE_NUMBER_STRATEGY = OPTION_B（独立非生产命名空间，不消耗真实成就编号）
```

冻结要求：
1. 验收证书**不消耗** `cert_trn` / `cert_srv` 任何编号。
2. 其编号必须落在**明确可识别为非生产成就**的命名空间（建议 `ACCEPT-<batchPublicId>-<seq>` 形态，
   或独立 `cert_acc` 池 —— 但后者需 CHECK 扩展，**故优先前者**）。
3. 结构上必须可由 `cert_kind='acceptance'` 判别（0045 已提供该列）。
4. 绝不可与真实证书编号碰撞（`cert_no` UNIQUE 保证；命名空间前缀保证语义隔离）。
5. 验收证书**不得**被公开验真视为真实成就（见 §22）。

---

## 5. id_pools 约束评估（§9）

```
ID_POOLS_REBUILD_REQUIRED = NO
```

- 目标设计（`cert_trn` + `cert_srv` 两个池）**完全落在既有 CHECK 内**：
  `('cert_trn','cert_srv','cert_hon','volunteer')`。
- **无需**重建表、**无需**改 CHECK、**无需**新增 `cert_act`。
- 未来若确需 `cert_act`，则需独立迁移 Gate（**CERT-R3A 不创建**）。

---

## 6. 域 SOURCE vs 持久化 SOURCE（§11）

### 6.1 现状映射（CERT-R2 冻结）

| 域概念 | 持久化 `source_type` |
| --- | --- |
| `TRAINING_EXAM` | `'exam'` |
| `COURSE` | `'course'` |
| `ACTIVITY` | `'activity'` |
| `SERVICE` | `'activity'` ← **碰撞点** |
| `MANUAL` | `'manual'` |

### 6.2 判别能力实测（生产只读）

```sql
SELECT source_type, cert_type, COUNT(*), SUM(source_id IS NULL)
  FROM certificates GROUP BY source_type, cert_type;
→ activity | activity | 55 | 55     ← 55 行 service 形状全部 cert_type='activity'
→ course   | training | 358 | 358
```

`certificates` 全部可用列：`id, public_id, cert_no, verify_code, template_id, user_id, team_id,
cert_type, source_type, source_id, holder_name, issuer_name, snapshot, file_id, issued_at, status,
created_at, updated_at, exam_paper_id(0022), cert_kind/issued_by/issue_reason/revoked_*(0045)`。

### 6.3 关键问题回答

> **服务如何从 DB 读回后区分 ACTIVITY 与 SERVICE？**

**答：当前无法用任何结构化列可靠区分。** 逐列排除：

| 候选判别器 | 能否区分 | 证据 |
| --- | --- | --- |
| `source_type` | ❌ | 二者同为 `'activity'` |
| `cert_type` | ❌ | CHECK 仅 `('training','activity','honor')`，**无 `service`**；生产 55 行皆 `'activity'` |
| `cert_kind` | ❌ | 只有 participant/acceptance，与 service 无关 |
| `issue_reason` | ❌ | 是发放**原因**（normal/reissue/...），非来源判别；语义被 §3 纪律禁止混用 |
| `snapshot` JSON | ⚠ 可行但脆弱 | 运行时**从未填充**（exam 路径传 `snapshotCert` 但生产无值）；非结构化、不可索引、无约束 |
| `cert_no` 前缀 | ⚠ **当前唯一可用**，但非结构化 | 存量 55 行靠 `JHCRT-SRV-*` 区分；新发若用 `CSRV%06d` 则前缀语义变化 |
| `template_id` | ⚠ 间接 | 模板绑定 `cert_type`，而 `cert_type` 本身无 service 语义 |

### 6.4 冻结决策

```
DOMAIN_SOURCE_PERSISTENCE_DECISION =
  维持 CERT-R2 映射（source_type 不新增取值）；
  ACTIVITY/SERVICE 的判别【不】依赖 source_type，改由 §11.2 的 cert_kind 扩展位或编号池段承担。

ACTIVITY_SERVICE_DISCRIMINATOR =
  【当前无结构化判别器 —— 这是必须修复的 schema gap】
```

**结论：存在 schema gap。** CERT-R2 §6 曾断言「前缀已足以区分」，本轮追踪证明该断言**不成立**：
前缀是字符串约定，无 DB 约束、无索引支持、且新发编号形态（`CSRV%06d`）与历史前缀（`JHCRT-SRV-*`）
不同族，无法作为稳定判别器。

---

## 7. 判别器方案（§11 收口）

三个候选，按可靠性排序：

| 方案 | 机制 | 迁移代价 | 评价 |
| --- | --- | --- | --- |
| **G1 `source_type` 新增 `'service'`** | 最自然 | 需改 CHECK → 重建 `certificates`（413 行） | ❌ 违反 ADDITIVE，代价最高 |
| **G2 新增 `issue_source` 列**（`'activity'\|'service'`） | 独立判别列 | `ADD COLUMN` 即可，**ADDITIVE** | ✅ **推荐** |
| **G3 复用 `cert_type` 新增 `'service'`** | 复用既有列 | 需改 CHECK → 重建 | ❌ 同 G1 |

### 7.1 冻结决策

```
判别器 = G2：新增 certificates.issue_source TEXT
          CHECK (issue_source IS NULL OR issue_source IN ('activity','service'))
          DEFAULT NULL（历史 413 行保持 NULL，不改写、不伪造）

- 域 SERVICE  → issue_source='service'
- 域 ACTIVITY → issue_source='activity'
- 历史行     → NULL（域层映射为 LEGACY_UNSPECIFIED，不猜测）
- source_type 保持 'activity' 不变（幂等索引契约不受影响）
```

**为何 G2 而非 G1/G3**：
- `ADD COLUMN ... CHECK` 在 SQLite/D1 上是**纯增量**（0045 已用同一模式验证：6×ADD COLUMN 全部成功）。
- 不触达 413 行、不重建表、不改 `source_type` 语义 → **0045 幂等索引与该列正交**。
- 独立列可被索引/查询，不依赖字符串前缀约定。

### 7.2 与 §25 修正的关系

`issue_source` **同时**解决 §13 碰撞问题（见下节）：幂等键可改为包含 `issue_source`。

---

## 8. SOURCE_ID 契约（§12）

**统一纪律：新建的成就类证书不得静默产生 `source_id=NULL`。** 生产 413 行全 NULL 是**历史事实**，
未来发放必须携带权威 source identity（否则幂等保护形同虚设）。

| 域 | `source_type` | `source_id` 语义 | 必填 | 逻辑实体 | FK 可行性 |
| --- | --- | --- | --- | --- | --- |
| `TRAINING_EXAM` | `'exam'` | `exam_sessions.id` | **是** | `exam_sessions` | ❌ 多态；已有专用 `exam_paper_id` FK 承载归属 |
| `ACTIVITY` | `'activity'` | `activities.id` | **是** | `activities` | ❌ 多态（列无 FK） |
| `SERVICE` | `'activity'` | `service_records.id` | **是** | `service_records` | ❌ 多态（列无 FK） |
| `ACCEPTANCE` | `'manual'` | `NULL`（无成就来源） | **否**（必须为 NULL） | — | — |
| `COURSE`(legacy) | `'course'` | 历史 NULL | — | — | — |

**为何保持多态、应用层校验**：`certificates.source_id` 是**多态引用**（可能指向 `activities` /
`exam_sessions` / `service_records`），SQLite 无法对多态列建 FK。故：
- DB 层：靠 `uq_cert_user_source` 索引 + CHECK 保证形状；
- 应用层：`issue()` 原语**必须**在事务内校验 `source_id` 在对应实体表中真实存在（`SOURCE_NOT_FOUND`）。

---

## 9. 幂等契约充分性（§13 — HARD DECISION）

### 9.1 碰撞可能性判定

> **活动证书与服务证书能否因相同 `source_id` 与相同 user 而碰撞？**

**答：能。** 证据链：

1. 二者 `source_type` 同为 `'activity'`。
2. `activities.id` 与 `service_records.id` 是**两个独立表的独立 INTEGER PRIMARY KEY** →
   **数值空间天然重叠**。
3. `service_records.activity_id` 指向 `activities.id`，说明服务记录本身是「某活动的服务记录」，
   其 `id` 与 `activities.id` 无任何全局唯一性关联。

**具体失效场景**（同一 user）：

| 证书 | source_type | issue_source | source_id | 实际成就 | 0045 索引判定 |
| --- | --- | --- | --- | --- | --- |
| 活动证书 | `'activity'` | （无此列） | `activities.id = 5` | 参加活动 #5 | 索引键 = `(user, 'activity', 5)` |
| 服务证书 | `'activity'` | （无此列） | `service_records.id = 5` | 在活动 #3 服务 5 次 | **同键 → 被误判为重复** |

**结论**：`0045_IDEMPOTENCY_SUFFICIENT = NO`（对未来的域模型而言）。
生产当前冲突数为 0 仅因**存量全部 `source_id=NULL`**，新发一旦携带 `source_id` 即刻暴露该风险。

### 9.2 方案评估

| 方案 | 说明 | 判定 |
| --- | --- | --- |
| 源 ID 命名空间全局不相交 | 给 service 用独立 ID 段（如负数或偏移） | ❌ 脆弱、不可维护、非 schema 保证 |
| 源 ID 来自同一张表 | 令 service 证书 `source_id` 也指向 `activities.id` | ⚠ 部分可行：**一个活动可产生多张服务证书**，会误判重复 |
| 需额外判别列 | 幂等键纳入 `issue_source` | ✅ **采纳** |
| service 是 activity 子类型 | 域模型简化，service 不再独立 | ❌ 与 V1.0「服务证书」独立语义及 55 行存量冲突 |
| 简化域模型 | 取消 SERVICE 域概念 | ❌ 丢失业务语义，不采纳 |

### 9.3 冻结决策 + 0045 修正

```
0045_IDEMPOTENCY_SUFFICIENT = NO
0045_ADEQUACY = SOURCE_AMENDMENT_REQUIRED_BEFORE_REMOTE_APPLY

0045_REQUIRED_CORRECTION（最小修正）：
  将 M2 索引的判别维度纳入 service/activity 区分，最小形式为——
    1) 新增 certificates.issue_source 列（ADD COLUMN + CHECK，ADDITIVE，不改写历史）
    2) 将 uq_cert_user_source 改为纳入该列：
         CREATE UNIQUE INDEX uq_cert_user_source
           ON certificates(user_id, source_type, source_id)
          WHERE status = 1 AND source_type = 'activity'
            AND source_id IS NOT NULL
            AND COALESCE(issue_source,'activity') = issue_source   -- 或等价写法

  等价且更简的替代：将 issue_source 纳入索引列
         ON certificates(user_id, source_type, issue_source, source_id)

  ⚠ 具体 DDL 属独立「0045 源修订 Gate」，CERT-R3A 不编辑 0045。
  ⚠ 修订后必须重跑：生产只读冲突核验（谓词须逐字匹配新索引）+ CERT-R2 fixture。
```

> **重要**：因生产 413/413 行 `source_id IS NULL` 且冲突数为 0，**该修正不影响任何存量行**；
> 纯粹是为未来新发证书的正确性。修正窗口充足（0045 尚未远端应用）。

---

## 10. 事务边界（§14）

### 10.1 TX_PHASE（必须原子，单 `db.batch`）

| 序 | 步骤 | 机制 |
| --- | --- | --- |
| 1 | 资格复核（eligibility recheck） | 同一 batch 内的 `EXISTS`/`NOT EXISTS` 谓词（照抄 exam 模式） |
| 2 | 幂等检查 | `NOT EXISTS(active cert for same key)` |
| 3 | 编号消费 | `UPDATE id_pools SET status=1, assigned_to=?, assigned_at=? WHERE pool_type=? AND code=? AND status=0` |
| 4 | 证书 INSERT | `INSERT ... SELECT ... WHERE <guards>` （条件插入） |
| 5 | 审计 INSERT | `INSERT INTO certificate_logs ... SELECT c.id FROM certificates c WHERE c.public_id=?`（read-your-writes） |

**D1 兼容机制：`db.batch()` + 条件 `UPDATE`/`INSERT...SELECT` + 派生 `EXISTS` 守卫。**
沿用 `exam.ts:738` 的既有模式 —— 与 CERT-R1 §29 回归契约一致。
**不使用** `INSERT ... RETURNING`（现有代码库无此先例，保守起见不引入新机制）。
**不使用**显式 `BEGIN/COMMIT`（D1 `batch` 本身即事务单元）。

### 10.2 编号消费的守卫（关键）

沿用 exam 的**依赖子查询**模式，使「证书未生成则不烧号」：

```sql
UPDATE id_pools SET status=1, assigned_to=?, assigned_at=?
 WHERE pool_type=? AND code=? AND status=0
   AND EXISTS (SELECT 1 FROM certificates c WHERE c.public_id=? AND c.status=1)
```

### 10.3 POST_TX_PHASE（事务外，绝不参与原子性）

| 序 | 步骤 | 失败处理 |
| --- | --- | --- |
| 1 | PDF 生成 | 独立；失败记 `certificate_logs.failure_code='PDF_GEN_FAILED'`，证书保持 `status=1` |
| 2 | R2 上传 | 同上 |
| 3 | `files` 行 + `certificates.file_id` 回填 | 失败不改证书有效性 |
| 4 | 响应构造 | — |

> **PDF/R2 绝不进入 D1 事务**：外部存储无法参与 D1 原子提交。文件状态由
> `deriveFileStatus()` 从 `file_id` 推导（0045 无新增列）。

---

## 11. 编号消耗失败语义（§15）

| 场景 | 可否复用该编号 | 冻结行为 |
| --- | --- | --- |
| 分配成功、证书 INSERT 失败 | **可复用** | 池消耗以 `EXISTS(cert)` 为守卫 → 同 batch 回滚，号未被烧 |
| 证书成功、审计 INSERT 失败 | 不可复用 | 同 batch 回滚（证书与审计同事务）→ 号随证书一起回滚 |
| D1 提交后 Worker 崩溃（未响应） | 不可复用 | 证书与号已同时提交；客户端重试命中 `ALREADY_ISSUED` → 返回既有证书，**不重发号** |
| 客户端重试 | 不可复用 | 幂等键命中 → `ALREADY_ISSUED` |
| 事务成功后 PDF 失败 | 不可复用 | 证书有效，仅文件状态 `FAILED`（记日志） |

```
NUMBER_GAP_POLICY = 允许有「空洞」(gaps)，但绝不允许「重复」或「重新分配」(never duplicate, never reassign)。
                   空洞来源：事务回滚后池行回到 status=0（被下个请求复用，不产生空洞）；
                   真正的空洞仅来自 max(id) 已被占用但批次失败且池行状态未回退的极端情况 —— 可接受。
                   正确性优先于消除空洞。
```

---

## 12. 现有考试写入者的提取边界（§16）

| 关注点 | 分类 | 说明 |
| --- | --- | --- |
| 考试结果 / 判分 | **KEEP_IN_EXAM** | 与证书无关 |
| pass/fail 计算 | **KEEP_IN_EXAM** | 业务规则 |
| 证书资格判定 | **KEEP_IN_EXAM** | 「重考不发第二张」是考试域规则 |
| 事务编排（answers+session 同批） | **KEEP_IN_EXAM** | 考试不变量，**绝不可拆**（§P32-P2 §11：绝不允许「答案已定稿 + 无证书」中间态） |
| **条件消费池编号**原语 | **EXTRACT_TO_SHARED_SERVICE** | 参数化 `pool_type`，供共享原语复用 |
| 证书 INSERT（条件谓词构造） | **ADAPT_TO_SHARED_PRIMITIVE** | 幂等维度不同（`exam_paper_id` → `source_id`+`issue_source`） |
| 审计 INSERT | **ADAPT_TO_SHARED_PRIMITIVE** | 加上 `result`/`batch_id` 填充 |
| 响应格式化 | **KEEP_IN_EXAM** | — |
| 已有 DEBUG console.error 行 | **DO_NOT_TOUCH_YET** | 位于 HEAD 既有代码（commit `cdd0e5f`），非 CERT-R2 引入；本轮不改 |

---

## 13. 考试迁移策略（§17）

| 策略 | 回归风险 | 长期重复风险 | 判定 |
| --- | --- | --- | --- |
| **A** 先建共享服务供新发放，考试原封不动 | **最低** | 中（两套逻辑并存一段时间） | 备选 |
| **B** 立即把考试搬到共享服务 | **最高** | 最低 | ❌ 违反 CERT-R1 §29 回归契约 |
| **C** 仅提取分配/持久化原语，考试编排保持完整 | **低** | 低 | ✅ **采纳** |

```
EXAM_EXTRACTION_STRATEGY = C
```

理由：策略 C 让 `issue()` 原语内部复用「条件消费池编号」与「审计 INSERT」两块，
**但不移动考试的 5 条语句编排**（事务边界与不变量完全不变）→ 考试行为零变更，
同时避免长期存在两套发证逻辑。

---

## 14. CERT-R3B 冻结接口（§18/§19）

### 14.1 CertificateIssueRequest

```ts
interface CertificateIssueRequest {
  recipientUserId: number;          // 非 PII（内部 FK）
  teamId: number;
  domainSource: CertificateSource;  // 域概念（非持久化取值）
  sourceId: number | null;          // 成就类必填；ACCEPTANCE 必须为 null
  certificateKind: CertificateKind; // participant | acceptance
  issuanceReason: IssuanceReason;
  templateId: number | null;        // 未指定则按 (source, kind) 解析
  operatorUserId: number;           // 授权操作者
  batchPublicId?: string;           // 批量上下文（可空）
  skipPdf?: boolean;                // 默认 false
  issuedByPublicId?: string;        // 预生成 public_id（ULID），保证幂等重放
  verifyCode?: string;
  snapshot?: string | null;         // 结构化，禁含 PII
}
```

> **不暴露 PII**：`holder_name` / `issuer_name` 不在请求内，由服务端从 `users` 派生或留空。

### 14.2 CertificateIssueResult

```ts
type CertificateIssueOutcome = 'issued' | 'alreadyIssued';

interface CertificateIssueResult {
  outcome: CertificateIssueOutcome;
  certificateId?: number;            // 内部 FK，不入响应体
  certificatePublicId?: string;      // 对外
  certificateNo?: string;            // 验收证书不返回
  fileStatus: CertificateFileStatus;
  failureCode?: CertificateFailureCode;
}
```

### 14.3 错误契约（沿用 `utils/errors.ts` 约定）

```
NOT_ELIGIBLE            业务预期（返回 ineligible，不抛异常）
ALREADY_ISSUED          业务预期（outcome='alreadyIssued'，非错误）
SOURCE_NOT_FOUND        业务预期（sourceId 在实体表中不存在）
SOURCE_ID_REQUIRED      业务预期（成就类证书缺 sourceId）
NUMBER_POOL_EXHAUSTED   业务预期（映射既有 EXAM_POOL_EXHAUSTED 同族）
NUMBER_ALLOCATION_FAILED  内部异常
CERTIFICATE_INSERT_FAILED   内部异常
AUDIT_FAILED            内部异常
UNAUTHORIZED            路由层抛（见 §20）
```

> 约定对齐：既有 `ConflictReason` 使用**小写蛇形**（`exam_pool_exhausted`），
> `ErrorCode` 使用**大写**。CERT-R3B 沿用：对外 reason 小写、内部 code 大写。
> **预期业务结果与内部异常严格分离**：前 4 项为正常返回路径，不进 catch。

---

## 15. 授权边界（§20）

| 层 | 职责 |
| --- | --- |
| **路由层** | 鉴权 + 授权（`certificate.certificate.issue` / `.issue.batch`）；**唯一**做权限判定处 |
| **服务层** | 上下文作用域校验（`teamId` 与操作者授权范围一致）+ `assertNotSystemUser` |
| **仓储层** | 信任服务层；不重复鉴权（`ensureTableRead` 仅防跨租户表误读） |

- 角色：`team_owner` / `team_admin` 可为本团队发放；`platform_super_admin` 可跨团队。
- **不授予 `platform_operator` 发放权**（沿用 CERT-R1 §27 决策；本轮**不改 RBAC**）。
- 共享域服务**不得**成为授权旁路：服务层**不**自行判定权限，但**必须**校验
  `teamId ∈ 操作者授权范围`，否则路由层的粗粒度授权会被穿透。

---

## 16. 验收模式边界（§21）

- 未来验收发放**不要求** signup / attendance / hours / points / exam pass。
- **必须**满足：`cert_kind='acceptance'` + `issue_reason='admin_acceptance'` +
  授权操作者 + `source_id IS NULL` + 非生产成就语义。
- **禁止**创建任何考勤/服务时长/积分/考试行（硬约束，0045 契约）。
- **是否出现在「我的证书」：默认 NO**（除非产品显式批准）。
  理由：验收证书不是真实成就，混入用户证书列表会误导；`cert_kind` 已提供结构化过滤能力。

---

## 17. 公开验真边界（§22）

现状实测（**只读发现，非本轮修复**）：`CertificateRepository.queryVerifyRow` 的 SQL
**未按 `status` 过滤**，且 `LEFT JOIN activities ON c.source_id = a.id` 会对 SERVICE 行
**错误解析出活动标题与服务时长**。

冻结建议：

| 证书类别 | 公开验真 | 理由 |
| --- | --- | --- |
| `ADMIN_ACCEPTANCE` | **NO** | 非生产成就，不得被公开验证为真实荣誉 |
| `status=2`（revoked） | **NO**（应显示「已撤销」） | 现行为会公开显示有效证书，构成事实性错误 |
| file-pending | **YES** | 证书本身有效；文件状态与证书有效性解耦 |
| 正常 participant | YES（现状） | 保持 |

> 这些是**建议**，落地属 CERT-R3B+ 的 verify 路由变更，**本轮不改 verify 路由**。
> 已登记为技术债：`VERIFY_STATUS_FILTER_MISSING`。

---

## 18. PDF 边界（§23）

```
1. D1 事务提交（证书 + 审计 + 编号）   ← 权威，原子
2. API 响应返回（fileStatus=PENDING）  ← 不等 PDF
3. PDF 生成（事务外）
4. R2 上传（事务外）
5. files 行创建 + certificates.file_id 回填 → fileStatus=READY
```

- 发放 API **在 PDF READY 之前即返回**（`fileStatus='pending'`）。
- 重试：`PDF_GEN_FAILED` 记 `certificate_logs.failure_code`；重跑只做步骤 3–5，**不重发编号、不重发证书**。
- 证书有效性**不依赖** PDF 成功。

---

## 19. 批量边界（§24）

```
BATCH_BOUNDARY = per-recipient 原子发放 + 持久化批次聚合
```

- 批量**必须**逐接收者调用**同一** `issue()` 原语（不另写批量专用发放逻辑）。
- **每接收者独立事务**（避免单点失败回滚整批）。
- 重试模型：批次表 `certificate_batches` 记录计数（`issued`/`failed`/`skipped`/`already_issued`），
  失败项按 `failure_code` 分类重试；**重试不重复消耗编号**（幂等键命中）。
- 部分失败语义：批次 `status=3`（COMPLETED_WITH_FAILURES），已成功者不回滚。
- 批次表**不存逐接收者 PII 快照**（0045 已定）。

---

## 20. CERT-R3B 实施范围（§26）

**纳入**：
- `CertificateNumberAllocator` 实现（`cert_trn` / `cert_srv` 两池，条件消费）
- `CertificateIssuanceService.issue()` + `previewEligibility()`
- 仓储原语：条件 INSERT、审计 INSERT、池消费
- 活动/服务**合成**发放本地测试 + 碰撞回归测试
- `cert_srv` 池种子迁移（独立迁移文件，幂等守卫，**不改 0045**）

**排除**（明确不做）：远端迁移 APPLY · 管理员路由 · 前端 · PDF 渲染器 · 批量引擎 · RBAC 变更

预期文件：`src/services/certificate-issuance-service.ts`（新）·
`src/repository/certificate-allocator.ts`（新）· `src/repository/certificate.ts`（扩展）·
`migrations/0046_*.sql`（`cert_srv` 种子，独立 Gate）· `tests/cert_r3_*.mjs`（新）

**前置依赖**：§9.3 的 0045 源修订（`issue_source`）**必须先完成**，
否则 activity/service 幂等无法正确实现。

---

## 21. 数据保护声明（§28）

本文档仅记录**聚合与结构性事实**。未包含：真实证书编号、接收者 ID、姓名、手机号、
OpenID、身份证、生产连接串。历史格式以**结构描述**呈现（`JHCRT-<TYPE>-<ULID8>-<ULID6>` 模式）。
