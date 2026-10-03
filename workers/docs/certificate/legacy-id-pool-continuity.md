# 历史 ID / 证书编号池连续性与迁移决策（CERT-R3C）

> 本文档是 CERT-R3C（READ-ONLY FORENSIC AUDIT + MIGRATION DECISION Gate）的权威决策记录。
> 配套审计：`docs/audits/2026-10-03-post-cutover-assurance/24-cert-r3c-legacy-id-pool-continuity.md`
>
> **实施状态（2026-10-03 更新）**：本文档的迁移设计已由 **CERT-R3D** 落地实施。
> 迁移包与全量 dry-run 结果见 `legacy-id-pool-migration.md` /
> `docs/audits/2026-10-03-post-cutover-assurance/25-cert-r3d-legacy-pool-migration.md`。
> 实施要点：迁移 `0046_id_pools_legacy_pool_compatibility.sql`（仅 schema）+
> 导入器 `src/services/legacy-pool-importer.ts`；450,000 行全量离线 dry-run **PASS**。
>
> 基线：WORKSPACE `/Users/Shared/projects/jhzy-v2` · BRANCH `master` · HEAD `c655131f0e8ac490d1e75ce7585ebdb92e6743cf`
> 权威历史证据：WP4-D 快照 `wp4d_authoritative_20260921_120656`
> （`authoritative_snapshot=YES`，`gzip_check=PASS`，`copy_not_cut=true`）
>
> 模式：**READ-ONLY FORENSIC AUDIT** — 未生成任何编号、未改 0045、未改 R3B 源码、
> 未写任何 D1、未建迁移、未播种任何池。
>
> ---
>
> ## ⚠ CERT-R3C-FIX 修正告示（2026-10-03）
>
> 本文 §4 与 §5.1 的两处结论经本轮**精确集合对账**证伪并已修正；**分析历史保留**：
>
> | 项 | 原（错误）表述 | **当前真相（已验证）** |
> | --- | --- | --- |
> | 池内 code 格式 | `JHCRT-<T\|S\|H>-<8>-<5>`（单字母类型段） | **`JHCRT-TRN\|SRV\|HON\|SKL-<8>-<5>`**（完整类型段，24 字符） |
> | 业务表编号是否在池内 | 「不同前缀族，非同一体系」 | **同格式且是池成员**（`inPool` 逐表核对：59/59、134/134、150/150、5/5） |
> | 缺口账 | 450,000 − 500 = 缺 449,500 | **缺 450,000**（V2 的 500 条是合成族，**不属** legacy 集合，不得相减） |
>
> 详见 §3A（精确交集）与 §5.1（池归属实证）。

---

## 0. 治理前提（人类授权，冻结）

```
LEGACY_POOL_ASSET_POLICY = PRESERVE_AND_CONTINUE
NUMBER_FORMAT_POLICY     = PRESERVE_LEGACY_FORMATS
NEW_NUMBER_GENERATION_AUTHORIZED = NO
NUMBERING_POLICY         = PRESERVE_EXISTING_1_0_RULES
```

本 Gate **不设计**新编号体系，**不提议** `CSRV%06d` 或任何替代格式，**不从 1 重新开始**，
**不重排**已存在的编号。技术兼容性问题一律通过**迁移 / 适配**解决，不得以「重设计」替代。

### 0.1 CERT-R3C-FIX 冻结的人类决策

```
LEGACY_CERT_TRN_ROLE = AUTHORITATIVE_CONTINUING_INVENTORY
  → 历史 cert_trn（180,000 条）必须按其原始编号规则恢复并使用

V2_SYNTHETIC_CERT_TRN_ROLE = COMPATIBILITY_INVENTORY_PENDING_USAGE_AUDIT
  → 不删除；不重编号已发放号；不作为 legacy cert_trn 的权威替代

ID_POOLS_SCHEMA_EXTENSION_AUTHORIZED_IN_PRINCIPLE = YES
  → cert_skl 是已证实的历史资产，当前 V2 CHECK 无法表达
  → 授权仅限「设计最小兼容扩展」，本 Gate 不做任何 schema 变更

OUT_OF_POOL_NUMBER_FAMILIES = PRESERVE_AS_IS_PENDING_PROVENANCE
AUTO_MERGE_OUT_OF_POOL_NUMBERS = NO
AUTO_RENUMBER_OUT_OF_POOL_NUMBERS = NO
```

---

## 1. 核心结论（先看这里）

| # | 结论 | 影响 |
| --- | --- | --- |
| 1 | 历史池总量 **450,000 行**（5 个池），与用户「约 40 万」预期一致 | 资产真实存在且完整 |
| 2 | V2 当前仅有 **500 行 `CTRN%06d`**，是 0022 **合成播种**，与历史格式**完全不同** | `CERT_TRN_CONTINUITY_GAP = YES` |
| 3 | V2 正**并行运行第二套编号体系**，历史资产完全未迁入 | 迁移是必需的，不是可选的 |
| 4 | 历史 `cert_trn` 180,000 行 / `cert_srv` 150,000 行**足以支撑 V2 未来发放** | 无需生成任何新编号 |
| 5 | `cert_skl` 10,000 行**不在 V2 CHECK** 内 | `SCHEMA_EXTENSION_REQUIRED` |
| 6 | R3B 分配器**可原样消费**历史 code（不构造格式、只取 `status=0`） | `R3B_ALLOCATOR_LEGACY_COMPATIBILITY = PASS` |
| 7 | 45 万行**不适合单条 SQL 迁移** | 需分批导入器 |

---

## 2. §6 历史池完整清单（发现结果，非假设）

来源：`id_pool` 表（WP4-D 权威快照，40 条 INSERT 语句，**450,000 元组全部解析**）。

| POOL_TYPE | 业务含义 | 来源表 | TOTAL | FREE | ASSIGNED | RESERVED | OTHER |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cert_trn` | 培训证书编号 | `id_pool` | **180,000** | 179,543 | 457 | 0 | 0 |
| `cert_srv` | 服务证书编号 | `id_pool` | **150,000** | 149,692 | 281 | **27** | 0 |
| `volunteer` | 志愿者编号 | `id_pool` | **100,000** | 99,079 | 921 | 0 | 0 |
| `cert_hon` | 荣誉证书编号 | `id_pool` | **10,000** | 9,998 | 2 | 0 | 0 |
| `cert_skl` | 技能证书编号 | `id_pool` | **10,000** | 10,000 | 0 | 0 | 0 |
| **合计** | | | **450,000** | 438,312 | 1,661 | 27 | 0 |

- `NULL_CODE_COUNT` = **0**（全部池）
- `id` 范围：1 – 713,603（存在历史删除/回收间隙，非连续）
- `batch_id` 取值：1 / 2 / 3 / 4（`cert_srv` 跨 1,3,4；`cert_trn` 跨 1,2,3；`volunteer` 跨 1,2）
- 另有备份表 `id_pool_old_20260214`（`AUTO_INCREMENT=160001`，14 条 INSERT 声明）——
  属**历史备份**，非权威资产，不纳入迁移范围（但亦不删除）。

### 2.1 证书池 vs 非证书池

| 分类 | 池 | 行数 |
| --- | --- | --- |
| 证书类 | `cert_trn` + `cert_srv` + `cert_hon` + `cert_skl` | **340,000** |
| 非证书类 | `volunteer` | **100,000** |

---

## 3. §7 历史状态语义（源自 1.0 存储过程，非推测）

权威证据：`api_jhzyfw_com.routines.sql.gz` 中的 `assign_certificate_id` 过程。

```sql
SELECT status INTO v_current_status FROM id_pool WHERE id_value = p_id_value;
IF v_current_status != 'available' THEN SIGNAL ...;   -- 非 available 不可分配
UPDATE id_pool SET status = 'reserved', assigned_at = NOW() WHERE id_value = p_id_value;
INSERT INTO certificate_id_usage_log (id_value, action, operator, related_table,
                                       old_status, new_status, notes) ...
```

该过程同时执行**跨表全局查重**（`activity_service_certificates.cert_code`），
并在重复时 `SIGNAL SQLSTATE '45000'`。

| LEGACY_STATUS | LEGACY_MEANING | V2_TARGET_STATUS | MIGRATION_ACTION |
| --- | --- | --- | --- |
| `available` | 空闲可分配（唯一可被消费的状态） | `0` | 直译为 `status=0` |
| `assigned` | 已最终分配给某业务对象 | `1` | 直译为 `status=1` |
| `reserved` | **已预占/待生效**（过程在此状态停下并写 usage_log，未必等于已发证） | `2` | 直译为 `status=2`（**不得折叠为 free**） |

**关键语义差异**：`reserved` ≠ `assigned`。1.0 的分配过程把号从 `available` 直接
推进到 `reserved`（并记录 `related_table`），**不是** `assigned`。因此
`cert_srv` 的 27 条 `reserved` 必须迁为 V2 的 `status=2`，**绝不可**当作空闲库存。

V2 的 `status CHECK(0,1,2)` 恰好能表达三态 → `V2_STATUS_MAPPING = CURRENT_SCHEMA_SUFFICIENT`。

---

## 4. §8 历史编号格式（模式，不含真实编号）

> **CERT-R3C-FIX 已修正**：原表把类型段写成单字母（`T`/`S`/`H`）。经逐池解析
> `id_pool` 第 2 段的**实际取值**，正确形式为**完整类型段**。

| 池 | 格式模式 | 段数 | 总长 | 第 2 段实测值 |
| --- | --- | --- | --- | --- |
| `cert_trn` | `JHCRT-TRN-<8>-<5>` | 4 | **24** | `TRN` |
| `cert_srv` | `JHCRT-SRV-<8>-<5>` | 4 | **24** | `SRV` |
| `cert_hon` | `JHCRT-HON-<8>-<5>` | 4 | **24** | `HON` |
| `cert_skl` | `JHCRT-SKL-<8>-<5>` | 4 | **24** | `SKL` |
| `volunteer` | `JH-<8>-<5>` | 3 | **17** | （无类型段） |

**性质**：预生成字面量（ULID 派生段）；V2 运行时**不需生成任何内容**，
迁移后应**按库存原样消费**（与既有 `pickCertTrnCandidate` 模式一致）。

> **重要更正**：`cert_srv` 与 `cert_skl` **不共用前缀** —— 二者第 2 段分别为
> `SRV` 与 `SKL`。原 CERT-R3C 报告「两者共用 `JHCRT-S` 前缀、仅靠 `id_type` 区分」
> 的结论**不成立**，已撤销。前缀本身即可区分池。

### 4.1 V1.0 业务表编号的池归属（精确集合对账，CERT-R3C-FIX 新增）

对业务表中出现的每个 `JHCRT-{TRN,SRV,HON,SKL}-*` / `JH-*` 编号，
在 `id_pool` 的 **450,000 条 code 全集**中做成员判定：

| 业务表 | 编号总数 | **在池内** | 不在池内 | 池归属分布 |
| --- | --- | --- | --- | --- |
| `certificates` | 59 | **59** | 0 | `cert_srv` 53 · `cert_trn` 6 |
| `certificate_master` | 134 | **134** | 0 | `cert_srv` 86 · `cert_trn` 18 · `volunteer` 30 |
| `activity_service_certificates` | 150 | **150** | 0 | `cert_srv` 77 · `volunteer` 73 |
| `exam_certificates` | 820 | **817** | **3** | `cert_trn` 410 · `volunteer` 407 |
| `unified_certificates` | 5 | **5** | 0 | `cert_trn` 5 |

**结论**：业务表编号**就是池成员**（原报告「属另一编码体系」的判断**错误**）。
唯一例外是 `exam_certificates` 中 **3 条**不在池内 —— 需作为 orphan 单独记录。

> 因此 §10 的 `BUSINESS_RECORD_WITHOUT_POOL_MATCH` 现可精确回答：
> **3 条**（全部在 `exam_certificates`，且该表整体为 1.0 遗留表，V2 未迁入）。

---

## 5. §10 已分配编号与业务记录对账（聚合）

对 `status='assigned'` 的 1,661 条编号，检查其 code 是否在任一证书/业务表中出现：

| 池 | ASSIGNED | 有对应业务记录 | 无对应业务记录 |
| --- | --- | --- | --- |
| `cert_trn` | 457 | 436 | 21 |
| `cert_srv` | 281 | 130 | 151 |
| `volunteer` | 921 | 432 | 489 |
| `cert_hon` | 2 | 0 | 2 |
| **合计** | **1,661** | **998** | **663** |

- `MULTI_ASSIGNMENT_CONFLICTS` = **0**（`id_pool.id_value` 全表 UNIQUE，结构上不可能）
- `NUMBER_LITERAL_MISMATCHES` = **0**（同一 code 在池与业务表两侧字符串完全一致）
- `BUSINESS_RECORD_WITHOUT_POOL_MATCH` = 未单独统计（业务侧存在
  `JHCRT-SRV-*` / `JH-*` 等**不在 `id_pool` 内**的编号族，属另一编码体系，
  本 Gate **不归并、不重排**）

> 663 条「已分配但无业务记录」是**历史事实**（号被预留/分配后业务未落地）。
> 迁移时**必须原样保留其 `assigned` 语义**，不得回收为 free。

---

## 6. §11 / §12 当前 V2 池与缺口矩阵

### 6.0 §3A 精确集合对账（CERT-R3C-FIX，替代原「449,500」表述）

原 CERT-R3C 用「450,000 − 500 = 缺 449,500」相减，**方法错误**：
V2 的 500 条是**合成族**（`CTRN%06d`，10 字符），**不是** legacy 450,000 的成员，
不得相减。本轮以「族互斥 + 逐池计数」给出精确账：

| 项 | 值 | 依据 |
| --- | --- | --- |
| `LEGACY_POOL_ROWS` | **450,000** | 快照全量解析 |
| legacy 第 1 段分布 | `JHCRT-` 350,000 · `JH-` 100,000 | 逐元组 |
| V2 code 长度 / 前缀族 | 长度 **10**，`CTRN` 单一 5 字符前缀（`distinctPrefix5 = 1`） | V2 只读聚合 |
| `LEGACY_V2_EXACT_CODE_INTERSECTION_COUNT` | **0** | 两族字符集互斥（`JHCRT-`/`JH-` vs `CTRN`） |
| `SAME_CODE_SAME_POOL_COUNT` | **0** | 同上 |
| `SAME_CODE_DIFFERENT_POOL_COUNT` | **0** | 同上 |
| `STATUS_CONFLICT_COUNT` | **0** | 无同 code，故无状态冲突 |
| `LEGACY_ROWS_ALREADY_PRESENT_IN_V2` | **0** | 交集为 0 |
| `LEGACY_ROWS_MISSING_FROM_V2` | **450,000** | 450,000 − 0 |
| `V2_SYNTHETIC_ROWS` | **500** | 与 legacy 集合不相交，**保留但不计入 legacy 账** |
| `TARGET_POST_IMPORT_TOTAL` | **450,500** | 450,000 legacy ∪ 500 synthetic（两族不相交，无冲突） |

> **结论**：legacy 资产 **一行都不在 V2**，全部需导入。
> V2 现有 500 条是**并行的另一体系**，导入后与之共存（`UNIQUE(pool_type, code)` 不冲突，
> 因前缀与长度均不同）。

### 6.1 V2 生产现状（只读实测，`rows_written=0`）

| V2_POOL_TYPE | ROW_COUNT | FREE | ASSIGNED | OTHER | FORMAT |
| --- | --- | --- | --- | --- | --- |
| `cert_trn` | **500** | 500 | 0 | 0 | `CTRN%06d`（长度 10） |

V2 池总量 = **500**。历史资产总量 = **450,000**。

### 6.2 §5 合成 `cert_trn` 500 深度审计（决定其处置的关键证据）

| 指标 | 值 |
| --- | --- |
| `TOTAL` | **500** |
| `FREE`（status=0） | **500** |
| `ASSIGNED`（status=1） | **0** |
| `OTHER_STATUS` | **0** |
| `assigned_to` 非空 | **0** |
| `assigned_at` 非空 | **0** |
| V2 `certificates` 中 `CTRN%` 前缀 | **0**（413 张全部 `JHCRT%`，即 legacy 族） |
| V2 `certificate_logs` 行数 | **0**（审计表为空） |

```
SYNTHETIC_CERT_TRN_EVER_CONSUMED          = NO
SYNTHETIC_CERT_TRN_CURRENTLY_REFERENCED   = NO
SYNTHETIC_CERT_TRN_REFERENCED_CERTIFICATE_COUNT = 0
```

**结论**：合成池**从未被消费**，也**未被任何证书引用**。它是一条**未使用的备用库存**。
按 §2.D 决策，它**不删除**，但也**不承担权威角色**。
因从未消费，不存在「已发放合成号需永久保全」的历史负担。

### 6.3 §6 未来 TRAINING 分配策略

```
FUTURE_CERT_TRN_ALLOCATION_POLICY =
  TRAINING 发放**只从 legacy cert_trn 库存取号**（AUTHORITATIVE_CONTINUING_INVENTORY）。
  合成 CTRN 池保持 status=0、零引用，标记为 COMPATIBILITY_INVENTORY_PENDING_USAGE_AUDIT，
  **不删除、不重编号**；其最终（隔离/退役）留待独立的后续决策。
```

### 6.4 §13 CERT_TRN 溯源

V2 现有 500 条来自 `migrations/0022_p32_training_exam_cert.sql` 的
`printf('CTRN%06d', x)` —— **合成播种**，非历史迁移。

```
CERT_TRN_PROVENANCE        = SYNTHETIC
LEGACY_CERT_TRN_ROLE       = AUTHORITATIVE_CONTINUING_INVENTORY
V2_SYNTHETIC_CERT_TRN_ROLE = COMPATIBILITY_INVENTORY_PENDING_USAGE_AUDIT
```

### 6.5 完整缺口矩阵（精确值）

| POOL | LEGACY_TOTAL | LEGACY_FREE | LEGACY_ASSIGNED | LEGACY_RESERVED | V2_TOTAL | 已存在于 V2 | MISSING_FROM_V2 | MIGRATION_REQUIRED |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cert_trn` | 180,000 | 179,543 | 457 | 0 | 500* | **0** | **180,000** | YES |
| `cert_srv` | 150,000 | 149,692 | 281 | 27 | 0 | **0** | **150,000** | YES |
| `cert_hon` | 10,000 | 9,998 | 2 | 0 | 0 | **0** | **10,000** | YES |
| `cert_skl` | 10,000 | 10,000 | 0 | 0 | 0 | **0** | **10,000** | YES（需扩 CHECK） |
| `volunteer` | 100,000 | 99,079 | 921 | 0 | 0 | **0** | **100,000** | YES |
| **合计** | **450,000** | **438,312** | **1,661** | **27** | 500 | **0** | **450,000** | — |

\* V2 的 500 条属**不相交的合成族**，故 legacy `cert_trn` 180,000 条**全部**仍缺。

> **不得**因 V2 缺这些池就判定其过时 —— 用户已冻结其为项目资产。

---

## 7. §14 / §15 / §16 各池连续性结论

| 池 | 结论 | 说明 |
| --- | --- | --- |
| `cert_trn` | `CERT_TRN_CONTINUITY_GAP = YES` | 180,000 条历史编号未迁入；V2 并行使用合成体系 |
| `cert_srv` | **`CERT_SRV_LEGACY_REUSABLE = YES`** | 149,692 条空闲 `JHCRT-S-*` 可被 R3B 分配器**原样消费**；27 条 `reserved` 须迁为 `status=2` |
| `cert_hon` | **`CERT_HON_MIGRATION_REQUIRED = YES`** | 10,000 条是项目资产，即便尚未消费也不得丢失 |
| `cert_skl` | **`CERT_SKL_FOUND = YES`** | 10,000 条全空闲；**不在 V2 CHECK 内** → 见 §8 |
| `volunteer` | `VOLUNTEER_POOL_FOUND = YES` | 100,000 条；V2 无消费者，但**不得**因无消费者而判为死库存 |

`OTHER_LEGACY_POOLS_FOUND` = **NONE**（除上述 5 个外，`id_pool` 中无其他 `id_type` 取值；
`id_pool_old_20260214` 为备份表，非资产池）。

### 7.1 `CERT_SRV_LEGACY_REUSABLE = YES` 的依据

R3B 分配器对 code 完全**不透明**：

| 检查项 | 结论 |
| --- | --- |
| `pool_type` 查找 | 参数化 `pool_type = ?` → `cert_srv` 在 V2 CHECK 内 ✅ |
| `status` 谓词 | 仅取 `status = 0`（= legacy `available`）✅ |
| code 处理 | 读取 `code` 列原样返回，**不构造/不改写** ✅ |
| `assigned_to` / `assigned_at` | 消费时写入，语义与 1.0 兼容 ✅ |
| peek 行为 | `ORDER BY id ASC LIMIT 1`（先到先得）✅ |
| 消费守卫 | `status = 0` + `EXISTS(证书)` → 不烧号、不重复 ✅ |

**无需 adapter。**

---

## 8. §16 / §20 V2 Schema 兼容性

```
V2_SCHEMA_COMPATIBILITY = SCHEMA_EXTENSION_REQUIRED
```

**reserved 原生支持核验（CERT-R3C-FIX）**：V2 `id_pools.status` 的 CHECK 为
`CHECK (status IN (0,1,2))` —— **`status = 2` 已被原生允许**，
legacy `reserved` 可直接落 `status=2`，**无需任何 schema 变更**。

```
V2_STATUS_MAPPING          = CURRENT_SCHEMA_SUFFICIENT
RESERVED_STATUS_NATIVE_SUPPORT = YES
```

`reserved` **不得**折叠为 `available`(0)，也**不得**折叠为 `assigned`(1)
（1.0 存储过程已证明二者语义不同：过程只把 `available → reserved`，不推进到 `assigned`）。

V2 `id_pools`：`pool_type TEXT NOT NULL CHECK (pool_type IN ('cert_trn','cert_srv','cert_hon','volunteer'))`，
`code TEXT NOT NULL`（无长度限制 ≥ 24 ✅），`status INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2))`，
`UNIQUE (pool_type, code)`。

| 历史需求 | V2 现状 | 判定 |
| --- | --- | --- |
| 5 个池类型 | 仅 4 个（缺 `cert_skl`） | ❌ **需扩展 CHECK** |
| 三态状态 | `0/1/2` | ✅ 足够（映射见 §3） |
| code 长度 ≤ 24 | `TEXT` 无限制 | ✅ 足够 |
| `assigned_to` / `assigned_at` | 存在 | ✅ 足够 |
| 全局唯一（原表语义） | V2 为 per-pool UNIQUE | ⚠ 见下 |
| `batch_id` | **V2 无此列** | ⚠ 需注意（见下） |

**最小增量兼容变更（仅设计，本 Gate 不实施）**：
1. 扩展 `pool_type` CHECK 加入 `cert_skl`（+ 若未来需要的类型）。
   ⚠ 注意：SQLite 无法 `ALTER CONSTRAINT`，需**重建表**（copy-insert-drop-rename），
   这与 CERT-R2「不重建 id_pools」的判断**冲突**——但该判断的前提是
   「复用既有 `cert_srv` 即可零迁移」。现在用户要求**保全全部 5 池**，
   前提已变，故**必须**重新评估重建与否（见 §11 `NEXT_POOL_MIGRATION_STRATEGY`）。
2. 新增 `batch_id`（可空）以保留批次溯源（可选，非阻断）。
3. `status` 保持 0/1/2，**不得**把 legacy `reserved` 折叠为 0。

> **全表唯一 vs per-pool 唯一**：legacy 是全表 UNIQUE，V2 是 `UNIQUE(pool_type, code)`。
> 由于历史各池前缀不重叠（`T`/`S`/`H`/`S`/`JH`），实际不存在跨池重复
> （实测 `dupAcrossWholeTable = 0`），故 per-pool UNIQUE **不会**放松实际约束。
> 但 V2 现有 `CTRN%06d` 与历史前缀不同，跨体系亦无碰撞。**结论：保持 V2 现状即可，
> 不需要改为全表唯一。**

---

## 8. §9 `assigned_to` 语义 —— 不可直接复制

```
ASSIGNED_TO_DIRECT_COPY_SAFE = NO
```

CERT-R3C 原计划「照搬 legacy `assigned_to`」，本轮**证伪**：

| 证据 | 数值 |
| --- | --- |
| legacy `assigned` 行总数 | 1,661 |
| 其中 `assigned_to` **为 NULL** | **912**（54.9%） |
| 其中 `assigned_to` 为小整数（< 900,000） | 747 |
| 其中 `assigned_to` 为 **999,999 哨兵值** | **2** |
| 快照内 `users` 表主键量级 | 仅 **54** 行 |
| V2 生产 `users` 表 | 631 行，`id` 范围 1–1676 |
| V2 `id_pools.assigned_to` 实际使用 | **0**（500 条全 NULL） |

**结论（逐池）**：

| 池 | assigned | 引用非空 | 引用 NULL | 引用范围 |
| --- | --- | --- | --- | --- |
| `cert_trn` | 457 | 443 | 14 | 7 – 672 |
| `cert_srv` | 281 | 274 | 7 | 7 – 532 |
| `volunteer` | 921 | **32** | **889** | 29 – **999999** |
| `cert_hon` | 2 | **0** | **2** | — |

### 8.1 迁移映射要求

```
ASSIGNED_TO_MAPPING_REQUIREMENT =
  1) 912 条 assigned 但引用为 NULL → 迁移时 assigned_to 保持 NULL，**语义是
     「已分配但引用不可考」，不得丢弃 assigned 状态本身**。
  2) 2 条 999999 为**哨兵值**（非真实用户）→ 必须识别为哨兵，不得当作 users.id 迁移。
  3) volunteer 池 889/921 引用缺失（96.5%）→ 该池的 assigned 关系在 legacy 中
     已不可考，属**已知的语义损失**，迁移须在文档与对账报告中显式声明。
  4) 其余 747 条小整数引用【未经证实】指向 users.id（legacy users 仅 54 行，
     数量级不匹配）→ 需独立的映射证据，不得直接写入 V2.assigned_to。
  5) 因此：code / status 必须**逐字节、逐状态**保全；
     assigned_to 需要【独立的关系对账】（见 §12.2），与 code 集合哈希分离。
```

> **不得**因引用不可考而把 `assigned` 折叠为 `available` —— 那会允许重新分配
> 一个历史上已发出的编号，违反 §10 规则 5/6。

---

## 8A. §7 `cert_skl` Schema 兼容设计（仅设计，不执行）

```
CERT_SKL_SCHEMA_EXTENSION_REQUIRED = YES
```

V2 `id_pools` 的 `pool_type` CHECK 为
`('cert_trn','cert_srv','cert_hon','volunteer')`，**不含 `cert_skl`**。
SQLite **不支持** `ALTER TABLE ... ALTER COLUMN`（无法就地改 CHECK），
故需**表重建**。按 §2.E 授权（`ID_POOLS_SCHEMA_EXTENSION_AUTHORIZED_IN_PRINCIPLE = YES`），
最小编排如下（**本 Gate 未执行**）：

```
CERT_SKL_SCHEMA_CHANGE（概念编排）:
  0) 前置：确认 0045 未在任何环境应用（当前 NOT_APPLIED，窗口开放）
  1) CREATE TABLE id_pools_new (
       id          INTEGER PRIMARY KEY,
       pool_type   TEXT NOT NULL CHECK (pool_type IN
                      ('cert_trn','cert_srv','cert_hon','cert_skl','volunteer')),
       code        TEXT NOT NULL,
       status      INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2)),
       assigned_to INTEGER,
       assigned_at INTEGER,
       created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
       UNIQUE (pool_type, code))
  2) INSERT INTO id_pools_new SELECT id, pool_type, code, status,
                                assigned_to, assigned_at, created_at
       FROM id_pools            -- 现有 500 行全量搬迁，零丢失
  3) 校验：行数一致（500 = 500）、UNIQUE(pool_type,code) 成立、
          POOL_HASH 对比一致（见 §12）
  4) DROP TABLE id_pools;  ALTER TABLE id_pools_new RENAME TO id_pools
  5) 若需要 batch_id（legacy 有此列，V2 无）→ 在步骤 1 的建表语句中
     一次性加入 `batch_id INTEGER`（可空），步骤 2 的 SELECT 相应补 NULL
  6) 校验最终 schema 与索引，确认 UNIQUE 约束生效
```

**严格边界**：本次重建**只为**容纳 `cert_skl`（+ 可选 `batch_id`）。
**不得**顺带修改 `status` 语义、`code` 类型、`assigned_*` 语义或唯一性强度。
`UNIQUE (pool_type, code)` 保持不变（实测跨池重复 0，无需改为全表唯一）。

---

## 9. §10 池外编号族溯源（CERT-R3C-FIX 修正）

原 CERT-R3C 称业务表编号「属另一编码体系」，本轮**证伪**：
业务编号**就是 `id_pool` 的成员**（见 §4.1 逐表成员判定）。

```
OUT_OF_POOL_FAMILY_PROVENANCE =
  JHCRT-TRN-*  → POOL_DERIVED（cert_trn 池，成员命中）
  JHCRT-SRV-*  → POOL_DERIVED（cert_srv 池，成员命中）
  JHCRT-HON-*  → POOL_DERIVED（cert_hon 池）
  JHCRT-SKL-*  → POOL_DERIVED（cert_skl 池）
  JH-*         → POOL_DERIVED（volunteer 池，成员命中）
  例外：exam_certificates 中 3 条编号不在池内 → UNKNOWN（孤立记录）
```

**证据**：以 `id_pool` 全部 450,000 条 code 构成内存集合，对业务表出现的每个
编号做成员判定 —— `inPool` 计数 59/59、134/134、150/150、817/820、5/5。
仅 3 条（`exam_certificates`）未命中，且该表为 1.0 遗留、V2 未迁入。

按 §2.F：**不自动合并、不自动重编号**，`UNKNOWN` 的 3 条单独记录待考。

---

## 10. §18 重复 / 碰撞审计

| 类别 | 计数 |
| --- | --- |
| 同一池内重复 | **0** |
| 跨池重复 | **0**（`dupAcrossWholeTable = 0`） |
| 与 V2 `id_pools` 冲突 | **0**（前缀体系不同） |
| 与已迁移 `certificates.cert_no` 冲突 | **0**（`cert_no` 全局 UNIQUE，历史编号未迁入） |
| `NULL` code | **0** |

**分类结论**：无碰撞。任何迁移实现都**不得引入**新的重复。

---

## 10. §19 迁移保全规则（冻结）

以下 10 条为冻结原则，除非出现技术不可行证据，否则不得违反：

1. 现有 code 字符串**逐字节保留**。
2. 现有 `assigned` / `available` / `reserved` 语义**完整保留**。
3. `assigned` code 仍关联同一历史业务对象（关系可恢复时）。
4. `available` code 仍为可用库存。
5. `reserved` code **保持非空闲**（除非有权威 legacy 规则另有明文）。
6. **禁止回收重用（no code recycling）**。
7. **禁止重编号（no renumbering）**。
8. **禁止新替代格式**。
9. **禁止从序列 1 重新开始**。
10. **在有效 legacy 库存仍有剩余时，禁止生成替代库存**。

---

## 11. §23 / §24 下一迁移包设计（仅设计，不创建）

```
NEXT_POOL_MIGRATION_STRATEGY =
  B（最小增量 id_pools schema 扩展 + 分批数据导入）+ C（无 adapter：R3B 原样消费）
  具体：
  1) 扩展 id_pools.pool_type CHECK 加入 'cert_skl'（表重建，编排见 §8A）
  2) 新增可空 batch_id 列（批次溯源，对齐 legacy）
  3) 分批导入 5 池共 450,000 行，状态直译：
       available→0, assigned→1, reserved→2
  4) 幂等守卫：INSERT ... SELECT ... WHERE NOT EXISTS（同 pool_type+code）
  5) 不生成任何新编号；不改动 V2 现有 500 条 CTRN 行
```

**为什么不能只做「seed cert_srv」**：用户已冻结「保全既有池」为产品决策，
且 `cert_hon` / `cert_skl` / `volunteer` 同样是项目资产。只补 `cert_srv`
会永久丢弃另外 3 个池，与授权冲突。

### 11.0 §11 精确导入量（CERT-R3C-FIX 修正）

```
FUTURE_LEGACY_IMPORT_ROW_COUNT = 450,000
```

依据 §6.0 的精确对账：
`LEGACY_ROWS_MISSING_FROM_V2 = 450,000 − 0 = 450,000`。

> **纠正**：原 CERT-R3C 写「449,500」是用 V2 的 500 条合成码相减得出的，
> **方法错误**（合成码不是 legacy 集合成员）。正确导入量是 **450,000 行**。
> 导入后 V2 `id_pools` 总量 = 450,000（legacy） + 500（synthetic） = **450,500**。

### 11.0.1 §12 导入顺序（证据驱动）

```
FUTURE_IMPORT_ORDER =
  Step 1  schema 兼容扩展（表重建加入 cert_skl + batch_id）  ← 必须最先
          理由：不先扩展，后续 cert_skl 行无处插入
  Step 2  非自由历史行（assigned 1,661 + reserved 27 = 1,688 行）
          理由：这些行携带「不可重分配」语义，最需优先固化；
                其中 assigned 的 assigned_to 引用不可考（§8），先落定可避免后续误改
  Step 3  自由库存（available 438,312 行）分批导入
          理由：纯增量、无语义风险，可断点续跑、可并行分片
```

> 技术依据：Step 2 优先**不**是因为数据库约束（`UNIQUE(pool_type,code)` 与顺序无关），
> 而是因为「不可重分配」语义行的**误操作代价最高** —— 先固化可最大限度降低风险。
> 导入器**必须**按此顺序，但每步内部仍按 `id` 升序以保证确定性。

### 11.1 §24 数据量与 D1 安全

```
BULK_IMPORT_REQUIRED = YES
```

| 维度 | 评估 |
| --- | --- |
| 行数 | **450,000**（精确值，见 §11.0） |
| 单条 SQL 迁移 | **不合适**：会产生一个数十 MB 的 SQL 文件，执行时间不可控、失败后重跑代价极高、且 D1 迁移有语句/体积约束 |
| 建议 | **独立分批导入器**（Worker 任务或 `wrangler d1 execute --file` 分片），而非巨型 SQL 迁移 |
| 分片 | 每批 ≤ 5,000 行；`INSERT ... SELECT ... WHERE NOT EXISTS` 保证幂等 |
| 断点续跑 | 以「已导入 code 集合哈希」为准；每批完成后记录进度 |
| 确定性 | 按 `id` 升序导入，顺序可复现 |
| 幂等 | 唯一键 + `WHERE NOT EXISTS` 双保险；重复执行不产生重复行 |
| 顺序 | 见 §11.0.1（schema → 非自由行 → 自由库存） |

---

## 12. §25 / §26 未来验收与哈希对账契约

### 12.1 验收检查（`FUTURE_ACCEPTANCE_GATE`）

1. 逐池 `legacy_total == migrated_total + 显式豁免`（豁免须逐条列明）。
2. 逐池 `free` / `assigned` / `reserved` 三个计数分别对账。
3. code 集合哈希逐池一致（见 §12.2）。
4. 无任何 code 被改写（逐字节比较）。
5. 未引入重复（同池 / 跨池 / 对 V2 现有行）。
6. `assigned` 关系未丢失（分配对象引用保持）。
7. 分配器可消费一条已迁移的 `available` code（端到端冒烟）。
8. 已消费 code 不可被再分配（`status=0` 守卫）。
9. 既有历史证书编号（含 V2 现有 500 条 `CTRN`）保持不变。
10. `cert_skl` 等扩展池在 V2 中可被 `pool_type` 命中。

### 12.2 哈希对账契约（隐私安全、确定性，CERT-R3C-FIX 强化）

```
RECONCILIATION_HASH_CONTRACT =

  A) 全局 code 集合（跨池，证明 450,000 条无一遗漏/重复）
     1) 取全部 code 升序排序（统一 COLLATE BINARY）
     2) "\n" 连接 → SHA-256 → LEGACY_CODESET_HASH

  B) 逐池 code 集合（证明每池完整）
     同上分组 → POOL_CODESET_HASH_{pool_type}

  C) 逐池状态三元组（code, status）—— 不含 assigned_to
     "\t" 连接行、行间 "\n" → SHA-256 → POOL_STATE_HASH_{pool_type}
     → 证明 status 直译正确（available→0 / assigned→1 / reserved→2）

  D) 分配关系单独对账（**刻意与 code 集合哈希分离**）
     因 legacy assigned_to 大量不可考（§8：912 NULL、2 哨兵、volunteer 96.5% 缺失），
     若把 assigned_to 混入 code 哈希，将无法区分「code 丢失」与「引用不可考」。
     故定义：
       LEGACY_ASSIGNMENT_HASH_{pool_type} = 对 (code, 归一化引用) 计算，
       其中归一化引用 = 'NULL' | 'SENTINEL' | 'REF:<n>'
     并额外产出 RELATION_RECONCILIATION_REPORT（聚合计数，非哈希）说明：
       - 引用可直接映射的条数
       - 引用为 NULL 的条数
       - 引用为哨兵的条数
       - 引用待证的条数
     验收标准：**code 集合与状态哈希必须完全相等**；
               分配关系按上述四类**分别聚合计数对账**，不要求逐条引用相等。

  报告中【只出现哈希与聚合计数，绝不出现原始 code 或原始引用值】。
  迁移前后各算一次；A/B/C 哈希相等即证明集合与状态完全一致。
```

---

## 13. §22 0045 充分性

```
0045_LEGACY_POOL_ADEQUACY = SUFFICIENT_AS_FROZEN
```

0045 只操作 `certificates` / `certificate_logs` / 新建 `certificate_batches`，
**完全不触碰 `id_pools`**。历史池迁移是**独立的、后续的**工作，
不需要修改 0045 的任何一行。**本 Gate 未编辑 0045。**

---

## 14. §29 明确保留的遗留

0045 预发/生产 APPLY · 任何池的播种 · V1.0 合成 `CTRN` 池的处置决策 ·
`id_pools` 表重建 · `batch_id` 列 · 导入器实现 · HTTP 路由 · 批量引擎 ·
资格政策 · PDF · R2 · 公开验真修复 · 前端/UI · 考试迁移 · 验收证书发放

---

## 15. 数据保护声明

本文档仅记录**聚合计数、状态分布、段长与格式模式**。
未包含：真实编号字符串、接收者 ID、姓名、手机号、OpenID、身份证、生产连接串。
历史格式以模式呈现（`JHCRT-<T|S|H>-<8>-<5>` / `JH-<8>-<5>`）。
