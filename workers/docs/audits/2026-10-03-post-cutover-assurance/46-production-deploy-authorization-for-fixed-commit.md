# 46 — POST-R5-P8C Production Deploy Authorization Gate for Fixed Commit

- 文档编号：46
- 日期：2026-10-04
- 阶段：POST-R5-P8C（为修复后 commit 重建 production deploy 授权门）
- 前置：doc 45（P8B 最小修复 PASS）· doc 44（P8A BLOCKED_ON_QUALITY_GATE）· doc 43（BLOCKED_ON_DIRTY_WORKTREE）· doc 42 / 41 / 40 / 39
- **本任务性质：只读 preflight + 授权门文档。未 deploy、未写 D1、未发证、未 push。**
- **READY_FOR_PRODUCTION_DEPLOY_AUTHORIZATION = YES**

---

## 0. 一句话结论

修复后 clean worktree commit **`a6e259d29d266d0d9e1a3463fcb80ccebabb2490`** 已通过全部质量门（typecheck exit 0 · P5 40/40 · P6B 32/32）；其相对原授权锚点 `9c4c122` 的**代码差异仅 1 个文件**（`participation.ts` 补 `activity_id`），**并行流零带入**（git tree 172 个 src 文件中命中 0）；production 目标绑定正确、D1 快照 9/9 一致、Worker 仍为 `bfff110b-4787-40cb-b982-6c692e699429`。

**授权门已形成，等待用户明确授权后方可执行 deploy。**

---

## 1. P8A 阻断背景（回顾）

P8A（doc 44）在 clean worktree 锚点 `9c4c122` 上发现质量门失败：

- `tsc --noEmit` 报 `src/routes/activities.ts(701,14) TS2339`
- P5 测试 **27/40**（13 项失败）

**根因**：`231eb21`（P5）提交了 `activities.ts:701` 的参与行归属校验 `if (part.activity_id !== activity.id)`，但其依赖的仓储层契约从未提交——`findByPublicIdWithSignup` 既未 SELECT `s.activity_id`，返回类型也未声明。运行时 `undefined !== number` 恒为 true → 单人发证路由在任何输入下均抛 404，批量幂等分类与账本失真。

**为何此前未被发现**：P6（doc 40）与 doc 42 §4 的「typecheck 0 / P5 40/40」均在**主工作树**取得，而主工作树 `participation.ts` 的未提交 diff 恰好包含该修复（注释自称 `POST-R5-P5`），掩盖了提交级缺陷。

---

## 2. P8B 修复摘要（doc 45）

| 项 | 值 |
|---|---|
| 修复 commit | `a6e259d29d266d0d9e1a3463fcb80ccebabb2490` |
| parent | `9c4c1228d9cfa5cfb49214fecb5ca9c802aa9aa9` |
| subject | `fix(certificates): return activity id for participant issuance guard` |
| 修改文件 | **1**：`workers/src/repository/participation.ts`（+10 / −4） |
| 修改点 | ① SELECT 增 `s.activity_id AS activity_id`　② 返回类型增 `activity_id: number`　③ 补注释 |
| 未涉及 | schema / 迁移 / 路由 / 业务逻辑 / wrangler 配置 / `app.ts` / certificate service / permission / 号池 selector |
| P5 测试恢复 | 27/40 → **40/40**（13 项全部转正） |

其中两处语义修正尤关键：
- 用例 I（活动本人自发证）：修复前 `404` 先于 `403` → 现正确返回 **403 SELF_ISSUE_FORBIDDEN**
- 用例 D（批量幂等）：修复前目标被误计入 `issued`、账本 `already_issued` 失真 → 现分类正确

---

## 3. Deploy source commit 与产物边界

### 3.1 Source commit

```
DEPLOY_SOURCE_COMMIT = a6e259d29d266d0d9e1a3463fcb80ccebabb2490
CLEAN_WORKTREE_PATH  = /Users/Shared/projects/jhzy-v2-deploy-r5-p8-clean
WORKTREE_STATE       = detached HEAD @ a6e259d，git status 空
```

### 3.2 与原授权锚点的差异（`9c4c122` → `a6e259d`）

全量差异 **2 个文件**：

| 文件 | 性质 |
|---|---|
| `workers/src/repository/participation.ts` | **代码**（+10/−4，唯一最小修复） |
| `workers/docs/audits/.../45-clean-worktree-minimal-fix.md` | 纯文档 |

**代码文件差异清单**（`git diff --name-only 9c4c122..a6e259d -- workers/src workers/wrangler.jsonc workers/migrations workers/package.json`）：

```
workers/src/repository/participation.ts
```

→ **仅此 1 个文件。** 无第二处代码改动。

### 3.3 并行流零带入（tree 级证明）

`git ls-tree -r --name-only a6e259d -- workers/src` → **172 个文件**，并行流特征文件命中 **0**：

| 并行流文件 | 在 `a6e259d` tree 中 |
|---|---|
| `workers/src/routes/public.ts` | **ABSENT** ✅ |
| `workers/src/routes/h5.ts` | **ABSENT** ✅ |
| `workers/src/routes/admin-notification-templates.ts` | **ABSENT** ✅ |
| `workers/src/routes/notifications-wechat.ts` | **ABSENT** ✅ |
| `workers/src/middleware/security-headers.ts` | **ABSENT** ✅ |
| `workers/src/services/notification-orchestrator.ts` | **ABSENT** ✅ |
| `workers/src/services/activity-start-reminder-service.ts` | **ABSENT** ✅ |
| `workers/src/h5/` | **ABSENT** ✅ |

`app.ts` 中 `strict: false` / `routes/public` / `routes/h5` / `security-headers` / `notification-templates` / `notifications-wechat` → **全部无匹配** ✅

`verifyPublic` / `maskHolderName`（P11-WP3 匿名验真面）在 `a6e259d` 的 `workers/src` 中出现次数 = **0** ✅
（该改动仅存在于主工作树未提交区，未进入 deploy 产物；`certificate-service.ts` 相对锚点**零差异**。）

**关键发证文件在 tree 中确认存在**：`participation.ts` · `routes/activities.ts` · `routes/certificates.ts` · `services/certificate-issuance-service.ts` ✅

### 3.4 部署链（clean worktree）

```
a6e259d  fix(certificates): return activity id for participant issuance guard
9c4c122  docs(certificates): confirm client team context readiness
bbc1459  docs(certificates): validate activity service issuance
231eb21  feat(certificates): wire activity service issuance
```

---

## 4. Clean worktree proof

| 校验项 | 结果 |
|---|---|
| `pwd` / toplevel | `/Users/Shared/projects/jhzy-v2-deploy-r5-p8-clean` ✅ |
| `git rev-parse HEAD` | `a6e259d29d266d0d9e1a3463fcb80ccebabb2490` ✅ 与授权锚点一致 |
| `git status --short` | **空**（`STATUS_COUNT=0`）✅ |
| `git status --short --untracked-files=all` | **空**（`node_modules` 已 gitignore）✅ |
| 依赖 | `npm ci` 已就绪（42 packages，仅在 clean worktree，lockfile 未提交） |

**主工作树隔离证明**：

| 项 | 值 |
|---|---|
| 主工作树 HEAD | `9ddd865`（本任务期间未变） |
| `workers/src` + `wrangler.jsonc` + `migrations` 脏文件 | **28**（20 M + 8 ??，与 P8A/P8B 记录一致） |
| `git stash list` | **0** |
| `a6e259d` 是否在 `master` 上 | **NO**（`merge-base --is-ancestor` = false） |
| 主工作树 `participation.ts` | 仍为**未提交修改**状态，**未被本任务触碰** |
| merge / rebase / cherry-pick / reset / clean | **均未执行** |
| 历史 worktree `jhzy-v2-r3f-deploy-20261003T174948` | **未触碰** |

---

## 5. Quality gate proof（clean worktree 内实跑，`a6e259d`）

| 门 | 命令 | 结果 |
|---|---|---|
| Typecheck | `npm run typecheck`（`tsc --noEmit`） | **PASS**（exit 0，无 error） |
| P5 测试 | `node --test tests/p_r5_activity_service_issuance.test.mjs` | **PASS — 40/40**（`# pass 1 / # fail 0`） |
| P6B 契约 | `node miniprogram/tests/cert_team_context_contract.mjs` | **PASS — 32/32** |

**QUALITY_GATE = PASS（三绿）**

覆盖范围含：A1–A4 鉴权/RBAC · B 预览三态 · C 单人发证落库 · D 批量幂等分类与账本 · E 重复发证幂等 · F/G/H 服务记录发证（`issue_source=service` 命名空间）· I/J 自发证禁止 · K/L 边界。

---

## 6. Production target preflight

### 6.1 Wrangler 绑定（`a6e259d` 的 `wrangler.jsonc`）

```jsonc
"production": {
  "workers_dev": true,
  "vars": { "ENVIRONMENT": "production", "WECHAT_APPID": "...", "ADMIN_ALLOWED_ORIGINS": "..." },
  "d1_databases": [ { "binding": "DB",
                       "database_name": "jhzy-v2-prod",
                       "database_id": "d372229f-c0ae-4dcc-b968-4ec7c2832842",
                       "migrations_dir": "migrations" } ],
  "r2_buckets": [ { "binding": "FILES", "bucket_name": "jhzy20-files" } ]
}
```

| 目标 | 绑定 | 判定 |
|---|---|---|
| `env.production` → DB | `jhzy-v2-prod` / `d372229f-c0ae-4dcc-b968-4ec7c2832842` | ✅ |
| `env.production` → `ENVIRONMENT` | `production` | ✅ |
| `env.staging` → DB | `jhzy-v2-staging` / `85853fb1-1384-486e-9be3-566f72f45c5d` | ✅ 独立，`--env production` 不选中 |
| forbidden `jhzy-v2-db` | `ea603f43-d076-4df5-b118-3d8a0c245439` | ✅ **仅 top-level default**，`--env production` **不使用** |

**PRODUCTION_TARGET_SAFE = YES**

### 6.2 D1 list（只读）

| 名称 | UUID | 冻结值核对 |
|---|---|---|
| `jhzy-v2-prod` | `d372229f-c0ae-4dcc-b968-4ec7c2832842` | ✅ |
| `jhzy-v2-staging` | `85853fb1-1384-486e-9be3-566f72f45c5d` | ✅ |
| `jhzy-v2-db`（forbidden default） | `ea603f43-d076-4df5-b118-3d8a0c245439` | ✅ |

### 6.3 Production D1 只读快照（全部 SELECT，零写入）

| 指标 | 实测 | 期望 | 判定 |
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

**PRODUCTION_D1_PREFLIGHT = PASS（9/9）**

`duplicate_source_key` 存量 legacy 备注（6 组，均 `issue_source=NULL` 命名空间，cert_no 互异）沿用 doc 42 §3.B.1：与新 wiring 的 `issue_source='activity'/'service'` 命名空间**不相交**，既不误判 `ALREADY_ISSUED` 也不阻断新发证 → **不作为阻断**，属存量数据质量备注。

**与 doc 42 / 43 / 44 / 45 逐项一致 → 生产 D1 全程零漂移。**

---

## 7. Worker current version

```
wrangler deployments list --env production
→ Version(s):  (100%) bfff110b-4787-40cb-b982-6c692e699429   ← 最新 active
```

与 P7/P8A/P8B 记录一致，**无外部 deploy**。

**PRODUCTION_WORKER_CURRENT_VERSION = `bfff110b-4787-40cb-b982-6c692e699429`**

---

## 8. 风险清单

### 8.1 Deploy 后会发生什么

- **仅更新 Worker 代码**（bundle 替换），版本号变化。
- **不会自动发证**。
- **不会自动写** `certificates`。
- **不会自动消耗** `id_pools`。
- **不会写** `certificate_logs`。
- 发证**仅在管理员后续显式调用 issue route** 时才可能发生。
- 号池 selector 已限制 `provenance ∈ {legacy_migrated, v2_native}` 且 `status = 0`（P3/P5 验证），不会触碰 `v2_synthetic_compat` 兼容号。

### 8.2 相对原授权的变化（仅一处，且是修复）

相对用户最初授权的 `9c4c122`，本次 deploy 产物**只多一个最小修复**：
`participation.ts` 的 SELECT / 返回类型补 `activity_id`。

- 该修复**修复**了单人活动发证路由恒 404 与批量幂等分类错误。
- **不含** P11-WP2/WP3/WP4、S18 H5、public verify 等并行流（tree 级已证）。
- **不含**任何 schema / 迁移 / 权限 / selector 变更。
- 相对 P8A 的锚点产物，**本部署不是新增未验证功能，而是修复一个已验证但实现不完整的缺陷**。

### 8.3 已知 finding（继承自 P6 / P6B）

- **远程 staging 公网 E2E 未完成**：沙箱代理屏蔽所有 `*.workers.dev` 出站。P6 改用「本地 staging-env 真实 Worker 代码 + staging 等价 fixture 克隆」完成 A–I 验证。→ 建议 deploy 后先做 production **只读 / preview** smoke，**不发证**。
- **P6 §8 客户端 team context**：P6B（doc 41）已闭环验证 —— `transport.ts` 统一注入 `X-Team-Id`，`trainingApi` / `adminApi` 的 request wrapper 默认 `teamScoped=true`，志愿者证书页 `hasTeamContext()` pre-guard 并渲染「请先选择团队」。**P1-B2.3 客户端必须注入当前团队 `x-team-id`**，否则持证人本人会 403。
- **管理端证书页缺专属 CTA**：`pages/admin/training-certificates/index.ts` 未加 `ensureTeam()` pre-guard，依赖 `adminPanel` 级门控 + 后端 403 toast（不静默空列表，但无「去选择团队」按钮）。**体验优化，非阻断**。
- **存量 legacy 幂等键重复 6 组**：见 §6.3，命名空间不相交，不阻断。
- **本地代理屏蔽 `*.workers.dev`**：若 deploy 后 HTTP smoke 报 `HTTP 000`，属**沙箱网络限制**，**不得伪造为通过**；以 `deployments list` + 只读 D1 after 快照作为部署成功证据。

---

## 9. Deploy plan（获得授权后执行）

1. 在 **clean worktree** `/Users/Shared/projects/jhzy-v2-deploy-r5-p8-clean`（HEAD = `a6e259d`）内执行，**不得从 dirty 主工作树打包**。
2. 部署前再次确认 `git status` 空、`git rev-parse HEAD` = `a6e259d…`。
3. 执行 `wrangler deploy --env production`。
4. **确认输出**：`Worker = jhzy-v2-worker-production`；D1 binding = `jhzy-v2-prod / d372229f-…`；`ENVIRONMENT = production`。
   - **若输出出现 staging / `jhzy-v2-db` / `ea603f43…`，立即 STOP。**
5. 记录新 Version ID。

---

## 10. Smoke plan（部署后，不发证）

按顺序执行，**任一步异常即回滚**：

| # | 步骤 | 类型 | 期望 |
|---|---|---|---|
| 1 | `wrangler deployments list --env production` | 只读 | 新 Version 100% active |
| 2 | production D1 只读快照（重复 §6.3） | 只读 | 9 指标**与部署前完全一致**（413 / 450500 / 149692 / dup 0） |
| 3 | `/health`（若可达） | 只读 | 200 |
| 4 | auth / RBAC smoke（未认证 → 401；volunteer 发证 → 403） | 只读 | 不发证 |
| 5 | certificate **preview-only** smoke（不调用 issue） | 只读 | 不写 D1 |

- **HTTP smoke 若因沙箱代理阻断** → 记 `HTTP_SMOKE = BLOCKED_BY_LOCAL_NETWORK_OR_PROXY`，**不得伪造通过**；以步骤 1–2 为部署成功证据。
- **preview smoke 若无真实合规 production auth session** → 记 `PREVIEW_SMOKE = SKIPPED_NO_SAFE_PRODUCTION_AUTH_CONTEXT`，**不伪造生产 fixture、不写生产测试数据**。
- **真实首条发证另行授权（P9）**，不在本次范围。

---

## 11. Rollback plan

| 项 | 值 |
|---|---|
| 当前 rollback 目标版本 | **`bfff110b-4787-40cb-b982-6c692e699429`** |
| 回滚方式 | `wrangler deployments list` 查上一 active → `wrangler rollback`（或 redeploy 该 version） |
| 回滚影响面 | **仅 Worker 代码**；**不回滚 D1** |
| 风险可控性 | deploy 本身**不写 D1**，故回滚无数据侧后果 |
| 触发条件 | smoke 出现 route / RBAC / 5xx 异常；或 preview 行为与预期不符 |
| 应急处置 | 若 preview/issue route 误触发 → 立即回滚 Worker，并对 `certificates` / `id_pools` 做**只读**对账 |

---

## 12. 授权文本（须由用户复制确认）

> 我明确授权执行 POST-R5-P8C production Worker deploy：允许从 clean worktree `/Users/Shared/projects/jhzy-v2-deploy-r5-p8-clean` 将当前 HEAD `a6e259d29d266d0d9e1a3463fcb80ccebabb2490` 部署到 `jhzy-v2-worker-production`，确认 production D1 目标为 `jhzy-v2-prod/d372229f-c0ae-4dcc-b968-4ec7c2832842`。本次授权仅允许部署 Worker 与部署后只读/preview smoke，不允许真实发证、不允许写 production D1 测试数据、不允许 push、不允许改 secrets、不允许触碰 JHZY 1.0；不得从 dirty 主工作树 `/Users/Shared/projects/jhzy-v2` 打包。

**本任务不执行该授权**，仅将其写入文档与 Final return。真正 deploy 等待用户下一条明确确认。

---

## 13. Final return

```
POST_R5_P8C_STATUS                    : PASS
DEPLOY_SOURCE_COMMIT                  : a6e259d29d266d0d9e1a3463fcb80ccebabb2490
CLEAN_WORKTREE_PATH                   : /Users/Shared/projects/jhzy-v2-deploy-r5-p8-clean
                                        （detached HEAD @ a6e259d，git status 空）
CLEAN_WORKTREE_PROOF                  : PASS（HEAD 精确匹配；status 0 含 --untracked-files=all）
DIFF_VS_ORIGINAL_ANCHOR_9c4c122       : CODE=1 文件（participation.ts +10/−4）
                                        DOC=1 文件（doc 45）；并行流 tree 命中 0 / 172
PARALLEL_STREAM_PULLED_IN             : NONE（public.ts / h5.ts / admin-notification-templates /
                                        notifications-wechat / security-headers /
                                        notification-orchestrator / activity-start-reminder-service /
                                        src/h5/ 全部 ABSENT；app.ts 无 strict:false 与新挂载；
                                        verifyPublic & maskHolderName 出现次数 = 0）
QUALITY_GATE                          : PASS（三绿）
TYPECHECK                             : PASS — tsc --noEmit exit 0
P5_TEST                               : PASS — 40/40
P6B_TEST                              : PASS — 32/32
PRODUCTION_D1_PREFLIGHT               : PASS 9/9（46 / 46 / 450500 / 450000 / 500 / 0 / 149692 / 413 / 0）
PRODUCTION_WORKER_CURRENT_VERSION     : bfff110b-4787-40cb-b982-6c692e699429（无外部 deploy）
PRODUCTION_TARGET_SAFE                : YES（env.production → jhzy-v2-prod / d372229f… /
                                        ENVIRONMENT=production；未指向 jhzy-v2-db 或 staging）
ROLLBACK_VERSION                      : bfff110b-4787-40cb-b982-6c692e699429
READY_FOR_PRODUCTION_DEPLOY_AUTHORIZATION : YES
AUTHORIZATION_TEXT                    : 见 §12（须用户复制确认；本任务未执行）
DOC_COMMIT_SHA                        : 本文件所在提交（完整 SHA 见 Final return —— 因文档与自身同
                                        commit，SHA 只能于提交创建后回填，文档内不硬编码自引用
                                        SHA 以免过期失效）
SECRET_PII_SCAN                       : PASS
PRODUCTION_WORKER_DEPLOYED            : NO
PRODUCTION_D1_MUTATED                 : NO（全部 SELECT 只读）
PRODUCTION_CERTIFICATE_ISSUED         : NO
SECRET_MUTATED                        : NO
JHZY_1_0_LIVE_TOUCHED                 : NO
GIT_PUSH_PERFORMED                    : NO
MAIN_WORKTREE_DIRTY_TOUCHED           : NO（28 项原样，stash=0，未 merge/rebase/reset/clean，
                                        修复未应用到主工作树，a6e259d 不在 master）
OTHER_WORKTREE_TOUCHED                : NO（jhzy-v2-r3f-deploy-20261003T174948 未动）
NEXT_ACTION                           : ① 用户复制 §12 授权文本确认
                                        ② 获授权后在 clean worktree 执行 deploy（锚点 a6e259d）
                                        ③ 按 §10 做只读 / preview smoke（不发证）
                                        ④ 观察期
                                        ⑤ P9 首条真实合规发证授权门
```

---

## 14. 纪律声明

- 本任务**未修改任何代码**：唯一变更是新增本文档（doc 46）。
- **未执行** `wrangler deploy`；production Worker 全程为 `bfff110b-4787-40cb-b982-6c692e699429`。
- production D1 调用**全部为 `--command SELECT`** 只读；无 INSERT / UPDATE / DELETE / DDL。
- **未调用**任何 production 发证接口；未写生产测试数据。
- 主工作树 28 项未提交并行流改动**零触碰**；未 stash / reset / clean / merge / rebase / cherry-pick。
- clean worktree 仅用于只读校验与质量门复跑；`a6e259d` 保持为稳定 deploy 锚点。
- 未修改 secrets、未访问 JHZY 1.0、未 push。
- 历史 worktree `jhzy-v2-r3f-deploy-20261003T174948` **未触碰**。

---

## 15. 提交说明

本文档以 **doc-only commit** 形式提交于**主工作树**，提交信息：

```
docs(certificates): authorize production deploy for fixed commit
```

**为何不放进 clean worktree**：doc 46 记录的核心对象是 clean worktree 的 `a6e259d`。若在 clean worktree 内提交该文档，clean worktree 的 HEAD 会从 `a6e259d` 前移，导致 §3.1 / §12 的授权锚点**立即失效**。故本文档提交于主工作树，**保持 `a6e259d` 为稳定、可复现的 deploy source commit**。

本次提交**仅含** `workers/docs/audits/2026-10-03-post-cutover-assurance/46-production-deploy-authorization-for-fixed-commit.md` 一个文件，**不含**主工作树任何 dirty 并行流文件。
