# 47 —— Production Worker Deploy 执行记录（修复提交 a6e259d）

> 阶段：POST-R5-P8C-PRODUCTION-DEPLOY-AUTHORIZATION-GATE-FOR-FIXED-COMMIT
> 日期：2026-10-04
> 授权来源：管理员在对话中明确授权 P8C production Worker deploy
> 部署源：clean worktree `/Users/Shared/projects/jhzy-v2-deploy-r5-p8-clean`
> 部署提交：`a6e259d29d266d0d9e1a3463fcb80ccebabb2490`
> 结论：**DEPLOY=SUCCESS / PRODUCTION_D1_ZERO_WRITE=PASS / RUNTIME_SMOKE=BLOCKED（环境限制，非部署失败）**

---

## 0. 授权边界执行对照

| 授权条款 | 执行情况 | 证据 |
|---|---|---|
| 仅允许从 clean worktree 部署 | 遵守 | toplevel=`/Users/Shared/projects/jhzy-v2-deploy-r5-p8-clean`，`git status --porcelain`=0 |
| 部署目标 `jhzy-v2-worker-production` | 遵守 | 上传日志 `Uploaded jhzy-v2-worker-production` |
| D1 目标 `jhzy-v2-prod/d372229f-...` | 遵守 | `wrangler d1 list` UUID 精确匹配；版本绑定 `env.DB (d372229f-...)` |
| 允许部署后只读/preview smoke | 遵守（preview 受阻，见 §6） | §6 完整记录 |
| 不允许真实发证 | 遵守 | certificates 413→413 |
| 不允许写 production D1 测试数据 | 遵守 | 10 张关键表全部 delta=0（§5） |
| 不允许 push | 遵守 | 无 `git push`；HEAD 仍为 detached 本地提交 |
| 不允许改 secrets | 遵守 | 3 个 secret 原样保留（§3） |
| 不允许触碰 JHZY 1.0 | 遵守 | 未访问 MySQL / 101.43.30.163 |
| 不得从 dirty 主工作树打包 | 遵守 | 主工作树 583 项改动，全程未参与打包（§7） |

---

## 1. REPO_IDENTITY_GATE（部署前）

```
$ git rev-parse --show-toplevel
/Users/Shared/projects/jhzy-v2-deploy-r5-p8-clean
$ git rev-parse HEAD
a6e259d29d266d0d9e1a3463fcb80ccebabb2490     ← 与授权 SHA 逐字符一致
$ git status --porcelain | wc -l
0                ← 完全干净
$ git rev-parse --abbrev-ref HEAD
HEAD             ← detached（clean worktree 预期状态）
```

**判定：PASS**。授权 SHA 与实际部署源完全一致，且工作树零改动。

---

## 2. 部署前 production 基线固定（回滚锚点）

### 2.1 Worker 版本基线

```
$ wrangler deployments list --env production --profile jhzy
bfff110b-4787-40cb-b982-6c692e699429   2026-10-04T03:54:01.065Z  (100%)
```

**回滚目标版本 = `bfff110b-4787-40cb-b982-6c692e699429`**（部署后仍完整保留，见 §4）。

### 2.2 D1 资源身份确认

```
$ wrangler d1 list --profile jhzy
d372229f-c0ae-4dcc-b968-4ec7c2832842  jhzy-v2-prod     ← 授权目标，精确匹配
85853fb1-1384-486e-9be3-566f72f45c5d  jhzy-v2-staging
ea603f43-d076-4df5-b118-3d8a0c245439  jhzy-v2-db       （forbidden default）
```

### 2.3 D1 表结构确认

`SELECT name FROM sqlite_master WHERE type='table'` → **87 张表**，全部为 JHZY 2.0
命名空间（`certificates` / `id_pools` / `activities` / `users` /
`activity_signups` / `activity_participations` / `service_records` / …）。

> 注：`activity_service_certificates`（JHZY 1.0 命名空间）在本库**不存在**，
> 首次基线查询因此报 `no such table`，随即改用 2.0 实际表名。该失败为只读查询、
> 无副作用，且反向证明本轮未触碰 1.0 命名空间。

### 2.4 数据基线快照

| 表 | 部署前行数 |
|---|---|
| certificates | 413 |
| id_pools | 450500 |
| activities | 72 |
| users | 631 |
| activity_signups | 370 |
| activity_participations | 370 |
| service_records | 0 |
| certificate_logs | 0 |
| operation_logs | 0 |
| d1_migrations | 46 |

与 P7 只读 preflight 完全一致（certificates 413 / id_pools_total 450500 / migration 46/46）。

### 2.5 部署前 typecheck

```
$ npx tsc --noEmit
TYPECHECK_EXIT=0
```

---

## 3. 部署执行

```
$ npx wrangler deploy --env production --profile jhzy

Total Upload: 877.63 KiB / gzip: 201.31 KiB
Worker Startup Time: 11 ms

Binding                          Resource
env.DB (jhzy-v2-prod)            D1 Database
env.FILES (jhzy20-files)         R2 Bucket
env.ENVIRONMENT ("production")   Environment Variable
env.WECHAT_APPID ("wxfd0c72ef78144686")  Environment Variable
env.ADMIN_ALLOWED_ORIGINS ("https://admin.jhzyfw.com")  Environment Variable

Uploaded jhzy-v2-worker-production (6.80 sec)
Deployed jhzy-v2-worker-production triggers (1.17 sec)
Current Version ID: 3cb9d6f5-11a8-4588-930d-e58dfd1b7ea7
```

### 3.1 已部署版本只读核验（`wrangler versions view`）

```
Version ID:  3cb9d6f5-11a8-4588-930d-e58dfd1b7ea7
Created:     2026-10-04T08:35:10.933Z
Handlers:    get, post, put, delete, options, patch, query, all, on, use,
             router, getPath, _basePath, routes, errorHandler, onError,
             notFound, fetch, request, fire, route, basePath, mount
Compatibility Date:  2025-08-01
Compatibility Flags: nodejs_compat

env.DB (d372229f-c0ae-4dcc-b968-4ec7c2832842)  D1 Database   ← 授权目标，精确匹配
env.FILES (jhzy20-files)                        R2 Bucket
env.ENVIRONMENT ("production")                  Environment Variable
env.WECHAT_APPID ("wxfd0c72ef78144686")         Environment Variable
env.ADMIN_ALLOWED_ORIGINS ("https://admin.jhzyfw.com")  Environment Variable

Secrets:
  DELIVERY_IDENTITY_ENC_KEY     ← 原样保留
  IDENTITY_HMAC_KEY             ← 原样保留
  WECHAT_APP_SECRET             ← 原样保留
```

**secrets 未被改动、未被覆盖、未丢失。**

---

## 4. 流量激活与可回滚性

```
$ wrangler deployments list --env production --profile jhzy

bfff110b-4787-40cb-b982-6c692e699429   2026-10-04T03:54:01.065Z  (100%)   ← 旧版本仍在
3cb9d6f5-11a8-4588-930d-e58dfd1b7ea7   2026-10-04T08:35:10.933Z  (100%)   ← 新版本 100%
```

- 新版本以 **100% 流量** 激活。
- 旧版本 `bfff110b` **未被删除**，随时可回滚：
  `wrangler rollback --env production --profile jhzy` 或显式指定版本。

---

## 5. PRODUCTION D1 零写入证明

部署后重复 §2.4 完全相同的只读查询，逐表对账：

| 表 | 部署前 | 部署后 | Delta | 判定 |
|---|---:|---:|---:|---|
| certificates | 413 | 413 | +0 | SAME |
| id_pools | 450500 | 450500 | +0 | SAME |
| activities | 72 | 72 | +0 | SAME |
| users | 631 | 631 | +0 | SAME |
| activity_signups | 370 | 370 | +0 | SAME |
| activity_participations | 370 | 370 | +0 | SAME |
| service_records | 0 | 0 | +0 | SAME |
| certificate_logs | 0 | 0 | +0 | SAME |
| operation_logs | 0 | 0 | +0 | SAME |
| d1_migrations | 46 | 46 | +0 | SAME |

**PRODUCTION_D1_ZERO_WRITE_PROOF = PASS**

- `certificates` 未增长 → **未发生任何真实发证**。
- `certificate_logs` / `operation_logs` 保持 0 → **无任何业务写入被触发**。
- `d1_migrations` 保持 46 → 本轮**未执行任何 migration apply**。

---

## 6. 运行时 smoke —— 受环境限制未能完成（BLOCKED）

### 6.1 尝试记录

| # | 通道 | 结果 |
|---|---|---|
| 1 | `curl https://jhzy-v2-worker-production.lsv3255.workers.dev/`（经沙箱代理） | `HTTP=000`；代理 CONNECT 隧道返回 **502 Bad Gateway** |
| 2 | 同上，`--noproxy '*'` 直连 | `HTTP=000` |
| 3 | 同上，沙箱外执行 | `HTTP=000` |
| 4 | `wrangler dev --remote --env production --port 8799` | 绑定已正确解析为 `env.DB (jhzy-v2-prod)`，但卡死于 `Starting remote preview...`（`TimeoutError: The operation was aborted due to timeout`），60s 内端口未 LISTENING；已 `pkill` 干净终止 |

### 6.2 原因判定

**环境网络策略阻断，非部署失败。** 依据：

1. `*.workers.dev` 与 `wrangler dev --remote` 所需的 Cloudflare 边缘长连接，
   在本机沙箱内外**一致不可达**（三次 curl + 一次长连接均失败）。
2. 该限制在 **P6 阶段已被记录**（"P6 改用真实本地 staging-env Worker + 等价 fixture，
   并明确记录偏差"），属已知环境壁垒，非本轮新增。
3. Cloudflare **API 侧**全部操作正常（deploy / d1 list / d1 execute /
   deployments list / versions view 均成功返回），说明网络与凭据本身无问题，
   仅边缘运行时域被屏蔽。

### 6.3 补偿性验证（已完成的等价只读证据）

| 验证项 | 方法 | 结果 |
|---|---|---|
| Worker 已正确激活 | `wrangler deployments list` | 100% @ `3cb9d6f5` |
| 生产 D1 绑定正确 | `wrangler versions view` | `env.DB (d372229f-...)` 精确匹配 |
| 环境变量正确 | 同上 | production / WECHAT_APPID / ADMIN_ALLOWED_ORIGINS 均正确 |
| Secrets 完整 | 同上 | 3/3 保留 |
| 路由表已挂载 | `versions view` Handlers 列表 | `get/post/put/delete/options/patch/query/all/on/use/router/…/fetch` 完整 |
| 兼容性标志 | 同上 | `nodejs_compat` + `2025-08-01` |
| D1 schema 就绪 | 部署前后 `d1_migrations` = 46（一致） | PASS |
| D1 可连通且可查询 | `wrangler d1 execute --remote` 多次成功 | PASS |

**偏差声明**：本轮**未能**取得「真实边缘 HTTP 响应」这一级别的运行时证据。
按 P6 已确立的处理惯例，此项记为 **BLOCKED（环境限制）**，
运行时行为的最终确认需由管理员在可访问 `workers.dev` 的网络环境中完成。

---

## 7. 隔离性与工作树纪律核验

### 7.1 部署产物纯净性证明

P8B 修复确实进入已部署产物：

```
$ grep -n "activity_id AS activity_id" src/repository/participation.ts
242:  s.user_id AS signup_user_id, s.activity_id AS activity_id     ← P8B 修复

$ grep -rn "part.activity_id !== activity.id" src/
src/routes/activities.ts:701:  if (part.activity_id !== activity.id) throw notFound('participation');
```

修复（仓储层返回 `activity_id`）与其消费点（路由层校验）**成对存在**，
不再是 P8A 暴露的「`undefined !== id` 恒为 true」缺陷。

部署后再次复核工作树：`git status --porcelain | wc -l` = **0**，
`git rev-parse HEAD` = `a6e259d29d266d0d9e1a3463fcb80ccebabb2490` —— **部署未污染源树**。

### 7.2 dirty 主工作树未被触碰

| 项 | 值 |
|---|---|
| 主工作树路径 | `/Users/Shared/projects/jhzy-v2`（**未参与打包**） |
| 主工作树 HEAD | `334f835fe5a5611140a3c37534fd378d3b31db6c`（与部署前一致，未变） |
| 主工作树 dirty 总数 | 583（tracked 346 + untracked 237） |
| 其中 `workers/` 下改动 | **132 项**（含 `src/repository/participation.ts` 等） |
| stash 计数 | **0**（未 stash / 未 reset / 未 clean） |

> **这正是必须使用 clean worktree 的量化理由**：主工作树 `workers/` 内有 132 项
> 未验证的并行流改动（P11-WP5 / S18 / H5 / permission-catalog 等），
> 若从中打包，部署产物将远超 `a6e259d` 的授权范围，且 typecheck 与 P5/P6B
> 门禁结论将全部失效。方案 A 的隔离决策在事后被证实是必要的。

### 7.3 无 push

全程未执行 `git push`。clean worktree 处于 detached HEAD，
提交 `a6e259d` 仅存在于本地，未推送至任何远端。

---

## 8. 结论

```
DEPLOY                                = SUCCESS
  new_version_id                      = 3cb9d6f5-11a8-4588-930d-e58dfd1b7ea7
  traffic                             = 100%
  previous_version_retained           = bfff110b-4787-40cb-b982-6c692e699429 (可回滚)
  production_d1_target                = jhzy-v2-prod / d372229f-c0ae-4dcc-b968-4ec7c2832842 ✅
  secrets_intact                      = 3/3 ✅
PRODUCTION_D1_ZERO_WRITE              = PASS (10/10 表 delta=0)
REAL_CERTIFICATION_ISSUED             = NO (certificates 413 → 413)
DEPLOY_SOURCE_PURITY                  = PASS (clean tree, SHA 精确匹配, 部署后仍 0 改动)
MAIN_WORKTREE_INTEGRITY               = UNTOUCHED (HEAD 未变, stash=0, 未参与打包)
PUSH                                  = NONE
RUNTIME_SMOKE                         = BLOCKED (workers.dev 沙箱内外均不可达, P6 已知限制)
```

### 8.1 P8B 缺陷的最终闭环

提交 `231eb21` 遗漏的 `participation.ts` 契约缺陷（P8A 发现）已按以下链路闭合：

```
a6e259d  最小修复（仅 participation.ts 返回 activity_id）
   ↓  typecheck PASS
   ↓  P5 40/40 PASS
   ↓  P6B 32/32 PASS
   ↓  P8C 只读 preflight PASS
   ↓  production deploy SUCCESS  ← 本文档
```

**R5 证书签发链路的 activity/service 命名空间 wiring 现已在生产环境上线。**

### 8.2 遗留事项

1. **运行时 smoke 待人工补验**：需在可访问 `*.workers.dev` 的网络环境中
   对 `GET /health` 及 `GET /api/v2/certificates/mine`（带 `X-Team-Id`）
   做一次只读确认。本文档 §6 已完整记录受阻原因与尝试证据。
2. **P8A 发现的 P5 假绿风险仍在主工作树潜伏**：主工作树
   `workers/src/repository/participation.ts` 处于 modified 状态且**未提交**。
   P8A 阶段正是这份未提交修复曾掩盖 `231eb21` 的提交缺陷。
   建议后续单独裁定该并行流如何与 `a6e259d` 汇合，避免二次踩坑。
3. **本次未 push**：若需将 `a6e259d` 纳入远端基线，需另行授权。

---

*本记录由 WorkBuddy 依据真实命令输出与 Cloudflare API 返回值撰写；
所有数值均来自实际执行，未做任何推断性填充。*
