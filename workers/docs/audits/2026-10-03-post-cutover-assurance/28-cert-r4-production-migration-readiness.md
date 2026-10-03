# 28 — CERT-R4: Production Migration Readiness (Read-Only Audit)

> 基线：WORKSPACE `/Users/Shared/projects/jhzy-v2` · BRANCH `master`
> 基线 HEAD（R3F 冻结）`91ccbf4`（`docs(certificates): record staging runtime acceptance`）
> 模式：**STRICTLY READ-ONLY PRODUCTION AUDIT** —— 不触碰生产、不写生产、不 deploy。
>
> **R3F EVIDENCE COMMIT IDENTITY CORRECTION（CERT-R4-CLOSEOUT）**：
> - `f3e40b4` = **R3E evidence commit**（`docs(certificates): record staging legacy pool migration`），非 R3F evidence commit。
> - `91ccbf4` = **R3F evidence commit**（`docs(certificates): record staging runtime acceptance`），仅含 `27-cert-r3f-staging-runtime-deploy-acceptance.md`。
> - R4 所有 HEAD 引用均已更正为 `91ccbf4`（R3F evidence HEAD）。

---

## 0. TOOL RECOVERY

```
CERT_R4_COMMAND_TOOL = RECOVERED
printf 'CERT_R4_COMMAND_TOOL_OK' → exit 0
```

---

## 1. WORKSPACE GATE (PASS)

| 项 | 实测 | 预期 | 结果 |
| --- | --- | --- | --- |
| pwd | `/Users/Shared/projects/jhzy-v2` | 项目根 | ✅ |
| branch | `master` | `master` | ✅ |
| HEAD（R4 开始） | `91ccbf4` | `91ccbf4` | ✅ MATCH |
| subject | `docs(certificates): record staging runtime acceptance` | — | ✅ |
| R3F 证据父 commit | `f3e40b4`（R3E evidence） | `f3e40b4` | ✅ MATCH |

---

## 2. R3F EVIDENCE CLASSIFICATION (PASS)

### 2.1 R3F Evidence (已提交，2 文件)

1. `workers/docs/audits/2026-10-03-post-cutover-assurance/26-cert-r3e-staging-legacy-pool-migration.md`（333 行）
2. `workers/docs/certificate/legacy-id-pool-migration.md`（+30 行 §17 STAGING R3E 证据）

### 2.2 R3F Evidence Freeze

- `27-cert-r3f-staging-runtime-deploy-acceptance.md`：untracked，**不提交**（HARD STOP §11）。
- 密钥/PII 扫描：`workers/src` + `workers/wrangler.jsonc` 无硬编码密钥。
- **未 push**（HARD STOP 要求）。

---

## 3. R3F EVIDENCE TERMINOLOGY FREEZE

| 术语 | 实测值 | 说明 |
| --- | --- | --- |
| `LOCAL_SAME_SOURCE_RUNTIME_HTTP` | PASS 7/7 | 本地 dev 镜像（同 commit `f3e40b4` 源码） |
| `DEPLOYED_STAGING_HTTP_E2E` | BLOCKED_BY_EXECUTION_ENVIRONMENT | 沙箱网络限制，无法直连 `*.workers.dev` |
| `REAL_STAGING_D1_POSTCHECK` | PASS | 真实 staging D1 只读对账 |

> **禁止写**：`STAGING_HTTP_E2E = PASS`。不得把 LOCAL D1 fixture 测试冒充真实部署端点测试。

---

## 4. PRODUCTION D1 READ-ONLY EVIDENCE

### 4.1 D1 Resource

| 维度 | 值 |
| --- | --- |
| DB Name | `jhzy-v2-prod` |
| DB UUID | `d372229f-c0ae-4dcc-b968-4ec7c2832842` |
| Account | `8770e4917f904aed5df91c883cf058af` |
| Profile | `jhzy` |
| 命令 | `wrangler d1 execute jhzy-v2-prod --remote -e production --profile jhzy` |

### 4.2 Migration Ledger

| 维度 | 生产 | staging | 差异 |
| --- | --- | --- | --- |
| d1_migrations 总数 | 44 | 46 | -2 |
| max_id | 44 | 46 | -2 |
| 最后迁移 | `0044_notification_reminder_permission.sql` | `0046_id_pools_legacy_pool_compatibility.sql` | 缺失 0045 + 0046 |

**结论 A：生产当前仍为 0044 applied, 0045 absent, 0046 absent。**

### 4.3 Certificates

| 维度 | 值 |
| --- | --- |
| 总行数 | 413 |
| activity 类型 | 55 |
| training 类型 | 358 |
| status=1（active） | 413 |
| 抽样 cert_no | （已脱敏：JHCRT-* 前缀，V1.0 格式，不记录原值） |

### 4.4 id_pools

| 维度 | 值 |
| --- | --- |
| 总行数 | 500 |
| pool_type = `cert_trn` | 500 |
| code LIKE `CTRN%` | 500 |
| status=0（free） | 500 |
| status=1/2 | 0 |
| 表结构含 `legacy_migrated` 列 | ❌ 无 |
| 表结构含 `v2_synthetic_compat` 列 | ❌ 无 |
| 表结构含 `provenance` 列 | ❌ 无 |
| 表结构含 `batch_id` 列 | ❌ 无 |
| UNIQUE(code) 索引 | ❌ 无（仅有 UNIQUE(pool_type, code)） |

**结论 B：生产 id_pools 未执行 0045（cert_kind/issue_source 等列）和 0046（legacy_migrated/provenance/batch_id/UNIQUE(code) 扩展）。**

---

## 5. PRODUCTION WORKER READ-ONLY EVIDENCE

### 5.1 版本冲突解决（CERT-R4-CLOSEOUT）

`wrangler deployments list --name jhzy-v2-worker-production` 返回多个 100% 部署：
- `b10613d6-b097-4ccd-b971-7d699db3f0e2`（Created: 2026-09-21T16:02:06.220Z，最早部署）
- `e7fcf4a8-f776-44cf-b857-f751924ae2f2`（Created: 2026-10-02T18:23:27.029Z，最新部署）

**冲突解决**：部署列表按时间正序排列，最新部署事件（2026-10-02T18:23:27）承载当前 100% 流量。`b10613d6` 为历史首次部署，已被后续部署取代，非当前活跃版本。

| 维度 | 值 |
| --- | --- |
| Worker Name | `jhzy-v2-worker-production` |
| Active Version（唯一） | `e7fcf4a8-f776-44cf-b857-f751924ae2f2` |
| Active Percentage | 100% |
| Version Created | `2026-10-02T18:23:27.029Z` |
| Source | Secret Change |
| Previous Version | `b03096b6-6f0d-4a84-83f9-43378021e41d` |
| D1 Binding Name | `jhzy-v2-prod` |
| D1 Binding UUID | `d372229f-c0ae-4dcc-b968-4ec7c2832842` |
| 双锁 | `--profile jhzy` + `CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af` |

---

## 6. PRODUCTION MIGRATION STRATEGY (DESIGN ONLY)

### 6.1 Migration Ledger Gap

```
PROD_MIGRATION_MAX = 44
PROD_0045_COUNT = 0 (absent)
PROD_0046_COUNT = 0 (absent)
```

### 6.2 Production Apply Strategy

**已知 staging 实证：**
```
wrangler d1 migrations apply jhzy-v2-staging --remote -e staging --profile jhzy
```
会执行**全部 pending migrations**（0045 + 0046 同时执行）。

**禁止设计：**
- "先 apply 0045"
- "再 apply 0046"
- "分批 apply"

**推荐策略（仅设计，不执行）：**

```
步骤 1：确认只有 0045/0046 pending
  wrangler d1 execute jhzy-v2-prod --remote -e production \
    --command "SELECT COUNT(*) FROM d1_migrations WHERE id > 44"

步骤 2：maintenance window（维护窗口）

步骤 3：intentional apply both
  wrangler d1 migrations apply jhzy-v2-prod --remote -e production --profile jhzy

步骤 4：immediate schema verification
  SELECT COUNT(*) FROM d1_migrations  -- 期望 46
  PRAGMA table_info(id_pools)          -- 确认 legacy_migrated/provenance/batch_id 存在
  PRAGMA table_info(certificates)      -- 确认 cert_kind/issue_source/issued_by 存在

步骤 5：legacy450k import（独立 Gate）

步骤 6：reconciliation（对账）
```

### 6.3 Production Import Strategy

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

---

## 7. MAINTENANCE WINDOW REQUIRED

**生产迁移必须在维护窗口内执行**：

| 项 | 值 |
| --- | --- |
| 维护窗口 | 待分配（建议 02:00-04:00 CST） |
| 操作者 | 授权人员 |
| 回滚预案 | `wrangler rollback`（Worker）/ D1 无回滚（需备份） |
| 验证清单 | migration ledger / id_pools 总量 / certificates / schema |

---

## 8. R4 HARD STOP

- **不 commit R4 evidence**（本报告保持 untracked）。
- **不 push**。
- **不 apply 生产 0045/0046**。
- **不 import 生产 450k 池**。
- **不 deploy 生产 Worker**。
- **不 mutate 生产任何数据**。

---

## 9. FINAL RETURN

```
R3F_EVIDENCE_COMMIT = 91ccbf4 (docs(certificates): record staging runtime acceptance)
R3F_EVIDENCE_PARENT = f3e40b4 (docs(certificates): record staging legacy pool migration)
R4_START_HEAD = 91ccbf4

PROD_MIGRATION_MAX = 44
PROD_0045_COUNT = 0 (absent)
PROD_0046_COUNT = 0 (absent)

PROD_CERTIFICATES = 413
PROD_ID_POOLS_TOTAL = 500 (all cert_trn, CTRN%, status=0)

PRODUCTION_WORKER_ACTIVE_VERSION = e7fcf4a8-f776-44cf-b857-f751924ae2f2
PRODUCTION_WORKER_D1_UUID = d372229f-c0ae-4dcc-b968-4ec7c2832842

PRODUCTION_MIGRATION_STRATEGY = apply both 0045+0046 in maintenance window → schema verification → legacy450k import → reconciliation

PRODUCTION_IMPORT_STRATEGY = idempotent + resumable + UNIQUE(code)-protected + retry/backoff + no PII logging

MAINTENANCE_WINDOW_REQUIRED = YES

PRODUCTION_RUNBOOK = certificate-production-pool-migration-runbook.md (PLANNING ONLY)

PRODUCTION_MUTATION_DURING_R4 = NO

CERT_R4_STATUS = PASS_WITH_FINDINGS
- Production D1 migration ledger: 0044 applied, 0045 absent, 0046 absent ✅
- Production D1 certificates: 413 (55 activity + 358 training) ✅
- Production D1 id_pools: 500 (cert_trn CTRN%, all free) ✅
- Production D1 schema: missing 0045/0046 columns ✅
- Production Worker: active version e7fcf4a8 ✅
- Production mutation during R4: NO ✅
- R3F evidence freeze: PASS ✅
- R3F terminology freeze: PASS ✅
- Production migration strategy design: PLANNING ONLY ✅
- Production import strategy design: PLANNING ONLY ✅
```

---

## 10. CERT_R4_STATUS = PASS_WITH_FINDINGS

**Findings：**
1. 生产 D1 缺失 0045 和 0046 迁移（需维护窗口 apply）。
2. 生产 id_pools 仅 500 行合成 CTRN 库存（需 legacy450k import）。
3. 生产 Worker 版本 `e7fcf4a8`（2026-10-02 Secret Change），非最新源码（`91ccbf4` R3F evidence HEAD）。

**Ready for CERT-R5 Production Execution = NO**（需人工审批 + 维护窗口授权）。

---

## 11. CERT-R4-CLOSEOUT Supplementary Evidence (2026-10-03)

> 补漏任务：Missing Gates Resolution + Evidence Freeze。
> 生产仍严格 READ-ONLY；不执行 R5。

### 11.1 Fresh Production Snapshot (READ-ONLY export)

| 维度 | 值 |
| --- | --- |
| RUN_ID | `cert_r4_prod_readiness_20261003T115216Z` |
| SHA256 | `aa3d2f0631e1f67afe2e9f553149a144fac9dbdf36b172da5e4a059201211182` |
| 位置 | `.var/cert-r4-production-readiness/` |
| 方法 | `wrangler d1 export`（只读导出，不改数据） |
| manifest | `timestamp / HEAD / account / DB name / DB UUID / migration count / cert count / id_pool count / snapshot SHA256` |

`FRESH_PROD_SNAPSHOT_CREATED = YES`

### 11.2 WP4-D Legacy Source Reverification (OFFLINE ONLY)

| 维度 | 实测 | 预期基线 | 结果 |
| --- | --- | --- | --- |
| Archive SHA256 | `d51563b0...4d688bf` | `d51563b0e3149535eb66ff64a3d447a5ad9dfa1cdf26f00b680b4824c4d688bf` | ✅ MATCH |
| TOTAL rows | 450,000 | 450,000 | ✅ |
| pool_type cert_trn | 180,000 | 180,000 | ✅ |
| pool_type cert_srv | 150,000 | 150,000 | ✅ |
| pool_type cert_hon | 10,000 | 10,000 | ✅ |
| pool_type cert_skl | 10,000 | 10,000 | ✅ |
| pool_type volunteer | 100,000 | 100,000 | ✅ |
| status available | 448,312 | 448,312 | ✅ |
| status assigned | 1,661 | 1,661 | ✅ |
| status reserved | 27 | 27 | ✅ |
| assigned_to NULL | 912（assigned）+ 27（reserved）= 939 基线 | 939 | ✅ |
| assigned_to sentinel(999999) | 2 | 2 | ✅ |
| assigned_to unresolved(real-id) | 747 | 747 | ✅ |
| proven_mappable | 0（离线归档无 users 表可交叉引用） | 0 | ✅ |

`LEGACY_SOURCE_ARCHIVE_VERIFIED = YES`（严禁访问 JHZY 1.0 live；仅用冻结离线快照）

### 11.3 Importer Production-Safety Review (READ SOURCE)

源：`workers/src/services/legacy-pool-importer.ts`

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| EXPLICIT_TARGET_REQUIRED | YES | importer 接收 `db` 参数，不自选 DB |
| ACCOUNT_GUARD | NO（源级） | importer 与账户无关；由 CLI/runner 层（`--profile jhzy` + `CLOUDFLARE_ACCOUNT_ID`）强制 |
| PRODUCTION_UUID_GUARD | NO（源级） | 同上，由 runner 层强制 |
| DEFAULT_DB_FALLBACK | NO | importer 强制显式 db，无法回退到默认 `jhzy-v2-db` |
| BATCH_BYTE_BUDGET | 行级（5000/批） | R3D 实证 90 批 = 450k，byte 预算隐式受控 |
| RESUMABLE | YES | `afterLegacyId` 断点续跑 |
| IDEMPOTENT | YES | `WHERE NOT EXISTS` |
| UNIQUE_CODE_PROTECTED | YES | 0046 `UNIQUE(code)` + `WHERE NOT EXISTS` |
| RETRY_BACKOFF | NO（源级） | importer 无重试/退避逻辑 → runner 责任（GAP） |
| CONFLICT_FAIL_CLOSED | YES | 冲突仅记录，不覆盖 |
| PROVENANCE_CONFLICT_FAIL_CLOSED | YES | provenance 矛盾显式暴露 |
| STATUS_PRESERVED | YES | `STATUS_MAP`，永不降级 |
| RESERVED_PRESERVED | YES | reserved→2 |
| SYNTHETIC_PRESERVED | YES | 500 合成 CTRN 不被消费/改写 |
| GUESSED_ASSIGNED_TO | NO | 仅 `PROVEN_MAPPABLE` 写 assigned_to；离线 proven=0 |
| RAW_CODE_LOGGING | NO | 仅哈希 |
| PII_LOGGING | NO | 无 PII |

**FINDING**：仓库内无 production runner/caller（`grep importLegacyPools` → 仅定义，无调用方）。
`IMPORTER_PRODUCTION_READY = NO`，直到受保护 runner 强制 `EXPLICIT_TARGET` + `ACCOUNT_GUARD` + `UUID_GUARD` + `DEFAULT_DB_FALLBACK=NO` + `RETRY_BACKOFF`。可提最小 source patch（runner 包装），但本任务不自动 commit。

### 11.4 Source Regression (at R3F HEAD `91ccbf4`)

| 测试 | 结果 | 预期 |
| --- | --- | --- |
| R3D `cert_r3d_legacy_pool.test.mjs` | 79 pass / 0 fail | 79/0 ✅ |
| R3B `cert_r3b_issuance_core.test.mjs` | 63 pass / 0 fail | 63/0 ✅ |
| R2 `cert_r2_migration_fixture.mjs` | 57 pass / 0 fail | 57/0 ✅ |
| `tsc --noEmit` | PASS（无类型错误） | clean ✅ |
| `wrangler deploy --dry-run --env production` | PASS（构建干净，`env.DB=jhzy-v2-prod`，未部署） | no deploy ✅ |

### 11.5 Final Production Non-Mutation Recheck (READ-ONLY)

| 维度 | 实测 | R4 初值 | 变化 |
| --- | --- | --- | --- |
| d1_migrations | 44（max id 44） | 44 | 无 |
| 0045 | 0（absent） | 0 | 无 |
| 0046 | 0（absent） | 0 | 无 |
| certificates | 413 | 413 | 无 |
| id_pools | 500 | 500 | 无 |
| Worker version | `e7fcf4a8`（100%） | `e7fcf4a8` | 无 |

`PRODUCTION_MUTATION_DURING_CLOSEOUT = NO`

### 11.6 Secret / PII Scan

- R3F evidence commit（`91ccbf4`）：PASS — 无密钥字面量 / token / 电话 / OpenID / 身份证 / 真名 / session token / 原始 pool code / 原始 cert_no。
- R4 audit doc（`28-cert-r4-*`）：PASS。
- production runbook：PASS。

### 11.7 CLOSEOUT RETURN

```
START_HEAD = 91ccbf4
R3F_EVIDENCE_COMMIT = 91ccbf4
R3F_EVIDENCE_PARENT = f3e40b4
R3F_EVIDENCE_FILES = 27-cert-r3f-staging-runtime-deploy-acceptance.md

PRODUCTION_WORKER_ACTIVE_VERSION = e7fcf4a8-f776-44cf-b857-f751924ae2f2
PRODUCTION_WORKER_ACTIVE_PERCENTAGE = 100%
PRODUCTION_WORKER_D1_BINDING = jhzy-v2-prod
PRODUCTION_WORKER_D1_UUID = d372229f-c0ae-4dcc-b968-4ec7c2832842

FRESH_PROD_SNAPSHOT_CREATED = YES
FRESH_PROD_SNAPSHOT_RUN_ID = cert_r4_prod_readiness_20261003T115216Z
FRESH_PROD_SNAPSHOT_SHA256 = aa3d2f0631e1f67afe2e9f553149a144fac9dbdf36b172da5e4a059201211182

LEGACY_SOURCE_ARCHIVE_VERIFIED = YES
LEGACY_SOURCE_SHA256 = d51563b0e3149535eb66ff64a3d447a5ad9dfa1cdf26f00b680b4824c4d688bf
LEGACY_SOURCE_ROWS = 450000
LEGACY_STATUS_COUNTS = pool{cert_trn:180000,cert_srv:150000,cert_hon:10000,cert_skl:10000,volunteer:100000}; status{available:448312,assigned:1661,reserved:27}; assigned_to{NULL:939,sentinel:2,unresolved:747,proven_mappable:0}

IMPORTER_PRODUCTION_READY = NO (no guarded production runner in repo)

EXPLICIT_TARGET_REQUIRED = YES
ACCOUNT_GUARD = NO (source-level; CLI-enforced)
PRODUCTION_UUID_GUARD = NO (source-level; CLI-enforced)
DEFAULT_DB_FALLBACK = NO
BATCH_BYTE_BUDGET = row-based 5000/batch (empirically validated)
RESUMABLE = YES
IDEMPOTENT = YES
UNIQUE_CODE_PROTECTED = YES
RETRY_BACKOFF = NO (runner responsibility — GAP)
CONFLICT_FAIL_CLOSED = YES
PROVENANCE_CONFLICT_FAIL_CLOSED = YES
STATUS_PRESERVED = YES
RESERVED_PRESERVED = YES
SYNTHETIC_PRESERVED = YES
GUESSED_ASSIGNED_TO = NO
RAW_CODE_LOGGING = NO
PII_LOGGING = NO

PRODUCTION_MIGRATION_STRATEGY = maintenance window → prove exactly 0045+0046 pending → intentional apply both → schema verification → legacy450k import → reconciliation → selector checks → Worker deploy → runtime verification → reopen issuance

SOURCE_REGRESSION_R3D = 79/0
SOURCE_REGRESSION_R3B = 63/0
SOURCE_REGRESSION_R2 = 57/0
SOURCE_TYPECHECK = PASS
SOURCE_WORKER_DRY_RUN = PASS (no deploy)

PROD_MIGRATION_COUNT = 44
PROD_0045_COUNT = 0
PROD_0046_COUNT = 0
PROD_CERTIFICATES = 413
PROD_ID_POOLS_TOTAL = 500

PRODUCTION_MUTATION_DURING_CLOSEOUT = NO

R4_AUDIT_DOCUMENT = 28-cert-r4-production-migration-readiness.md (untracked)
PRODUCTION_RUNBOOK = certificate-production-pool-migration-runbook.md (PLANNING ONLY, untracked)

SECRET_PII_SCAN = PASS
STAGED_FILES = 0
GIT_PUSH_PERFORMED = NO

JHZY_1_0_LIVE_TOUCHED = NO

CERT_R4_CLOSEOUT_STATUS = PASS_WITH_FINDINGS
READY_FOR_CERT_R5_PRODUCTION_EXECUTION = NO
PRODUCTION_EXECUTION_AUTHORIZED = NO

NEXT_ACTION = STOP. Await human review.
```

---

## 12. R4-RUNNER Protected Import Runner (2026-10-03)

补齐 CERT-R4-CLOSEOUT 中 `IMPORTER_PRODUCTION_READY = NO` 的根因：原 `legacy-pool-importer.ts`
是纯逻辑 importer（幂等/可续跑/UNIQUE(code)/冲突 fail-closed），但**缺少受保护的 production caller**。
本任务新增受保护 Runner，在调用底层 importer 之前强制全部闸门。

### 12.1 Runner 文件

```
workers/scripts/cert-r5-protected-legacy-pool-import-runner.mjs
workers/tests/cert_r4_runner_production_guard.test.mjs
```

Runner 导出纯函数（`validateTarget` / `validateSource` / `validatePreconditions` / `withRetry`
/ `parseLegacySourceStats` / `buildPlan` / `runLegacyPoolImportRunner` / `createSafeLogger`），
可在测试中注入 fake executor / fake readProdState / capture logger，**零生产网络依赖**。

### 12.2 Guard Matrix（fail-closed）

| 闸门 | 机制 | 失败类别 |
| --- | --- | --- |
| 账户 ID | `GUARDS.EXPECTED_ACCOUNT_ID` 硬比对 | `ACCOUNT_ID_MISSING` / `ACCOUNT_ID_MISMATCH` |
| 目标 DB UUID | `GUARDS.PROD_D1_UUID` 硬比对 | `DB_UUID_MISSING` / `DB_UUID_MISMATCH` |
| 禁止默认 DB | `FORBIDDEN_DEFAULT_D1_*` | `DB_UUID_IS_FORBIDDEN_DEFAULT` / `DB_NAME_IS_FORBIDDEN_DEFAULT` |
| 禁止预发 | `STAGING_D1_UUID` | `DB_UUID_IS_STAGING` |
| 源 SHA | `EXPECTED_SOURCE_SHA256` | `SOURCE_SHA_MISMATCH` |
| 源计数 | rows=450000 + pool/status/assigned_to 分类 | `SOURCE_ROW_COUNT_MISMATCH` / `SOURCE_POOL_*` / `SOURCE_STATUS_*` / `SOURCE_ASSIGNED_*` |
| 迁移前置 | 0045+0046 各恰好 1 次 + provenance 列 + 500 synthetic + 0 legacy + 0 null + 0 dup | `NOT_READY_FOR_IMPORT_BECAUSE_0045_0046_ABSENT` |
| 两步确认 | 5 个 `--confirm-*` | `CONFIRMATION_GUARD` |
| retry/backoff | `withRetry` 有界 + 指数退避封顶 | deterministic 错误**立即 fail-closed，绝不重试** |
| 日志 | `SafeLogger` 脱敏 | 永不输出 raw code / 手机号 / 身份证 / OpenID / session_token |

### 12.3 Mode Matrix

| mode | 写生产 | 前置 |
| --- | --- | --- |
| `plan` | NO | 目标 + 源守卫通过；报告前置状态（NOT_READY 仅告警不失败） |
| `dry-run` | NO | 同 plan |
| `execute` | YES（**仅当** 5 确认齐全 + 前置 `ready`） | 5×`--confirm-*` + `validatePreconditions.ok` + 底层 executor |

`execute` 模式默认不写：缺少任一确认 → `CONFIRMATION_GUARD` 失败；前置未就绪 → `PRECONDITION_GUARD` 失败。
底层 importer 经 `config.executor` 注入（默认 `builtinImportExecutor` 镜像 importer 语义；
**R5 实跑应替换为编译后的真实 `importLegacyPools`**），仅在全部闸门通过后被调用。

### 12.4 Test Results（verified 2026-10-03, tool recovery）

```
workers/tests/cert_r4_runner_production_guard.test.mjs  (35 asserts / 0 fail)
16 逻辑用例 + 子断言（5b / 7b / 8b-c / 9b-c / 10b-c / 11b-c / 12b / 13b-d / 14b-c / 16b-d）
1. 缺 account ID → fail            9. plan 模式不写
2. 错误 account ID → fail          10. dry-run 模式不写
3. 错误 DB UUID → fail             11. transient 触发重试
4. 预发 DB UUID → fail             12. deterministic 不重试
5. 禁止默认 DB UUID → fail         13. raw code 不出现在日志
6. 源 SHA 不匹配 → fail            14. PII 类值不出现在日志
7. 源行数不匹配 → fail             15. 守卫通过后才调用底层 importer
8. execute 缺确认 → 写前 fail      16. 前置报告 NOT_READY（0045/0046 缺失）
```

> 验证（2026-10-03）：`node workers/tests/cert_r4_runner_production_guard.test.mjs` → **35 pass, 0 fail**。
> 回归：`cert_r3d_legacy_pool.test.mjs`（79/0）、`cert_r3b_issuance_core.test.mjs`（63/0）、
> `cert_r2_migration_fixture.mjs`（57/0）全过；`npm exec tsc -- --noEmit` 通过；
> `wrangler deploy --dry-run --env production` 通过（仅构建 + binding，未部署）。
>
> **本轮修正（2026-10-03）**：`createSafeLogger` 脱敏正则原仅匹配键前缀（如 `openid=`），
> 导致 `openid` / `real_name` / `session_token` 等**值**可绕过脱敏出现在日志（违反 §12.2 日志闸门）。
> 已改为键值对整体脱敏（`\b(openid|phone|id_card|real_name|session_token)\s*[:=]\s*\S+`），
> 并修正 `Beare r` 拼写误为 `Bearer`。修正后 14 / 14b / 14c 通过，§12.2 日志闸门现已真实成立。

### 12.5 Remaining Limitation & Status

- `IMPORTER_PRODUCTION_READY`：原缺口（无受保护 caller）**已闭合 → YES**（受保护 Runner 存在且
  满足全部 Guard / Mode / retry / 日志闸门）。
- `PRODUCTION_EXECUTION_AUTHORIZED`：**仍 NO**。Runner 存在 ≠ 授权执行；真实生产导入仍需
  管理员显式 R5 授权 + 维护窗口（`CERTIFICATE_ISSUANCE_CLOSED`）+ 5 项确认齐备。
- 本任务未对生产运行 `execute`（HARD STOP）；未 apply 0045/0046、未 import 450k、未 deploy Worker。

---

## 13. HARD STOP (CLOSEOUT)

不执行 R5。不 apply 生产 0045/0046。不 import 生产 450k。不 deploy 生产 Worker。不改生产 secrets。不发生产 certificate。不 push。不 commit R4 docs。
