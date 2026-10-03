# 22 — CERT-R3A: Certificate Number Allocation & Issuance Boundary Decision

> 前置 Gate：CERT-R2 = CLOSED/PASS（commit `c698e6677d1f8f7d1e7c6d402b09f837e12cf64e`）
> 权威决策文档：`docs/certificate/certificate-issuance-boundary.md`
> 模式：**READ-ONLY ARCHITECTURE DECISION**
> **禁止**：改源码 / 改迁移 / 建迁移 / APPLY 0045 / 写生产或预发 D1 / 部署 / 改 Secret / 改 Keychain /
> 改 RBAC / 真实发证 / 生成或上传 PDF / commit / push / 触碰 JHZY 1.0 / 清理无关脏工作区。
> 本 Gate **无任何实现**，仅产出 2 份文档（§27 允许的唯一写入）。

---

## 0. 后续变更告示（CERT-R3A-FIX，2026-10-03）— 本文档 §9.3 的修正要求已实施

本文档 §9.3 判定 `0045_ADEQUACY = SOURCE_AMENDMENT_REQUIRED_BEFORE_REMOTE_APPLY`，
并给出最小修正方案。**该修正已于 CERT-R3A-FIX Gate 实施完成**（分析历史保留，不改写）：

| 项 | 本文档原始结论 | **当前真相** |
| --- | --- | --- |
| 判别器 | G2 建议新增 `issue_source` | ✅ **已实施**：`ADD COLUMN issue_source TEXT CHECK (... IN ('activity','service'))` |
| 索引键 | 建议纳入 `issue_source` | ✅ **已实施**：`(user_id, source_type, issue_source, source_id)` |
| 索引谓词 | 建议加 `issue_source IS NOT NULL` | ✅ **已实施**：双 `IS NOT NULL` 排除 |
| 修正方式 | 「属独立 0045 源修订 Gate」 | ✅ **直接改写 0045 源文件**（未新增 0046，无 `DROP INDEX` 编排） |
| `ACTIVITY_NUMBER_FORMAT` | OPTION_A 建议 `CSRV%06d` | ⚠️ **治理更正**：`EXTERNAL NUMBER_FORMAT = DEFERRED_TO_CERT_R3B`；池策略降级为 `candidate reuse of cert_srv` |

- 0045 仍 **NOT_APPLIED**（staging / production 均未应用），修正窗口仍然有效。
- commit `c698e667` 保留原三列契约作为**历史证据**，未被 amend。
- 验证：fixture **57 pass / 0 fail**（新增 9 项命名空间碰撞测试）；typecheck PASS；dry-run PASS。


---

## 1. Workspace Gate（§3）— PASS

| 项 | 要求 | 实测 |
| --- | --- | --- |
| pwd | `/Users/Shared/projects/jhzy-v2` | ✅ 一致 |
| branch | `master` | ✅ `master` |
| HEAD | `c698e6677d1f8f7d1e7c6d402b09f837e12cf64e` | ✅ 精确一致 |
| staged | 0 | ✅ 0 |
| tracked `.var` | 0 | ✅ 0 |

> HEAD 与预期完全一致，未触发 STOP。脏工作区允许存在（`workers/` 44 + `miniprogram/` 287 项
> 既有并行改动），**本轮未触碰、未清理**。

---

## 2. CERT-R2 契约装载（§4）— COMPLETE

全量通读（非记忆）以下 4 份冻结产物：

| 产物 | 装载 |
| --- | --- |
| `workers/docs/certificate/certificate-domain-contract.md` | ✅ 全文 |
| `workers/docs/audits/2026-10-03-post-cutover-assurance/21-cert-r2-domain-schema-contract.md` | ✅ 全文 |
| `workers/migrations/0045_certificate_domain_contract.sql` | ✅ 全文（113 行） |
| `workers/src/domain/certificate.ts` | ✅ 全文（246 行） |

抽取（未重解释）并作为本轮推理基线：`CertificateSource` / 持久化 source 兼容层 /
`CertificateKind` / `IssuanceReason` / `CertificateFileStatus` / `CertificateNumberAllocator` /
`CertificateIssuanceService` / 幂等契约 / 验收语义 / 批量语义 / 审计语义。

---

## 3. 编号体系全仓盘点（§5）

### 3.1 发现：V1.0 曾有 5 池预生成编号体系

来源：`docs/嘉禾志愿V2.0 Phase0.4.1数据迁移前置核查报告V1.0.md` §8.2（V1.0 生产实测）

| `id_type` | available | assigned | reserved |
| --- | --- | --- | --- |
| `cert_trn` | 179,669 | 331 | — |
| `cert_srv` | 149,692 | 281 | 27 |
| `cert_hon` | 9,998 | 2 | — |
| `cert_skl` | 10,000 | — | — |
| `volunteer` | 99,252 | 748 | — |

### 3.2 池状态判定（不靠名字推测）

生产只读核验：`SELECT pool_type, status, COUNT(*) FROM id_pools GROUP BY pool_type, status`
→ **仅 `cert_trn | status=0 | 500`**。

| pool_type | CHECK 内 | 生产行数 | 运行时消费者 | **判定** |
| --- | --- | --- | --- | --- |
| `cert_trn` | ✅ | 500 | `exam-service.ts:222` + `certificate.ts:295` | **CURRENTLY_USED_BY_RUNTIME** |
| `cert_srv` | ✅ | **0** | **无** | **RESERVED**（V1.0 服务证书语义，V2 未播种） |
| `cert_hon` | ✅ | **0** | **无** | **RESERVED**（V1.0 荣誉证书语义） |
| `volunteer` | ✅ | **0** | **无** | **RESERVED**（志愿者编号，非证书域） |
| `cert_act` | ❌ 不在 CHECK | — | — | **不存在** |
| `cert_skl` | ❌ 不在 CHECK | — | — | **V2 未继承** |

> 全仓搜索证实：`cert_srv` / `cert_hon` / `volunteer` **仅出现在** 0001 CHECK、0022 种子守卫、
> CERT-R2 文档与 fixture 中，**零运行时消费代码** → 是 RESERVED，非 HISTORICAL_ONLY / UNKNOWN。

---

## 4. TRAINING 分配追踪（§6）

- **池选择**：`pickCertTrnCandidate()`（`src/repository/certificate.ts:295-298`）只读探测
  `WHERE pool_type='cert_trn' AND status=0 ORDER BY id ASC LIMIT 1`。
- **格式构造**：`CTRN%06d`，在 `0022` 播种时一次性生成，**运行时零构造**。
- **原子性**：编号消费与证书 INSERT 在**同一 `db.batch()`**（`exam.ts:738`），5 条语句。
- **失败语义**：池消耗以 `EXISTS(certificates.public_id=? AND status=1)` 为守卫 →
  证书未生成则不烧号；`sessionChanges===0` 且 session 仍 `status=1` → `retryRequired=true`。
- **池耗尽**：候选为 `null` → `needIssue=false` → 仅完成 session；上层 `EXAM_POOL_EXHAUSTED`。
- **是否同事务**：**是**（同一 batch 即同一 D1 事务单元）。

```
TRAINING_ALLOCATOR_REUSABILITY = EXTRACTION_REQUIRED
```

不可 DIRECT（硬编码 `pool_type='cert_trn'` 5 处 + `exam_paper_id` 幂等维度 +
依赖 session 已 `status=3`）；不可 ADAPTER（池类型与幂等维度均非参数化）。

---

## 5. SERVICE / HONOR 编号历史（§7）

三类证据严格分离：

| 类别 | 内容 | 可否升格为运行时规则 |
| --- | --- | --- |
| **CURRENT RUNTIME RULE** | **不存在**（V2 运行时零消费） | — |
| **HISTORICAL IMPORT FORMAT** | V1.0 `JHCRT-TRN-<ULID8>-<ULID6>` / `JHCRT-SRV-<ULID8>-<ULID6>`（连字符三段式）；`cert_srv` 池曾承载服务证书编号 | **否**（见下） |
| **DESIGN-ONLY** | CERT-R1 `CACT%06d` + 新池 `cert_act`；基线文档「荣誉证书——管理员手动授予」 | **否** |

不升格的 4 条理由：① `cert_srv` 池在 V2 为空，ULID 派生需逐条生成，丧失池并发模型；
② V2 现行唯一格式是 pool code 模式（`CTRN%06d`），历史值是迁移带入的**存量字面量**；
③ `P9_WP4E_R2_CERTIFICATE_CONFLICT_POLICY_DECISION_20260921.md` 记录该格式在迁移中已产生
**5 例 `cert_no` 碰撞**（同号不同人/活动），全部 `ARCHIVE_ONLY` → 存在历史唯一性缺陷；
④ CERT-R1 自身将 `CACT%06d` 标为 design-only。

---

## 6. ACTIVITY 编号决策（§8 — 解决 CERT-R2 的 DEFERRED）

| 维度 | A 复用 `cert_srv` | B 新建 `cert_act` | C 语义类共享 |
| --- | --- | --- | --- |
| schema 兼容 | ✅ CHECK 已允许 | ❌ 违反 CHECK | ✅ |
| 需迁移 | **NO** | **YES**（重建表） | NO |
| 碰撞安全 | ✅ | ✅ | ⚠ 见 §9 |
| 可读性 | ✅ | ✅ | ✅ |
| 事务安全 | ✅ 复用池消费 | ✅ | ✅ |
| 运维复杂度 | ✅ 最低 | ⚠ 迁移+播种 | ✅ |

```
ACTIVITY_NUMBER_STRATEGY = OPTION_A
ACTIVITY_NUMBER_FORMAT    = CSRV%06d（与 cert_trn 同构；池种子属独立迁移 Gate，非 0045）
SERVICE_NUMBER_STRATEGY   = OPTION_A（同池共用编号段）
ID_POOLS_REBUILD_REQUIRED = NO
```

**关键理由**：`cert_srv` 是 V1.0 **既有的服务证书语义池**，复用它可**零迁移**落地分配器；
新建 `cert_act` 需扩展 CHECK → 重建 `id_pools` 表，直接违反 CERT-R2 冻结的不变式。

### 6.1 验收证书编号（§10）

```
ACCEPTANCE_NUMBER_STRATEGY = OPTION_B（独立非生产命名空间）
```

冻结：① 不消耗 `cert_trn`/`cert_srv` 任何编号；② 落在明确可识别为非生产成就的命名空间
（`ACCEPT-<batchPublicId>-<seq>` 形态；**不**用 `cert_acc` 池 —— 那需 CHECK 扩展）；
③ 由 `cert_kind='acceptance'` 结构可判别；④ 绝不与真实编号碰撞；⑤ 不被公开验真视为真实成就。

---

## 7. 域 vs 持久化 source（§11）— 存在 schema gap

### 7.1 实测判别能力

`cert_type` CHECK = `('training','activity','honor')` —— **无 `service` 值**。
生产交叉表：`activity|activity|55|55`（55 行 service 形状全部 `cert_type='activity'`）、
`course|training|358|358`。

| 候选判别器 | 可否区分 | 依据 |
| --- | --- | --- |
| `source_type` | ❌ | 二者同为 `'activity'` |
| `cert_type` | ❌ | CHECK 无 `service`；生产全为 `'activity'` |
| `cert_kind` | ❌ | 仅 participant/acceptance，与 service 无关 |
| `issue_reason` | ❌ | 是**原因**维度，契约禁止与 source 混用 |
| `snapshot` JSON | ⚠ 脆弱 | 运行时从未填充；非结构化、不可索引 |
| `cert_no` 前缀 | ⚠ 当前唯一可用但非结构化 | 无 DB 约束/索引；新发形态与历史前缀不同族 |
| `template_id` | ⚠ 间接 | 模板绑定 `cert_type`，而 `cert_type` 无 service 语义 |

### 7.2 结论

```
DOMAIN_SOURCE_PERSISTENCE_DECISION = 维持 CERT-R2 映射（source_type 不新增取值）
ACTIVITY_SERVICE_DISCRIMINATOR     = 当前无结构化判别器 —— schema gap
```

**CERT-R2 §6「前缀已足以区分」的断言经本轮追踪证伪**：前缀是字符串约定，无 DB 约束、无索引，
且新发编号形态（`CSRV%06d`）与历史前缀（`JHCRT-SRV-*`）不同族，无法作为稳定判别器。

### 7.3 判别器方案选择

| 方案 | 迁移代价 | 判定 |
| --- | --- | --- |
| G1 `source_type` 新增 `'service'` | 改 CHECK → **重建 certificates（413 行）** | ❌ 违反 ADDITIVE |
| **G2 新增 `issue_source` 列** | `ADD COLUMN` + CHECK，**ADDITIVE，不改写历史** | ✅ **采纳** |
| G3 `cert_type` 新增 `'service'` | 改 CHECK → 重建 | ❌ 同 G1 |

冻结：`certificates.issue_source TEXT CHECK (IS NULL OR IN ('activity','service')) DEFAULT NULL`
（历史 413 行保持 NULL，域层映射 LEGACY_UNSPECIFIED，**不猜测**）。
`source_type` 保持 `'activity'` 不变 → **与 0045 幂等索引正交**。

---

## 8. SOURCE_ID 契约（§12）

| 域 | `source_type` | `source_id` 语义 | 必填 | 逻辑实体 | FK |
| --- | --- | --- | --- | --- | --- |
| TRAINING_EXAM | `'exam'` | `exam_sessions.id` | 是 | `exam_sessions` | ❌ 多态（另有专用 `exam_paper_id` FK） |
| ACTIVITY | `'activity'` | `activities.id` | 是 | `activities` | ❌ 多态 |
| SERVICE | `'activity'` | `service_records.id` | 是 | `service_records` | ❌ 多态 |
| ACCEPTANCE | `'manual'` | `NULL` | 否（必须 NULL） | — | — |

**纪律**：新建成就类证书**不得**静默产生 `source_id=NULL`（生产 413 行全 NULL 是历史事实，
未来发放必须携带权威 identity，否则幂等保护形同虚设）。
`source_id` 为**多态引用**（可指 `activities`/`exam_sessions`/`service_records`），
SQLite 无法建 FK → DB 层靠索引+CHECK 保证形状，**应用层必须**校验 `source_id` 真实存在。

---

## 9. 幂等充分性（§13）— HARD DECISION

### 9.1 碰撞判定：**能碰撞**

证据链：
1. 二者 `source_type` 同为 `'activity'`；
2. `activities.id` 与 `service_records.id` 是**两个独立表的独立 INTEGER PK** → 数值空间**天然重叠**；
3. `service_records.activity_id` 指向 `activities.id`，说明服务记录是「某活动的服务记录」，
   其 `id` 与 `activities.id` 无全局唯一性关联。

| 证书 | source_type | source_id | 实际成就 | 0045 索引键 |
| --- | --- | --- | --- | --- |
| 活动证书 | `'activity'` | `activities.id=5` | 参加活动 #5 | `(user,'activity',5)` |
| 服务证书 | `'activity'` | `service_records.id=5` | 在活动 #3 服务 5 次 | **同键 → 误判重复** |

> 生产当前冲突数为 0 **仅因存量全部 `source_id=NULL`**；新发一旦携带 `source_id` 即刻暴露。

### 9.2 方案评估

| 方案 | 判定 |
| --- | --- |
| 源 ID 命名空间全局不相交 | ❌ 脆弱、非 schema 保证 |
| 源 ID 来自同一张表 | ⚠ 一个活动可产生多张服务证书 → 误判 |
| **需额外判别列** | ✅ **采纳**（§7.3 的 `issue_source`） |
| service 是 activity 子类型 | ❌ 与 V1.0 独立语义及 55 行存量冲突 |
| 简化域模型取消 SERVICE | ❌ 丢失业务语义 |

### 9.3 冻结决策

```
0045_IDEMPOTENCY_SUFFICIENT = NO
0045_ADEQUACY = SOURCE_AMENDMENT_REQUIRED_BEFORE_REMOTE_APPLY

0045_REQUIRED_CORRECTION（最小修正）：
  1) 新增 certificates.issue_source（ADD COLUMN + CHECK，ADDITIVE，不改写 413 行历史）
  2) uq_cert_user_source 纳入该判别维度，例如：
       CREATE UNIQUE INDEX uq_cert_user_source
         ON certificates(user_id, source_type, issue_source, source_id)
        WHERE status = 1 AND source_type = 'activity' AND source_id IS NOT NULL;
     （或保留 3 列 + 谓词内 COALESCE 等价写法）
  ⚠ 具体 DDL 属独立「0045 源修订 Gate」；CERT-R3A 不编辑 0045。
  ⚠ 修订后必须重跑：生产只读冲突核验（谓词逐字匹配新索引）+ CERT-R2 fixture。
```

> 因生产 413/413 行 `source_id IS NULL` 且冲突数 0，**该修正不影响任何存量行**，
> 纯粹保障未来新发正确性。0045 尚未远端应用 → **修正窗口充足**。

---

## 10. 事务边界（§14）

**TX_PHASE（单 `db.batch()`，D1 兼容）**：
1. 资格复核（同 batch 内 `EXISTS`/`NOT EXISTS` 谓词）
2. 幂等检查（`NOT EXISTS(active cert)`）
3. 编号消费（`UPDATE id_pools ... WHERE pool_type=? AND code=? AND status=0`）
4. 证书 INSERT（`INSERT ... SELECT ... WHERE <guards>` 条件插入）
5. 审计 INSERT（`SELECT c.id FROM certificates c WHERE c.public_id=?`，read-your-writes）

编号消费守卫（照抄 exam 模式，保证「证书未生成则不烧号」）：
```sql
UPDATE id_pools SET status=1, assigned_to=?, assigned_at=?
 WHERE pool_type=? AND code=? AND status=0
   AND EXISTS (SELECT 1 FROM certificates c WHERE c.public_id=? AND c.status=1)
```

**机制选择**：`db.batch()` + 条件 UPDATE/INSERT...SELECT + 派生 EXISTS。
**不**使用 `INSERT...RETURNING`（代码库无先例，不引入新机制）；**不**使用显式 `BEGIN/COMMIT`
（D1 `batch` 即事务单元）。

**POST_TX_PHASE（事务外）**：PDF 生成 → R2 上传 → `files` 行 + `file_id` 回填。
**PDF/R2 绝不参与 D1 原子性**；文件状态由 `deriveFileStatus()` 从 `file_id` 推导。

---

## 11. 编号消耗失败语义（§15）

| 场景 | 可否复用 | 冻结行为 |
| --- | --- | --- |
| 分配成功、证书 INSERT 失败 | **可** | 同 batch 回滚，号未烧 |
| 证书成功、审计 INSERT 失败 | 不可 | 同 batch 回滚，号随证书回滚 |
| D1 提交后 Worker 崩溃 | 不可 | 证书+号已同时提交；重试命中 `ALREADY_ISSUED` |
| 客户端重试 | 不可 | 幂等键命中 → `ALREADY_ISSUED` |
| 证书成功、PDF 失败 | 不可 | 证书有效，文件 FAILED 记日志 |

```
NUMBER_GAP_POLICY = 允许空洞，绝不允许重复或重新分配。正确性优先于消除空洞。
```

---

## 12. 考试提取边界（§16）与迁移策略（§17）

| 关注点 | 分类 |
| --- | --- |
| 判分 / pass-fail / 资格判定 / 事务编排 / 响应格式化 | **KEEP_IN_EXAM** |
| 条件消费池编号原语 | **EXTRACT_TO_SHARED_SERVICE** |
| 证书 INSERT 谓词构造 / 审计 INSERT | **ADAPT_TO_SHARED_PRIMITIVE** |
| 既有 DEBUG `console.error` 行 | **DO_NOT_TOUCH_YET**（属 HEAD 既有代码 commit `cdd0e5f`，非 CERT-R2 引入） |

```
EXAM_EXTRACTION_STRATEGY = C（仅提取分配/持久化原语，考试编排保持完整）
```

| 策略 | 回归风险 | 长期重复风险 | 判定 |
| --- | --- | --- | --- |
| A 先建共享服务，考试不动 | 最低 | 中 | 备选 |
| B 立即迁移考试 | 最高 | 最低 | ❌ 违反 CERT-R1 §29 回归契约 |
| **C 仅提取原语** | **低** | **低** | ✅ 采纳 |

---

## 13. CERT-R3B 冻结契约（§18–§24）

| 项 | 状态 | 要点 |
| --- | --- | --- |
| `SHARED_SERVICE_INTERFACE` | **DEFINED** | `issue()` / `previewEligibility()`；请求含 `domainSource`+`sourceId`+`certificateKind`+`issuanceReason`+`operatorUserId`+`batchPublicId`；**不暴露 PII**（`holder_name`/`issuer_name` 由服务端派生） |
| `ERROR_CONTRACT` | **DEFINED** | 业务预期（`NOT_ELIGIBLE`/`ALREADY_ISSUED`/`SOURCE_NOT_FOUND`/`SOURCE_ID_REQUIRED`/`NUMBER_POOL_EXHAUSTED`）**不进 catch**；内部异常（`NUMBER_ALLOCATION_FAILED`/`CERTIFICATE_INSERT_FAILED`/`AUDIT_FAILED`/`UNAUTHORIZED`）进 catch。对外 reason 小写蛇形、内部 code 大写（沿用 `utils/errors.ts`） |
| `AUTHORIZATION_BOUNDARY` | **DEFINED** | 路由层**唯一**鉴权点；服务层校验 `teamId ∈ 操作者授权范围` + `assertNotSystemUser`；仓储信任服务。**不授予 `platform_operator` 发放权**；不改 RBAC |
| `ACCEPTANCE_MODE_BOUNDARY` | **DEFINED** | 无需 signup/attendance/hours/points/exam；必须 `cert_kind='acceptance'`+`issue_reason='admin_acceptance'`+授权操作者+`source_id IS NULL`；禁建考勤/时长/积分/考试行；**默认不出现在「我的证书」** |
| `PUBLIC_VERIFY_BOUNDARY` | **DEFINED** | 建议：`ADMIN_ACCEPTANCE` **不可**公开验真；`status=2` 应显示已撤销（现行为有缺陷）；file-pending **可**验真。**本轮不改 verify 路由**；登记技术债 `VERIFY_STATUS_FILTER_MISSING` |
| `PDF_BOUNDARY` | **DEFINED** | D1 事务先提交 → API 即返回 `fileStatus=PENDING` → PDF → R2 → `file_id` 回填；PDF 失败记 `failure_code`，不重发编号/证书 |
| `BATCH_BOUNDARY` | **DEFINED** | 逐接收者调用**同一** `issue()`；每接收者独立事务；批次表仅计数；失败按 `failure_code` 重试且不重复耗号；部分失败 `status=3` |

### 13.1 只读发现的既有缺陷（本轮不修，仅登记）

`CertificateRepository.queryVerifyRow`（`src/repository/certificate.ts:259-276`）：
- SQL **未按 `status` 过滤** → 已撤销证书仍可公开验真成功；
- `LEFT JOIN activities ON c.source_id = a.id` 会对 SERVICE 行**错误解析**活动标题与服务时长。

### 13.2 CERT-R3B 范围（§26）

**纳入**：`CertificateNumberAllocator` 实现 · `CertificateIssuanceService.issue()`/`previewEligibility()` ·
仓储原语 · 活动/服务**合成**发放测试 + 碰撞回归测试 · `cert_srv` 池种子迁移（独立文件，幂等守卫）

**排除**：远端迁移 APPLY · 管理员路由 · 前端 · PDF 渲染器 · 批量引擎 · RBAC 变更

预期文件：`src/services/certificate-issuance-service.ts`（新）·
`src/repository/certificate-allocator.ts`（新）· `src/repository/certificate.ts`（扩展）·
`migrations/0046_*.sql`（`cert_srv` 种子，独立 Gate）· `tests/cert_r3_*.mjs`（新）

> **前置依赖**：§9.3 的 0045 源修订（`issue_source`）**必须先完成**，
> 否则 activity/service 幂等无法正确实现。

---

## 14. 文档产出（§27）

| 文件 | 状态 |
| --- | --- |
| `workers/docs/certificate/certificate-issuance-boundary.md` | 新建（架构决策冻结） |
| `workers/docs/audits/2026-10-03-post-cutover-assurance/22-cert-r3a-number-allocation-decision.md` | 新建（本文件） |

**为 CERT-R3A 唯一允许的文件系统写入**。未 stage、未 commit、未 push。
未修改任何源码或迁移。

---

## 15. Secret / PII 扫描（§28）

见 §16 结论。两份文档仅含**聚合与结构事实**；历史编号格式以**模式描述**呈现
（`JHCRT-<TYPE>-<ULID8>-<ULID6>`），**未复制任何真实证书编号**、接收者 ID、姓名、
手机号、OpenID、身份证或生产连接串。

---

## 16. STOP 纪律（§2 / §10）

| 禁止项 | 状态 |
| --- | --- |
| 修改源码 | ✅ 未改（仅 2 份新文档） |
| 修改 / 创建迁移 | ✅ 未改（0045 保持 SOURCE FROZEN） |
| APPLY 0045 | ✅ 未 apply（仅 node:sqlite 隔离 fixture，未重跑） |
| 写生产 / 预发 D1 | ✅ 仅 `--remote` 只读聚合（`rows_written=0`） |
| 部署 Worker | ✅ 未部署 |
| 改 Secret / Keychain / RBAC | ✅ |
| 真实发证 / PDF | ✅ |
| commit / push | ✅ |
| 触碰 JHZY 1.0 | ✅ |
| 清理无关脏工作区 | ✅ 未触碰（44 + 287 项原样保留） |
| CERT-R3B 实现 | ✅ 本 Gate 无任何实现 |

---

## 17. SUCCESS DEFINITION

| # | 项 | 状态 |
| --- | --- | --- |
| 1 | 编号体系全仓盘点（含 V1.0 历史） | ✅ §3 |
| 2 | TRAINING 分配精确追踪 + 原子性判定 | ✅ §4 |
| 3 | SERVICE/HONOR 历史格式三类证据分离 | ✅ §5 |
| 4 | ACTIVITY 编号决策（解决 DEFERRED） | ✅ §6 OPTION_A |
| 5 | `ID_POOLS_REBUILD_REQUIRED = NO` | ✅ §6 |
| 6 | 验收证书编号决策 | ✅ §6 OPTION_B |
| 7 | 域 vs 持久化 source 判别器 | ✅ §7（含 schema gap 认定） |
| 8 | SOURCE_ID 契约（四类） | ✅ §8 |
| 9 | 幂等充分性 HARD DECISION | ✅ §9（**需 0045 源修订**） |
| 10 | 事务边界 TX / POST_TX | ✅ §10 |
| 11 | 编号失败语义 | ✅ §11 |
| 12 | 考试提取边界 + 迁移策略 | ✅ §12 STRATEGY C |
| 13 | 接口 / 错误 / 授权 / 验收 / 验真 / PDF / 批量 七项冻结 | ✅ §13 |
| 14 | CERT-R3B 范围 | ✅ §13.2 |
| 15 | 2 份文档 + Secret 扫描 | ✅ §14–§15 |

---

## 18. 最重要的产出

> **0045_ADEQUACY = SOURCE_AMENDMENT_REQUIRED_BEFORE_REMOTE_APPLY**
>
> 理由：`uq_cert_user_source` 以 `(user_id, source_type, source_id)` 为键，而 ACTIVITY 与 SERVICE
> 共用 `source_type='activity'`，其 `source_id` 分别来自 `activities.id` 与 `service_records.id`
> —— 两个独立表的独立主键，**数值空间天然重叠**。当二者携带相同 `source_id` 且同一 user 时，
> 索引会把「活动成就」与「服务成就」误判为同一证书。
>
> 该风险**当前不可见**（生产 413/413 行 `source_id IS NULL`，冲突数 0），但**新发证书一旦携带
> `source_id` 即刻暴露**。因 0045 尚未远端应用，**修正窗口充足**。
>
> 最小修正：新增 `certificates.issue_source`（ADD COLUMN + CHECK，纯增量，不改写历史），
> 并将其纳入幂等索引。详见 §9.3。

---

## 19. FINAL RETURN（§29）

```
CERT_R3A_START_HEAD = c698e6677d1f8f7d1e7c6d402b09f837e12cf64e

WORKSPACE_GATE = PASS
CERT_R2_CONTRACT_LOADED = YES

TRAINING_POOL = cert_trn (production 500 rows, status=0, all free)
TRAINING_FORMAT = CTRN%06d (pre-generated in migration 0022; no runtime construction)
TRAINING_ALLOCATOR_REUSABILITY = EXTRACTION_REQUIRED

CERT_SRV_CURRENT_MEANING = RESERVED (declared in CHECK, 0 production rows, zero runtime consumers;
                                 V1.0 historically served service-certificate numbers)
CERT_HON_CURRENT_MEANING = RESERVED (declared in CHECK, 0 production rows, zero runtime consumers;
                                 V1.0 historically served honor-certificate numbers)

HISTORICAL_SERVICE_FORMAT = JHCRT-<TYPE>-<ULID8>-<ULID6> hyphenated 3-segment (ULID-derived);
                            V1.0-only; NOT promoted to runtime rule (5 historical cert_no
                            collisions documented; import literal, not a reusable mechanism)

ACTIVITY_NUMBER_STRATEGY = OPTION_A (reuse existing cert_srv pool; zero migration)
ACTIVITY_NUMBER_FORMAT = CSRV%06d (isomorphic to CTRN; seeding belongs to a separate migration gate)
SERVICE_NUMBER_STRATEGY = OPTION_A (shares the cert_srv number space with ACTIVITY)
ACCEPTANCE_NUMBER_STRATEGY = OPTION_B (separate non-production namespace; consumes no real achievement number)

ID_POOLS_REBUILD_REQUIRED = NO

DOMAIN_SOURCE_PERSISTENCE_DECISION = keep CERT-R2 mapping (source_type gains no new value);
                                     ACTIVITY/SERVICE distinguished by a new column, not source_type
ACTIVITY_SERVICE_DISCRIMINATOR = SCHEMA_GAP — no structured discriminator exists today
                                  (cert_type CHECK lacks 'service'; all 55 prod service-shaped rows
                                   are cert_type='activity'; only the cert_no string prefix separates them)
                                  FROZEN FIX = new certificates.issue_source column (ADDITIVE)

TRAINING_SOURCE_ID_CONTRACT = source_type='exam', source_id=exam_sessions.id, REQUIRED, polymorphic
                              (no FK; dedicated exam_paper_id FK already carries entitlement)
ACTIVITY_SOURCE_ID_CONTRACT  = source_type='activity', source_id=activities.id, REQUIRED, polymorphic
SERVICE_SOURCE_ID_CONTRACT   = source_type='activity', source_id=service_records.id, REQUIRED, polymorphic
ACCEPTANCE_SOURCE_ID_CONTRACT= source_type='manual', source_id=NULL (mandatory NULL; no achievement source)

0045_IDEMPOTENCY_SUFFICIENT = NO
0045_ADEQUACY = SOURCE_AMENDMENT_REQUIRED_BEFORE_REMOTE_APPLY
0045_REQUIRED_CORRECTION = add certificates.issue_source (ADD COLUMN + CHECK, additive, no history
                          rewrite) and include it in uq_cert_user_source, e.g.
                          ON certificates(user_id, source_type, issue_source, source_id)
                          WHERE status=1 AND source_type='activity' AND source_id IS NOT NULL

TX_PHASE = single db.batch(): eligibility recheck -> idempotency NOT EXISTS -> conditional id_pools
           consume (guarded by EXISTS certificate) -> conditional certificate INSERT..SELECT ->
           audit INSERT via read-your-writes
POST_TX_PHASE = PDF generation -> R2 upload -> files row + file_id writeback (never inside D1 atomicity)

NUMBER_GAP_POLICY = gaps allowed; duplicates and reassignment forbidden. Correctness over gap-freedom.

EXAM_EXTRACTION_STRATEGY = C
SHARED_SERVICE_INTERFACE = DEFINED
ERROR_CONTRACT = DEFINED
AUTHORIZATION_BOUNDARY = DEFINED
ACCEPTANCE_MODE_BOUNDARY = DEFINED
PUBLIC_VERIFY_BOUNDARY = DEFINED
PDF_BOUNDARY = DEFINED
BATCH_BOUNDARY = DEFINED
CERT_R3B_PLAN = DEFINED

DOCUMENTS_CREATED = 2
SECRET_PII_SCAN = PASS

SOURCE_FILES_MODIFIED = NO
MIGRATION_MODIFIED = NO
PRODUCTION_D1_MUTATED = NO   (read-only aggregates only, rows_written=0)
STAGING_D1_MUTATED = NO
CERTIFICATE_ISSUED = NO
WORKER_DEPLOYED = NO
RBAC_MUTATED = NO
GIT_COMMIT_PERFORMED = NO
GIT_PUSH_PERFORMED = NO
JHZY_1_0_TOUCHED = NO

CERT_R3A_STATUS = PASS_WITH_FINDINGS

NEXT_ACTION = STOP. Await authorization for (a) 0045 SOURCE AMENDMENT Gate
              (issue_source + idempotency index revision), then (b) CERT-R3B implementation Gate.
              Do not begin CERT-R3B.
```

---

## 20. STOP

CERT-R3A 完成并 STOP。**未启动 CERT-R3B。**
