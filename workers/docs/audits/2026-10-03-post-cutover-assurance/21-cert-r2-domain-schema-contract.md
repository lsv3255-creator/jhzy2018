# 21 — CERT-R2: Certificate Domain & Schema Contract（本地设计 + 源码实现 + 迁移编写 + 本地验证）

> 前置 Gate：`20-cert-r1-current-state-gap-decision.md`（CERT-R1 = PASS）
> 权威域契约：`docs/certificate/certificate-domain-contract.md`
> 模式：**LOCAL DESIGN + SOURCE IMPLEMENTATION + MIGRATION AUTHORING + LOCAL VALIDATION**
> **禁止**：生产/预发 APPLY、DEPLOY、真实发证、生成生产 PDF、上传文件、改生产 RBAC、改 Secret/Keychain、push、触碰 JHZY 1.0、修复历史 413/8 重复组、伪造考勤/服务/积分、清理无关脏工作区。

---

## 1. Workspace Gate（§4）— PASS

| 项 | 要求 | 实测 |
| --- | --- | --- |
| pwd | `/Users/Shared/projects/jhzy-v2` | ✅ 一致 |
| branch | `master` | ✅ `master` |
| HEAD | `9d6f8b32aa22d3a737fbe7b0d43e9a575a24036b` | ✅ `9d6f8b32...` |
| staged | 0（进入前） | ✅ 0 |
| 受跟踪 `.var` | 0 | ✅ 0 |

> CERT-R1 审计已全量通读（非记忆），作为本任务权威基线。

---

## 2. §A — 0045 最小范围冻结（逐项分类）

> 仅结构描述，**不含生产数据**。

| # | 变更 | 分类 | 理由 |
| --- | --- | --- | --- |
| M1a | `certificates.cert_kind` TEXT NOT NULL DEFAULT `'participant'` + CHECK(participant/acceptance) | **REQUIRED_FOR_CERT_R2** | 验收证书区分（§2/§7）必需；默认 participant 使 413 行语义真实、零改写 |
| M1b | `certificates.issued_by` / `issue_reason` / `revoked_at` / `revoked_by` / `revoke_reason` | **REQUIRED_FOR_CERT_R2** | 发放原因与撤销生命周期（CERT-R1 M1）；全部可空，历史行 NULL |
| M2 | `uq_cert_user_source` 部分唯一索引（谓词含 `source_id IS NOT NULL`） | **REQUIRED_FOR_CERT_R2** | 活动/服务幂等防护；生产核验冲突=0 |
| M3 | `id_pools` 播种 `cert_act` / `cert_svc` | **DEFER_TO_CERT_R3+** | CHECK 不含 `cert_act`；生产用 `JHCRT-SRV-*` 非 pool 模式；编号决策 defer（§H） |
| M4 | `certificate_logs` + `batch_id` / `result` / `failure_code` | **REQUIRED_FOR_CERT_R2** | 复用既有审计表（CERT-R1 M4 / §14） |
| M5 | `certificate_batches` 新表（最小、仅计数、无 PII 快照） | **REQUIRED_FOR_CERT_R2** | 批量结果与可观测性（CERT-R1 M5 / §15） |
| — | `id_pools` CHECK 扩展 / 表重建 | **REMOVE** | 违反 ADDITIVE / NON-DESTRUCTIVE |
| — | 历史证书重写 / 回填 `source_id` | **REMOVE** | 禁止改写历史；且 source identity 不可从现有数据可靠推导 |
| — | 8 组历史 `(user, exam_paper)` 重复修复 | **REMOVE** | CERT-R1 记录的数据质量异常，非 CERT-R2 职责 |

**0045 不变式**：`ADDITIVE` ✓ / `NON-DESTRUCTIVE` ✓ / `D1-COMPATIBLE` ✓ / `LEGACY-413-COMPATIBLE` ✓ /
**无表重建** ✓ / **无历史证书重写** ✓ / **无 id_pools 修改** ✓ / **可重复执行**（`IF NOT EXISTS` + 幂等）✓

---

## 3. 产出物（Created，LOCAL ONLY）

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `migrations/0045_certificate_domain_contract.sql` | 迁移（增量） | M1 域字段 / M2 幂等索引 / M3 文档化不执行 / M4 日志扩展 / M5 批量表 |
| `src/domain/certificate.ts` | 域类型契约 | 枚举 + 纯函数 + 接口（无运行时写逻辑） |
| `tests/cert_r2_migration_fixture.mjs` | 本地 fixture 验证 | node:sqlite 隔离沙箱，413 行合成生产形态，32 断言 |
| `docs/certificate/certificate-domain-contract.md` | 权威域契约文档 | 本文档 §14 引用 |
| `docs/audits/.../21-cert-r2-domain-schema-contract.md` | 本审计报告 | — |

> **迁移未 APPLY**：`0045` 仅编写 + 本地 fixture 应用验证，未对 local/staging/production D1 执行
> `wrangler d1 migrations apply`。无 DEPLOY、无 push、无 commit（见 §9 STOP 纪律）。

---

## 4. §B — 精确索引契约与生产核验

> ⚠ **CERT-R3A-FIX 修正告示（2026-10-03）**：本节记录的是 **CERT-R2 当时冻结的原始契约**，
> 作为 commit `c698e667` 的历史证据保留。**该索引已在 CERT-R3A-FIX 中被修正**（因
> ACTIVITY/SERVICE 共享 `source_type='activity'` 而 `source_id` 分属不同命名空间，
> 相同数值会互相误判为重复）。**当前真相**：
> `ON certificates(user_id, source_type, issue_source, source_id)
>  WHERE status = 1 AND source_type = 'activity'
>    AND issue_source IS NOT NULL AND source_id IS NOT NULL`
> （新增 `certificates.issue_source` 列；0045 仍未在任何环境 APPLY）。
> 详见 `docs/certificate/certificate-domain-contract.md` §1.3 / §5.1。

**EXACT_0045_INDEX_CONTRACT（CERT-R2 原冻结版本 — 已被 CERT-R3A-FIX 取代）**

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_cert_user_source
  ON certificates(user_id, source_type, source_id)
  WHERE status = 1 AND source_type = 'activity' AND source_id IS NOT NULL;
```

| 维度 | 定义（均从实际 schema 推导，非假设） |
| --- | --- |
| columns | `(user_id, source_type, source_id)` |
| predicate | `WHERE status = 1 AND source_type = 'activity' AND source_id IS NOT NULL` |
| 覆盖 source_type | 仅 `'activity'`（含复用它的 service）；排除 course/exam/manual/NULL |
| status 行为 | `status CHECK(1,2)`：1=active / 2=revoked。谓词仅锁 active；revoked 不参与唯一性 → 撤销后可重发 |
| NULL 行为 | 显式排除 `source_id IS NULL`：无权威 source identity 的 legacy 行永不进入索引 |
| legacy 兼容 | 生产 413 行 `source_id` 全为 NULL → 全部在谓词外，0 行被约束或改动 |

> **未裸用 `UNIQUE(user_id, source_type, source_id)` 的原因**：那会把无 source identity 的
> legacy/service 行纳入约束语义。本索引只保护**具备权威 source identity 的成就行**。

**EXACT_INDEX_PRODUCTION_CONFLICT_COUNT = 0**
（生产只读核验，`wrangler d1 execute jhzy-v2-prod --remote`，`rows_written=0`；
查询与索引谓词逐字一致：`status=1 AND source_type='activity' AND source_id IS NOT NULL`）
→ 结果 0，**不触发 §31 STOP**，接受该索引。

**为何为 0（重要解释）**：冲突数为 0 是因为**非 NULL 冲突集本身为空** ——
生产 413 张证书 `source_id` 全部为 NULL，**不存在**任何带权威 source identity 的行，
因此该索引对存量数据**完全无约束力、零风险**，只对未来新发证书生效。

---

## 5. §I — 新发现：生产存在 source_id 为 NULL 的 legacy/service 形状证书

> 仅记录**聚合/结构性事实**。**不含**接收者 ID、证书编号、姓名或任何 PII。
> 这是**兼容性证据**，**不是清理任务**。

生产只读聚合（2026-10-03）：

| 结构事实 | 值 |
| --- | --- |
| 证书总数 | 413 |
| `course` / `activity` 分布 | 358 / 55 |
| `source_id IS NOT NULL` 的行数 | **0**（全部为 NULL） |
| `source_type='activity' AND source_id IS NULL AND status=1` | 55 |
| `status=1` / `status=2` | 413 / 0 |
| `exam_paper_id IS NOT NULL` 的行数 | 0 |
| 当前 prod 的 `(user, exam_paper)` 重复组 | 0 |

**结论**：生产现存全部 413 张证书**均无权威 source identity**，属 legacy/service 种子形状。
这些行必须保持合法、永不进入成就级唯一性约束 —— 0045 谓词显式排除 `source_id IS NULL`
正是为此。**不修复、不回填、不删除**（CERT-R2 无权改写历史）。

> 关于「8 组重复」：CERT-R1 记录的 8 组历史 `(user, exam_paper)` 重复属 V1.0 迁移遗留形态；
> 当前 prod 中 `exam_paper_id` 全为 NULL，故重复组计数为 0。fixture 仍**故意**表示该历史形态，
> 以证明 0045 对其 0 改动（见 §6 显式理由）。

---

## 6. §C — Source 双层模型

**第 1 层 PERSISTED SOURCE COMPATIBILITY**：既有 CHECK
`NULL | 'course' | 'exam' | 'activity' | 'manual'`。CERT-R2 **不新增/不修改/不删除**任何取值，
**不因域模型想要更干净的 enum 就发明新的 persisted source_type**。

**第 2 层 DOMAIN SOURCE SEMANTICS**：`TRAINING_EXAM→'exam'`、`COURSE→'course'`、
`ACTIVITY→'activity'`、`MANUAL→'manual'`、**`SERVICE→'activity'`**（以 `JHCRT-SRV-*` 前缀区分）。

- 映射为**多对一**。`src/domain/certificate.ts` 用数组 + `persistedSourceFor()` /
  `domainSourcesFor()` 表达；**不用对象字面量**（会触发 TS1117 重复键 —— 该冲突由
  typecheck 实际捕获并已修复，见 §7.2）。
- **SERVICE 不获独立 source_type**：新增取值需重估 CHECK 并触及 413 行（违背 ADDITIVE）；
  CERT-R2 不臆造新枚举；前缀已足够区分。
- **推论**：`uq_cert_user_source`（谓词锁 `'activity'`）自动同时覆盖 activity 与 service。

---

## 7. §D / §E / §F — Fixture 与负向验证

### 7.1 §D — 为何 PRE-0045 fixture 不含 `uq_cert_user_paper`（显式理由）

生产那 8 组历史 `(user, exam_paper)` 重复 active 证书，是**先于** `uq_cert_user_paper` 落库
就已存在的历史形态（V1.0 迁移遗留）。若 fixture 先建该唯一索引，这 8 组重复行将**无法插入**，
fixture 就**无法忠实表示生产既有历史状态**。

- 0045 的职责**不包含**回溯校验历史 `uq_cert_user_paper` 条件 —— 它是 CERT-R1 记录的既有
  数据质量异常（建议 remediation ticket，非 CERT-R2 blocker），0045 对这 8 组 **0 改动、0 删除**。
- 故 fixture **故意不含** `uq_cert_user_paper`，以真实表示该历史形态，并断言迁移后 **8 → 8 保留**。
- ⚠ **此为「忠实表示历史」的取舍，不是削弱新约束的理由**：0045 新增的 `uq_cert_user_source`
  仍被完整负向测试（见 §7.3），未被放宽。

### 7.2 §E — 应用真实 0045 的结果

`node tests/cert_r2_migration_fixture.mjs` → **42 pass / 0 fail**（node:sqlite 隔离沙箱，
应用真实 `migrations/0045_certificate_domain_contract.sql`）：

| §E 要求 | 结果 |
| --- | --- |
| 迁移成功 | ✅ |
| 413 → 413 | ✅ |
| `cert_no` mutation = 0 | ✅ 集合逐一比对 |
| user binding mutation = 0 | ✅ 迁移前绑定快照比对 |
| source mutation = 0 | ✅ 同上 |
| status mutation = 0 | ✅ `status=1` 恒为 413 |
| 8 组历史重复保留 | ✅ 8 → 8（索引创建后再次复核仍为 8） |
| legacy `source_id=NULL` 行保留 | ✅ |
| 新部分唯一索引创建 | ✅ 且谓词逐字校验通过 |
| 精确索引谓词冲突数 = 0 | ✅ 与生产核验一致 |

### 7.3 §F — 负向并发/幂等矩阵（全部 PASS）

| 用例 | 期望 | 结果 |
| --- | --- | --- |
| 首张有效 activity 成就证书 INSERT | 成功 | ✅ |
| 同成就第 2 张 **active** 证书 | DB UNIQUE **拒绝** | ✅ |
| 不同 user、同 `source_id` | 允许 | ✅ |
| 同 user、不同 `source_id` | 允许 | ✅ |
| legacy `source_id=NULL` | 不破坏迁移 | ✅ |
| 历史 exam/course 重复形态 | 不被新约束改动 | ✅ |
| `status=2`(revoked) 策略 | 撤销后**可重发**同一成就 | ✅ |

> revoked 策略**非假设**：由实际 schema `status CHECK(1,2)`（1=active/2=revoked）与谓词
> `status=1` 推导 —— 已撤销证书不参与唯一性，故撤销后允许重发。

### 7.4 Typecheck / Worker dry-run（§23）

- `tsc --noEmit` → **TSC_EXIT=0**。
  - 过程中 typecheck **实际捕获** `TS1117`（`ACTIVITY`/`SERVICE` 双键映射到 `'activity'`），
    已改用数组 + 访问函数修复 —— 这是 §C 多对一映射的真实工程证据。
- `wrangler deploy --dry-run` → 构建成功（875.71 KiB / gzip 201.62 KiB），`--dry-run: exiting now.`，**未部署**。

---

## 8. 关键设计决策与偏离（需 ChatGPT 审查）

### 8.1 M3 不播种 id_pools（对 CERT-R1 M3 的偏离，已文档化）
- CERT-R1 提议 M3 播种 `cert_act`/`cert_svc` 池。
- **偏离理由**：
  1. `id_pools.pool_type` CHECK = `('cert_trn','cert_srv','cert_hon','volunteer')` —— **不含 `cert_act`**，INSERT `'cert_act'` 会违反 CHECK（生产亦会失败）。
  2. 生产现实：activity/service 证书**并非**以 id_pools pool 模式编号；55 张 service 证书使用字母数字前缀 `JHCRT-SRV-*`。
  3. 扩展 `id_pools` CHECK 需重建表（非增量），违背 ADDITIVE / NON-DESTRUCTIVE 与 §31 STOP 精神。
- **处置**：`ACTIVITY_NUMBER_FORMAT_DECISION = DEFERRED_TO_CERT_R3`；CERT-R2 仅落到接口/契约
  （`CertificateNumberAllocator`），**不臆造对外编号**。`ID_POOLS_SCHEMA_CHANGED = NO`、
  `CERT_ACT_POOL_CREATED = NO`。

### 8.2 SERVICE 复用 `source_type='activity'`（不新增 CHECK 值）
- 域枚举 `CertificateSource.SERVICE = 'activity'`，以 `cert_no` 前缀 `JHCRT-SRV-*` 区分。
- 理由：新增 `source_type` 值会触达既有 413 行约束评估，违背非破坏原则；生产现实已复用 `'activity'`。
- 工程证据：多对一映射曾触发 TS1117，已由 typecheck 捕获并改为数组 + 访问函数。

### 8.3 验收证书不创建考勤/服务/积分
- `cert_kind=acceptance` + `issue_reason=admin_acceptance` 为硬契约；排除真实统计。CERT-R2 仅定义，发放实现在 CERT-R3。

---

## 9. Source Scope 控制（§27）

### 9.1 起始状态清点（baseline）
- 进入时：staged 0，受跟踪 `.var` 0。
- 本任务**仅新增** 5 个文件（见 §3），**未修改**任何既有受跟踪源文件（含 `exam.ts`、
  `src/repository/certificate.ts`、`wrangler.jsonc`、`0001`/`0022` 迁移）。
- ⚠ 工作区存在**与 CERT-R2 无关的既有脏状态**（其他并行任务产物）：
  `workers/` 下 44 个受跟踪文件被修改、`miniprogram/` 下 287 个文件被修改。
  **本任务未触碰、未清理**这些改动（§3 禁止项：清理无关脏工作区）。

### 9.2 修改/新增清单
| 动作 | 文件 |
| --- | --- |
| 新增 | `migrations/0045_certificate_domain_contract.sql` |
| 新增 | `src/domain/certificate.ts` |
| 新增 | `tests/cert_r2_migration_fixture.mjs` |
| 新增 | `docs/certificate/certificate-domain-contract.md` |
| 新增 | `docs/audits/.../21-cert-r2-domain-schema-contract.md` |

> `git status --porcelain` 逐一确认：以上 5 个文件均为**未跟踪新增（`??`）**，
> 本任务未修改任何既有文件，选择性提交只应纳入这 5 个路径。

---

## 10. Secret / PII 扫描（§29）

对全部 5 个新增文件执行敏感信息扫描：

| 检查项 | 结果 |
| --- | --- |
| 明文 Secret / API Token / 私钥 | 无 |
| 生产 DB 连接串 / 账号密码 | 无（仅表名/列名/枚举值） |
| 真实用户 PII（姓名/身份证/手机号） | 无（fixture 用合成 userId 与 `JHCRT-SRV-*` 占位 cert_no） |
| 生产真实 `cert_no` 值 | 无（fixture 为合成，不读取生产明文） |
| 生产接收者 ID / user_id 明文 | 无（§5 仅记录聚合与结构事实） |

> 扫描中唯一的文本命中来自本文档自身对「禁止项」与「扫描结果」的描述性文字，
> **非真实敏感信息**。结论：新增产物零敏感信息。

---

## 11. 权限设计（§24，仅设计，不改角色）

- 复用 CERT-R1 §26 既定 permission：`certificate.certificate.issue` / `.issue.batch`（待 CERT-R3 接线到管理员路由）。
- CERT-R2 **未**修改任何 RBAC 角色/权限种子；`src/domain/certificate.ts` 的 `assertNotSystemUser` 为发放前守卫（拒绝 `is_system=1`）。
- 平台 system 账号被守卫排除为接收者（仅记录结构性事实，不列 ID）。

---

## 12. STOP 纪律（§28 / §31）

| STOP 项 | 状态 |
| --- | --- |
| 未 APPLY 迁移到 prod/staging/local D1 | ✅ 仅 fixture 沙箱应用 |
| 未 DEPLOY | ✅ 仅 dry-run |
| 未真实发证 | ✅ 无写逻辑、无运行 |
| 未生成生产 PDF / 上传文件 | ✅ |
| 未改生产 RBAC / Secret / Keychain | ✅ |
| 未 push | ✅ |
| 未 commit | ✅ |
| 未触碰 JHZY 1.0 | ✅ |
| 未重建表 / 未改 `id_pools` CHECK / 未播种 `cert_act` | ✅ |
| 未改写历史证书 / 未回填 `source_id` | ✅ |
| 未修复历史 413 / 8 组重复 | ✅（仅保留并记录 anomaly） |
| 未伪造考勤/服务/积分 | ✅ |
| **STOP BEFORE COMMIT** | ✅ 见 §13 |

---

## 13. FINAL RETURN（§30 固定字段 + 本轮追加字段）

```
# ---- 原有 §30 固定字段 ----
CERT_R2_STATUS               = COMPLETE_LOCAL_ONLY
CERT_R1_BASELINE             = PASS
WORKSPACE_GATE               = PASS (HEAD 9d6f8b32, branch master, staged 0, .var 0)
MIGRATION_0045_AUTHORED      = YES (NOT APPLIED to any env)
DOMAIN_TYPES_FILE            = src/domain/certificate.ts (typecheck PASS)
FIXTURE_VALIDATION           = 42 pass / 0 fail (413->413, cert_no unchanged, 0 binding mutation)
TYPECHECK                    = PASS (tsc --noEmit, exit 0)
WORKER_DRYRUN_BUILD          = PASS (no deploy)
PROD_READONLY_VERIFY         = rows_written=0; all aggregates read-only
UQ_CERT_USER_SOURCE          = CREATED, safe (predicate excludes source_id IS NULL)
BACKWARD_COMPAT_413          = PRESERVED (0 business cols modified)
M3_POOL_SEEDING              = DEFERRED to CERT-R3 (documented deviation)
EXAM_REGRESSION              = NO behavioral change to submitAndMaybeIssueAtomically
SECRET_PII_SCAN              = CLEAN
READY_FOR_CERT_R2_COMMIT     = YES (selective: 5 new files only)
COMMIT_POLICY                = STOP BEFORE COMMIT — awaiting ChatGPT review
NEXT_PHASE                   = CERT-R3

# ---- 本轮追加固定字段 ----
EXACT_0045_INDEX_CONTRACT =
  UNIQUE INDEX uq_cert_user_source
  ON certificates(user_id, source_type, source_id)
  WHERE status = 1 AND source_type = 'activity' AND source_id IS NOT NULL
  -- columns: (user_id, source_type, source_id)
  -- predicate excludes: source_id IS NULL (no authoritative source identity)
  -- covers source_type: 'activity' only (incl. SERVICE which reuses 'activity')
  -- excludes source_type: course / exam / manual / NULL
  -- status semantics: 1=active (locked), 2=revoked (excluded -> reissue allowed)
  -- legacy compat: all 413 prod rows have source_id NULL -> outside predicate, 0 rows constrained

EXACT_INDEX_PRODUCTION_CONFLICT_COUNT = 0
  (query verbatim-matched the index predicate; rows_written=0)
  NOTE: 0 because the non-NULL conflict set is EMPTY (0 of 413 rows have a
  non-NULL source_id) — NOT because conflicts were resolved.

LEGACY_NULL_SOURCE_ROWS_PRESERVED = YES
  (413/413 prod rows have source_id NULL; fixture preserves them; 0 modified)

ID_POOLS_SCHEMA_CHANGED = NO
  (no table rebuild, no CHECK change; existing cert_trn pool untouched at 500)

CERT_ACT_POOL_CREATED = NO
  (id_pools CHECK lacks 'cert_act'; seeding deferred to CERT-R3 per §H)

ACTIVITY_NUMBER_FORMAT_DECISION = DEFERRED_TO_CERT_R3
  (no authoritative product rule found; CERT-R1's CACT%06d was design-only and
   conflicts with prod JHCRT-SRV-* reality; CERT-R2 invents no external prefix)
```

---

## 14. SUCCESS DEFINITION（§32，14 项）

| # | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 权威 TS 域类型建立 | ✅ | `src/domain/certificate.ts`（TSC_EXIT=0） |
| 2 | source/kind/status 语义冻结（双层模型） | ✅ | 契约文档 §1–§4；本文档 §6 |
| 3 | 发放/审计/批量 schema 基础 | ✅ | 0045 M1 / M4 / M5 |
| 4 | 活动/服务幂等防护契约 | ✅ | 0045 M2；生产冲突 = 0；§F 负向矩阵 |
| 5 | 验收证书区分 | ✅ | `cert_kind=acceptance` + `admin_acceptance` 契约 |
| 6 | PDF/文件生命周期字段 | ✅ | 仅契约 `deriveFileStatus`（无新列） |
| 7 | 未来共享 `CertificateIssuanceService` 接口 | ✅ | 接口边界（CERT-R3 实现） |
| 8 | 向后兼容 413 | ✅ | fixture 42/0（413→413，0 绑定 mutation） |
| 9 | 迁移 SQL LOCAL ONLY | ✅ | 未 APPLY 任何环境 |
| 10 | 测试证明兼容 | ✅ | 42 pass / 0 fail + 考试发卡回归 |
| 11 | typecheck / Worker dry-run PASS | ✅ | §7.4 |
| 12 | 权限设计（不改角色） | ✅ | §11 |
| 13 | 非目标未越界（无路由/UI/RBAC/引擎） | ✅ | §0 表 + §12 STOP 表 |
| 14 | 文档 + 扫描 + FINAL RETURN | ✅ | 本文档 |

> **CERT-R2 完成并 STOP。未启动 CERT-R3。未 commit、未 push。**

---

## 15. 后续（CERT-R3 入口，非本任务范围）

1. 实现 `CertificateNumberAllocator`（决策 A/B 二选一，见 §8.1）。
2. 实现 `CertificateIssuanceService.issue()`（复用 `assertNotSystemUser` + `uq_cert_user_source`
   应用层 `NOT EXISTS` 谓词，含 `source_id IS NOT NULL`）。
3. 将 `exam.ts submitAndMaybeIssueAtomically` 收敛到共享原语（**事务边界不得改变**）。
4. 批量发证回路 + `certificate_batches` 计数写入。
5. 管理员路由接线（permission `certificate.certificate.issue[.batch]`）。
6. 验收证书发放路径（不创建考勤/服务/积分）。
7. （可选）历史 `(user, exam_paper)` 重复数据质量 remediation —— 独立 ticket，非 CERT-R3 强制项。
