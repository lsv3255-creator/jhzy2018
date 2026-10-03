# 26 — CERT-R3E: Staging Legacy ID Pool Migration（执行与对账报告）

> 基线：WORKSPACE `/Users/Shared/projects/jhzy-v2` · BRANCH `master`
> HEAD `9b31f1170f390380dd48fb41937cf7147a074020`
> （`feat(certificates): preserve legacy id pool continuity` = CERT-R3D/R3D-FIX 冻结基线）
>
> 模式：**STAGING-ONLY 受控迁移** —— 0045+0046 应用、450,000 行全量导入、
> 全量对账、只读运行时烟测、证据冻结。
> 绝对禁止项均已遵守：未触碰生产、未部署 Worker、未真实发证、未 push、未 commit、
> 未访问 JHZY 1.0 线上。

---

## 1. 目标证明（§7 / §8）

| 项 | 值 |
| --- | --- |
| 环境 | `staging` |
| 数据库名 | `jhzy-v2-staging` |
| 数据库 UUID | `85853fb1-1384-486e-9be3-566f72f45c5d` |
| Cloudflare 账户 | `8770e4917f904aed5df91c883cf058af` |

**证明方式（非依赖配置文件）**：wrangler API 响应中的请求路径本身即证据 ——
`/accounts/8770e4917f904aed5df91c883cf058af/d1/database/85853fb1-.../query`，
以及 `d1 export` 的签名下载 URL 中同样包含该 UUID。

> ⚠ **关键陷阱**：`wrangler.jsonc` 的**默认 binding** 是被本Gate 明确禁止的
> `jhzy-v2-db`（`ea603f43-...`）。故**每条命令**都必须显式携带
> `-e staging` + 数据库名，从不依赖默认绑定。执行器内置
> `assertTarget()`：命令串若缺 `-e staging`/`--remote`，或出现生产 UUID /
> 禁止 UUID，立即抛错中止。

---

## 2. 权威源快照校验（§5）

| 项 | 结果 |
| --- | --- |
| 归档 SHA256 | `d51563b0…d688bf` **完全一致** |
| data 成员 SHA256 | `5850ff6c…6196936` **一致** |
| schema 成员 SHA256 | `b67db86e…28dd6b9` **一致** |
| gzip 完整性 | PASS |
| 源行数 | **450,000**（解析 40 条 INSERT 实得） |
| 逐池 | cert_trn 180,000 · cert_srv 150,000 · cert_hon 10,000 · cert_skl 10,000 · volunteer 100,000 |
| 状态 | free 448,312 · assigned 1,661 · reserved 27（合计 450,000 ✓） |
| 分配引用 | NULL 939 · SENTINEL 2 · UNRESOLVED 747 · **PROVEN_MAPPABLE 0** |

**JHZY 1.0 线上**：未 SSH、未查询、未使用。全部历史数据来自离线快照。

---

## 3. 迁移前状态与快照（§10 / §11）

| 项 | 迁移前 |
| --- | --- |
| `d1_migrations` | max **0044**，共 44 条 |
| 0045 / 0046 | **均不存在**（符合预期） |
| `id_pools` | 500（全 `cert_trn`、status=0、**无 provenance 列**） |
| `certificates` | **413**（`cert_no` 全distinct） |
| `certificate_logs` | 0 |
| `certificate_batches` | 表不存在 |
| FK 违规 / 重复 cert_no | 0 / 0 |

迁移前快照：`cert_r3e_staging_pre_20261003T051322Z`
SHA256 `b6a579b807da4b76e6fcbaa5472bd7449dcf853d582a9677167dccb03ebb4550`
（3,617,578 字节；存于 `.var/cert-r3e-staging-snapshots/`，`.var` 未受git 跟踪）

---

## 4. 发证窗口（§12）

`STAGING_CERTIFICATE_ISSUANCE_WINDOW = CLOSED` 自施加0045/0046 前起，
直至本文档全部后置门禁通过。全程**未进行任何真实发证**。

---

## 5. 0045 与 0046 执行（§13 / §15）

`wrangler d1 migrations apply` 将两个待应用迁移一并执行（官方语义：应用所有 pending）：

| 迁移 | 状态 | 事后核验 |
| --- | --- | --- |
| 0045_certificate_domain_contract.sql | ✅ | `issue_source` / `cert_kind` / `uq_cert_user_source` / `certificate_batches` 均存在 |
| 0046_id_pools_legacy_pool_compatibility.sql | ✅ | `cert_skl` 纳入 CHECK；`status(0,1,2)` 保留；`UNIQUE(code)` 生效；`provenance` 列生效 |

**迁移账本**：max 46 ·共 46 条 · 0045 ×1 · 0046 ×1（各仅一次）。

**证书零改动**：413 → 413，`cert_no` 全distinct。
0045 新增列全部为默认值（`cert_kind='participant'` 413 行；`issue_source`/`issue_reason` 全 NULL），
**无破坏性回填、无证书编号变化、FK 完整性不变**。

**0046 后临界检查点（导入前）**：

```
STAGING_ID_POOLS_TOTAL   = 500
SYNTHETIC_COMPAT         = 500   (全部 provenance='v2_synthetic_compat')
SYNTHETIC_STATUS_0       = 500   (status 全部保持 0，未伪造状态)
SYNTHETIC_ALLOCATABLE    = 0     ← 有意的 fail-closed 中间态
global duplicate codes   = 0
```

---

## 6. 450,000 行批量导入（§17–§21）

### 6.1 执行器与三项实测限制

复用已提交的 `src/services/legacy-pool-importer.ts` 语义（逐字节保留 code、
直译 status、`provenance='legacy_migrated'`、`assigned_to` 无证据恒 NULL）。
实际执行中定位到**三项平台限制**（均为实测，非猜测，一并记录以便后续 Gate 复用）：

| 限制 | 现象 | 规避 |
| --- | --- | --- |
| macOS `MAX_ARG_STRLEN` 256KB | `--command` 传大SQL → `E2BIG` | 按**字节预算**（60KB）切块 |
| D1 单语句体积 | >~80KB → `SQLITE_TOOBIG` | 同上；单语句 ≤60KB |
| D1 `SQLITE_MAX_COMPOUND_SELECT` | `UNION ALL` 复合 SELECT（实测 100 项即失败） | **不用**复合 SELECT |

最终形态：**`INSERT OR IGNORE … VALUES (…),(…)…` 单语句多行**
—— 幂等由 `UNIQUE(code)` 保证（无需逐行 `NOT EXISTS` 子查询），
且每块单事务，远端耗时约 4–7 秒（对比逐行 `--file` 上传 17秒+ 且会超时）。

### 6.2 结果

| 项 | 值 |
| --- | --- |
| 输入行 | 450,000 |
| 导入结果 | **450,000 全部落库**（`legacy_migrated`） |
| 冲突 | **0** |
| 断点续跑 | **使用**（多次网络中断后按 checkpoint 续跑） |
| 导入后总量 | **450,500** |

> **过程记录（须如实披露）**：执行期间曾用 `INSERT OR IGNORE` 探测 D1 语句体积上限，
> 探测数据（合成 `PROBE-*` 前缀）因 `OR IGNORE` 语义**实际落库 1,000 行**。
> 导入完成后计数为 451,000，比权威值多 1,000 —— 经前缀特征精确定位为
> **10 组 × 100 条 `PROBE-*` 探测行**（非权威历史数据）。
> 处置：以 `code LIKE 'PROBE-%'` **精确删除 1,000 行**（`changes=1000`），
> 删除范围绝不触及任何 `JHCRT-*` / `JH-*` / `CTRN*` 权威码。
> 事后逐池/逐状态计数与哈希全部与源端精确一致（见 §7）。

### 6.3 生产 Gate 前向纪律（对应 §6 之 A–H 完全登记）

本迁移暴露的操作教训，已固化为后续生产 Gate 的硬纪律：

- **A. 探测污染**：执行期间曾以 `INSERT OR IGNORE` 探测 D1 单语句体积上限，
  导致 1,000 行 `PROBE-*` 合成数据**真实落库**（见 §6.2）。
- **B. 精确定位与清除**：经前缀特征（`PROBE-*`）精确定位 10 组 ×100 行，
  以 `code LIKE 'PROBE-%'` 精确删除 1,000 行，未触及任何权威码（见 §6.2 / §7）。
- **C. 无残留证明**：删除后逐池/逐状态计数与逐位指纹全部与源端精确一致（见 §7）。
- **D. 生产禁止写式探测**：**生产（及任何正式）Gate 严禁以写入式语句探测平台限制**
  （如 `INSERT OR IGNORE` 试错）。平台约束须只读探明或离线估算；
  若必须写探测，须使用**可隔离、可整体回滚**的临时表，且事后强制清理并复算。
- **E. 迁移一并应用**：`wrangler d1 migrations apply <db> -e staging` 的语义是
  **应用全部 pending 迁移**，故 0045 与 0046 被同时执行（见 §5）。
- **F. 生产不可假定单条应用**：**未来生产 Gate 不得假定可借助该命令"一次只应用一条"迁移**；
  若需严格分批/分窗，须改用 `wrangler d1 execute --remote --file <single-migration.sql>`
  或受控脚本，且每条应用后即时核验账本。
- **G. 平台约束**：argv 256KB（`E2BIG`）、D1 单语句 ~80KB（`SQLITE_TOOBIG`）、
  `SQLITE_MAX_COMPOUND_SELECT` 极小（实测 100 项即失败）、网络 `fetch failed` 频发、
  断点续跑 + 幂等为必需（见 §6.1）。
- **H. 最终可用批量策略**：有界紧凑切块（`INSERT OR IGNORE … VALUES (…),(…)…`，
  ≤60KB 字节预算）+ `UNIQUE(code)` 幂等守卫（见 §6.1）。

---

## 7. 对账（§22–§28）

### 7.1 计数

| 维度 | 结果 |
| --- | --- |
| 总�� | **450,500** = 450,000 legacy + 500 synthetic |
| provenance | legacy_migrated 450,000 · v2_synthetic_compat 500 · **NULL 0** |
| status | 0: **448,812** · 1: **1,661** · 2: **27** |
| legacy 子集 status | 0: 448,312 · 1: 1,661 · 2: 27 |
| V2 池聚合 | cert_trn **180,500**（180,000 legacy + 500 合成）· cert_srv 150,000 · cert_hon 10,000 · cert_skl 10,000 · volunteer 100,000 |
| legacy 子集逐池 | cert_trn 180,000 · cert_srv 150,000 · cert_hon 10,000 · cert_skl 10,000 · volunteer 100,000 |

### 7.2 哈希/指纹对账（§26）

隐私安全：全程只输出计数与聚合指纹，**不输出任何 code**。
指纹算法在源端与D1 端**逐位复现**（`COUNT` + `SUM(LENGTH)` +
逐位置 ASCII 和 + 位置加权ASCII 和）。

| 项 | 结果 |
| --- | --- |
| LEGACY_CODESET | **PASS**（n=450,000 · len=10,100,000 · ascii 与加权完全一致） |
| POOL_CODESET | **5/5 PASS**（含 volunteer：17 字符码） |
| POOL_STATE + PROVENANCE | **5/5 PASS** |

> 修正记录：首版指纹用 `unicode(code)`，实测 SQLite 的 `unicode(X)` **只返回首字符**
> 码点（`unicode('JHCRT-…')=74`），导致公式失效；且 `substr` 越界时 `unicode('')=NULL`
> 使 `SUM` 变 NULL（volunteer 17 字符受影响）。改为
> `COALESCE(unicode(substr(code,i,1)),0)` 后全部 PASS。

### 7.3唯一性与完整性

| 项 | 结果 |
| --- | --- |
| 全局重复 code 组/ 行 | **0 / 0**（`UNIQUE(code)` 生效） |
| FK 违规 | 0 |
| 非法 pool_type / status / provenance 行 | 0 / 0 / 0 |
| 证书重复 cert_no | 0 |
| 证书行数漂移 | 0（413 → 413） |

### 7.4 合成 500 保全（§27）

| 项 | 结果 |
| --- | --- |
| 数量 | 500 |
| code | 长度恒为 10（`CTRN%06d` 形态），逐字节未变 |
| pool_type | 全部 `cert_trn` |
| status | 全部 **0**（`SYNTHETIC_STATUS_MUTATIONS = 0`） |
| assigned_to / assigned_at | 全部 NULL（未改动） |
| provenance | 全部 `v2_synthetic_compat` |
| 被消费 / 被引用 / 被删除 | 无 / 无 / 无 |

### 7.5 assigned_to 政策（§18）

**`ASSIGNED_TO_GUESSED_MAPPING_COUNT = 0`** —— 1,688 条非自由行
（assigned 1,661 + reserved 27）中，939 NULL / 2哨兵 / 747 待证，
无一具备权威映射证据，故一律写 NULL；**status 无一下降**。

---

## 8. 只读运行时烟测（§29–§34）

全部为**只读聚合**，未消费任何号池行、未真实发证。

| 烟测 | 结果 | 证据 |
| --- | --- | --- |
| TRAINING候选（cert_trn） | **PASS** | 可分配 179,543；status=0 179,543；legacy 179,543；**合成 0** |
| ACTIVITY（cert_srv） | **PASS** | 可分配 149,692；status=0 149,692；legacy 149,692 |
| SERVICE（cert_srv） | **PASS** | 同上（共用 cert_srv 池，符合设计） |
| reserved 不可分配 | **PASS** | 27 条仍为 status=2；真实选择器要求 status=0 → 结构性不可达 |
| 合成兼容不可分配 | **PASS**（`SYNTHETIC_COMPAT_ALLOCATABLE = NO`） | status=0 且 provenance 合规者中合成码 = **0** |
| 未知 provenance fail-closed | **PASS** | CHECK 约束拒绝未知字面量（schema 证据）；NULL 不在白名单 → 不入选|
| 可分配 legacy 空闲库存 | 448,312（>0） | — |

---

## 9. 证书数据保全（§35）

| 项 | 结果 |
| --- | --- |
| 证书数 | 413 → **413** |
| cert_no | 413 distinct（无重复、无改号） |
| user_id | 284 distinct（未变） |
| source_type 分布 | activity 55 · course 358（未变） |
| source_id | 413 行全 NULL（与迁移前一致，**未被回填**） |
| 0045 新增列 | 全为默认值（`cert_kind='participant'`；`issue_source`/`issue_reason` NULL） |
| certificate_logs | 0（未变） |

**无证书重发、无既有证书重编号。**

---

## 10. 幂等复跑（§36）

以 `INSERT OR IGNORE` 对**全量 450,000 行**复跑（并多次完整重扫）：

| 项 | 结果 |
| --- | --- |
| 新增插入 | **0** |
| 冲突 | **0** |
| 总量 | 恒为 **450,500** |

---

## 11. 迁移后回归（§37）

| 门禁 | 结果 |
| --- | --- |
| CERT-R3D | **79 / 0** |
| CERT-R3B | **63 / 0** |
| CERT-R2 | **57 / 0** |
| `tsc --noEmit` | **PASS**（exit 0，零输出） |
| `wrangler deploy --dry-run` | **PASS**（877.92 KiB / gzip 202.71 KiB，未部署） |

---

## 12. 迁移后快照（§41）

`cert_r3e_staging_post_20261003T085132Z`
SHA256 `75cc8cc293b4c7d9b193d237a8fde914949932e8db55126c179ae2c5067345c3`
（2,500,352 字节；含迁移后 `id_pools` 数据；同样存于 `.var/`，**未进 Git**）

两份 manifest 均记录：run_id / 时间戳 / 目标 DB 名与 UUID / HEAD /
迁移版本 / 前后计数 / 对账结果 / 完整性 / 烟测结论 / 各项禁止项。

---

## 13. 发证窗口释放（§38）

所有强制门禁均 PASS：

```
0045 ✅  0046 ✅  450k 导入 ✅  计数 ✅  状态 ✅  provenance ✅
全局唯一 ✅  哈希 5/5 ✅  状态+provenance 哈希 5/5 ✅  合成保全 ✅
DB 完整性 ✅  TRAINING 烟测 ✅  ACTIVITY 烟测 ✅  SERVICE 烟测 ✅
reserved 安全 ✅  幂等复跑 ✅  全量回归 ✅  post 快照 ✅  Secret/PII 扫描 ✅
生产未触碰 ✅  JHZY 1.0 未触碰 ✅  未部署 ✅  未发证 ✅  未 push ✅
```

```
STAGING_CERTIFICATE_ISSUANCE_WINDOW = OPEN
```

> **注意**：窗口 OPEN 仅表示**数据库状态已就绪、可支撑发证**。
> 本 Gate **未**发出任何证书，Worker 也**未**部署到 staging
> （部署属独立受控 Gate，见 §14）。

---

## 14. 后续（不在本 Gate 范围）

- **CERT-R3F**：staging Worker 运行时部署（本 Gate 明确禁止部署）
- 生产号池迁移：**仍为 NO**（需独立授权与窗口）
- 实际发证验收：需独立 Gate

---

## 15. 禁止项确认（§45/§46）

| 项 | 状态 |
| --- | --- |
| 生产 D1 被改动 | **NO**（全程零生产访问） |
| 生产迁移被应用 | **NO** |
| 预发/生产 D1 写入 | 仅 staging（授权目标） |
| Worker 被部署 | **NO** |
| 真实证书签发 | **NO** |
| Secret / RBAC 变更 | **NO** |
| git commit / push | **NO** |
| JHZY 1.0 线上触碰 | **NO**（仅离线快照） |
| 证据被提交 | **NO**（staged = 0） |