# 44 — POST-R5-P8A Clean Worktree Production Deploy（BLOCKED_ON_QUALITY_GATE）

- 文档编号：44
- 日期：2026-10-04
- 阶段：POST-R5-P8A（Clean Worktree Production Deploy）
- 前置：doc 43（BLOCKED_ON_DIRTY_WORKTREE）· doc 42（授权闸门 PASS）· doc 41 / 40 / 39
- 授权来源：用户于 2026-10-04 15:54 裁决**方案 A**（git worktree 干净提交部署），并明确「本次 production deploy 打包锚点使用 `9c4c1228d9cfa5cfb49214fecb5ca9c802aa9aa9`」
- **执行结论：BLOCKED_ON_QUALITY_GATE — 未执行 `wrangler deploy --env production`，生产 Worker 保持 `bfff110b-4787-40cb-b982-6c692e699429` 不变**

---

## 0. 一句话结论

方案 A 的 clean worktree 机制**本身运作完全正确**：`9c4c122` 抽出后工作树 `git status` 为空、并行流的 7 个文件与 `h5/` 目录**全部不存在**、`app.ts` 无 `strict:false`/`public`/`h5`/新中间件——打包边界精确等于授权锚点。

**但质量门在锚点代码上暴露了一个 P5 提交级缺陷（此前被主工作树的未提交改动掩盖）**：`tsc --noEmit` 失败 1 项，且 **P5 测试从 40/40 跌至 27/40**。按 P7 门禁「只有以上全部通过才执行 deploy」，**deploy 被阻断**。

---

## 1. 为何使用 clean worktree（背景）

doc 43 认定 P7 阻断的根因是：`wrangler deploy` 打包**工作树**而非 git commit，而主工作树 `workers/src` 当时含 28 项未提交改动（3,708 行，属 P11-WP2/WP3/WP4 + S18 H5 + P6-2 并行流），部署对象 ≠ 授权锚点。

方案 A 用 `git worktree` 抽出一个 detached 干净工作树，使打包来源**精确等于** `9c4c122`，且**完全不触碰**主工作树的 28 项并行流改动（不 stash / reset / clean）。

---

## 2. 主工作树只读 gate（未触碰）

| 项 | 值 |
|---|---|
| `pwd` / toplevel | `/Users/Shared/projects/jhzy-v2` ✅ |
| `HEAD` | `483c97a1419c697b8e7d79a7408513e44ccc1435` |
| `workers/src` + `wrangler.jsonc` + `migrations` 脏文件 | **28**（20 M + 8 ??），与 doc 43 记录一致 |
| `git stash list` | **0**（未 stash） |
| 目标目录 `/Users/Shared/projects/jhzy-v2-deploy-r5-p8-clean` | **ABSENT**（无旧残留，无需删除） |

**已存在的历史 worktree**：`/Users/Shared/jhzy-v2-r3f-deploy-20261003T174948`（detached `f3e40b4`，R3F 时期产物）→ **本任务全程未触碰**。

---

## 3. Clean worktree 建立与纯净性验证（PASS）

```
git worktree add /Users/Shared/projects/jhzy-v2-deploy-r5-p8-clean 9c4c1228d9cfa5cfb49214fecb5ca9c802aa9aa9
→ HEAD is now at 9c4c122 docs(certificates): confirm client team context readiness
```

| 校验项 | 结果 |
|---|---|
| `git rev-parse --show-toplevel` | `/Users/Shared/projects/jhzy-v2-deploy-r5-p8-clean` ✅ |
| `git rev-parse HEAD` | `9c4c1228d9cfa5cfb49214fecb5ca9c802aa9aa9` ✅ 与授权锚点一致 |
| `git status --short` | **空**（`STATUS_COUNT=0`）✅ |
| `npm ci` 后 status | **仍为 0**（`node_modules` 已 gitignore）✅ |

### 3.1 并行流文件排除验证（关键）

| 文件 | clean worktree |
|---|---|
| `workers/src/routes/public.ts` | **ABSENT** ✅ |
| `workers/src/routes/h5.ts` | **ABSENT** ✅ |
| `workers/src/middleware/security-headers.ts` | **ABSENT** ✅ |
| `workers/src/routes/admin-notification-templates.ts` | **ABSENT** ✅ |
| `workers/src/routes/notifications-wechat.ts` | **ABSENT** ✅ |
| `workers/src/services/notification-orchestrator.ts` | **ABSENT** ✅ |
| `workers/src/services/activity-start-reminder-service.ts` | **ABSENT** ✅ |
| `workers/src/h5/` | **ABSENT** ✅ |

`app.ts` 中 `strict: false` / `routes/public` / `routes/h5` / `security-headers` / `notification-templates` / `notifications-wechat` → **全部无匹配** ✅

→ **打包边界 = 授权锚点，方案 A 机制验证通过。**

### 3.2 关键文件存在性（7/7 EXISTS）

`workers/wrangler.jsonc` · `workers/src/routes/activities.ts` · `workers/src/routes/service-records.ts` · `workers/src/services/certificate-issuance-factory.ts` · `workers/src/services/certificate-eligibility-policies.ts` · `workers/tests/p_r5_activity_service_issuance.test.mjs` · `miniprogram/tests/cert_team_context_contract.mjs`

---

## 4. Wrangler production binding 核对（PASS）

`[env.production]`（锚点版本）：

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
| `env.production` → DB | `jhzy-v2-prod` / `d372229f-c0ae-4dcc-b968-4ec7c2832842` | ✅ 正确 |
| `env.production` → ENVIRONMENT | `production` | ✅ |
| forbidden `jhzy-v2-db`（`ea603f43…`） | **仅 top-level default**，`--env production` 不使用 | ✅ 未被选中 |
| `jhzy-v2-staging`（`85853fb1…`） | `env.staging` 独立绑定 | ✅ 未被选中 |

**PRODUCTION_TARGET_SAFE = YES**（若继续 deploy，目标本会正确）

---

## 5. 依赖安装（仅 clean worktree）

```
cd /Users/Shared/projects/jhzy-v2-deploy-r5-p8-clean/workers
npm ci --no-audit --no-fund   → added 42 packages in 18s
```

- **仅在 clean worktree 内执行**；主工作树 `node_modules` 未被触碰
- `package-lock.json` **未变更**、**未提交**（worktree status 保持 0）
- 未执行 `npm install`（避免 lockfile 漂移）

---

## 6. ⛔ 质量门：FAIL（deploy 阻断点）

### 6.1 `npm run typecheck`（`tsc --noEmit`）— 失败 1 项

```
src/routes/activities.ts(701,14): error TS2339:
  Property 'activity_id' does not exist on type 'ParticipationRow & { signup_user_id: number; }'.
```

**TYPECHECK_EXIT = 2（失败）**

### 6.2 `node --test tests/p_r5_activity_service_issuance.test.mjs` — **27/40 PASS（13 FAIL）**

```
P_R5 RESULT: 27/40 PASS
=== P_R5 = BLOCKED ===
```

失败项（完整）：

| 用例 | 观测 | 判定 |
|---|---|---|
| C 单人发证 200 | `status=404` | ❌ |
| C `outcome=ISSUED` | `outcome=undefined` | ❌ |
| C `certificatePublicId` 非空 | 空 | ❌ |
| C `userId=6` | 空 | ❌ |
| C-DB 本地证书落库(volC activity) | `n=0` | ❌ |
| C-DB 审计 success 落库 | `n=0` | ❌ |
| D `issued=0`（期望 1） | `issued=1` | ❌ 断言反向 |
| D `alreadyIssued=1`（volC 已发） | `ai=0` | ❌ |
| D `alreadyIssued` 含 volC | 缺 | ❌ |
| D 批量账本计数正确(COMPLETED) | `issued=1, already_issued=0, ineligible=1, failed=0` | ❌ 账本分类错误 |
| E 幂等 200 | `status=404` | ❌ |
| E `outcome=ALREADY_ISSUED` | `undefined` | ❌ |
| I 活动本人自发证 → 403 | `status=404` | ❌ 404 先于 403 触发 |

**通过项**（证明并非全盘失效）：A1–A4 鉴权/RBAC 全部 PASS · B 预览 3 例 PASS · D 批量 HTTP 200 + `notEligible`/`failed` 分类 PASS · F/G/H 服务发证链路 **全部 PASS**（含 `issue_source=service` 命名空间与幂等）· J 服务自发证 403 PASS · K/L PASS

### 6.3 根因（P5 提交级缺陷，**非**并行流污染）

`workers/src/routes/activities.ts:700-701`（锚点代码，P5 于 `231eb21` 提交）：

```ts
const part = await partRepo.findByPublicIdWithSignup(participantPublicId, tenant.teamId);
if (part == null) throw notFound('participation');
// 参与行归属本活动校验（防 IDOR：participantId 指向其它活动的参与行）。
if (part.activity_id !== activity.id) throw notFound('participation');   // ← line 701
```

而锚点 `workers/src/repository/participation.ts` 的 `findByPublicIdWithSignup`：

```ts
): Promise<(ParticipationRow & { signup_user_id: number }) | null> {
  return this.first<...>(
    `SELECT p.id, p.public_id, p.signup_id, p.occurrence_id, p.slot_id, p.occurrence_position_id,
            p.status, p.cancelled_at, p.created_at, p.updated_at,
            s.user_id AS signup_user_id              // ← 未 SELECT s.activity_id
       FROM activity_participations p
       JOIN activity_signups s ON s.id = p.signup_id
       JOIN activities a ON a.id = s.activity_id
      WHERE p.public_id = ? AND a.team_id = ? AND a.deleted_at IS NULL`,
    [publicId, teamId],
  );
}
```

- `ParticipationRow` 接口（line 27-38）**不含** `activity_id`
- SQL **未选取** `s.activity_id`
- → 运行时 `part.activity_id === undefined`，`activity.id` 为 number
- → **`undefined !== number` 恒为 true** → 该路由**在任何输入下都抛 404**

**运行时后果（若强行部署）**：

| 路由 | 后果 |
|---|---|
| `POST /api/v2/activities/:activityId/participants/:participantId/certificate/issue` | **完全不可用，恒 404**（单人活动发证功能整体失效） |
| 自发证防护用例 I | 404 先于 403 触发（安全语义仍闭合，但错误码语义错误） |
| 批量 `issue` | HTTP 200 但把目标计入 `issued` 而非 `alreadyIssued` → **批量幂等分类错误，账本 `already_issued` 计数失真** |
| 服务记录发证链路 | **不受影响**（`issue_source='service'`，独立命名空间，全部 PASS） |

**为何 P6/P7 未发现**：P6 staging 验证与 P7 阶段 §4 质量门均在**主工作树**执行，而主工作树 `repository/participation.ts` 的**未提交** diff 恰好包含该修复：

```diff
-  ): Promise<(ParticipationRow & { signup_user_id: number }) | null> {
+  ): Promise<(ParticipationRow & { signup_user_id: number; activity_id: number }) | null> {
-              p.status, p.cancelled_at, p.created_at, p.updated_at, s.user_id AS signup_user_id
+              p.status, p.cancelled_at, p.created_at, p.updated_at,
+              s.user_id AS signup_user_id, s.activity_id AS activity_id
```

该 diff 注释自称 `POST-R5-P5：单人发证路由需据 activity_id 校验参与行确属本活动（防 IDOR）`——即**它是 P5 自身的配套修复，在 P5 收尾时遗漏提交**，而非 P11 并行流的产物。

**证据链影响（须记录）**：doc 42 §4「QUALITY_EVIDENCE: typecheck exit 0; P5 40/40」与 doc 40 的 P6 A–I 结论，**均在含未提交修复的工作树上取得**，不能作为锚点代码的证据。doc 43 §2.5 曾判定「P5/P6 已验证的 7 个发证文件全部 CLEAN」——该结论对 `activities.ts` 成立（文件本身未改），但**其运行所依赖的仓储层契约在锚点缺失**，故 P6 的 C/E/H2/I 单人发证类结论**在锚点代码上不成立**。

### 6.4 P6B 契约测试（PASS，不依赖 workers 树）

```
node miniprogram/tests/cert_team_context_contract.mjs
→ RESULT: 32 passed, 0 failed
```

---

## 7. ⛔ Deploy 未执行

依 P7 门禁「**只有以上全部通过才执行**」，§6 质量门 FAIL → **Step 6 deploy 跳过**。

| 检查 | 状态 |
|---|---|
| `wrangler deploy --env production` | **NOT EXECUTED** |
| production Worker active version（部署后复核） | **`bfff110b-4787-40cb-b982-6c692e699429`（未变）** |
| HTTP smoke | **NOT ATTEMPTED**（deploy 未发生，无新版本可测） |
| preview smoke | **NOT ATTEMPTED**（同上；且不会以生产 fixture 伪造） |

---

## 8. Production 只读 preflight（9/9 一致，零漂移）

`wrangler d1 list`（UUID 三者与冻结值一致）：

| 名称 | UUID |
|---|---|
| `jhzy-v2-prod` | `d372229f-c0ae-4dcc-b968-4ec7c2832842` ✅ |
| `jhzy-v2-staging` | `85853fb1-1384-486e-9be3-566f72f45c5d` ✅ |
| `jhzy-v2-db`（forbidden default） | `ea603f43-d076-4df5-b118-3d8a0c245439` ✅ |

`d1 execute jhzy-v2-prod --remote`（**全部 SELECT，只读**）：

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

`duplicate_source_key` 存量 legacy 备注（`issue_source=NULL` 命名空间，6 组）沿用 doc 42 §3.B.1，**不作为阻断**。

**D1_MUTATION_CHECK = NO MUTATION**（preflight 与 doc 42/43 逐项一致；`certificates_count` 仍 413、`cert_srv_available_legacy` 仍 149692、`id_pools_total` 仍 450500）

---

## 9. 建议修复（最小、可审计，**未执行**）

**单文件最小修复**：在锚点 `workers/src/repository/participation.ts` 的 `findByPublicIdWithSignup` 中补 `s.activity_id AS activity_id` 并扩展返回类型 —— 即把主工作树那段未提交 diff 中的 P5 配套部分**单独提交**。

- 改动面：1 个文件、2 处（SELECT 列表 + 返回类型）
- 不触碰任何业务逻辑、路由契约、DB schema（`activity_signups.activity_id` 早已存在）
- 修复后预期：`tsc --noEmit` exit 0；P5 测试回到 40/40

**流程建议**（避免再次污染证据链）：

1. 在 **clean worktree** 内实施该最小修复（不碰主工作树）
2. 同一 clean worktree 内重跑 `npm run typecheck` + P5 40/40 + P6B 32/32，三绿方可继续
3. 在主工作树以**独立 commit** 提交该修复（如 `fix(certificates): select activity_id for participation IDOR guard`）
4. 重新走一次 production deploy 授权闸门（锚点改为新 commit）
5. deploy → 只读/preview smoke → 观察期 → P9 首条真实发证授权门

> 另建议：后续所有「质量门证据」必须在**待部署的同一 clean worktree** 内取得，避免主工作树未提交改动再次掩盖提交级缺陷。

---

## 10. Final return

```
POST_R5_P8A_STATUS              : BLOCKED_ON_QUALITY_GATE
BLOCK_REASON                    : 锚点代码 typecheck 失败 1 项（activities.ts:701 TS2339）
                                  + P5 测试 27/40（13 FAIL），P7 门禁要求全通过方可 deploy
CLEAN_WORKTREE_MECHANISM        : PASS（status=0；并行流 7 文件 + h5/ 全部 ABSENT；
                                  app.ts 无 strict:false/public/h5/新中间件 → 打包边界=锚点）
DEPLOY_SOURCE_COMMIT            : 9c4c1228d9cfa5cfb49214fecb5ca9c802aa9aa9（未部署）
CLEAN_WORKTREE_PATH             : /Users/Shared/projects/jhzy-v2-deploy-r5-p8-clean
                                  （detached HEAD 9c4c122，保留为证据目录）
NPM_CI                          : added 42 packages（仅 clean worktree；lockfile 未变更/未提交）
QUALITY_GATE                    : FAIL
  TYPECHECK                     : FAIL — src/routes/activities.ts(701,14) TS2339
  P5_TEST                       : FAIL — 27/40 PASS, 13 FAIL（C 单人发证 404 / E 幂等 404 /
                                  I 自发证 404 / D 批量幂等分类错误与账本失真）
  P6B_CONTRACT_TEST             : PASS — 32/32
PRODUCTION_TARGET_SAFE          : YES（env.production → jhzy-v2-prod / d372229f…，
                                  ENVIRONMENT=production；未指向 jhzy-v2-db / staging）
PRODUCTION_D1_PREFLIGHT_BEFORE  : PASS 9/9（46/46, 450500, 450000, 500, 0, 149692, 413, 0）
PRODUCTION_WORKER_OLD_VERSION   : bfff110b-4787-40cb-b982-6c692e699429
PRODUCTION_WORKER_NEW_VERSION   : N/A（deploy 未执行）
PRODUCTION_DEPLOYED             : NO
D1_MUTATION_CHECK               : NO MUTATION（preflight 与 doc 42/43 逐项一致，零漂移）
HTTP_SMOKE                      : NOT_ATTEMPTED_NO_DEPLOY
PREVIEW_SMOKE                   : NOT_ATTEMPTED_NO_DEPLOY
ROOT_CAUSE                      : P5(231eb21) 提交 activities.ts IDOR 校验 part.activity_id，
                                  但配套仓储改动（participation.ts 补 s.activity_id +
                                  返回类型）从未提交 → 运行时 undefined !== number 恒真
                                  → 单人发证路由恒 404；批量幂等分类与账本失真
                                  服务记录发证链路不受影响（独立 issue_source 命名空间）
EVIDENCE_CONTAMINATION_NOTE     : doc 40(P6) / doc 42(§4) 的 typecheck 0 与 P5 40/40 均取自
                                  主工作树（含未提交修复），不构成锚点代码证据
MAIN_WORKTREE_DIRTY_FILES_TOUCHED: NO（28 项脏改动原样保留，stash=0，未 reset/clean）
OTHER_WORKTREE_TOUCHED          : NO（jhzy-v2-r3f-deploy-20261003T174948 未触碰）
ROLLBACK_VERSION                : bfff110b-4787-40cb-b982-6c692e699429（deploy 未发生，无需回滚）
PRODUCTION_CERTIFICATE_ISSUED   : NO
PRODUCTION_D1_TEST_DATA_WRITTEN : NO
SECRET_MUTATED                  : NO
JHZY_1_0_LIVE_TOUCHED           : NO
GIT_PUSH_PERFORMED              : NO
DOC_COMMIT_SHA                  : （见 §11，本文件单独 commit）
SECRET_PII_SCAN                 : PASS
READY_FOR_PRODUCTION_DEPLOY     : NO — 须先修复 §9 最小缺陷并重跑质量门三绿
NEXT_ACTION                     : 用户裁决是否授权「在 clean worktree 内实施 participation.ts
                                  最小修复 + 重跑三绿 + 独立 commit + 重走部署授权闸门」
```

---

## 11. 纪律声明

- **未执行** `wrangler deploy`；production Worker 全程为 `bfff110b-4787-40cb-b982-6c692e699429`。
- production D1 调用**全部为 `--command SELECT`** 只读快照；无 INSERT/UPDATE/DELETE/DDL。
- **未调用**任何 issue 端点（本地 P5 测试仅打本地 worker，非生产）。
- 主工作树 28 项未提交并行流改动**零触碰**（未 stash / reset / clean / commit / 删改）。
- `jhzy-v2-r3f-deploy-20261003T174948` 历史 worktree **零触碰**。
- 未修改 secrets、未访问 JHZY 1.0、未 push。
- 依赖安装仅在 clean worktree（`npm ci`），主工作树 `node_modules` 未变，`package-lock.json` 未提交。
- 本文档为唯一新增文件，`git commit` 仅含本文件。
