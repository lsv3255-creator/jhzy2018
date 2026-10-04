# CERT-R5: Production Certificate Pool Migration Execution

> **CERT_R5_STATUS = BLOCKED**
> PRODUCTION EXECUTION = **PARTIALLY EXECUTED, STOPPED AT P6/P7 GATE**
> CERTIFICATE ISSUANCE = **REMAINS CLOSED**
>
> 本文件为执行证据记录。生产 D1 已发生部分变更（0045 + 0046 已应用），
> legacy 450k 导入**未执行**（执行路径未组装，见 §7）。
> 本文件**未提交 Git**（未经人工复核）。
>
> **后续**：根因已由 CERT-R5A 修复，见
> `32-cert-r5a-import-runner-wiring.md`（wiring 完成 + 本地全量模拟通过）。
> R5A 同样**未执行**生产导入；生产仍为下述中间态。
>
> **CERT-R5A-CLOSEOUT 补充（2026-10-04）**：导入执行路径根因已修复（见 `32-cert-r5a-import-runner-wiring.md` §7）；`LEGACY_DATETIME_POLICY` 已冻结为 **Asia/Shanghai / CST(+08:00)**；本地测试全绿（R5A 51/0 + R4/R3D/R3B/R2）、PII/Secret 扫描 clean；**生产只读环境证明**为最后一项运行验证门，需在 TTY 或 `CLOUDFLARE_API_TOKEN` 下运行 `cert-r5b-prod-readiness-probe.mjs`（零写入）。本文件仍为 BLOCKED 执行记录，未改变。

---

## 0. 授权记录（P0）

| 项 | 值 |
| --- | --- |
| 授权短语 | 已收到，**逐字匹配** `29-*.md` §11 / runbook §10.1 |
| 授权短语原文 | 我明确授权执行 CERT-R5 生产证书号池迁移：允许在维护窗口内对 jhzy-v2-prod 应用 0045/0046、导入 450000 legacy id_pools、使用受保护 runner 执行生产写入，并按 runbook 部署 production Worker 与完成验收。 |
| AUTHORIZATION_RECEIVED | YES |
| 维护窗口（原声明） | 2026-10-04 02:00–04:00 CST |
| 维护窗口（实际生效） | **2026-10-04 00:15–04:00 CST** |
| 窗口变更授权 | 管理员于 CST 00:12 明确选择「立即继续，改写窗口」 |
| 窗口变更理由 | 00:00–02:00 CST 对该国内志愿服务类应用实际流量**低于** 02:00–04:00 CST；提前开始风险不升反降。硬截止 04:00 CST 不变。 |
| Operator | 管理员（单人） |
| Reviewer | 管理员（单人，逐阶段打卡） |
| Communicator | 管理员（单人） |
| 执行开始（UTC / CST） | `2026-10-03T16:12:52Z` / `2026-10-04 00:12:52 CST` |
| START_HEAD / AUTHORIZED_HEAD | `01e1effb89b756a30410d8c647420d2b01a86360` |
| branch | `master` |
| staged / tracked `.var` | 0 / 0 |

---

## 1. 目标与环境（P1）

| 项 | 实测 | 结果 |
| --- | --- | --- |
| Cloudflare profile | `jhzy` | ✅ |
| Cloudflare account | `8770e4917f904aed5df91c883cf058af` | ✅ |
| DB name | `jhzy-v2-prod` | ✅ |
| DB UUID | `d372229f-c0ae-4dcc-b968-4ec7c2832842` | ✅ |
| D1 list 中存在目标 | 是 | ✅ |
| 未指向 staging `jhzy-v2-staging` (`85853fb1…`) | 确认 | ✅ |
| 未指向禁用默认库 `jhzy-v2-db` (`ea603f43…`) | 确认 | ✅ |
| 生产 Worker | `jhzy-v2-worker-production` 存在 | ✅ |
| OLD_WORKER_VERSION | `e7fcf4a8-f776-44cf-b857-f751924ae2f2`（100%） | ✅ |

全部 Cloudflare / Wrangler 命令均使用双锁：`--profile jhzy` + `CLOUDFLARE_ACCOUNT_ID`。

---

## 2. P2 — 执行前只读预检与快照

| 检查 | 预期 | 实测 | 结果 |
| --- | --- | --- | --- |
| d1_migrations count | 44 | 44 | ✅ |
| max migration id | 44 | 44 | ✅ |
| 0045 count | 0 | 0 | ✅ |
| 0046 count | 0 | 0 | ✅ |
| certificates | 413 | 413 | ✅ |
| id_pools | 500 | 500 | ✅ |
| duplicate cert_no groups | 0 | 0 | ✅ |
| duplicate id_pool code groups | 0 | 0 | ✅ |

全部查询 `changed_db=false`、`rows_written=0`。

**PRE_SNAPSHOT_RUN_ID** = `cert_r5_prod_pre_20261003T170017Z`
**PRE_SNAPSHOT_SHA256** = `aa3d2f0631e1f67afe2e9f553149a144fac9dbdf36b172da5e4a059201211182`
存储：`.var/cert-r5-production-execution/`（gitignored）。

> **重要证据**：pre 快照 SHA256 **与 CERT-R4 冻结快照（2026-10-03T11:52:16Z）逐字节一致** ——
> 证明自 R4 冻结以来生产 D1 零漂移。

---

## 3. P3 — 关闭证书签发窗口

`CERTIFICATE_ISSUANCE_MAINTENANCE_WINDOW = CLOSED_FOR_WRITES`

已确认无：培训签发 / 活动签发 / 服务签发 / 手动验收签发 / 管理员测试签发 / 批量签发 / 对外可用性声明。

源码复核（只读）：`workers/src/routes/certificates.ts` 注册路由仅为
`GET /mine`、`GET /verify`、`GET|POST|PUT /admin/templates`、`GET /admin`、`GET /:certificatePublicId`
—— **无任何运行时发证 POST 路由**；`CertificateIssuanceService` 仅定义，未被任何 route 调用。
模板写路由（POST/PUT `/admin/templates`）窗口期冻结；`GET /verify` 保持开放（HTTP E2E 依赖）。

---

## 4. P4 — 应用 0045 + 0046（生产写入 #1）

**Pending 证明**：本地迁移文件共 46 个，末位为 `0046_id_pools_legacy_pool_compatibility.sql`，无 > 0046 的文件；生产 ledger max = 44 → pending **恰好** `{0045, 0046}`，无其他待迁移。

```bash
CI=1 CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af \
  wrangler d1 migrations apply jhzy-v2-prod --remote -e production --profile jhzy
```

| 校验 | 预期 | 实测 | 结果 |
| --- | --- | --- | --- |
| d1_migrations count | 46 | 46 | ✅ |
| max migration id | 46 | 46 | ✅ |
| 0045 count | 1 | 1 | ✅ |
| 0046 count | 1 | 1 | ✅ |

0045 + 0046 **一次性同时应用**，未分批。wrangler 在非交互模式下自动捕获备份。

---

## 5. P5 — 模式校验

| 检查 | 预期 | 实测 | 结果 |
| --- | --- | --- | --- |
| certificates 0045 列数（7 列） | 7 | 7 | ✅ |
| `uq_cert_user_source` 唯一索引 | 存在 | 1 | ✅ |
| certificate_logs 新列（batch_id/result/failure_code） | 3 | 3 | ✅ |
| certificate_batches 表存在 | 存在 | 17 列 | ✅ |
| id_pools 0046 列（batch_id/provenance） | 2 | 2 | ✅ |
| id_pools 全局 `UNIQUE(code)` | 存在 | 1 | ✅ |
| id_pools DDL 含 `cert_skl` | 是 | 是 | ✅ |
| `CHECK(status IN …)` 三态保留 | 是 | 是 | ✅ |
| id_pools 总数 | 500 | 500 | ✅ |
| v2_synthetic_compat | 500 | 500 | ✅ |
| legacy_migrated（导入前） | 0 | 0 | ✅ |
| NULL provenance | 0 | 0 | ✅ |
| duplicate code groups | 0 | 0 | ✅ |
| cert_trn 可分配 legacy 库存 | 0 | 0 | ✅ |

**P5 = PASS**

---

## 6. P6 — 受保护 runner plan / dry-run

**结果：FAIL（守卫未被真正执行）**

按要求以 CLI 运行：

```bash
node scripts/cert-r5-protected-legacy-pool-import-runner.mjs --mode plan  --target jhzy-v2-prod --account … --db-uuid …
node scripts/cert-r5-protected-legacy-pool-import-runner.mjs --mode dry-run --target jhzy-v2-prod --account … --db-uuid …
```

两者均 `exit 0`，但输出**仅为三行常量日志**：

```
CERT-R5-RUNNER invoked mode=plan (no production write unless --mode execute with full confirmations)
EXPECTED_ACCOUNT=8770e4917f904aed5df91c883cf058af PROD_D1=jhzy-v2-prod/d372229f-c0ae-4dcc-b968-4ec7c2832842
This runner is guarded. Execute mode requires explicit --confirm-* flags and a maintenance window.
```

| P6 要求守卫 | 是否真正执行 | 证据 |
| --- | --- | --- |
| account id exact | ❌ 仅打印常量 | 未读取环境变量 |
| DB name / UUID exact | ❌ 仅打印常量 | 未连接 D1 |
| source SHA exact | ❌ **未执行** | 归档未被读取 |
| source row count exact (450000) | ❌ **未执行** | 未解析归档 |
| source pool totals exact | ❌ **未执行** | — |
| source status totals exact | ❌ **未执行** | — |
| migration precondition exact | ❌ **未执行** | `readProdState` 未注入 |
| no staging target / no default DB fallback | ❌ 未校验 | — |
| no raw code / PII logging | 未触发 | 无输出可判 |

**P6 = FAIL**（不是守卫拒绝，而是守卫根本没有运行；`exit 0` 是伪通过）

---

## 7. P7 — 导入执行：BLOCKED（根因）

**根因：导入执行路径未组装。** 三项独立证据：

1. **CLI 是纯守卫桩** —— `cert-r5-protected-legacy-pool-import-runner.mjs` 的 `isMain` 块仅 `parseCliArgs` + 三行日志 + `process.exitCode = 0`，**不连接 D1、不读归档、不调用任何执行逻辑**。
2. **无生产 caller** —— `runLegacyPoolImportRunner()` 的唯一调用点是 `workers/tests/cert_r4_runner_production_guard.test.mjs`（测试注入 fake `db`/`rows`/`executor`）；`importLegacyPools` 仅在 `legacy-pool-importer.ts` 中定义，在 runner 第 303 行只作为**注释**出现：
   > `// 生产 R5 应将 config.executor 替换为真实 importLegacyPools（编译后的 .js）；`
   即：真实 executor 的接线被明确留作待办，从未完成。
3. **无归档解析器** —— 全仓无代码解析 `/Users/Shared/jhzy-v2-wp4d-authoritative-20260921.tar.gz`。归档内是 `wp4d_authoritative_20260921_120656/api_jhzyfw_com.data.sql.gz`（gzip 的 MySQL dump）。runner 的 `readArchiveSql()` 自述：
   > `// 若是 tar，则需进一步解析 —— R5 实跑前会先 tar xzf 抽取内层 sql，本函数仅负责纯 .gz sql 的解压。`
   即 tar 抽取步骤同样未完成。

**归档本身有效**：SHA256 = `d51563b0e3149535eb66ff64a3d447a5ad9dfa1cdf26f00b680b4824c4d688bf`，与预期一致；条目 18 个。

依据 HARD PROHIBITIONS「Do NOT improvise recovery」与「Do NOT continue after any failed guard」：**STOP，不现场拼装执行路径**。

| 项 | 值 |
| --- | --- |
| MIGRATIONS_APPLIED | `0045,0046` |
| LEGACY_IMPORT_PERFORMED | **NO** |
| id_pools | 500（未变） |
| LEGACY_MIGRATED | 0 |
| HASH_RECONCILIATION | NOT_RUN |
| SELECTOR_CHECKS | NOT_RUN |

---

## 8. P8 / P9 / P10 — 未执行

依赖 P7，全部 NOT_RUN：对账计数、对账哈希、selector/candidate 检查。

---

## 9. P11 / P12 — 未执行

P11 前置条件为 P8/P9/P10 PASS —— 未满足，**未部署生产 Worker**。
生产 Worker 仍为 `e7fcf4a8-f776-44cf-b857-f751924ae2f2`（100%）。

| 项 | 值 |
| --- | --- |
| WORKER_DEPLOYED | NO |
| NEW_WORKER_VERSION | N/A（未变更） |
| WORKER_BINDING | 未重新验证（未部署）；既有绑定 `jhzy-v2-prod` / `d372229f…` 未变 |

---

## 10. P13 — HTTP E2E：NOT_RUN

未部署新 Worker，且导入未完成，E2E 不具备执行前提。未执行任何 HTTP 请求。

---

## 11. P14 — 签发窗口：REMAINS CLOSED

关键闸门未通过（导入未完成）→ 依据规则保持关闭。

`CERTIFICATE_ISSUANCE_MAINTENANCE_WINDOW = CLOSED_FOR_WRITES`（保持）

---

## 12. ⚠ 中间态风险（必须披露）

生产当前处于 **0045/0046 已应用、450k legacy 库存未导入** 的中间态。

- `id_pools` 中 `cert_trn` 共 500 条，但 **provenance 全部为 `v2_synthetic_compat`（不可分配）**，`legacy_migrated = 0`
- 结果：**TRAINING 证书编号分配的可用库存为 0**（`cert_trn_eligible = 0`）
- 这是 0046 设计的预期行为（fail-closed：宁可 EXAM_POOL_EXHAUSTED，也不违规消费合成兼容库存）
- 缓解：签发窗口保持关闭，且 v2 Worker 无运行时发证路由 → **当前无实际业务影响**
- **但**：在 legacy 导入完成前，任何 TRAINING 发证都会失败。须尽快补齐导入路径后执行

---

## 13. P15 — 执行后快照

**POST_SNAPSHOT_RUN_ID** = `cert_r5_prod_post_20261003T172725Z`
**POST_SNAPSHOT_SHA256** = `ffeda68a6a61b738b2b228fc03c3d7c0061ad8e92307917d5c4f4a096b189720`

| 快照 | 文件 | SHA256 | 大小 |
| --- | --- | --- | --- |
| PRE | `cert_r5_prod_pre_20261003T170017Z.sql` | `aa3d2f0631e1f67afe2e9f553149a144fac9dbdf36b172da5e4a059201211182` | 3,617,639 |
| POST | `cert_r5_prod_post_20261003T172725Z.sql` | `ffeda68a6a61b738b2b228fc03c3d7c0061ad8e92307917d5c4f4a096b189720` | 3,703,041 |

快照完整性校验：
- PRE 与 CERT-R4 冻结快照 SHA256 逐字节一致 → 完整有效
- POST 以完整 trigger 定义 `END;` 收尾，非截断；`CREATE TABLE` 数 84 → **85**（增量即 0045 新建的 `certificate_batches`）；SHA256 两次独立计算一致

> 注：首次 post 导出因进程被 SIGTERM 中断产生截断文件（2,560,832 字节，尾部停在半条 INSERT 语句），已删除并重跑。
> 教训：D1 export 耗时可能远超前台命令上限，须后台执行并**强制校验文件尾部的语句完整性**，不能只看 exit code 或文件大小。

**执行后生产状态（只读实测）**：

| 项 | 值 |
| --- | --- |
| d1_migrations count / max | 46 / 46 |
| certificates | 413（**未变**） |
| id_pools 总数 | 500（**未变**） |
| provenance 分布 | `v2_synthetic_compat` 500 |
| pool_type 分布 | `cert_trn` 500 |
| status 分布 | 0 → 500 |
| duplicate code groups | 0 |
| duplicate cert_no groups | 0 |

---

## 14. 非突变 / 禁止项确认

| 项 | 状态 |
| --- | --- |
| JHZY 1.0 live 触碰 | **NO**（无 SSH、无 `/www/wwwroot/api.jhzyfw.com/`、无 1.0 DB/文件系统访问） |
| Git push | **NO** |
| Secret 变更 | **NO** |
| 证书签发 | **NO** |
| 生产 Worker 部署 | **NO** |
| 破坏性 DB 回滚 | **NO** |
| 450k legacy 导入 | **NO**（未执行） |
| 公开验真路由修复 | **NO**（已知技术债，不入 R5） |

**已发生的生产变更（唯一一项）**：D1 `jhzy-v2-prod` 应用 migration 0045 + 0046。

---

## 15. 阻断项与建议下一步（不自行执行）

| # | 缺口 | 建议（待人工批准） |
| --- | --- | --- |
| 1 | CLI 未接线 `readProdState` | 编写生产 caller，注入只读前置状态读取 |
| 2 | 归档 tar.gz 未抽取/解析 | 实现 `tar xzf` + gunzip + `parseLegacySourceStats` 串联 |
| 3 | 真实 executor 未接线 | 编译 `importLegacyPools` 或验证 `builtinImportExecutor` 可承担生产写入 |
| 4 | D1 export 易被中断 | 后台执行 + 完整性校验 |
| 5 | 中间态 `cert_trn` 可分配库存为 0 | 优先完成导入；期间保持签发关闭 |

---

**NEXT_ACTION = STOP. Await human review of this BLOCKED finding before any further production action.**
