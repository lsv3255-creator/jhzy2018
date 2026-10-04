# 42 · Production Deploy 授权闸门（POST-R5-P7）

- 工作包：`POST-R5-P7-PRODUCTION-DEPLOY-AUTHORIZATION-GATE`
- 上游：P5 wiring = PASS · P6 staging validation = PASS_WITH_FINDINGS · P6B client team context = PASS。
- 性质：**只读 preflight / 授权文本 / 部署与回滚计划 / 文档**。**未部署、未写 production D1、未发证、未改 secrets、未 push**。
- 权威库：`/Users/Shared/projects/jhzy-v2`（HEAD = `9c4c1228d9cfa5cfb49214fecb5ca9c802aa9aa9`，branch `master`）。
- 提交：`docs(certificates): prepare production deploy authorization`（**仅 stage 本 doc，未 push**）。

---

## 0. 纪律声明（铁律，全程遵守）

| 禁令 | 状态 |
|---|---|
| `wrangler deploy --env production` | ❌ 未执行 |
| 调用 production 发证接口 | ❌ 未调用 |
| 写 production D1 | ❌ 未写（全部查询为 `--command` 只读 SELECT）|
| 插入 production certificates | ❌ 未插入 |
| 更新 production id_pools | ❌ 未更新 |
| 写 production certificate_logs | ❌ 未写 |
| 改 production secrets | ❌ 未改 |
| 触碰 JHZY 1.0 live | ❌ 未碰 |
| push 到远端 | ❌ 未 push |
| 无关修复 | ❌ 未做 |
| stage / 清理 / reset 并行流改动 | ❌ 未做（工作树 583 项只读查看）|

> 所有 Cloudflare 调用均带 `--profile jhzy` + `CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af`，并 `env -u CLOUDFLARE_API_TOKEN`（走 profile 凭据）。

---

## 1. Repo Gate

| 项 | 值 | 结论 |
|---|---|---|
| `pwd` / toplevel | `/Users/Shared/projects/jhzy-v2` | ✅ |
| branch | `master` | ✅ |
| `git rev-parse HEAD` | `9c4c1228d9cfa5cfb49214fecb5ca9c802aa9aa9` | ✅ 与要求完全一致 |
| `git status --short` | 583 项（并行流未提交改动）| ⚠️ 只读查看，未 stage / 未清理 / 未 reset |

## 2. 提交链核查（LOCAL_DEPLOY_CHAIN_READY）

`git log --oneline -n 12`（新→旧）：

| # | SHA | 说明 |
|---|---|---|
| 1 | `9c4c122` | docs(certificates): confirm client team context readiness（P6B）|
| 2 | `bbc1459` | docs(certificates): validate activity service issuance（P6）|
| 3 | `231eb21` | **feat(certificates): wire activity service issuance（P5，唯一代码提交）** |
| 4 | `8287556` | docs(certificates): confirm cert_srv inventory for issuance wiring（P5A）|
| 5 | `d66424c` | docs(certificates): design activity service issuance wiring（P4）|
| 6 | `cca1976` | docs(certificates): verify post-R5 selector safety（P3）|
| 7 | `90abdae` | docs(certificates): design post-R5 issuance validation（P2）|
| 8 | `1f0ceb3` | docs(certificates): record post-R5 production monitoring（P1）|

- 三条必需提交（`231eb21` → `bbc1459` → `9c4c122`）**存在且顺序正确**：先实现（P5）→ 再验证（P6）→ 再客户端闭环（P6B）。
- 另三条前置（`cca1976` / `d66424c` / `8287556`）亦齐备。
- **LOCAL_DEPLOY_CHAIN_READY = YES**。

## 3. Production Target 只读 Preflight

### 3.A D1 list（`wrangler d1 list --profile jhzy`）

| 名称 | UUID | 期望 | 实际 | 结论 |
|---|---|---|---|---|
| `jhzy-v2-prod` | `d372229f-c0ae-4dcc-b968-4ec7c2832842` | ✅ 同值 | 同值 | ✅ |
| `jhzy-v2-staging` | `85853fb1-1384-486e-9be3-566f72f45c5d` | ✅ 同值 | 同值 | ✅ |
| `jhzy-v2-db`（forbidden default）| `ea603f43-d076-4df5-b118-3d8a0c245439` | ✅ 同值 | 同值 | ✅ |

三个 UUID 与冻结值**完全一致**，无漂移。

### 3.B production D1 只读查询（`jhzy-v2-prod --remote`）

| 指标 | 期望 | 实际 | 结论 |
|---|---|---|---|
| `migration_count` | 46 | 46 | ✅ |
| `migration_max` | 46 | 46 | ✅ |
| `id_pools_total` | 450500 | 450500 | ✅ |
| `legacy_migrated` | 450000 | 450000 | ✅ |
| `synthetic_compat` | 500 | 500 | ✅ |
| `null_provenance` | 0 | 0 | ✅ |
| `cert_srv_available_legacy` | 149692 | 149692 | ✅ |
| `certificates_count` | 413 | 413 | ✅ |
| `duplicate_cert_no_groups` | 0 | 0 | ✅ |
| `duplicate_source_key_groups` | 0 | **6** | ⚠️ 见 §3.B.1 |

#### 3.B.1 `duplicate_source_key_groups = 6` 偏离说明（重要，非阻断）

- 原查询使用 `WHERE deleted_at IS NULL`；实测 **`certificates` 表无 `deleted_at` 列**（仅有 `status`），该条件报错，故改为不含 `deleted_at` 的等价分组复核，得到 6 组。
- 6 组构成（仅结构，无 PII）：全部为**存量 legacy 行**，特征为
  - `issue_source = NULL`（= 新 wiring 之前的历史数据，无命名空间判别列）；
  - 各组 `cert_no` **互不重复**（`COUNT(DISTINCT cert_no) = COUNT(*)`，最大组 85 行 course、38 行 activity、其余 2 行 ×4）；
  - 全部 `status = 1`。
- **对新 wiring 无影响（命名空间隔离）**：新发证幂等查询 `findActiveByNamespace`（`src/repository/certificate-issuance.ts:133-148`）条件为
  `WHERE user_id = ? AND source_type = ? AND issue_source = ? AND source_id = ? AND status = 1`，
  其中 `issue_source` 由域派生为**非空** `'activity'` / `'service'`（`issueSourceFor`）。SQL 中 `issue_source = 'activity'` **永不匹配 NULL**，故：
  - 遗留 6 组**不会**被误判为 `ALREADY_ISSUED`；
  - 也**不会**阻断新的合法发证（新行落入独立命名空间与唯一索引 `uq_cert_user_source`）。
- 结论：这是**存量数据质量备注（informational）**，源于 P2 时期记录的"413 行 legacy 种子形状"（`source_id` 多为 NULL），**与本次 deploy 无关，不构成阻断**。是否清理应另立数据治理任务，不在本 Gate 范围。

### 3.C production Worker 当前部署（`wrangler deployments list --env production`）

- 当前 active version：**`bfff110b-4787-40cb-b982-6c692e699429`**（created `2026-10-04T03:54:01Z`，Author `lsv3255@gmail.com`，Source `Unknown (deployment)`）。
- 与本工作包"已知 active version"**完全一致** → **无外部/意外 deploy**，无需追责。
- 历史可见版本（回滚候选，由新到旧）：`bfff110b…`（当前）→ `e7fcf4a8-f776-44cf-b857-f751924ae2f2`（Secret Change, 2026-10-02）→ `b03096b6-6f0d-4a84-83f9-43378021e41d`（2026-10-02）→ `45282c30-0e80-4234-818f-96c25585999a`（2026-09-29）→ `315ba43a-c9aa-46ff-84a1-43f956d4b876`（2026-09-29）。
- 注：首次调用因沙箱代理**超时**，重试成功（只读操作，未产生任何部署副作用）。

### 3.D Wrangler 配置目标核对（`workers/wrangler.jsonc`）

| 检查项 | 结果 |
|---|---|
| `--env production` 部署目标 | `jhzy-v2-worker` + `[env.production]`（`workers_dev: true`）→ production Worker ✅ |
| production D1 binding | `DB` → `jhzy-v2-prod` / `d372229f-c0ae-4dcc-b968-4ec7c2832842` ✅ |
| 是否指向 forbidden default `jhzy-v2-db` | ❌ 否（`jhzy-v2-db` 仅为顶层默认/local 绑定，`[env.production]` 未引用）✅ |
| 是否指向 staging D1 | ❌ 否（`[env.staging]` 独立绑定 85853fb1…，production 未引用）✅ |

**PRODUCTION_TARGET_SAFE = YES**。

## 4. 本地质量门汇总

| 证据 | 结果 |
|---|---|
| doc 39（P5 实现）存在 | ✅ |
| doc 40（P6 staging 验证）存在 | ✅ |
| doc 41（P6B 客户端 team context）存在 | ✅ |
| `npm run typecheck`（`tsc --noEmit`，workers）| ✅ **exit 0**（无类型错误）|
| P5 测试 `tests/p_r5_activity_service_issuance.test.mjs` | ✅ **40/40 PASS**（本地 node:sqlite；含 service 命名空间 `issue_source=service`、幂等 `ALREADY_ISSUED`、本人自发证 403、跨团队 404）|
| P6B 测试 `miniprogram/tests/cert_team_context_contract.mjs` | ✅ **32/32 PASS** |

> 未重跑耗时的全量 integration 套件；采用 P5/P6/P6B 已提交证据 + 本轮轻量复跑（typecheck / P5 / P6B），无伪造。

## 5. 风险清单

### A. production deploy 后会发生什么

- **仅更新 Worker 代码**（`wrangler deploy --env production` → `jhzy-v2-worker`）。
- **不会**自动发证；**不会**自动写 `certificates`；**不会**自动消费 `id_pools`。
- 发证**仅在管理员显式调用新 route** 时发生（`POST /api/v2/activities/:id/participants/:pid/certificate/issue` 等）。
- 号池 selector 已限制：`pool_type='cert_srv'` + `status=0` + `provenance ∈ {legacy_migrated, v2_native}`（`allocatableProvenanceSql`），合成兼容库存（`v2_synthetic_compat`）与 NULL provenance **确定性排除**（P3/P5A 证据）。
- deploy 本身**不写 D1**，故代码上线与数据写入解耦。

### B. 已知 finding（非阻断）

1. **P6 未完成远程 `*.workers.dev` 公网 E2E** —— 沙箱代理屏蔽 workers.dev；P6 以本地 staging-env 真实 Worker + staging 等价 fixture 完成 A–I 验证。**建议 deploy 后先做 production smoke（不发证）**补齐该链路。
2. **production 存量 6 组 `issue_source=NULL` 重复源键**（§3.B.1）—— 命名空间隔离，不影响新 wiring；建议另立数据治理任务。
3. **管理端证书页缺专属 `ensureTeam` CTA**（P6B）—— 体验优化项，注入与门控均已就位，**不阻断**。

### C. 生产首次验证顺序（deploy 后）

1. 执行 production deploy（需用户明确授权）。
2. `wrangler deployments list --env production` 确认新 version 生效。
3. **只读** D1 复核：`certificates_count` / `cert_srv` consumed / `duplicate_*` 应与 deploy 前一致（deploy 不写 D1）。
4. auth / RBAC smoke（无鉴权 401、无权限 403）。
5. **preview-only** smoke（`.../certificates/preview`，no-write）。
6. **不发证**。
7. 观察（部署后一段时间内监控）。
8. 之后**单独请求用户授权**（P8）首条真实合规发证。

### D. 回滚 / 应急

- 用 `wrangler deployments list --env production` 查上一 active version（当前为 `bfff110b…`，上一为 `e7fcf4a8…`）。
- 若 deploy 后出现 route / RBAC 异常：回滚到上一 active production version（Worker 代码层面）。
- **回滚只影响 Worker 代码，不回滚 D1**；因 deploy 本身不写 D1，**风险可控**。
- 若 preview/issue route 误触发：**立即禁用 / 回滚 Worker**，并**只读**对账 `certificates` / `id_pools` / `certificate_logs`，据实报告，**不自动清理**。

## 6. 生产部署授权文本（须用户复制确认）

> 我明确授权执行 POST-R5-P7 production Worker deploy：允许将当前本地 HEAD `9c4c122` 的 activity/service 证书发放 wiring 部署到 `jhzy-v2-worker-production`，确认 production D1 目标为 `jhzy-v2-prod/d372229f-c0ae-4dcc-b968-4ec7c2832842`。本次授权仅允许部署 Worker 与部署后只读/preview smoke，**不允许真实发证、不允许写 production D1 测试数据、不允许 push、不允许改 secrets、不允许触碰 JHZY 1.0**。

> ⚠️ 本 Gate（P7）**不执行**该授权，仅将其写入文档与 Final return。真正 deploy 需用户下一条明确复制/确认授权。

## 7. 当前决策

**READY_FOR_PRODUCTION_DEPLOY_AUTHORIZATION = YES**

理由：提交链完整、生产目标安全（`PRODUCTION_TARGET_SAFE=YES`）、production D1 preflight 8/9 指标符合预期（第 9 项为存量数据质量备注，命名空间隔离不阻断）、Worker 当前版本与已知一致（无外部 deploy）、本地质量门全绿（typecheck exit 0 / P5 40-40 / P6B 32-32）。

**是否阻断 production deploy：否。** 唯一待办为"用户明确授权 deploy 动作"本身；技术前置条件已满足。

## 8. 禁令符合性声明

| 声明 | 值 |
|---|---|
| no production D1 mutation | **NO**（全部只读 SELECT）|
| no production deploy | **NO**（未执行 deploy）|
| no certificate issued | **NO**（未发证）|
| no secret mutated | **NO** |
| JHZY 1.0 live touched | **NO** |
| git push performed | **NO**（仅本地 commit，未 push）|

## 9. Secret / PII 扫描（doc 42）

| 项 | 状态 |
|---|---|
| token / session token | ❌ 不含 |
| 手机号 / OpenID / 身份证 / 真实姓名 | ❌ 不含 |
| raw cert_no / raw pool code | ❌ 不含（仅统计口径，无具体编号）|
| 硬编码 team id / user id | ❌ 不含（仅引用 UUID 形式的 D1 资源 ID 与 Worker version id，属资源标识非 PII）|

> 作者邮箱（`lsv3255@gmail.com`）为 `wrangler deployments list` 输出中的部署作者字段，属工具原始元数据、非本 Gate 引入的 PII；如需严格脱敏可在归档时移除。此处保留以便追溯"无外部 deploy"结论。

## 10. 结论

POST-R5-P7 闸门 **完成**：production deploy 的只读前置条件（repo / 提交链 / D1 preflight / Worker 版本 / 配置目标 / 质量门）已全部核验通过，部署与回滚/观察方案及授权文本已就绪。**deploy 本身需用户下一条明确授权后方可执行。**

---

## 附录 · Final return

```
POST_R5_P7_STATUS            : PASS
START_HEAD                    : 9c4c1228d9cfa5cfb49214fecb5ca9c802aa9aa9
END_HEAD                      : 9c4c1228d9cfa5cfb49214fecb5ca9c802aa9aa9 (doc-only; see COMMIT_SHA)
COMMIT_SHA                    : (see git log; docs-only commit, no code change)
LOCAL_DEPLOY_CHAIN_READY      : YES (cca1976→d66424c→8287556→231eb21→bbc1459→9c4c122)
PRODUCTION_D1_PREFLIGHT       : PASS_WITH_NOTE — 8/9 指标符合预期；duplicate_source_key_groups=6（存量 issue_source=NULL legacy 行，命名空间隔离，不阻断，详见 §3.B.1）
PRODUCTION_WORKER_CURRENT_VERSION : bfff110b-4787-40cb-b982-6c692e699429 (2026-10-04T03:54Z, matches known; no external deploy)
PRODUCTION_TARGET_SAFE        : YES ([env.production]→jhzy-v2-prod/d372229f…; not jhzy-v2-db, not staging)
QUALITY_EVIDENCE              : doc39/40/41 present; typecheck exit 0; P5 test 40/40; P6B test 32/32
READY_FOR_PRODUCTION_DEPLOY_AUTHORIZATION : YES
AUTHORIZATION_TEXT            : 见 §6（须用户复制确认；P7 不执行）
SECRET_PII_SCAN               : PASS
PRODUCTION_D1_MUTATED         : NO
PRODUCTION_WORKER_DEPLOYED    : NO
PRODUCTION_CERTIFICATE_ISSUED : NO
SECRET_MUTATED                : NO
JHZY_1_0_LIVE_TOUCHED         : NO
GIT_PUSH_PERFORMED            : NO
NEXT_ACTION                   : 等待用户复制 §6 授权文本后执行 production deploy；deploy 后按 §5.C 做只读/preview smoke（不发证）；P8 首条真实发证需另行授权
```
