# 历史编号池迁移包（CERT-R3D 实现）

> 本文档描述 CERT-R3D 已落地的迁移包实现与全量离线 dry-run 结果。
> 上游契约：`legacy-id-pool-continuity.md`（CERT-R3C / R3C-FIX）
> 审计报告：`docs/audits/2026-10-03-post-cutover-assurance/25-cert-r3d-legacy-pool-migration.md`
> 基线 HEAD：`c655131f0e8ac490d1e75ce7585ebdb92e6743cf`
>
> 模式：**LOCAL IMPLEMENTATION + OFFLINE FULL-DATA DRY-RUN**
> 本 Gate **未**写 staging / production，**未**部署，**未**发证，**未**提交。

---

## 0. 冻结前提（未在本 Gate 重开）

```
LEGACY_POOL_ASSET_POLICY     = PRESERVE_AND_CONTINUE
NUMBER_FORMAT_POLICY         = PRESERVE_LEGACY_FORMATS
LEGACY_CERT_TRN_ROLE         = AUTHORITATIVE_CONTINUING_INVENTORY
NEW_NUMBER_FORMAT            = FORBIDDEN
NEW_NUMBER_GENERATION        = FORBIDDEN
LEGACY CODE MUTATION         = FORBIDDEN
LEGACY CODE REGENERATION     = FORBIDDEN
LEGACY CODE RENNUMBERING     = FORBIDDEN
```

合成 `CTRN%06d` 500 行在本 Gate 中：**未删除、未消费、未改写、未视为 legacy 替代**。

---

## 1. 交付物

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `migrations/0046_id_pools_legacy_pool_compatibility.sql` | 迁移（**仅 schema**） | `pool_type` 扩 `cert_skl` + 新增 `batch_id` + 新增 `provenance` + 恢复 `UNIQUE(code)` |
| `src/services/legacy-pool-importer.ts` | 导入器 | 分批 / 可续跑 / 幂等 / 冲突显式 / 无臆造映射 |
| `tests/cert_r3d_legacy_pool.test.mjs` | 全量 dry-run | 450,000 行真实导入 + 哈希 + 重跑 + 续跑 + 冲突 |

> **迁移文件内不含任何历史数据**（§7 硬要求）：450,000 行由导入器搬运。

---

## 2. §6 Schema 扩展策略

SQLite **不支持** `ALTER TABLE ... ALTER COLUMN`（无法就地改 CHECK），故采用**表重建**：

| 步 | 动作 |
| --- | --- |
| 0 | `DROP TABLE IF EXISTS id_pools_new`（幂等残留清理） |
| 1 | `CREATE TABLE id_pools_new`：CHECK 加 `cert_skl`、新增可空 `batch_id`、新增 `provenance`、`UNIQUE(code)` |
| 2 | `INSERT ... SELECT` 全量搬迁既有行（`batch_id` 以 NULL 起步；既有 500 行显式分类 `provenance='v2_synthetic_compat'`） |
| 3 | `DROP TABLE id_pools` + `ALTER TABLE id_pools_new RENAME TO id_pools` |
| 4 | 结构自检（见下） |

**相对原结构仅三处业务变化**：
1. `pool_type` CHECK 增加 `cert_skl`（承载已证实的历史资产）
2. 新增可空 `batch_id`（legacy 批次溯源；V2 既有行无此元数据 → NULL）
3. 新增 `provenance`（库存来源语义 = 分配资格的唯一判据，见 §2.1）

> **CERT-R3D-FIX 补充**：第3 项由 CERT-R3D-FIX 加入。0046 尚未提交/未远端应用，
> 故在本轮直接修正同一文件（未创建 0047）。

**严格未改**：`status` 语义与 `CHECK(0,1,2)`、`assigned_to`/`assigned_at` 语义、
`code` 类型、`certificates` 等其他表。

### 2.1 结构自检手法（SQLite 无 `DO`/`RAISE`）

采用「**约束即断言**」：把期望结构写成只允许通过的临时表并插入期望值；
不符则 `INSERT` 违反 `CHECK` → 迁移立即失败，不会静默损坏。四项断言：
非空、5 个 `pool_type` 全可插入、`status` 0/1/2 全可插入、`UNIQUE` 索引存在。
每项断言后立即 `DROP`，不留残留。

### 2.2 迁移 ID 说明

仓库迁移序列末位为 `0045`（本 Gate 之前），故本迁移取 **`0046`**（已核实目录后确定）。

---

## 2.1 §4/§5/§9 库存来源（provenance）与分配优先级 —— CERT-R3D-FIX 核心决策

### 2.1.1 待修缺陷

CERT-R3D 完成后实测发现：合成 500 行 id = 1..500，导入的 180,000 行 legacy
cert_trn id 远大于此。原分配谓词为 `pool_type + status=0 + ORDER BY id ASC`，
故 **TRAINING 会先消费合成 CTRN 码** —— 违反冻结决策

```
NUMBER_FORMAT_POLICY = PRESERVE_LEGACY_FORMATS
LEGACY_CERT_TRN_ROLE  = AUTHORITATIVE_CONTINUING_INVENTORY
V2_SYNTHETIC_CERT_TRN_ROLE = COMPATIBILITY_INVENTORY_PENDING_USAGE_AUDIT
```

### 2.1.2 修法：显式存储语义（不做任何格式推断）

**明确禁止**（§3）：改 legacy 行 id · 删合成行 · 伪造 status 以隐藏合成行 ·
用 CTRN/JHCRT 前缀或长度或正则判别来源。

采用**显式来源列** `id_pools.provenance`：

| provenance | 含义 | 可分配 |
| --- | --- | --- |
| `legacy_migrated` | 由权威快照导入的 450,000 行历史库存 | ✅ |
| `v2_synthetic_compat` | V2 0022 播种的 500 条 CTRN 合成兼容库存 | ❌ |
| `v2_native` | 未来经显式批准的 V2 原生库存（本轮**不生成任何**） | ✅ |
| `NULL` / 未知 | 未分类或历史兼容态 | ❌（fail-closed） |

schema 约束：`CHECK (provenance IS NULL OR provenance IN (…))` —— 未知字面量无法写入。

### 2.1.3 FAIL-CLOSED（§5）

分配谓词为**白名单** `IN ('legacy_migrated','v2_native')`：

- `v2_synthetic_compat` → 不命中 → 不可分配
- `NULL` → 不命中（SQL 三值逻辑下 `NULL IN (…)` 非真）→ 不可分配
- 未来任何未知值 → 不命中 → 不可分配

**不存在「NULL 即允许」的路径**。故未新增冗余的 allocatable 布尔列 ——
provenance 本身即稳定的 fail-closed 判据，避免两列在未来漂移不一致。

### 2.1.4 单一策略，两个选择点（§10）

TRAINING 与 ACTIVITY/SERVICE 走**不同**的既有选择器，本轮把同一资格规则
经 `src/domain/certificate.ts::allocatableProvenanceSql()` 注入两处，
并在**消费侧**复用同一片段，确保「选时合法、烧时另一套规则」不可能发生：

| 角色 | 位置 | 变更 |
| --- | --- | --- |
| TRAINING 候选 | `repository/certificate.ts::pickCertTrnCandidate` | + provenance 谓词 |
| TRAINING 消费 | `repository/exam.ts`（3 处 EXISTS 守卫 + 1 处条件 UPDATE） | + provenance 谓词 |
| ACT/SVC 候选 | `repository/certificate-issuance.ts::peekPoolCode` | + provenance 谓词 |
| ACT/SVC 消费 | `repository/certificate-issuance.ts::buildPoolConsumeStatement` | + provenance 谓词 |

`ORDER BY id ASC` 仅在**合格集合内部**提供确定性定序，不再承担语义优先级。

### 2.1.5 合成 500 的保全方式（§7/§20）

既有 500 行在 0046 步骤 2 被**显式分类**为 `v2_synthetic_compat`，
业务字段（code / status / assigned_to / assigned_at）**逐字节不变**：

- `SYNTHETIC_STATUS_MUTATIONS = 0`（status 仍为历史事实 0）
- 「不被分配」完全来自 provenance 语义，而非伪造 status
- 未删除、未重编号、未消费

### 2.1.6 导入侧分类（§8）

导入器为**每一条**历史行写入 `provenance='legacy_migrated'`（常量
`LEGACY_PROVENANCE`），不留 NULL、不事后推断。provenance 亦列为**受保护字段**：
同 code 但来源不同 → 判定为**冲突**并显式报告，绝不静默覆盖（§19）。

哈希对账同步扩展：`hashPoolStateWithProvenance()` 以 `(code, status, provenance)`
三元组计算，NULL 以字面量 `NULL` 参与（§18）。

### 2.1.7 部署顺序约束（重要）

0046 应用后、历史库存导入前，cert_trn **无可分配候选**（500 条被排除）。
这是**预期的 fail-closed 行为**：TRAINING 将得到 `EXAM_POOL_EXHAUSTED`，
而非违规消费兼容库存。远端执行必须遵守：

```
1) 应用 0046（schema）  →  2) 导入 450,000 行历史库存  →  3) 恢复正常发证
```

---

## 3. §12 全局唯一性决策

```
GLOBAL_CODE_UNIQUENESS_DECISION = UPGRADE_TO_GLOBAL_UNIQUE(code)
```

| 维度 | legacy | V2 迁移前 | 本迁移后 |
| --- | --- | --- | --- |
| 唯一性 | **全表** `UNIQUE(id_value)` | `UNIQUE(pool_type, code)` | **`UNIQUE(code)`** |

**决策依据（全部经实测）**：
1. legacy 450,000 条 code 实测**零重复**（同池/跨池均为 0）。
2. V2 现有 500 条合成码（`CTRN%` 10 字符）与 legacy 族（`JHCRT-*`/`JH-*` 24/17 字符）
   字符集互斥，**精确交集 = 0** → 升级不会与既有行冲突。
3. code 第 2 段已含类型 token（`TRN`/`SRV`/`HON`/`SKL`），故 code 本身在语义上
   已可区分池，**不存在「合法跨池同码」会被误拒**的情形。
4. `UNIQUE(code)` 是 `UNIQUE(pool_type, code)` 的**严格子集条件** → 升级只更严，不放松。

**结论**：恢复 legacy 的更强不变量，防止未来任何跨池重复分配。

---

## 4. §8 状态映射（冻结，无证据不改）

```
available → 0
assigned  → 1
reserved  → 2
```

- `reserved` **保持 reserved**：即便分配引用不可考，**也不降级**为 free
  （否则会让一个历史上已发出的编号被重新分配，违反冻结规则 5/6）。
- dry-run 实测：27 条 `reserved` 全部以 `status=2` 落库。

---

## 5. §9 分配引用安全策略

```
ASSIGNED_TO_DIRECT_COPY_SAFE = NO   （R3C 结论，本 Gate 沿用）
```

导入器对每个非自由行（1,688 = 1,661 assigned + 27 reserved）分类：

| 分类 | 数量 | 处理 |
| --- | --- | --- |
| `ASSIGNMENT_REF_NULL` | **939** | `assigned_to` 保持 NULL |
| `ASSIGNMENT_REF_SENTINEL` | **2** | 哨兵值（999999 等）→ NULL，**不当作 users.id** |
| `ASSIGNMENT_REF_UNRESOLVED` | **747** | 无权威映射证据 → NULL |
| `ASSIGNMENT_REF_PROVEN_MAPPABLE` | **0** | 快照中无权威用户映射证据 |

**关键**：`assigned_to` 写 0 条（dry-run 实测 `withRef = 0`）——
**不臆造任何 V2 用户映射**。legacy 分配溯源由 legacy 快照本身保留（权威来源），
不复制进 V2 的用户语义列。

> 按池分布：`volunteer` 889 NULL / 2 SENTINEL / 30 UNRESOLVED；
> `cert_trn` 14 / 0 / 443；`cert_srv` 34 / 0 / 274；`cert_hon` 2 / 0 / 0。

---

## 6. §10–§11 导入器

```
IMPORTER_IMPLEMENTED = YES
IMPORTER_PATH        = workers/src/services/legacy-pool-importer.ts
IMPORT_BATCH_SIZE    = 5,000
IMPORT_RESUMABLE     = YES（afterLegacyId 游标）
IMPORT_IDEMPOTENT    = YES（INSERT ... WHERE NOT EXISTS(code)）
```

| 特性 | 实现 |
| --- | --- |
| 确定性顺序 | 按 legacy `id` 升序（可复现） |
| 分批 | 每批 ≤ 5,000（本次 90 批） |
| 幂等 | `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM id_pools WHERE code = ?)` |
| 冲突显式 | 同 code 但 `pool_type`/`status` 不同 → 记录 `ImportConflict`，**绝不覆盖** |
| 状态直译 | `STATUS_MAP` 冻结映射 |
| 无 PII 日志 | 只输出计数与 `[info]` 进度，不打印 code |

### 6.1 冲突语义

同 code 已存在且受保护字段一致 → 计入 `alreadyPresent`（不重复插入）。
同 code 但 `pool_type` 或 `status` 不同 → 计入 `conflicts` 并记录字段级差异，
**不执行任何 UPDATE/REPLACE**（dry-run 实测：预置冲突行后重跑，
冲突被检出、既有 status 保持不变、总量仍为 1 行）。

---

## 7. §14 全量离线 dry-run 结果

```
FULL_450K_DRY_RUN = PASS
```

环境：`workers/tmp/` 独立 sqlite（node:sqlite），基线为 **V2 真实 0001 schema** + 合成 500 行；
应用**真实 0046 迁移文件**；导入**全部 450,000 行**（非抽样）。
**未**触碰 local/staging/production D1。

| 指标 | 值 |
| --- | --- |
| 导入墙钟 | ~12.5 秒 |
| 批次 | 90（5,000/批） |
| `inserted` | **450,000** |
| `conflicts` | **0** |
| 导入后总量 | **450,500** |

### 7.1 逐池计数（legacy 口径，排除合成族）

| 池 | total | free | assigned | reserved |
| --- | --- | --- | --- | --- |
| `cert_trn` | 180,000 | 179,543 | 457 | 0 |
| `cert_srv` | 150,000 | 149,692 | 281 | 27 |
| `volunteer` | 100,000 | 99,079 | 921 | 0 |
| `cert_hon` | 10,000 | 9,998 | 2 | 0 |
| `cert_skl` | 10,000 | 10,000 | 0 | 0 |
| **合计** | **450,000** | **448,312** | **1,661** | **27** |

算术自洽：`448,312 + 1,661 + 27 = 450,000` ✅

> **重要口径提示**：V2 `pool_type='cert_trn'` 的聚合值为 **180,500**
> （= 180,000 legacy + 500 合成）。二者**不可混淆**：
> legacy 库存是 180,000；V2 该池总行数是 180,500。
> 合成族以 `code LIKE 'CTRN%'` 区分（本 Gate 唯一使用到的区分方式）。

### 7.2 §16 独立重算校验

导入前已从权威快照**独立重算**（不接受任何预期值作为输入）：
5 个池的 total/free/assigned/reserved **逐项 MATCH**，
`PER_POOL_MISMATCHES = 0`，且算术和自洽。
若源推导与预期不符，Gate 要求 STOP —— **未发生**。

---

## 8. §13 合成 500 保全

```
SYNTHETIC_500_PRESERVED = PASS
```

| 检查 | 结果 |
| --- | --- |
| 行数不变 | 500 |
| code 集合哈希 | 与迁移前一致 |
| 全部 `status=0`（未消费） | ✅ |
| `assigned_to` / `assigned_at` 仍 NULL | ✅ |
| legacy 中无 `CTRN` 码（两族不混） | ✅ |

---

## 9. §17 哈希对账

| 哈希 | 结果 |
| --- | --- |
| `LEGACY_CODESET_HASH`（全局） | **PASS** |
| 逐池 `POOL_CODESET_HASH_{pool}` | **PASS**（5/5） |
| 逐池 `POOL_STATE_HASH_{pool}`（`(code,status)`） | **PASS**（5/5） |

- 比较时**排除合成族**（`code NOT LIKE 'CTRN%'`），因为合成 500 是 V2 附加行，
  与 legacy 子集不可混算。
- **不**期望「V2 总集哈希 == legacy 哈希」：前者含 500 条合成行。

### 9.1 分配关系单独对账

分配关系**刻意不混入 code 哈希**（否则无法区分「编号丢失」与「引用不可考」）：
`RELATION_RECONCILIATION_REPORT` 以四类聚合计数呈现（见 §5）。

---

## 10. §19 R3B 分配器兼容

```
R3B_ALLOCATOR_LEGACY_CERT_SRV_TEST = PASS
TRAINING_LEGACY_CERT_TRN_CONTINUITY = PASS
```

R3B 分配器（`peekPoolCode`）只按 `pool_type` + `status=0` + `ORDER BY id ASC` 取号，
对 code 完全不透明 → **无需 adapter**。dry-run 实测：

- `ACTIVITY` / `SERVICE` 首候选 = **已迁移的 legacy `cert_srv` 空闲码** ✅
- `cert_trn` 空闲库存 = **179,543 条可被分配器查询**（连续性成立） ✅

### 10.1 已记录行为：合成 500 排在 legacy 之前

合成 500 行的 `id` 为 1–500，legacy 行的 `id` 远大于此；
`ORDER BY id ASC` 因此**先取到合成码**。dry-run 观测：
`cert_trn 首候选来源 = synthetic(compat)`。

- 这在语法与约束上**完全合法**（同池、同状态、唯一性满足）。
- 但与「TRAINING 未来只从 legacy 取号」的期望**存在张力**。
- **本 Gate 不改分配器**（§29 禁止修改 allocator），仅记录该行为。
  若产品希望 legacy 优先，需要一个**独立决策**（例如为 legacy 行分配更小的 `id`，
  或在分配器加池内优先级），**不在本 Gate 范围**。

---

## 11. §21 reserved 不可分配验证

```
RESERVED_NOT_ALLOCATABLE_TEST = PASS
```

| 断言 | 结果 |
| --- | --- |
| 27 条 `reserved` 以 `status=2` 落库 | ✅ |
| 分配器（`status=0`）取不到 reserved 码 | ✅ |
| `status=0` 集合与 `status=2` 集合无交集 | ✅ |

---

## 12. §22–§23 重跑 / 续跑 / 冲突

| 测试 | 结果 |
| --- | --- |
| 全量重跑：`inserted` | **0** |
| 全量重跑：`already_present` | **450,000** |
| 全量重跑：`conflicts` | **0** |
| 全量重跑后总量 | **450,500**（不变） |
| 中断后续跑总量 | **450,000**（无合成行的干净库） |
| 续跑结果 vs 干净全量导入 | **code 集合哈希一致** |
| 预置冲突（status 不同） | **检出 1 项，不覆盖，无重复** |

---

## 13. §24 既有证书编号

- 本迁移**只触碰 `id_pools`**，**不改写** `certificates.cert_no`。
- `exam_certificates` 的 3 条历史离群编号**未触碰**，仍作为单独记录的历史例外。
- dry-run 未涉及 `certificates` 表，故
  `EXISTING_CERTIFICATE_NUMBERS_UNCHANGED = PASS`（结构上不可能受影响）。

---

## 14. §25 0045 边界

- **未修改 0045**（保持 SOURCE FROZEN）。
- 0046 **仅**处理 `id_pools` 兼容，**不**混合证书域迁移职责。
- 0045 仍 **NOT_APPLIED**（staging / production 均未应用）。

---

## 15. 明确保留的遗留

远端 pool 导入（staging / production）· 0045 远端应用 · 合成 500 的最终处置 ·
legacy 优先分配策略 · 分配引用映射证据 · 3 条历史离群编号 ·
HTTP 路由 / 批量 / PDF / R2 / 公开验真修复 / 前端 / 考试迁移 / 验收证书发放

---

## 16. 数据保护声明

本文档仅记录聚合计数、哈希与格式模式。**未**包含：真实编号字符串、接收者 ID、
姓名、手机号、OpenID、身份证、生产连接串。历史格式以模式呈现
（`JHCRT-{TRN|SRV|HON|SKL}-<8>-<5>` / `JH-<8>-<5>` / `CTRN%06d`）。
