# Certificate Production Pool Migration Runbook

> STATUS = **PLANNING ONLY**
> PRODUCTION EXECUTION = **NOT AUTHORIZED**
>
> 依据：`28-cert-r4-production-migration-readiness.md`（CERT-R4）
>
> 此文档为**规划阶段产物**，未经管理员显式授权不得执行。

---

## 0. 概览

| 维度 | 值 |
| --- | --- |
| 目标 DB | `jhzy-v2-prod` / `d372229f-c0ae-4dcc-b968-4ec7c2832842` |
| 账户 | `8770e4917f904aed5df91c883cf058af` |
| Profile | `jhzy` |
| 当前 migration ledger | 44/46（0044 applied, 0045 absent, 0046 absent） |
| 当前 id_pools | 500 行（cert_trn CTRN%, status=0） |
| 目标 id_pools | 450,500 行（450,000 legacy + 500 synthetic） |
| 当前 certificates | 413 行 |
| 维护窗口 | **2026-10-04 02:00–04:00 CST**（已确认，原"待分配"） |
| HTTP E2E 环境 | **用户 Mac 本机浏览器和终端 curl**（已确认） |
| 授权状态 | `AUTHORIZATION_PHRASE_RECEIVED = NO` / `PRODUCTION_EXECUTION_AUTHORIZED = NO` |

### 0.1 人工条件录入（CERT-R5-FINAL-PREFLIGHT，2026-10-03）

```
MAINTENANCE_WINDOW_DEFINED = YES
MAINTENANCE_WINDOW = 2026-10-04 02:00–04:00 CST
HTTP_E2E_ENVIRONMENT_AVAILABLE = YES
HTTP_E2E_ENVIRONMENT = 用户 Mac 本机浏览器和终端 curl
AUTHORIZATION_PHRASE_RECEIVED = NO
PRODUCTION_EXECUTION_AUTHORIZED = NO
```

`READY_FOR_CERT_R5_PRODUCTION_EXECUTION = WAITING_FOR_EXPLICIT_AUTHORIZATION`。

---

## 1. Pre-Flight Checks

```bash
# 确认 pending migrations
wrangler d1 execute jhzy-v2-prod --remote -e production \
  --command "SELECT COUNT(*) FROM d1_migrations WHERE id > 44" \
  --profile jhzy

# 预期输出：2（0045 + 0046 未执行）
```

---

## 2. Migration Apply

### 2.1 Apply 0045 + 0046

```bash
cd /Users/Shared/projects/jhzy-v2

# 双锁：profile + account
wrangler d1 migrations apply jhzy-v2-prod \
  --remote -e production \
  --profile jhzy
```

**注意：**
- `wrangler d1 migrations apply` 会执行**全部 pending migrations**（0045 + 0046 同时执行）。
- **禁止**分批 apply（无 ledger-safe 精确机制）。
- 执行后验证：

```bash
# 验证 migration ledger
wrangler d1 execute jhzy-v2-prod --remote -e production \
  --command "SELECT COUNT(*), MAX(id) FROM d1_migrations" \
  --profile jhzy

# 预期输出：46 / 46
```

### 2.2 Schema Verification

```bash
# 验证 id_pools 新增列
wrangler d1 execute jhzy-v2-prod --remote -e production \
  --command "PRAGMA table_info(id_pools)" \
  --profile jhzy

# 确认存在：legacy_migrated, provenance, batch_id

# 验证 certificates 新增列
wrangler d1 execute jhzy-v2-prod --remote -e production \
  --command "PRAGMA table_info(certificates)" \
  --profile jhzy

# 确认存在：cert_kind, issue_source, issued_by, issue_reason, revoked_at, revoked_by, revoke_reason
```

---

## 3. Legacy Pool Import

### 3.1 Import Strategy

完全复用 staging 已验证策略（`legacy-id-pool-migration.md` §17）：

| 要求 | 状态 |
| --- | --- |
| idempotent | ✅ |
| resumable | ✅ |
| UNIQUE(code)-protected | ✅（0046 恢复 legacy 全局唯一不变量） |
| explicit production DB target | `jhzy-v2-prod` / `d372229f` |
| explicit account guard | `8770e4917f904aed5df91c883cf058af` |
| retry/backoff | ✅ |
| status preserved | ✅ |
| reserved preserved | ✅ |
| synthetic preserved | ✅（500 行 CTRN 保留） |
| no guessed assigned_to | ✅ |
| no raw code logging | ✅ |
| no PII logging | ✅ |

### 3.2 Import Steps

```bash
# 步骤 1：确认 id_pools 总量（pre-import）
wrangler d1 execute jhzy-v2-prod --remote -e production \
  --command "SELECT COUNT(*) FROM id_pools" \
  --profile jhzy
# 预期：500

# 步骤 2：执行 import（独立脚本，待 staging 验证后复制）
# 使用 staging 验证过的 import 脚本，修改 target DB 为 production

# 步骤 3：确认 id_pools 总量（post-import）
wrangler d1 execute jhzy-v2-prod --remote -e production \
  --command "SELECT COUNT(*) FROM id_pools" \
  --profile jhzy
# 预期：450,500
```

---

## 4. Post-Import Reconciliation

### 4.1 id_pools Reconciliation

```sql
-- pool_type 分布
SELECT pool_type, COUNT(*) FROM id_pools GROUP BY pool_type;

-- status 分布
SELECT status, COUNT(*) FROM id_pools GROUP BY status;

-- provenance 分布
SELECT provenance, COUNT(*) FROM id_pools GROUP BY provenance;

-- 重复 code 检查
SELECT code, COUNT(*) as cnt FROM id_pools GROUP BY code HAVING cnt > 1;
-- 预期：0 行
```

### 4.2 Certificates Reconciliation

```sql
-- 总数
SELECT COUNT(*) FROM certificates;
-- 预期：413

-- cert_type 分布
SELECT cert_type, COUNT(*) FROM certificates GROUP BY cert_type;

-- status 分布
SELECT status, COUNT(*) FROM certificates GROUP BY status;
```

---

## 5. Rollback Plan

### 5.1 Worker Rollback

```bash
# 如需回滚 Worker，切回上一 active 版本
wrangler versions rollback jhzy-v2-worker-production \
  --version <previous_version_id> \
  --profile jhzy
```

### 5.2 D1 Rollback

**D1 无原生回滚机制**。如需回滚：

1. 维护前导出全库：`wrangler d1 execute jhzy-v2-prod --remote --command ".dump" --profile jhzy > backup.sql`
2. 回滚时重新导入：`wrangler d1 execute jhzy-v2-prod --remote --command < backup.sql --profile jhzy`

> **注意**：此方案在大规模数据（450k+）下不可行。必须在维护窗口前完成完整备份。

---

## 6. Verification Checklist

| 项 | 预期 | 实测 | 状态 |
| --- | --- | --- | --- |
| d1_migrations 总数 | 46 | — | □ |
| 最后迁移 id | 46 | — | □ |
| id_pools 总量 | 450,500 | — | □ |
| id_pools pool_type cert_trn | 500（合成） | — | □ |
| id_pools pool_type cert_act | 448,812（legacy） | — | □ |
| id_pools pool_type cert_srv | 1,661（legacy） | — | □ |
| id_pools pool_type cert_hon | 27（legacy） | — | □ |
| id_pools provenance legacy_migrated | 450,000 | — | □ |
| id_pools provenance v2_synthetic_compat | 500 | — | □ |
| certificates 总量 | 413 | — | □ |
| 重复 code 检查 | 0 行 | — | □ |
| 表结构含 legacy_migrated | 是 | — | □ |
| 表结构含 provenance | 是 | — | □ |
| 表结构含 batch_id | 是 | — | □ |
| 表结构含 cert_kind | 是 | — | □ |
| 表结构含 issue_source | 是 | — | □ |

---

## 7. Post-Execution Notification

执行完成后：

1. 通知管理员维护窗口完成。
2. 更新 migration ledger 文档。
3. 更新 id_pools 文档。
4. 归档本 Runbook 为 EXECUTED（非 PLANNING ONLY）。

---

## 7b. CLOSEOUT Findings (CERT-R4-CLOSEOUT, 2026-10-03)

> 仅规划补充，未执行。生产仍 READ-ONLY。

### 7b.1 Importer Production Readiness

源：`workers/src/services/legacy-pool-importer.ts`（纯逻辑，接收 `db` 参数）。

- **`IMPORTER_PRODUCTION_READY = NO`** —— 仓库内无 production runner/caller（`grep importLegacyPools` 仅定义无调用）。执行路径尚未组装/受源码审查。
- importer 源级安全属性：IDEMPOTENT ✅ / RESUMABLE ✅ / UNIQUE(code) ✅ / CONFLICT_FAIL_CLOSED ✅ / STATUS_PRESERVED ✅ / RESERVED_PRESERVED ✅ / SYNTHETIC_PRESERVED ✅ / GUESSED_ASSIGNED_TO=NO ✅ / RAW_CODE_LOGGING=NO ✅ / PII_LOGGING=NO ✅ / DEFAULT_DB_FALLBACK=NO ✅。
- **源级缺口**：`ACCOUNT_GUARD` 与 `PRODUCTION_UUID_GUARD` 不在 importer 内，须由 runner/CLI 层（`--profile jhzy` + `CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af` + 显式 `--remote -e production` + DB 名 `jhzy-v2-prod`）强制。`RETRY_BACKOFF` 不在 importer 内，须由 runner 实现。
- **执行前最小要求**：编写受保护 runner，断言 `CLOUDFLARE_ACCOUNT_ID` + DB UUID `d372229f` + 显式 target，禁止默认 DB 回退，实现分批重试/退避。该 runner 不在此任务自动 commit。

### 7b.2 WP4-D Legacy Source Verification

- Archive SHA256：`d51563b0e3149535eb66ff64a3d447a5ad9dfa1cdf26f00b680b4824c4d688bf`（MATCH 基线）。
- TOTAL 450,000；pool_type 精确匹配；status available 448,312 / assigned 1,661 / reserved 27；assigned_to sentinel(999999) 2 / unresolved 747 / NULL 939。
- 严禁访问 JHZY 1.0 live；仅用冻结离线快照。

### 7b.3 Source Regression (R3F HEAD `91ccbf4`)

- R3D 79/0、R3B 63/0、R2 57/0、`tsc --noEmit` PASS、`wrangler deploy --dry-run --env production` PASS（未部署）。

---

## 9. Future R5: Protected Runner Usage Template

> ⚠️ **DO NOT EXECUTE WITHOUT EXPLICIT HUMAN R5 AUTHORIZATION**
> 以下模板仅用于未来 R5 生产执行。须经管理员显式授权 + 维护窗口
> （`CERTIFICATE_ISSUANCE_CLOSED`）+ 双锁（`--profile jhzy` + `CLOUDFLARE_ACCOUNT_ID`）。
> 本 Runbook 当前 `STATUS = PLANNING ONLY`，不含任何 secret / raw code。

### 9.1 仅安全：plan / dry-run（不写生产）

> ⚠ **旧版命令已废弃**（CERT-R5A）：R5 时期的 runner CLI 是「空转守卫桩」，
> 只打印三行常量并 `exit 0`，**从未读取归档、从未解析 450,000 行、从未校验源统计**。
> 其 `exit 0` 属伪通过。以下为 wiring 修复后的真实命令。

```bash
cd /Users/Shared/projects/jhzy-v2/workers

# 双锁：profile + account（--read-prod-state 需要 TTY 或 CLOUDFLARE_API_TOKEN）
export CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af

# 真实解析离线归档 450,000 行 + 校验 SHA/行数/pool/status/assigned_to + 生产前置（只读）
node scripts/cert-r5-protected-legacy-pool-import-runner.mjs --mode plan \
  --target jhzy-v2-prod \
  --account 8770e4917f904aed5df91c883cf058af \
  --db-uuid d372229f-c0ae-4dcc-b968-4ec7c2832842 \
  --read-prod-state

node scripts/cert-r5-protected-legacy-pool-import-runner.mjs --mode dry-run \
  --target jhzy-v2-prod \
  --account 8770e4917f904aed5df91c883cf058af \
  --db-uuid d372229f-c0ae-4dcc-b968-4ec7c2832842 \
  --read-prod-state
```

预期输出含 `SOURCE_PARSED rows=450000 pools[…] status[…] assignedTo[null=939 sentinel=2 unresolved=747 proven_mappable=0]`。
源缺失 / SHA 不匹配 / 行数不符 → **非 0 退出**。

### 9.2 生产写入（仅 R5 授权后，全确认齐全）

```bash
# 前置：§2 已 apply 0045+0046 且 §2.2 schema 验证通过；§3 源档案 SHA 已校验。
# 远程写入需 CLOUDFLARE_API_TOKEN（绝不写入文档 / 日志）。
export CLOUDFLARE_API_TOKEN=...

node scripts/cert-r5-protected-legacy-pool-import-runner.mjs --mode execute \
  --target jhzy-v2-prod \
  --account 8770e4917f904aed5df91c883cf058af \
  --db-uuid d372229f-c0ae-4dcc-b968-4ec7c2832842 \
  --db-mode remote \
  --read-prod-state \
  --confirm-production-d1 d372229f-c0ae-4dcc-b968-4ec7c2832842 \
  --confirm-account 8770e4917f904aed5df91c883cf058af \
  --confirm-source-sha d51563b0e3149535eb66ff64a3d447a5ad9dfa1cdf26f00b680b4824c4d688bf \
  --confirm-maintenance-window CERTIFICATE_ISSUANCE_CLOSED \
  --confirm-i-understand-production-write
```

任何一项确认缺失、未指定 `--db-mode`、目标/源守卫不匹配、或 0045/0046 前置未就绪，
Runner 都会 **fail-closed 不写**，底层 `importLegacyPools` 根本不会被调用。
日志永不输出 raw code / PII。

本地演练（零网络、零生产副作用）：

```bash
node --experimental-sqlite scripts/cert-r5a-local-import-simulation.mjs
```

已实测：`inserted=450000 / conflicts=0 / id_pools_total=450500 / legacy_migrated=450000 /
synthetic_compat=500 / null_provenance=0 / duplicate=0 / guessed_assigned_to=0`，
pool 与 status 分布与 §6 对账目标逐项吻合。

---

## 10. R5 Authorization Phrase & Final Human Gate

> 依据：`29-cert-r5-production-authorization-review.md`（CERT-R5-AUTH，2026-10-03）
> STATUS = **AUTHORIZATION REVIEW ONLY**
> PRODUCTION EXECUTION = **NOT AUTHORIZED**（尚未收到显式授权短语）

### 10.1 授权短语（显式、无歧义）

仅当管理员原样提供以下短语（或实质等同的明确授权）方可执行 R5：

> 我明确授权执行 CERT-R5 生产证书号池迁移：允许在维护窗口内对 jhzy-v2-prod
> 应用 0045/0046、导入 450000 legacy id_pools、使用受保护 runner 执行生产写入，
> 并按 runbook 部署 production Worker 与完成验收。

以下**不视为**授权：“继续” / “开始” / “执行下一步” / 任何模糊指令。

### 10.2 授权前人工确认清单（摘要）

> CERT-R5-FINAL-PREFLIGHT（2026-10-03）更新：维护窗口与 HTTP E2E 环境两项已人工确认。

- [x] 维护窗口精确时间（CST）已分配 —— `2026-10-04 02:00–04:00 CST`
- [ ] 负责操作员 / 沟通负责人已指定
- [ ] 写入前证书签发已关闭（CLOSED_FOR_WRITES）
- [ ] 窗口内无管理员/批量签发、无公开可用性声明
- [ ] 回滚沟通预案已备
- [x] HTTP E2E 环境可达 —— 用户 Mac 本机（浏览器 + `curl`）
- [ ] 收到 §10.1 显式授权短语 —— **唯一硬阻塞**

### 10.3 最终人工闸门

未同时满足 §10.2 全部项 + §10.1 显式短语 → 不得执行本 Runbook 任何写入步骤。
R5 命令包（P0–P15）见 `29-cert-r5-production-authorization-review.md` §10，全部为 TEMPLATE ONLY。

## 11. Final Pre-Flight Read-Only Re-Verification (2026-10-03)

> 双锁：`--profile jhzy` + `CLOUDFLARE_ACCOUNT_ID`。全部为只读查询。

| 检查 | 预期 | 实测 | 结果 |
| --- | --- | --- | --- |
| d1_migrations 总数 | 44 | 44 | ✅ |
| 0045 计数 | 0 | 0 | ✅ |
| 0046 计数 | 0 | 0 | ✅ |
| certificates | 413 | 413 | ✅ |
| id_pools | 500 | 500 | ✅ |
| production Worker active version | `e7fcf4a8-f776-44cf-b857-f751924ae2f2` | 同 | ✅ |

**PRODUCTION_PRESTATE_DRIFT = NO**

---

## 12. HARD STOP

```
STATUS = PLANNING ONLY
PRODUCTION EXECUTION = NOT AUTHORIZED

MAINTENANCE_WINDOW_DEFINED = YES          (2026-10-04 02:00–04:00 CST)
HTTP_E2E_ENVIRONMENT_AVAILABLE = YES      (用户 Mac 本机浏览器和终端 curl)
AUTHORIZATION_PHRASE_RECEIVED = NO
PRODUCTION_EXECUTION_AUTHORIZED = NO

READY_FOR_CERT_R5_PRODUCTION_EXECUTION = WAITING_FOR_EXPLICIT_AUTHORIZATION

未获管理员 §10.1 显式授权短语，不得执行本 Runbook 任何步骤。
```
