# CERT-R5 Production Execution Authorization Review

> STATUS = **AUTHORIZATION REVIEW ONLY**
> PRODUCTION EXECUTION = **NOT AUTHORIZED**
>
> 依据：`28-cert-r4-production-migration-readiness.md`（CERT-R4 / R4-RUNNER）
> 与 `certificate-production-pool-migration-runbook.md`（§7b / §9）
>
> 本文件为**授权前审查包**，未经管理员显式授权不得执行 R5 任何步骤。
> 所有写入命令均为 **TEMPLATE ONLY**，本任务未执行任何生产写入。

---

## 0. 当前已接受基线（ACCUMULATED BASELINE）

| 阶段 | 状态 |
| --- | --- |
| CERT-R4 | CLOSED_WITH_FINDINGS |
| CERT-R4-CLOSEOUT | PASS_WITH_FINDINGS |
| CERT-R4-RUNNER | PASS |

| 证据 | 值 |
| --- | --- |
| R3F evidence commit | `91ccbf4` |
| R4 runner commit | `6153b07bdc3248fc7555576ed4569033808fe5b3` |
| R4 runner commit subject | `feat(certificates): add protected legacy pool import runner` |

---

## 1. 权威工作区与 HEAD（Step 2）

| 项 | 值 |
| --- | --- |
| 工作区 | `/Users/Shared/projects/jhzy-v2` |
| branch | `master` |
| HEAD | `6153b07bdc3248fc7555576ed4569033808fe5b3` |
| HEAD subject | `feat(certificates): add protected legacy pool import runner` |
| staged | 0 |
| tracked `.var/` | 0 |
| dirty baseline | 584（均为无关文件：miniprogram/*、docs/production-audit/*、.gitignore 等） |

HEAD 与预期一致，未 reset、未夹带无关文件。

---

## 2. 生产 D1 只读复核（Step 4，双锁）

双锁：`--profile jhzy` + `CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af`
目标：`jhzy-v2-prod` / `d372229f-c0ae-4dcc-b968-4ec7c2832842`

| 检查 | 预期 | 实测 | 结果 |
| --- | --- | --- | --- |
| d1_migrations 总数 | 44 | 44 | ✅ |
| max migration id | 44 | 44 | ✅ |
| 0045 计数 | 0 | 0 | ✅ |
| 0046 计数 | 0 | 0 | ✅ |
| certificates | 413 | 413 | ✅ |
| id_pools | 500 | 500 | ✅ |
| 重复 cert_no 组 | 0 | 0 | ✅ |
| 重复 id_pool code 组 | 0 | 0 | ✅ |
| meta.changed_db | false | false | ✅ |
| meta.rows_written | 0 | 0 | ✅ |

**结论**：生产 prestate 未漂移。R5_AUTH 不因生产漂移阻断。

---

## 3. 生产 Worker 只读复核（Step 5）

| 项 | 值 |
| --- | --- |
| Worker | `jhzy-v2-worker-production`（`--env production`） |
| 当前 active version | `e7fcf4a8-f776-44cf-b857-f751924ae2f2` |
| active 占比 | 100% |
| 部署时间 | 2026-10-02T18:23:27.029Z（deployments list 时间序末条 = 当前活跃） |
| D1 binding | `jhzy-v2-prod` / `d372229f-c0ae-4dcc-b968-4ec7c2832842` |

`wrangler deploy --dry-run --env production` 显示 binding `env.DB (jhzy-v2-prod) D1 Database` + `ENVIRONMENT=production`。
**WORKER_VERSION_DRIFT = NO**（与基线 `e7fcf4a8` 一致）。

---

## 4. 生产快照复核（Step 6）

| 项 | 值 |
| --- | --- |
| 快照目录 | `.var/cert-r4-production-readiness/` |
| run_id | `cert_r4_prod_readiness_20261003T115216Z` |
| dump 文件 | `cert_r4_prod_readiness_20261003T115216Z.sql` |
| 记录 SHA256 | `aa3d2f0631e1f67afe2e9f553149a144fac9dbdf36b172da5e4a059201211182` |
| 实测 SHA256（dump） | `aa3d2f0631e1f67afe2e9f553149a144fac9dbdf36b172da5e4a059201211182` |
| 匹配 | ✅ |

未新建快照（仅复用 CERT-R4 冻结快照）。**SNAPSHOT_VERIFIED = YES**。

---

## 5. Legacy 源离线复核（Step 7）

| 项 | 值 |
| --- | --- |
| 归档 | `/Users/Shared/jhzy-v2-wp4d-authoritative-20260921.tar.gz` |
| 实测 SHA256 | `d51563b0e3149535eb66ff64a3d447a5ad9dfa1cdf26f00b680b4824c4d688bf` |
| 预期 SHA256 | `d51563b0e3149535eb66ff64a3d447a5ad9dfa1cdf26f00b680b4824c4d688bf` |
| 匹配 | ✅ |
| legacy 行数 | 450,000（R4 已离线分类精确吻合基线） |

严禁访问 JHZY 1.0 live；仅用冻结离线归档。**LEGACY_SOURCE_VERIFIED = YES**。

---

## 6. Runner 安全复核（Step 8）

`node workers/tests/cert_r4_runner_production_guard.test.mjs` → **35 pass / 0 fail**。

安全闸门（源码 + 测试双重验证）：

| 闸门 | 状态 |
| --- | --- |
| ACCOUNT_GUARD | YES |
| PRODUCTION_UUID_GUARD | YES |
| DEFAULT_DB_FALLBACK | NO |
| RETRY_BACKOFF | YES |
| RESUME | YES |
| IDEMPOTENCY | YES |
| CONFLICT_FAIL_CLOSED | YES |
| PROVENANCE_CONFLICT_FAIL_CLOSED | YES |
| RAW_CODE_LOGGING | NO |
| PII_LOGGING | NO |
| TWO_STEP_CONFIRMATION | YES（5× `--confirm-*`） |
| PLAN_MODE_NO_WRITE | YES |
| DRY_RUN_NO_WRITE | YES |
| EXECUTE_MODE_DISABLED_WITHOUT_CONFIRMATION | YES |
| SOURCE_SHA_GUARD | YES |
| SOURCE_COUNT_GUARD | YES |
| SOURCE_STATUS_GUARD | YES |
| MIGRATION_PRECONDITION_GUARD | YES |

**RUNNER_SAFETY_VERIFIED = YES**（importer 源级属性见 runbook §7b.1；runner 包装见 §9）。

---

## 7. 回归复核（Step 9）

| 项 | 结果 |
| --- | --- |
| R3D | 79/0 |
| R3B | 63/0 |
| R2 | 57/0 |
| `tsc --noEmit` | PASS（exit 0） |
| `wrangler deploy --dry-run --env production` | PASS（仅构建 + binding，未部署） |

**REGRESSION_VERIFIED = YES**。

---

## 8. 维护窗口清单（Step 10）

> **MAINTENANCE_WINDOW_DEFINED = NO**
> 本任务不虚构具体时间。以下为授权前必须由人工确认的清单模板。

| # | 项 | 人工确认 |
| --- | --- | --- |
| 1 | 精确开始时间（CST） | ☐ |
| 2 | 预计时长 | ☐ |
| 3 | 负责操作员 | ☐ |
| 4 | 沟通负责人 | ☐ |
| 5 | 写入前证书签发已关闭 | ☐ |
| 6 | 窗口内无管理员证书签发 | ☐ |
| 7 | 窗口内无批量签发 | ☐ |
| 8 | 无公开声明声称证书签发可用 | ☐ |
| 9 | 回滚沟通预案 | ☐ |
| 10 | 窗口后验证负责人 | ☐ |

---

## 9. 证书签发关闭计划（Step 11）

生产当前缺 0045/0046 且未导入，本任务不突变。

R5 写入前**必须**先逻辑关闭签发：

```
CERTIFICATE_ISSUANCE_MAINTENANCE_WINDOW = CLOSED_FOR_WRITES
```

范围：
- 无培训签发（training issuance）
- 无活动签发（activity issuance）
- 无服务签发（service issuance）
- 无手动验收签发（manual acceptance issuance）

若当前无运营开关（operational switch），须以人工运营关闭要求记录，并在 R5 执行前确认生效。
本任务不新建开关（除非已规划——当前未规划）。

---

## 10. R5 命令包（Step 12，TEMPLATE ONLY — 不执行）

每个写阶段含 PRECONDITION / COMMAND TEMPLATE / EXPECTED RESULT / ABORT CONDITION。

**P0 最终人工授权短语**
- TEMPLATE：见 §13 授权短语。
- EXPECTED：收到显式短语后进入 P1。
- ABORT：短语缺失/不匹配 → 不继续。

**P1 账户与目标证明**
- PRECONDITION：P0 通过。
- TEMPLATE：
  ```bash
  export CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af
  wrangler d1 execute jhzy-v2-prod --remote -e production --profile jhzy \
    --command "SELECT COUNT(*) FROM d1_migrations"
  ```
- EXPECTED：44（写入前再确认 prestate）。
- ABORT：计数 ≠ 44 或目标/账户守卫失败。

**P2 新鲜只读预检**
- PRECONDITION：P1 通过。
- TEMPLATE：`node workers/scripts/cert-r5-protected-legacy-pool-import-runner.mjs --mode plan ...`
- EXPECTED：plan 报告，不写。
- ABORT：源 SHA / 计数不匹配。

**P3 关闭证书签发窗口**
- PRECONDITION：P2 通过 + 人工确认 CLOSED_FOR_WRITES。
- TEMPLATE：运营开关 / 人工关闭（见 §9）。
- EXPECTED：签发路径不可写。
- ABORT：关闭未生效。

**P4 apply 0045+0046（一同）**
- PRECONDITION：P3 通过。
- TEMPLATE：
  ```bash
  wrangler d1 migrations apply jhzy-v2-prod --remote -e production --profile jhzy
  ```
- EXPECTED：ledger = 46 / 46（0045+0046 同时应用，禁止分批）。
- ABORT：ledger ≠ 46 或仅部分应用。

**P5 schema 验证**
- PRECONDITION：P4 通过。
- TEMPLATE：`PRAGMA table_info(id_pools)` / `PRAGMA table_info(certificates)`
- EXPECTED：id_pools 含 legacy_migrated/provenance/batch_id；certificates 含 cert_kind/issue_source/issued_by/issue_reason/revoked_at/revoked_by/revoke_reason。
- ABORT：缺失列。

**P6 受保护 runner plan/dry-run**
- PRECONDITION：P5 通过。
- TEMPLATE：`--mode plan` / `--mode dry-run`（见 runbook §9.1）。
- EXPECTED：不写；前置就绪报告。
- ABORT：守卫失败。

**P7 受保护 runner execute**
- PRECONDITION：P6 通过 + 5× `--confirm-*` 齐全 + 前置 ready。
- TEMPLATE：见 runbook §9.2。
- EXPECTED：id_pools = 450,500；底层 executor 仅守卫后调用。
- ABORT：任一确认缺失 / 守卫不匹配 / 前置未就绪 → fail-closed 不写。

**P8 对账计数**
- PRECONDITION：P7 通过。
- TEMPLATE：见 runbook §4.1/§4.2。
- EXPECTED：id_pools 450,500；pool_type/provenance 分布精确；certificates 413。
- ABORT：计数偏差。

**P9 对账哈希**
- PRECONDITION：P8 通过。
- TEMPLATE：对导入批次计算 batch_id 哈希并与源 archive 派生计数比对。
- EXPECTED：哈希/计数一致。
- ABORT：不一致。

**P10 selector 检查**
- PRECONDITION：P9 通过。
- TEMPLATE：抽样 code 在 certificates/id_pools 唯一性 + provenance 标记。
- EXPECTED：0 重复。
- ABORT：重复组 > 0。

**P11 生产 Worker 部署（clean worktree）**
- PRECONDITION：P10 通过。
- TEMPLATE：
  ```bash
  git stash  # 确保 clean（仅 R5 相关已提交）
  wrangler deploy --env production --profile jhzy
  ```
- EXPECTED：新版本 active 100%，binding 不变。
- ABORT：部署失败 / binding 变化。

**P12 版本/binding 验证**
- PRECONDITION：P11 通过。
- TEMPLATE：`wrangler deployments list --env production --profile jhzy`
- EXPECTED：新 version active 100%，D1 = jhzy-v2-prod/d372229f。
- ABORT：版本或 binding 异常。

**P13 运行时 HTTP E2E**
- PRECONDITION：P12 通过 + HTTP E2E 环境可达（见 §12）。
- TEMPLATE：对 production endpoint 发验证请求（同源 runtime 测试仅为支持证据，非部署后 E2E 证明）。
- EXPECTED：verify 路由返回预期。
- ABORT：E2E 失败且环境可达。

**P14 重开签发**
- PRECONDITION：P13 通过。
- TEMPLATE：恢复 §9 关闭的签发路径。
- EXPECTED：签发可用。
- ABORT：N/A。

**P15 执行后快照与证据**
- PRECONDITION：P14 通过。
- TEMPLATE：导出 post-exec 快照，记录 commit/version/hash。
- EXPECTED：证据归档。
- ABORT：N/A。

---

## 11. 执行授权短语（Step 13）

R5 执行前管理员必须原样提供以下显式短语（或实质等同的明确授权）：

> **我明确授权执行 CERT-R5 生产证书号池迁移：允许在维护窗口内对 jhzy-v2-prod 应用 0045/0046、导入 450000 legacy id_pools、使用受保护 runner 执行生产写入，并按 runbook 部署 production Worker 与完成验收。**

以下**不视为** R5 授权：
- “继续”
- “开始”
- “执行下一步”
- 任何非上述显式措辞的模糊指令

**AUTHORIZATION_PHRASE_DEFINED = YES**
**AUTHORIZATION_PHRASE_RECEIVED = NO**（本任务未收到）

---

## 12. 回滚 / 恢复审查（Step 14）

- **Worker 回滚可行**：`wrangler versions rollback jhzy-v2-worker-production --version <prev> --profile jhzy`。
- **DB 破坏性回滚非默认策略**：D1 无原生回滚；450k+ 全量 dump 复原不可行。
- 0045/0046 与导入池为**前向兼容状态**。
- 关键约束：
  - `IRREVERSIBLE_CRYPTO_BOUNDARY_CROSSED = YES`
  - `OLD_PRIMARY_SECRET_ROLLBACK = IMPOSSIBLE`
- 若导入部分失败：使用**可恢复（resumable）受保护 runner** 续跑，禁止盲目恢复 DB。
- 若最终对账失败：保持签发关闭（CLOSED_FOR_WRITES）。

---

## 13. HTTP E2E 现实（Step 15）

已知限制：本执行环境可能无法触达 `*.workers.dev`。

> **HTTP_E2E_ENVIRONMENT_AVAILABLE = UNKNOWN**
> R5 部署后 HTTP E2E 须在可触达生产端点的环境执行。
> 本地同源 runtime 测试为支持证据，非部署后生产 E2E 证明。

因该环境状态未知 → `READY_FOR_CERT_R5_PRODUCTION_EXECUTION = NO`。

---

## 14. 公开验证技术债（Step 16）

记录递延债务：

- 匿名公开证书验证路由（public verify route）与当前实现不匹配。
- R5 迁移期间**不修复**，不捆绑路由变更。
- 归入未来独立 WP 处理。

---

## 15. 最终裁定（Step 22/23）

| 闸门 | 结果 |
| --- | --- |
| 生产 prestate 未变 | ✅ |
| 快照有效 | ✅ |
| legacy 源有效 | ✅ |
| runner 安全已验证 | ✅ |
| 回归绿 | ✅ |
| 维护窗口已定义 | ❌（NO，待人工） |
| 签发关闭计划已定义 | ✅（模板，待 R5 执行） |
| HTTP E2E 环境可用 | ❓（UNKNOWN） |
| 授权短语已定义 | ✅ |
| 授权短语已收到 | ❌（NO） |
| runbook 已更新 | ✅（§18） |
| 文档已提交 | ✅（本文件 + runbook，未 push） |
| 生产未变 | ✅ |

**CERT_R5_AUTH_STATUS = PASS_WITH_FINDINGS**

> 所有技术闸门通过；剩余为人工依赖项（维护窗口时间、HTTP E2E 环境、显式授权短语）。
> 因此 `READY_FOR_CERT_R5_PRODUCTION_EXECUTION = NO`，`PRODUCTION_EXECUTION_AUTHORIZED = NO`。

---

## 16. 非突变确认（Step 21）

本任务仅执行只读查询与文档撰写，未执行任何生产写入：
- 未 apply 0045/0046
- 未导入 450k
- 未 deploy 生产 Worker
- 未变更 secret / RBAC
- 未签发证书
- 未 push Git
- 未触达 JHZY 1.0 live

**NEXT_ACTION = STOP. Await explicit human authorization.**
