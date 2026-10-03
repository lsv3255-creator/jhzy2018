# CERT-R5A: Production Import Runner Wiring Fix

> STATUS = **WIRING COMPLETE, LOCAL SIMULATED**
> PRODUCTION 450k IMPORT = **NOT PERFORMED**（本任务明确禁止）
> CERTIFICATE ISSUANCE = **REMAINS CLOSED**
>
> 前置：`31-cert-r5-production-execution.md`（CERT-R5 = BLOCKED）
> 本任务只修复「导入执行路径未组装」这一根因，**不**执行生产导入、**不**部署 Worker、**不** push。

---

## 0. R5 BLOCKED 根因回顾

R5 在 P6/P7 停止，三条独立证据（详见 `31-*.md` §6/§7）：

1. `cert-r5-protected-legacy-pool-import-runner.mjs` 的 CLI 是**纯守卫桩**——只打印常量并 `exit 0`。
2. `runLegacyPoolImportRunner()` 唯一调用点是测试；`importLegacyPools` 在 runner 第 303 行只作为**注释**出现。
3. 全仓**无归档解析器**；`readArchiveSql()` 自述 tar 需先 `tar xzf`，未完成。

**关键**：旧 plan / dry-run 的 `exit 0` 是**伪通过**——9 项要求守卫一项都没执行。

---

## 1. 本次修复内容

| 文件 | 变更 |
| --- | --- |
| `workers/scripts/legacy-pool-source-parser.mjs` | **新增**：离线归档 → 450,000 行解析 + 源统计 |
| `workers/scripts/d1-executor-adapters.mjs` | **新增**：本地 SQLite 适配器 + 远程 D1 REST 适配器 |
| `workers/scripts/cert-r5-protected-legacy-pool-import-runner.mjs` | **改造**：真实 CLI 接线（plan/dry-run/execute） |
| `workers/scripts/cert-r5a-local-import-simulation.mjs` | **新增**：本地全量模拟（零网络） |
| `workers/tests/cert_r5a_import_runner_wiring.test.mjs` | **新增**：35 项 wiring 测试 |

### 1.1 Source parser（A/B）

- 校验归档 SHA256（`d51563b0…`）后才解包，不匹配即 fail-closed
- `tar xzf` → `gunzip` → 只解析 `INSERT INTO \`id_pool\` VALUES`（精确表名，**排除** `id_pool_old_20260214` 的 14 条干扰语句）
- 自研词法扫描：尊重引号 / 转义 / 多级括号，**支持多行 INSERT**
- 正确处理 `NULL` datetime、`999999` 哨兵、转义单引号
- 输出完整 `LegacyPoolRow`：`id / code / poolType / status / assignedTo / assignedAt / batchId / createdAt`
- 绝不打印 raw code

legacy `id_pool` 列序：`id, id_value, id_type, batch_id, status, assigned_to, assigned_at, created_at`

### 1.2 行转换（B）

| 项 | 处理 |
| --- | --- |
| pool_type | 原样保留（5 种，与 0046 CHECK 一致） |
| status | `available→0 / assigned→1 / reserved→2`（复用 importer `STATUS_MAP`） |
| assigned_to | **不猜测 V2 user_id**：仅 PROVEN_MAPPABLE 才写入；本源 `proven_mappable = 0` → 全部 NULL |
| provenance | 统一 `legacy_migrated` |
| code | 逐字节原样 |

**决策点（需人工确认）**：legacy `datetime` 是 naive 挂钟时间、不带时区。为保证确定性/可复现/不臆造，默认按 **UTC** 解释（`parseSqlDateTime` 的 `datetimeTimezone` 可覆盖）。若应以 CST(+08:00) 解释，需人工确认后改默认值。
`created_at` 为 NOT NULL，legacy NULL 以 `nullTimestampFallback = 0` 兜底并在 stats 中计数上报（实测本源 `nullCreatedAt = 0`，无实际影响）。

### 1.3 Runner 真实接线（C/D/E）

| 模式 | 行为 |
| --- | --- |
| `plan` | **真实读取归档并解析 450,000 行** → 校验 SHA / 行数 / pool 分布 / status 分布 / assigned_to 分类 → 输出计数摘要。失败即非 0 退出 |
| `dry-run` | 同上 + 构建 batch plan（`batchSize=5000 → 90 batches`），`writes=0` |
| `execute` | 仍需 **全部 5 项 `--confirm-*`** + 显式 `--db-mode`；前置未就绪或确认缺失即 fail-closed |

新增 CLI 参数：`--source-archive`、`--work-dir`、`--db-mode local|remote`、`--local-db-path`、`--batch-size`、`--read-prod-state`。

### 1.4 D1 执行器（F）

- `createLocalSqliteD1()`：node:sqlite，用于本地模拟与测试，零网络
- `createRemoteD1Adapter()`：Cloudflare D1 REST，用于生产写入
  - 显式 target / account / dbUuid 必填，UUID 与 account 守卫在此层强制
  - **吞吐设计**：启动时一次性载入既有 `id_pools` 到内存 Map（语义等价于逐行 SELECT），冲突判定走内存；UPSERT batch 合并为单条 `INSERT OR IGNORE ... VALUES (…),(…)`，依赖 0046 恢复的全局 `UNIQUE(code)` 保证幂等
  - 避免 450,000 行产生 ~90 万次 HTTP 请求（维护窗口内不可行）
- 底层执行统一调用**真实 `importLegacyPools`**（esbuild 编译 `legacy-pool-importer.ts`，缓存于 gitignored `tmp/_r5a/`）；编译失败即 fail-closed，**不使用镜像实现执行写入**

---

## 2. 离线源实测结果

```
SOURCE_SHA256  = d51563b0e3149535eb66ff64a3d447a5ad9dfa1cdf26f00b680b4824c4d688bf  (MATCH)
OFFLINE_SOURCE_PARSED_ROWS = 450000
POOL_TOTALS   = cert_trn 180000 / cert_srv 150000 / cert_hon 10000 / cert_skl 10000 / volunteer 100000
STATUS_TOTALS = available 448312 / assigned 1661 / reserved 27
ASSIGNED_TO_CLASSIFICATION = null 939 / sentinel 2 / unresolved 747 / proven_mappable 0
```

全部与冻结基线（GUARDS）**逐项精确一致**。

### 2.1 ⚠ 两个必须披露的发现

**发现 1 —— 统计口径（已修正）：** `assigned_to` 分类的权威作用域是**非自由行 1,688 条**（=1,661 assigned + 27 reserved），不是全表。最初按全表计算得到 `null=449149 / unresolved=849`，与 GUARDS 的 `939/2/747` 不符。按非自由行口径重算后**逐项吻合**，且按池分布也与 `legacy-id-pool-migration.md` §5 完全一致（volunteer 889/2/30、cert_trn 14/0/443、cert_srv 34/0/274、cert_hon 2/0/0）。
`buildSourceStats` 现已按非自由行口径输出 `assignedTo`，全表口径另存 `assignedToAllRows` 供诊断。

**发现 2 —— 数据异常：** 有 **102 条 `status='available'` 却带非 NULL `assigned_to`** 的行。runner 会以 `SOURCE_ANOMALY availableWithRef=102` 告警。因 `proven_mappable = 0`，这些行的 `assigned_to` 落地为 NULL（不猜测映射），不影响导入正确性；但建议人工确认该异常的业务含义。

**发现 3 —— 旧守卫的潜在不一致：** R4-RUNNER 的 `GUARDS.EXPECTED_ASSIGNED_TO` 定义在非自由行口径上，而其自带的 `parseLegacySourceStats` 按全表计数 → 两者本就永不匹配。因测试只注入 fixture 统计、从不跑真实解析，该缺陷未被发现。本次已用真实解析验证口径一致。

---

## 3. 测试结果

| 套件 | 结果 |
| --- | --- |
| `cert_r5a_import_runner_wiring.test.mjs` | **35 pass / 0 fail** |
| `cert_r4_runner_production_guard.test.mjs`（回归） | **35 pass / 0 fail** |

覆盖（任务书 G 节 10 项）：

1. 解析器处理 multiline / NULL / sentinel / 转义单引号 ✅
2. plan 在 SHA 不匹配时失败（非 0 退出）✅
3. plan 在行数不匹配时失败（`SOURCE_ROW_COUNT_MISMATCH`）✅
4. plan 计算的 totals 与冻结基线精确一致 ✅
5. dry-run 未读取源即不得 exit 0；源可用时真实解析 450,000 行 ✅
6. execute 缺确认 / 缺 `--db-mode` 不得运行 ✅
7. 守卫未全过时底层 importer **不被调用**（fail-closed）✅
8. 生产当前态 46/1/1/500/0 判定 `READY_FOR_IMPORT` ✅
9. 0045/0046 缺失判定 `NOT_READY_FOR_IMPORT` ✅
10. 日志无 raw code / PII / secret 命中 ✅

### 3.1 已知限制（不阻断）

`--read-prod-state` 在无 TTY 且未设置 `CLOUDFLARE_API_TOKEN` 的环境下，wrangler 会拒绝执行，此时降级为 `PROD_STATE_UNAVAILABLE` 并记告警，前置守卫按缺失状态给出 NOT_READY（fail-closed，安全方向）。生产执行时需在 TTY 中运行或提供 API token。

---

## 4. 本地全量模拟（H）—— 已执行

**LOCAL_FULL_IMPORT_EXECUTED = YES**（本地 SQLite，零网络、零生产副作用）

```
parse_ms  = 12005
import_ms = 10064
inserted  = 450000   alreadyPresent = 0   conflicts = 0   batches = 90

id_pools_total            = 450500
legacy_migrated           = 450000
synthetic_compat          = 500
null_provenance           = 0
duplicate_code_groups     = 0
guessed_assigned_to_mappings = 0

pool_totals   = cert_trn 180500 / cert_srv 150000 / cert_hon 10000 / cert_skl 10000 / volunteer 100000
status_totals = 0:448812 / 1:1661 / 2:27
```

**与 R5 P8 对账目标逐项吻合**：450,500 / 450,000 / 500 / NULL=0 / 重复=0 / 猜测映射=0，
pool 与 status 分布全部命中（`cert_trn 180500` = 180,000 legacy + 500 合成；`status 0 = 448,812` = 448,312 legacy + 500 合成）。
这证明 wiring 端到端可用：解析 → 守卫 → 真实 importer → 落库，语义正确。

---

## 5. 生产状态与非突变确认

| 项 | 值 |
| --- | --- |
| PRODUCTION_D1_MUTATED（本任务） | **NO** |
| PRODUCTION_WORKER_DEPLOYED | **NO** |
| ISSUANCE_WINDOW | **REMAINS_CLOSED** |
| JHZY 1.0 live | 未触碰 |
| git push | 未执行 |

生产**仍保持** R5 遗留的中间态：`PROD_MIGRATION_COUNT=46`、`ID_POOLS_TOTAL=500`、`LEGACY_MIGRATED=0`、`SYNTHETIC_COMPAT=500`、`NULL_PROVENANCE=0`、`CERTIFICATES_COUNT=413`。
⚠ 该中间态下 `cert_trn` 可分配库存为 **0**（500 条合成库存均 `v2_synthetic_compat`，不可分配），在 legacy 导入完成前任何 TRAINING 发证会 `EXAM_POOL_EXHAUSTED`。

---

## 6. 是否可以继续生产导入

**READY_TO_RESUME_R5_IMPORT = YES**（wiring 已完成并本地验证），但**仍需**：

1. 人工显式授权短语（R5 的授权短语**不足以**覆盖 R5A 修复后的首次写入，建议重新给出针对「导入」的显式授权）
2. 在维护窗口内执行
3. 确认 §2.1 决策点（datetime 时区口径）与 102 条异常行的处置意见
4. TTY 或 `CLOUDFLARE_API_TOKEN` 可用，以便 `--read-prod-state` 生效

生产导入命令（修正后，替代已废弃的空转命令）：

```bash
cd /Users/Shared/projects/jhzy-v2/workers

# P6' plan / dry-run（真实解析 450,000 行，不写）
node scripts/cert-r5-protected-legacy-pool-import-runner.mjs --mode plan \
  --target jhzy-v2-prod --account 8770e4917f904aed5df91c883cf058af \
  --db-uuid d372229f-c0ae-4dcc-b968-4ec7c2832842 --read-prod-state

node scripts/cert-r5-protected-legacy-pool-import-runner.mjs --mode dry-run \
  --target jhzy-v2-prod --account 8770e4917f904aed5df91c883cf058af \
  --db-uuid d372229f-c0ae-4dcc-b968-4ec7c2832842 --read-prod-state

# P7' execute（全部确认 + 显式 remote，需 CLOUDFLARE_API_TOKEN）
export CLOUDFLARE_API_TOKEN=...   # 绝不写入文档 / 日志
node scripts/cert-r5-protected-legacy-pool-import-runner.mjs --mode execute \
  --target jhzy-v2-prod --account 8770e4917f904aed5df91c883cf058af \
  --db-uuid d372229f-c0ae-4dcc-b968-4ec7c2832842 \
  --db-mode remote --read-prod-state \
  --confirm-production-d1 d372229f-c0ae-4dcc-b968-4ec7c2832842 \
  --confirm-account 8770e4917f904aed5df91c883cf058af \
  --confirm-source-sha d51563b0e3149535eb66ff64a3d447a5ad9dfa1cdf26f00b680b4824c4d688bf \
  --confirm-maintenance-window CERTIFICATE_ISSUANCE_CLOSED \
  --confirm-i-understand-production-write
```

> 旧文档中「`node scripts/... --mode plan` 只打印三行常量」的空转命令**已废弃**。

---

**NEXT_ACTION = STOP. Await human review before any production import.**
