# 24 — CERT-R3C: Legacy ID Pool Continuity & Migration Audit

> 权威决策文档：`docs/certificate/legacy-id-pool-continuity.md`
> **实施状态（2026-10-03）**：本审计提出的迁移设计已由 **CERT-R3D** 实施，
> 见 `25-cert-r3d-legacy-pool-migration.md` 与 `docs/certificate/legacy-id-pool-migration.md`
> （迁移 `0046` + 导入器 + 450,000 行全量离线 dry-run PASS）。
> 基线 HEAD：`c655131f0e8ac490d1e75ce7585ebdb92e6743cf`（CERT-R3B = CLOSED/PASS）
> 权威历史证据：WP4-D 快照 `wp4d_authoritative_20260921_120656`
> 模式：**READ-ONLY FORENSIC AUDIT + MIGRATION DECISION GATE**
> **禁止**：重设计编号 / 生成新编号 / 播种 / 建迁移 / 改 0045 / 改 R3B 源码 /
> 写任何 D1 / 部署 / 发证 / commit / push / 触碰 JHZY 1.0 线上
>
> ---
>
> ## ⚠ CERT-R3C-FIX 修正告示（2026-10-03）— 三处结论经精确对账后修正
>
> | 项 | 原（错误）表述 | **当前真相（已验证）** |
> | --- | --- | --- |
> | 池内 code 格式 | `JHCRT-<单字母>-<8>-<5>` | **`JHCRT-TRN/SRV/HON/SKL-<8>-<5>`**（完整类型段） |
> | `cert_srv`/`cert_skl` 前缀 | 「共用 `JHCRT-S`，仅靠 id_type 区分」 | **不共用**（`SRV` vs `SKL`），前缀即可区分 |
> | 业务表编号来源 | 「属另一编码体系，非池成员」 | **是池成员**（inPool 59/59、134/134、150/150、817/820、5/5） |
> | 缺口账 | 450,000 − 500 = 缺 449,500 | **缺 450,000**（合成码不属 legacy 集合，不得相减） |
> | `assigned_to` | 计划照搬 | **不可直接复制**（912 NULL / 2 哨兵 / volunteer 96.5% 缺失） |
>
> 冻结的人类决策见主文档 §0.1；完整修正见主文档 §3A / §4 / §6.0 / §8 / §8A / §9。

---

---

## 1. Workspace Gate（§3）— PASS

| 项 | 要求 | 实测 |
| --- | --- | --- |
| pwd | `/Users/Shared/projects/jhzy-v2` | ✅ |
| branch | `master` | ✅ |
| HEAD | `c655131f0e8ac490d1e75ce7585ebdb92e6743cf` | ✅ 精确一致 |
| staged | 0 | ✅ 0 |
| tracked `.var` | 0 | ✅ 0 |
| 无关脏基线 | 记录即可 | `workers/` 44 · `miniprogram/` 287 |

> 门禁全程**未清理**任何无关脏文件。

---

## 2. 权威快照（§5）

```
AUTHORITATIVE_SNAPSHOT_FOUND = YES
```

| 项 | 值 |
| --- | --- |
| run_id | `wp4d_authoritative_20260921_120656` |
| Mac 副本 | `/Users/Shared/jhzy-v2-wp4d-snapshot/wp4d_authoritative_20260921_120656` |
| 打包归档 | `/Users/Shared/jhzy-v2-wp4d-authoritative-20260921.tar.gz` |
| `authoritative_snapshot` | **YES** |
| `gzip_check_result` | **PASS** |
| `copy_not_cut` | **true** |
| `routines_capture_status` | **PASS**（`assign_certificate_id` 已捕获） |
| `abort_status` | PASS |
| 源库 | `api_jhzyfw_com`（128 对象）· `signup_db`（3 对象） |

**完整性**：`sha256_manifest.txt` 列出 5 个文件哈希，`gzip_check` 全部 OK。
本 Gate **只读**该快照（解压到 `/tmp` 分析），**未访问 JHZY 1.0 线上**。

---

## 3. 历史池重建（§6 / §9）

```
NUMBERING_HISTORY_RECONSTRUCTED = YES
LEGACY_POOL_TYPES = cert_trn, cert_srv, cert_hon, cert_skl, volunteer
LEGACY_POOL_TOTAL_ROWS = 450,000
CERTIFICATE_POOL_TOTAL_ROWS = 340,000     (cert_trn+cert_srv+cert_hon+cert_skl)
NON_CERTIFICATE_POOL_TOTAL_ROWS = 100,000 (volunteer)
```

**发现方法**：从 `api_jhzyfw_com.data.sql.gz`（54MB 解压）解析 `id_pool` 全部
**40 条 INSERT 语句、450,000 个元组**（`AUTO_INCREMENT=713603`）。
逐元组统计 `id_type` × `status` 分布、code 段长与形状、重复与 NULL。
**未打印任何真实 code。**

### 3.1 逐池计数（PER_POOL_COUNTS）

| POOL_TYPE | TOTAL | FREE | ASSIGNED | RESERVED | NULL_CODE | DUP_SAME_POOL | LEN | 段长 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cert_trn` | 180,000 | 179,543 | 457 | 0 | 0 | 0 | 24 | 5-3-8-5 |
| `cert_srv` | 150,000 | 149,692 | 281 | 27 | 0 | 0 | 24 | 5-3-8-5 |
| `volunteer` | 100,000 | 99,079 | 921 | 0 | 0 | 0 | 17 | 2-8-5 |
| `cert_hon` | 10,000 | 9,998 | 2 | 0 | 0 | 0 | 24 | 5-3-8-5 |
| `cert_skl` | 10,000 | 10,000 | 0 | 0 | 0 | 0 | 24 | 5-3-8-5 |
| **合计** | **450,000** | **438,312** | **1,661** | **27** | **0** | **0** | — | — |

**与用户预期的差异解释**：用户预期「约 40 万」，实测 **450,000**。
差异来源：早期 `Phase0.4.1` 报告只统计了 `available` 部分
（179,669+149,692+99,252+10,000+9,998 ≈ 44.9 万的子集视角），
本 Gate 统计的是**全量含 assigned/reserved**，故得 450,000。
**未强行凑数**，以证据为准。

`LEGACY_DUPLICATE_WITHIN_POOL_COUNT = 0`
`LEGACY_CROSS_POOL_COLLISION_COUNT = 0`

---

## 4. 状态语义与格式（§7 / §8）

```
LEGACY_STATUS_SEMANTICS =
  available = 空闲可分配（唯一可消费态；1.0 过程显式拒绝非 available）
  reserved  = 已预占/待生效（assign_certificate_id 把 available→reserved 并写 usage_log）
  assigned  = 已最终分配
  三者在 V2 直译为 0 / 2 / 1
```

权威证据（`api_jhzyfw_com.routines.sql.gz` → `assign_certificate_id`）：
`SELECT status ... ; IF v_current_status != 'available' THEN SIGNAL ;` +
`UPDATE id_pool SET status='reserved' ...` + 写 `certificate_id_usage_log`。

> **重要语义发现**：1.0 的分配过程把号从 `available` 直接推到 **`reserved`**，
> **不是** `assigned`。故 `cert_srv` 的 27 条 `reserved` **不是**空闲库存，
> 迁移时必须落 `status=2`，**不得**折叠为 0。

```
PER_POOL_FORMAT_PATTERNS =
  cert_trn : JHCRT-TRN-<8>-<5>  (24 chars, 4 segments)
  cert_srv : JHCRT-SRV-<8>-<5>  (24 chars, 4 segments)
  cert_hon : JHCRT-HON-<8>-<5>  (24 chars, 4 segments)
  cert_skl : JHCRT-SKL-<8>-<5>  (24 chars, 4 segments)
  volunteer: JH-<8>-<5>          (17 chars, 3 segments)
  [CERT-R3C-FIX 修正] 第 2 段为完整类型段（TRN/SRV/HON/SKL），非单字母；
                        cert_srv 与 cert_skl 前缀不同（原「共用 JHCRT-S」结论已撤销）
  性质：预生成字面量（ULID 派生段）；V2 运行时【不需生成任何内容】
```

**关键发现**：`cert_srv` 与 `cert_skl` **共用 `JHCRT-S` 前缀**，仅靠 `id_type` 区分。
故 1.0 把 `id_value` 设为**全表 UNIQUE**（而非 per-type）—— 前缀不可用于区分池。
任何迁移实现**不得**依赖前缀做池判别。

---

## 5. 已分配编号对账（§10）

```
ASSIGNED_WITH_MATCHING_BUSINESS_RECORD = 998
ASSIGNED_WITHOUT_BUSINESS_RECORD        = 663
MULTI_ASSIGNMENT_CONFLICTS              = 0
NUMBER_LITERAL_MISMATCHES               = 0
```

| 池 | ASSIGNED | 有业务记录 | 无业务记录 |
| --- | --- | --- | --- |
| `cert_trn` | 457 | 436 | 21 |
| `cert_srv` | 281 | 130 | 151 |
| `volunteer` | 921 | 432 | 489 |
| `cert_hon` | 2 | 0 | 2 |
| 合计 | 1,661 | 998 | 663 |

> 663 条「已分配但无业务记录」是历史事实（号被分配后业务未落地）。
> 迁移**必须原样保留其 `assigned` 语义**，不得回收为 free。
> 另发现业务表存在**不在 `id_pool` 内**的编号族
> （`JHCRT-SRV-*` / `JH-*`，与池内 `JHCRT-S-*` 前缀不同）——
> 本 Gate **不推断**二者关系，**不归并、不重排**。

---

## 5A. CERT-R3C-FIX 结论（精确对账，只读）

### 5A.1 §4 精确集合交集

| 指标 | 值 |
| --- | --- |
| `LEGACY_V2_EXACT_CODE_INTERSECTION_COUNT` | **0** |
| `SAME_CODE_SAME_POOL_COUNT` | **0** |
| `SAME_CODE_DIFFERENT_POOL_COUNT` | **0** |
| `STATUS_CONFLICT_COUNT` | **0** |
| `LEGACY_ROWS_ALREADY_PRESENT_IN_V2` | **0** |
| `LEGACY_ROWS_MISSING_FROM_V2` | **450,000** |
| `V2_SYNTHETIC_ROWS` | **500** |
| `TARGET_POST_IMPORT_TOTAL` | **450,500** |

依据：V2 500 条 code 长度 10、前缀族单一（`distinctPrefix5 = 1`）；
legacy 350,000 条 `JHCRT-` + 100,000 条 `JH-`。两族字符集互斥 → 交集**证明为 0**（非假设）。

### 5A.2 §5 合成 `cert_trn` 500 审计

| 指标 | 值 |
| --- | --- |
| TOTAL / FREE / ASSIGNED / OTHER | 500 / 500 / 0 / 0 |
| `assigned_to` 非空 / `assigned_at` 非空 | 0 / 0 |
| V2 `certificates` 中 `CTRN%` | **0**（413 张全部 `JHCRT%`） |
| V2 `certificate_logs` 行数 | **0** |

```
SYNTHETIC_CERT_TRN_EVER_CONSUMED          = NO
SYNTHETIC_CERT_TRN_CURRENTLY_REFERENCED   = NO
SYNTHETIC_CERT_TRN_REFERENCED_CERTIFICATE_COUNT = 0
```

```
FUTURE_CERT_TRN_ALLOCATION_POLICY =
  TRAINING 未来发放只从 legacy cert_trn 库存取号（权威延续库存）；
  合成池零消费、零引用，标为 COMPATIBILITY_INVENTORY_PENDING_USAGE_AUDIT，
  不删除、不重编号；因从未消费，无「已发放合成号需永久保全」的历史负担。
```

### 5A.3 §8 reserved 原生支持

```
RESERVED_STATUS_NATIVE_SUPPORT = YES
```
V2 `status CHECK(0,1,2)` 原生接受 `2`；legacy `reserved` 直译 `status=2`，无需 schema 变更。

### 5A.4 §9 assigned_to 不可直接复制

```
ASSIGNED_TO_DIRECT_COPY_SAFE = NO
```
1,661 条 assigned 中：**912 引用 NULL**、**2 条哨兵 999999**、747 条小整数
（legacy `users` 仅 54 行，量级不匹配，未经证实指向 users.id）；
`volunteer` 池 **889/921（96.5%）** 引用缺失。

映射要求：code/status 逐字节保全；`assigned_to` 保持 NULL 者保持 NULL；
哨兵值单独标记；待证引用需独立映射证据，**不得臆造**；
**不得**因引用不可考而把 assigned 折叠为 available。

### 5A.5 §7 cert_skl schema 扩展

```
CERT_SKL_SCHEMA_EXTENSION_REQUIRED = YES
ID_POOLS_SCHEMA_EXTENSION_AUTHORIZED_IN_PRINCIPLE = YES
```
编排（仅设计）：建 `id_pools_new`（CHECK 加 `cert_skl`，可选加 `batch_id`）
→ 全量 copy 现有 500 行 → 校验行数与哈希 → drop + rename → 校验索引与唯一性。
**本 Gate 未执行任何 schema 变更。**

### 5A.6 §10 池外编号族溯源

全部业务表编号族均为 **POOL_DERIVED**（以 450,000 条池全集做成员判定）。
例外：`exam_certificates` 中 **3 条**不在池内 → `UNKNOWN`，单独记录，不合并、不重编号。

### 5A.7 §11/§12 导入量与顺序

```
FUTURE_LEGACY_IMPORT_ROW_COUNT = 450,000   （原 449,500 已纠正）

FUTURE_IMPORT_ORDER =
  1) schema 扩展（表重建加入 cert_skl [+ batch_id]）
  2) 非自由历史行（assigned 1,661 + reserved 27 = 1,688）
  3) 自由库存（available 438,312，分批）
```
Step 2 优先的技术依据：这些行携带「不可重分配」语义，误操作代价最高；
每步内部按 `id` 升序保证确定性。

### 5A.8 §13 哈希契约（分离 code 集合与分配关系）

```
A) LEGACY_CODESET_HASH          — 全局 code 集合
B) POOL_CODESET_HASH_{pool}     — 逐池 code 集合
C) POOL_STATE_HASH_{pool}       — (code,status)，不含 assigned_to
D) LEGACY_ASSIGNMENT_HASH_{pool} + RELATION_RECONCILIATION_REPORT
   — 分配关系【单独】对账，刻意不混入 code 哈希，
     以便区分「code 丢失」与「引用不可考」
验收：A/B/C 哈希必须完全相等；分配关系按四类聚合计数对账。
```

---

```
CURRENT_V2_POOL_TYPES = [cert_trn]
CURRENT_V2_POOL_TOTAL_ROWS = 500
CERT_TRN_PROVENANCE = SYNTHETIC
CERT_TRN_CONTINUITY_GAP = YES
```

V2 生产只读实测：`cert_trn | status=0 | 500 | len=10 | prefix=CTRN`。

**溯源**：500 条来自 `migrations/0022_p32_training_exam_cert.sql` 的
`printf('CTRN%06d', x)` —— **合成播种**，非历史迁移。
历史 `cert_trn` 为 `JHCRT-T-<8>-<5>`（24 字符）。
→ **V2 正并行运行第二套编号体系；历史资产完全未迁入。**

### 6.1 LEGACY_TO_V2_GAP

| POOL | LEGACY | V2 | MISSING_FROM_V2 | MIGRATION_REQUIRED |
| --- | --- | --- | --- | --- |
| `cert_trn` | 180,000 | 500* | 179,500 | YES |
| `cert_srv` | 150,000 | 0 | 150,000 | YES |
| `cert_hon` | 10,000 | 0 | 10,000 | YES |
| `cert_skl` | 10,000 | 0 | 10,000 | YES（需扩 CHECK） |
| `volunteer` | 100,000 | 0 | 100,000 | YES |
| 合计 | 450,000 | 500 | 449,500 | — |

\* V2 的 500 条属**不同体系**，故历史 180,000 条**全部**仍缺。

> **不得**因 V2 缺这些池就判定其过时 —— 用户已冻结其为项目资产。

---

## 7. 各池连续性与可复用性（§14 / §15 / §16 / §17）

```
CERT_SRV_LEGACY_REUSABLE      = YES
CERT_HON_MIGRATION_REQUIRED  = YES
CERT_SKL_FOUND                = YES
VOLUNTEER_POOL_FOUND          = YES
OTHER_LEGACY_POOLS_FOUND      = NONE
```

- **`cert_srv`**：149,692 条空闲 `JHCRT-S-*` 可被 R3B 分配器**原样消费**；
  27 条 `reserved` 须迁 `status=2`。无需 adapter。
- **`cert_hon`**：10,000 条是项目资产，即便尚未消费也不得丢失。
- **`cert_skl`**：10,000 条全空闲，**不在 V2 CHECK 内** → 需扩 CHECK。
- **`volunteer`**：100,000 条；V2 无消费者，但**不得**因无消费者判为死库存。
  `id_pool` 中无其他 `id_type`；`id_pool_old_20260214` 是**备份表**，非资产池。

---

## 8. Schema 与状态映射（§16 / §20）

```
V2_SCHEMA_COMPATIBILITY = SCHEMA_EXTENSION_REQUIRED
V2_STATUS_MAPPING       = CURRENT_SCHEMA_SUFFICIENT
```

| 历史需求 | V2 现状 | 判定 |
| --- | --- | --- |
| 5 个池类型 | CHECK 仅 4 个（缺 `cert_skl`） | ❌ 需扩展 |
| 三态状态 | `CHECK(0,1,2)` | ✅ 足够 |
| code 长 24 | `TEXT` 无限制 | ✅ 足够 |
| `assigned_to`/`assigned_at` | 存在 | ✅ 足够 |
| `batch_id` | **无此列** | ⚠ 建议新增（可空） |
| 全局 UNIQUE（原表） | `UNIQUE(pool_type, code)` | ✅ 实测跨池 0 重复，per-pool 即可 |

**最小增量变更（仅设计，未实施）**：扩 `pool_type` CHECK 加 `cert_skl`；
新增可空 `batch_id`；`status` 保持 0/1/2。

> ⚠ **与 CERT-R2 结论的冲突（必须记录）**：CERT-R2 曾判定
> `ID_POOLS_REBUILD_REQUIRED = NO`，前提是「复用既有 `cert_srv` 即可零迁移」。
> 用户现已冻结「保全全部 5 池」为产品决策，**前提已变**：
> 扩 `pool_type` CHECK 在 SQLite 需**重建表**。此冲突须在实施 Gate 显式裁决，
> 本 Gate **不擅自实施**，也不因此否定保全决策。

---

## 9. R3B 分配器兼容性（§21）

```
R3B_ALLOCATOR_LEGACY_COMPATIBILITY = PASS
```

| 检查项 | 结论 |
| --- | --- |
| `pool_type` 查找 | 参数化 `pool_type = ?`；`cert_srv` 在 CHECK 内 ✅ |
| `status` 谓词 | 仅 `status = 0`（= legacy `available`）✅ |
| code 处理 | 读 `code` 原样返回，**不构造/不改写** ✅ |
| `assigned_to`/`assigned_at` | 消费时写入，与 1.0 语义兼容 ✅ |
| peek 行为 | `ORDER BY id ASC LIMIT 1` ✅ |
| 消费守卫 | `status = 0` + `EXISTS(证书)` → 不烧号、不重复 ✅ |

**无需 adapter。** 前提：迁移把 `available` 落为 `status=0`。

---

## 10. 0045 充分性（§22）

```
0045_LEGACY_POOL_ADEQUACY = SUFFICIENT_AS_FROZEN
```

0045 只操作 `certificates` / `certificate_logs` / 新建 `certificate_batches`，
**完全不触碰 `id_pools`**。历史池迁移是独立后续工作，**不需修改 0045 任何一行**。
本 Gate **未编辑 0045**。

---

## 11. 下一迁移包（§23 / §24，仅设计）

```
NEXT_POOL_MIGRATION_STRATEGY =
  B（最小增量 id_pools schema 扩展）+ 分批数据导入；无 allocator adapter
  1) 扩 pool_type CHECK 加 'cert_skl'（表重建：copy-insert-drop-rename）
  2) 新增可空 batch_id（批次溯源）
  3) 分批导入 5 池 450,000 行，状态直译 available→0 / assigned→1 / reserved→2
  4) 幂等：UNIQUE(pool_type,code) + INSERT ... WHERE NOT EXISTS
  5) 不生成任何新编号；不动 V2 现有 500 条 CTRN

BULK_IMPORT_REQUIRED = YES
D1_IMPORT_STRATEGY =
  450,000 行不适合单条 SQL 迁移（数十 MB、执行时间不可控、失败重跑代价极高）。
  应使用独立分批导入器：每批 ≤ 5,000 行；按 id 升序（确定性）；
  先迁 assigned/reserved（保护语义），再迁 available（大头）；
  以 POOL_HASH 校验断点续跑；唯一键 + NOT EXISTS 双保险保证幂等。
```

**为何不能只「seed cert_srv」**：用户已冻结「保全既有池」，
只补 `cert_srv` 会永久丢弃 `cert_hon`/`cert_skl`/`volunteer`，与授权冲突。

---

## 12. 验收与哈希契约（§25 / §26）

```
RECONCILIATION_HASH_CONTRACT =
  per pool: 升序排序 code → "\n" 连接 → SHA-256 → POOL_HASH_{pool}
  where status matters: (code,status,assigned_to) 升序 → "\t"/"\n" → SHA-256
                        → POOL_TUPLE_HASH_{pool}
  报告只出现哈希，绝不出现原始 code；迁移前后各算一次比对。

FUTURE_ACCEPTANCE_GATE =
  1) 逐池 legacy_total == migrated_total + 显式豁免
  2) free/assigned/reserved 三个计数分别对账
  3) code 集合哈希逐池一致
  4) 无 code 被改写（逐字节）
  5) 未引入重复（同池/跨池/对 V2 现有行）
  6) assigned 关系未丢失
  7) 分配器可消费一条已迁移的 available code
  8) 已消费 code 不可被再分配
  9) 既有历史证书编号（含 V2 现有 500 条 CTRN）保持不变
  10) cert_skl 等扩展池在 V2 中可被 pool_type 命中
```

---

## 13. STOP 条件与禁止项核查（§29）

| 禁止项 | 状态 |
| --- | --- |
| 重设计编号格式 | ✅ 未做（保留全部历史格式） |
| 生成新 ID / 新证书号 | ✅ 未做 |
| 播种 `cert_srv` / `cert_act` | ✅ 未做 |
| 创建 0046 / 任何迁移 | ✅ 未做 |
| 修改 0045 | ✅ 未做（`git status` 为空） |
| 修改 R3B 源码 | ✅ 未做 |
| 写 staging / production D1 | ✅ 仅 `--remote` 只读聚合（`rows_written=0`） |
| 发证 / 部署 / 改 RBAC / Secrets / Keychain | ✅ 未做 |
| 改考试路径 / 前端 / API / UI / PDF / 批量 | ✅ 未做 |
| commit / push | ✅ 未做 |
| 清理无关脏工作区 | ✅ 未做（44 / 287 原样） |
| 触碰 JHZY 1.0 线上 | ✅ 未做（仅用离线快照） |

---

## 14. FINAL RETURN（§30，CERT-R3C-FIX 修正版）

```
CERT_R3C_FIX_START_HEAD = c655131f0e8ac490d1e75ce7585ebdb92e6743cf
WORKSPACE_GATE = PASS

LEGACY_POOL_ASSET_POLICY = PRESERVE_AND_CONTINUE
NUMBER_FORMAT_POLICY = PRESERVE_LEGACY_FORMATS
NEW_NUMBER_GENERATION_AUTHORIZED = NO

LEGACY_POOL_ROWS = 450,000
V2_SYNTHETIC_ROWS = 500
LEGACY_V2_EXACT_CODE_INTERSECTION_COUNT = 0
LEGACY_ROWS_ALREADY_PRESENT_IN_V2 = 0
LEGACY_ROWS_MISSING_FROM_V2 = 450,000
TARGET_POST_IMPORT_TOTAL = 450,500
SAME_CODE_SAME_POOL_COUNT = 0
SAME_CODE_DIFFERENT_POOL_COUNT = 0
STATUS_CONFLICT_COUNT = 0

SYNTHETIC_CERT_TRN_TOTAL = 500
SYNTHETIC_CERT_TRN_FREE = 500
SYNTHETIC_CERT_TRN_ASSIGNED = 0
SYNTHETIC_CERT_TRN_OTHER_STATUS = 0
SYNTHETIC_CERT_TRN_EVER_CONSUMED = NO
SYNTHETIC_CERT_TRN_CURRENTLY_REFERENCED = NO
SYNTHETIC_CERT_TRN_REFERENCED_CERTIFICATE_COUNT = 0

LEGACY_CERT_TRN_ROLE = AUTHORITATIVE_CONTINUING_INVENTORY
V2_SYNTHETIC_CERT_TRN_ROLE = COMPATIBILITY_INVENTORY_PENDING_USAGE_AUDIT
FUTURE_CERT_TRN_ALLOCATION_POLICY =
  TRAINING 只从 legacy cert_trn 取号；合成池零消费保留，不删除不重编号，
  最终处置留待独立后续决策

CERT_SKL_SCHEMA_EXTENSION_REQUIRED = YES
CERT_SKL_SCHEMA_CHANGE =
  SQLite 无法就地改 CHECK → 表重建：建 id_pools_new（CHECK 加 'cert_skl'
  [+ 可空 batch_id]）→ copy 现有 500 行 → 校验行数与哈希 → drop+rename
  → 校验索引/唯一性；仅此一项，不顺带改其他语义；本 Gate 未执行

RESERVED_STATUS_NATIVE_SUPPORT = YES
  （V2 status CHECK(0,1,2) 原生接受 2；reserved 直译 status=2）

ASSIGNED_TO_DIRECT_COPY_SAFE = NO
ASSIGNED_TO_MAPPING_REQUIREMENT =
  1,661 assigned 中 912 引用 NULL、2 条哨兵 999999、747 条待证；
  volunteer 池 889/921(96.5%) 引用缺失。code/status 逐字节保全；
  NULL 保持 NULL；哨兵单独标记；待证引用需独立映射证据，不得臆造；
  不得因引用不可考把 assigned 折叠为 available。

OUT_OF_POOL_FAMILY_PROVENANCE =
  全部业务表编号族 = POOL_DERIVED（以 450,000 池全集成员判定证实）；
  例外 exam_certificates 3 条 = UNKNOWN，单独记录，不合并不重编号

FUTURE_LEGACY_IMPORT_ROW_COUNT = 450,000  （原 449,500 已纠正）
FUTURE_IMPORT_ORDER =
  1) schema 扩展  2) 非自由行(1,688)  3) 自由库存(438,312, 分批)
  Step 2 优先依据：不可重分配语义行误操作代价最高；每步内按 id 升序

RECONCILIATION_HASH_CONTRACT =
  A LEGACY_CODESET_HASH / B POOL_CODESET_HASH_{pool} / C POOL_STATE_HASH_{pool}
  D LEGACY_ASSIGNMENT_HASH_{pool} + RELATION_RECONCILIATION_REPORT（单独对账，
  不混入 code 哈希，以区分「code 丢失」与「引用不可考」）
  验收：A/B/C 哈希完全相等；分配关系按四类聚合计数对账

ID_POOLS_SCHEMA_EXTENSION_AUTHORIZED_IN_PRINCIPLE = YES
NEW_NUMBER_FORMAT_CREATED = NO
NEW_NUMBERS_GENERATED = NO

DOCUMENTS_UPDATED = 2
SECRET_PII_SCAN = PASS

SOURCE_FILES_MODIFIED = NO
MIGRATION_FILES_MODIFIED = NO
NEW_MIGRATION_CREATED = NO
PRODUCTION_D1_MUTATED = NO   (read-only aggregates only)
STAGING_D1_MUTATED = NO
REAL_CERTIFICATE_ISSUED = NO
WORKER_DEPLOYED = NO
SECRET_MUTATED = NO
RBAC_MUTATED = NO
GIT_COMMIT_PERFORMED = NO
GIT_PUSH_PERFORMED = NO
JHZY_1_0_LIVE_TOUCHED = NO   (offline WP4-D snapshot only)

READY_FOR_LEGACY_POOL_MIGRATION_IMPLEMENTATION = YES
CERT_R3C_FIX_STATUS = PASS
NEXT_ACTION = STOP. Await implementation authorization.
```

---

## 15. 裁决状态（经 CERT-R3C-FIX 更新）

1. **合成 `cert_trn` 500 —— 已裁决并由证据闭合** ✅
   深度审计证明：500 条全部 `status=0`、`assigned_to`/`assigned_at` 全空、
   V2 无任何 `CTRN%` 证书、`certificate_logs` 为 0 行
   → **从未被消费、从未被引用**。
   裁决落地：`LEGACY_CERT_TRN_ROLE = AUTHORITATIVE_CONTINUING_INVENTORY`（未来培训发号
   只从 legacy 取号）；`V2_SYNTHETIC_CERT_TRN_ROLE =
   COMPATIBILITY_INVENTORY_PENDING_USAGE_AUDIT`（不删除、不重编号）。
   **无需再裁决**。

2. **与 CERT-R2 结论冲突 —— 已解除并授权** ✅
   CERT-R2 判「不需重建 `id_pools`」的前提是「复用 `cert_srv` 即可零迁移」；
   用户现冻结「保全 5 池」，前提已变。
   裁决落地：`ID_POOLS_SCHEMA_EXTENSION_AUTHORIZED_IN_PRINCIPLE = YES`
   （仅授权**设计**最小扩展，本 Gate 未执行任何 schema 变更）。
   实施 Gate 需按 §5A.5 编排执行并验证。

3. **池外编号族 —— 已澄清** ✅
   原判「业务表编号属另一编码体系」**被证伪**：以 450,000 条池全集做成员判定，
   业务表编号 **是池成员**（59/59、134/134、150/150、817/820、5/5）。
   全部族标记为 `POOL_DERIVED`；仅 `exam_certificates` 中 **3 条**为 `UNKNOWN`
   （该表为 1.0 遗留、V2 未迁入），按 §2.F 保持原样、单独记录，**不合并不重编号**。

> 三个原始待裁决项均已闭合。**无新增待裁决项。**

---

## 16. STOP

CERT-R3C-FIX 完成。未建迁移、未改 schema、未生成编号、未播种、未改源码、
未提交、未推送。

---

## 15. CERT-R3D-FIX 闭合记录（分配优先级）

CERT-R3C 曾把「合成 500 与 legacy 同处 cert_trn 时的取号优先级」列为待裁决项。
CERT-R3D-FIX 已闭合，方案为**显式 provenance 语义**：

- `id_pools.provenance`（0046 新增）：`legacy_migrated`（450,000，可分配）/
  `v2_synthetic_compat`（500，保留但不可分配）/ `v2_native`（未来预留）/
  `NULL|`未知`（不可分配，fail-closed）。
- 未改 legacy 行 id、未删合成行、未伪造 status、未用 code 前缀或长度判别。
- 合成 500 的业务字段（code/status/assigned_to/assigned_at）**逐字节不变**
  （`SYNTHETIC_STATUS_MUTATIONS = 0`）；排除完全来自 provenance 语义。
- TRAINING 与 ACTIVITY/SERVICE 的候选选择与条件消费共用同一谓词片段
  （`allocatableProvenanceSql()`），无两套策略。
- 部署顺序约束：schema → 导入 → 恢复发证（中间态 TRAINING 返回
  `EXAM_POOL_EXHAUSTED`，属预期 fail-closed）。

本节仅补记决策结论；上文 CERT-R3C-FIX 的取证与对账结论均未被推翻。

---
