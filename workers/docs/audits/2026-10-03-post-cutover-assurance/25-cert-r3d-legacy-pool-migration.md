# 25 — CERT-R3D: Legacy ID Pool Migration Package + Full Local Dry-Run

> 权威实现文档：`docs/certificate/legacy-id-pool-migration.md`
> 上游契约：`docs/certificate/legacy-id-pool-continuity.md`（CERT-R3C / R3C-FIX）
> 基线 HEAD：`c655131f0e8ac490d1e75ce7585ebdb92e6743cf`
> 模式：**LOCAL IMPLEMENTATION + OFFLINE FULL-DATA DRY-RUN**
> **禁止**：staging/production 写入、远端迁移 APPLY、部署、真实发证、commit、push、
> 触碰 JHZY 1.0 线上

---

## 1. Workspace Gate（§2）— PASS

| 项 | 要求 | 实测 |
| --- | --- | --- |
| pwd | `/Users/Shared/projects/jhzy-v2` | ✅ |
| branch | `master` | ✅ |
| HEAD | `c655131f0e8ac490d1e75ce7585ebdb92e6743cf` | ✅ 精确一致 |
| staged | 0 | ✅ 0 |
| tracked `.var` | 0 | ✅ 0 |
| 无关脏基线 | 记录即可 | `workers/` 44 · `miniprogram/` 287 |

> 迁移序列末位为 `0045`（已核实目录），故本迁移取 **`0046`**。

---

## 2. 权威快照校验（§4）— PASS

```
AUTHORITATIVE_SNAPSHOT_VERIFIED = YES
```

| 项 | 值 |
| --- | --- |
| 归档 SHA256（期望） | `d51563b0…88bf` |
| 归档 SHA256（实测） | `d51563b0…88bf` **完全一致** |
| `api_jhzyfw_com.data.sql.gz` | `5850ff6c…6936` 与 manifest 一致 |
| `api_jhzyfw_com.schema.sql.gz` | `b67db86e…c6b9` 与 manifest 一致 |

**未访问 JHZY 1.0 线上**，**未修改快照**（只读解压到 `/tmp`）。

---

## 3. §16 独立重算（先于任何实现）

导入前先从快照**独立重算**全部池计数（不接受任何预期值作为输入）：

| 池 | derived | stated | 结果 |
| --- | --- | --- | --- |
| `cert_trn` | 180,000 / 179,543 / 457 / 0 | 同 | MATCH |
| `cert_srv` | 150,000 / 149,692 / 281 / 27 | 同 | MATCH |
| `volunteer` | 100,000 / 99,079 / 921 / 0 | 同 | MATCH |
| `cert_hon` | 10,000 / 9,998 / 2 / 0 | 同 | MATCH |
| `cert_skl` | 10,000 / 10,000 / 0 / 0 | 同 | MATCH |

```
PER_POOL_MISMATCHES = 0
算术自洽：free 448,312 + assigned 1,661 + reserved 27 = 450,000  ✅
```

> §16 规定「若源推导与预期不符则 STOP」—— **未发生**。

---

## 4. 实现产物（§27）

| 文件 | 类型 | 行数级 |
| --- | --- | --- |
| `migrations/0046_id_pools_legacy_pool_compatibility.sql` | 迁移（仅 schema，**无历史数据**） | ~150 |
| `src/services/legacy-pool-importer.ts` | 导入器 | ~250 |
| `tests/cert_r3d_legacy_pool.test.mjs` | 全量 dry-run 测试 | ~380 |

---

## 5. §6–§7 Schema 扩展

```
SCHEMA_MIGRATION_REQUIRED = YES
SCHEMA_MIGRATION_FILE    = workers/migrations/0046_id_pools_legacy_pool_compatibility.sql
```

```
SCHEMA_REBUILD_STRATEGY =
  0) DROP TABLE IF EXISTS id_pools_new      （幂等残留清理）
  1) CREATE TABLE id_pools_new（CHECK 加 'cert_skl' + 可空 batch_id + UNIQUE(code)）
  2) INSERT..SELECT 全量搬迁既有 500 行（batch_id 以 NULL 起步，不臆造）
  3) DROP TABLE id_pools + ALTER TABLE ... RENAME
  4) 结构自检 ×4（非空 / 5 池可插入 / status 0,1,2 可插入 / UNIQUE 存在）
```

**SQLite 方言说明**：迁移为纯 DDL/DML，**无** `DO`/`RAISE`（与仓库既有迁移风格一致）。
结构自检采用「**约束即断言**」：期望结构写成只允许通过的临时表并插入期望值，
不符则违反 `CHECK` 使迁移立即失败。

`CERT_SKL_SUPPORTED = YES`（迁移后 `pool_type='cert_skl'` 可正常查询/插入）
`RESERVED_STATUS_SUPPORTED = YES`（`CHECK(0,1,2)` 原生接受 2，未改）

---

## 6. §12 全局唯一性决策

```
GLOBAL_CODE_UNIQUENESS_DECISION = UPGRADE_TO_GLOBAL_UNIQUE(code)
```

| 维度 | legacy | V2 迁移前 | 本迁移后 |
| --- | --- | --- | --- |
| 唯一性 | 全表 `UNIQUE(id_value)` | `UNIQUE(pool_type, code)` | **`UNIQUE(code)`** |

**依据**：legacy 450,000 条零重复；合成 500 与 legacy 族字符集互斥（交集 0）；
code 第 2 段含类型 token 故无「合法跨池同码」；`UNIQUE(code)` 是原约束的**严格子集条件**
→ 升级只更严，不放松。**未发现**任何依赖较弱唯一性的 V2 语义。

---

## 7. §9 分配引用安全

```
ASSIGNED_TO_DIRECT_COPY_SAFE = NO   （沿用 R3C 结论）
ASSIGNED_TO_GUESSED_MAPPING_COUNT = 0
```

对 1,688 条非自由行（1,661 assigned + 27 reserved）分类：

| 分类 | 数量 |
| --- | --- |
| `ASSIGNMENT_REF_NULL` | **939** |
| `ASSIGNMENT_REF_SENTINEL` | **2** |
| `ASSIGNMENT_REF_UNRESOLVED` | **747** |
| `ASSIGNMENT_REF_PROVEN_MAPPABLE` | **0** |

dry-run 实测：导入后非自由行中 `assigned_to IS NOT NULL` 的行数 = **0**
→ **未臆造任何 V2 用户映射**。legacy 溯源保留在权威快照中，不复制进用户语义列。
`status` 永不降级（27 条 `reserved` 仍为 2）。

---

## 8. §14 全量离线 dry-run — PASS

```
FULL_450K_DRY_RUN = PASS
```

隔离 sqlite（`workers/tmp/`），基线 = V2 真实 0001 schema + 合成 500 行；
应用**真实 0046**；导入**全部 450,000 行**（非抽样）。**未触碰任何远端 D1**。

| 指标 | 值 |
| --- | --- |
| 墙钟 | ~12.5 秒 |
| 批次 | 90（5,000/批） |
| inserted | **450,000** |
| conflicts | **0** |
| 导入后总量 | **450,500** |

### 8.1 逐池（legacy 口径，排除合成族）

| 池 | total | free | assigned | reserved |
| --- | --- | --- | --- | --- |
| `cert_trn` | 180,000 | 179,543 | 457 | 0 |
| `cert_srv` | 150,000 | 149,692 | 281 | 27 |
| `volunteer` | 100,000 | 99,079 | 921 | 0 |
| `cert_hon` | 10,000 | 9,998 | 2 | 0 |
| `cert_skl` | 10,000 | 10,000 | 0 | 0 |
| **合计** | **450,000** | **448,312** | **1,661** | **27** |

⚠ **口径提示**：V2 `pool_type='cert_trn'` 聚合 = **180,500**（180,000 legacy + 500 合成）。
legacy 库存是 180,000，V2 该池总行数是 180,500，**不可混淆**。

---

## 9. §13 合成 500 保全 — PASS

```
SYNTHETIC_500_PRESERVED = PASS
```

行数 500 不变 · code 集合哈希与迁移前一致 · 全部 `status=0`（未消费）·
`assigned_to`/`assigned_at` 仍 NULL · legacy 中无 `CTRN` 码（两族不混）。

---

## 10. §17 哈希对账 — 全 PASS

| 哈希 | 结果 |
| --- | --- |
| `LEGACY_CODESET_HASH` | **PASS** |
| 逐池 `POOL_CODESET_HASH_{pool}` | **PASS**（5/5） |
| 逐池 `POOL_STATE_HASH_{pool}` | **PASS**（5/5） |

比较排除合成族；**不**期望「V2 总集哈希 == legacy 哈希」。分配关系单独出报告，不混入 code 哈希。

---

## 11. §19 分配器兼容 + 一项已记录张力

```
R3B_ALLOCATOR_LEGACY_CERT_SRV_TEST = PASS
TRAINING_LEGACY_CERT_TRN_CONTINUITY = PASS
```

- `ACTIVITY`/`SERVICE` 首候选 = 已迁移 legacy `cert_srv` 空闲码 ✅
- `cert_trn` 空闲库存 179,543 条可被分配器查询 ✅
- R3B 分配器对 code 不透明（只按 `pool_type`+`status=0`+`ORDER BY id`）→ **无需 adapter**

### 11.1 已记录行为：合成 500 排在 legacy 之前

合成 500 行 `id` = 1–500，legacy 行 `id` 远大于此；`ORDER BY id ASC` 因此**先取合成码**
（dry-run 观测：`cert_trn 首候选来源 = synthetic(compat)`）。

- 语法与约束上**完全合法**（同池、同状态、唯一性满足）。
- 与「TRAINING 未来只从 legacy 取号」存在**张力**。
- **本 Gate 未改分配器**（§29 禁止）。若要 legacy 优先，需独立决策
  （如为 legacy 行分配更小 `id`，或分配器加池内优先级）。

---

## 12. §21–§23 安全测试 — 全 PASS

| 测试 | 结果 |
| --- | --- |
| 27 条 reserved 以 `status=2` 落库 | PASS |
| 分配器（`status=0`）取不到 reserved | PASS |
| `status=0` 与 `status=2` 集合无交集 | PASS |
| 全量重跑 `inserted` | **0** |
| 全量重跑 `already_present` | **450,000** |
| 全量重跑 `conflicts` | **0** |
| 重跑后总量 | **450,500**（不变） |
| 中断续跑后总量 | **450,000**，哈希与干净全量导入**一致** |
| 预置冲突（status 不同） | 检出 1 项 · **不覆盖** · 无重复 |

---

## 13. §24 既有证书编号 — PASS

本迁移**只触碰 `id_pools`**，不改写 `certificates.cert_no`。
`exam_certificates` 的 3 条历史离群编号**未触碰**，仍记录为历史例外。
`EXISTING_CERTIFICATE_NUMBERS_UNCHANGED = PASS`（结构上不可能受影响）。

---

## 14. §25 0045 边界

```
0045_MODIFIED = NO   （保持 SOURCE FROZEN，仍 NOT_APPLIED）
```

0046 **仅**处理 `id_pools` 兼容，**不**混合证书域迁移职责。

---

## 15. §26 测试 / 构建门禁 — 全 PASS

| 门禁 | 结果 |
| --- | --- |
| CERT-R3D 全量 dry-run | **51 pass / 0 fail** |
| CERT-R3B core | **63 pass / 0 fail** |
| CERT-R2 fixture | **57 pass / 0 fail** |
| `tsc --noEmit` | **PASS**（exit 0） |
| Worker dry-run | **PASS**（`--dry-run: exiting now.`） |

> 实现过程中 typecheck 捕获了导入器 `batch()` 的类型不匹配（`bind` 链式类型），
> 已修正为 `D1PreparedLike` / `D1BoundStatement` 分离接口。

---

## 16. STOP 条件核查（§31）

| 条件 | 触发？ |
| --- | --- |
| 快照哈希失败 | ❌ 完全一致 |
| legacy 计数与证据不符 | ❌ 独立重算 0 mismatch |
| 需要改写 code | ❌ 逐字节哈希一致 |
| legacy 格式无法安全容纳 | ❌ `TEXT` 无长度限制，24 字符可容纳 |
| 全局唯一性无法安全保留 | ❌ 已升级为 `UNIQUE(code)`，交集 0 |
| schema 重建丢失既有 500 | ❌ 500 行哈希一致 |
| reserved 无法保留 | ❌ 27 条保持 `status=2` |
| 导入器需要臆造 assigned_to | ❌ 写入 0 条臆造映射 |
| 全量导入无法对账 | ❌ 450,000 全量哈希一致 |
| 重跑改变状态 | ❌ inserted 0 / 总量不变 |
| 续跑结果异于干净跑 | ❌ 哈希一致 |
| 需修改 0045 | ❌ 未改 |
| 需生产/预发写入 | ❌ 仅离线 sqlite |

**未触发任何 STOP 条件。**

---

## 17. FINAL RETURN（§32）

```
CERT_R3D_START_HEAD = c655131f0e8ac490d1e75ce7585ebdb92e6743cf
WORKSPACE_GATE = PASS
AUTHORITATIVE_SNAPSHOT_VERIFIED = YES

SCHEMA_MIGRATION_REQUIRED = YES
SCHEMA_MIGRATION_FILE = workers/migrations/0046_id_pools_legacy_pool_compatibility.sql
SCHEMA_REBUILD_STRATEGY = table rebuild (create id_pools_new → copy 500 → drop+rename
                        → 4 constraint-as-assertion self-checks); SQLite has no ALTER COLUMN
CERT_SKL_SUPPORTED = YES
RESERVED_STATUS_SUPPORTED = YES

GLOBAL_CODE_UNIQUENESS_DECISION = UPGRADE_TO_GLOBAL_UNIQUE(code)
  (legacy had global UNIQUE; V2 had per-pool; upgraded to restore the stronger
   invariant — intersection with synthetic 500 is 0, and code's type token makes
   cross-pool same-code impossible, so no legitimate case is rejected)

IMPORTER_IMPLEMENTED = YES
IMPORTER_PATH = workers/src/services/legacy-pool-importer.ts
IMPORT_BATCH_SIZE = 5,000
IMPORT_RESUMABLE = YES (afterLegacyId cursor)
IMPORT_IDEMPOTENT = YES (INSERT..WHERE NOT EXISTS(code))

LEGACY_INPUT_ROWS = 450,000
LEGACY_IMPORTED_ROWS = 450,000
LEGACY_ALREADY_PRESENT = 0   (first run)
IMPORT_CONFLICTS = 0
POST_IMPORT_TOTAL_ROWS = 450,500

LEGACY_CERT_TRN_ROWS = 180,000
LEGACY_CERT_SRV_ROWS = 150,000
LEGACY_CERT_HON_ROWS = 10,000
LEGACY_CERT_SKL_ROWS = 10,000
LEGACY_VOLUNTEER_ROWS = 100,000
LEGACY_FREE_ROWS = 448,312
LEGACY_ASSIGNED_ROWS = 1,661
LEGACY_RESERVED_ROWS = 27
SYNTHETIC_CERT_TRN_ROWS = 500
  (V2 pool_type='cert_trn' aggregate = 180,500 = 180,000 legacy + 500 synthetic)

SYNTHETIC_500_PRESERVED = PASS

ASSIGNMENT_REF_NULL = 939
ASSIGNMENT_REF_SENTINEL = 2
ASSIGNMENT_REF_PROVEN_MAPPABLE = 0
ASSIGNMENT_REF_UNRESOLVED = 747
ASSIGNED_TO_GUESSED_MAPPING_COUNT = 0

LEGACY_CODESET_HASH_MATCH = PASS
PER_POOL_CODESET_HASH_MATCH = PASS (5/5)
PER_POOL_STATE_HASH_MATCH = PASS (5/5)

R3B_ALLOCATOR_LEGACY_CERT_SRV_TEST = PASS
TRAINING_LEGACY_CERT_TRN_CONTINUITY = PASS
  [recorded] synthetic 500 sort first by id → first cert_trn candidate is
  synthetic(compat). Legal but in tension with "TRAINING uses legacy only";
  resolving it requires a separate decision (allocator NOT modified here).
CERT_SKL_LOCAL_TEST = PASS
RESERVED_NOT_ALLOCATABLE_TEST = PASS

FULL_450K_DRY_RUN = PASS  (450,000 rows, 90 batches, ~12.5s, 0 conflicts)
RERUN_TEST = PASS    RERUN_NEW_INSERTS = 0   (already_present 450,000, total 450,500)
RESUME_TEST = PASS   (hash identical to clean full import)
CONFLICT_TEST = PASS (detected, no overwrite, no duplicate)
EXISTING_CERTIFICATE_NUMBERS_UNCHANGED = PASS

CERT_R3B_TESTS = PASS (63/0)
CERT_R2_FIXTURE = PASS (57/0)
TYPECHECK = PASS
WORKER_DRY_RUN = PASS
SECRET_PII_SCAN = PASS

0045_MODIFIED = NO
STAGING_D1_MUTATED = NO
PRODUCTION_D1_MUTATED = NO
REAL_CERTIFICATE_ISSUED = NO
WORKER_DEPLOYED = NO
SECRET_MUTATED = NO
RBAC_MUTATED = NO
JHZY_1_0_LIVE_TOUCHED = NO

READY_FOR_CERT_R3D_SELECTIVE_COMMIT = YES
READY_FOR_STAGING_POOL_MIGRATION =
  NO — 需先裁决 §11.1（合成 500 与 legacy 的取号优先级）及远端执行窗口

CERT_R3D_STATUS = PASS_WITH_FINDINGS

NEXT_ACTION = STOP. Await review.
```

---

## 18. CERT-R3D-FIX —— 该项发现已闭合

**原待裁决项**（合成 500 与 legacy 同处 cert_trn 时的取号优先级）已由
CERT-R3D-FIX 关闭，方案为**显式 provenance 语义**（非 id 操作、非格式推断）：

| 项 | 结果 |
| --- | --- |
| 修法 | `id_pools.provenance` 列 + 白名单谓词 |
| 合成 500 | 分类为 `v2_synthetic_compat`（保留、**不可分配**、status 零改动） |
| 450,000 历史行 | 导入时一律标记 `legacy_migrated`（可分配） |
| 未来原生库存 | `v2_native` 预留为可分配（本轮未生成任何） |
| NULL / 未知 | **不可分配**（fail-closed，无「NULL 即允许」路径） |
| 选择点 | TRAINING 与 ACT/SVC 各一，共 2 处（经同一 `allocatableProvenanceSql()`） |
| 消费点 | 4 处（exam.ts 三守卫一 UPDATE + issuance 条件 UPDATE）复用同一谓词 |
| `ORDER BY id ASC` | 仅在合格集合内部定序，不再承担语义优先级 |
| 0046 | 未提交/未应用 → 本轮**直接修正同一文件**（未建 0047）；0045 未动 |
| 测试 | CERT-R3D **79 pass / 0 fail**（51 → 79，新增 28 项） |

**TRAINING_ALLOCATION_PATH**（§10 实际链路，非 R3B 共享核心）：

```
src/services/exam-service.ts:222
  → src/repository/certificate.ts::pickCertTrnCandidate()   ← 候选选择（本轮加 provenance）
  → src/repository/exam.ts::submitAndMaybeIssueAtomically() ← 3 EXISTS 守卫 + 1 条件 UPDATE
                                                     （本轮全部加同一 provenance 谓词）
```

R3B 共享发证核心走**另一条**既有链路（`certificate-issuance.ts::peekPoolCode`），
两者现已共用同一资格规则片段，不存在两套策略。

**部署顺序约束（新增，重要）**：0046 应用后、450,000 行导入前，cert_trn
**无可分配候选** → TRAINING 返回 `EXAM_POOL_EXHAUSTED`。这是预期的
fail-closed 行为（而非违规消费兼容库存）。远端执行顺序必须为：
schema → 导入 → 恢复发证。

**R3B 测试夹具同步更新**：`tests/cert_r3b_issuance_core.test.mjs` 的
`id_pools` 夹具 schema 补 `provenance` 列、种子行标记 `legacy_migrated`
（对应生产 schema 现状）。回归 63 pass / 0 fail —— 反证生产代码变更正确、
仅夹具需对齐新 schema。

---

## 19. STOP

CERT-R3D 完成。**未提交、未推送、未应用任何远端迁移、未发证。**
