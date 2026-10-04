# 43 — POST-R5-P7 Production Deploy 执行中止（BLOCKED_ON_DIRTY_WORKTREE）

- 文档编号：43
- 日期：2026-10-04
- 阶段：POST-R5-P7（Production Deploy Authorization Gate）→ 执行阶段
- 前置：doc 42（授权闸门，PASS）· doc 41（P6B 客户端 team context，PASS）· doc 40（P6 staging 验证，PASS_WITH_FINDINGS）· doc 39（P5 wiring 实现，PASS）
- 授权来源：用户于 2026-10-04 15:44 明确复制并确认 doc 42 §6 授权文本
- **执行结论：BLOCKED — 未执行 `wrangler deploy --env production`，生产 Worker 保持 `bfff110b-4787-40cb-b982-6c692e699429` 不变**

---

## 0. 一句话结论

授权文本锚定的部署对象是 **git commit `9c4c122` 的代码状态**，但 `wrangler deploy` 打包的是**当前工作树**。
当前工作树包含 **28 项未提交改动（3,708 行 src 变更 + 8 个未跟踪新文件）**，属于**另一条并行流（P11-WP2 / P11-WP3 / P11-WP4 / S18 H5 / P6-2）**，且直接改写 `app.ts` 路由注册、鉴权会话写入与证书数据暴露面。

若照原样执行 deploy，**实际部署的将是这条未验证的并行流代码，而非 P5/P6 已通过质量门的发证 wiring**——这超出了本次授权范围，且会把从未在 staging 验证过的 H5 公开面与匿名证书验真端点上到生产。

因此按纪律 **STOP，不执行 deploy**，提请用户裁决。

---

## 1. Repo gate（通过）

| 项 | 值 | 判定 |
|---|---|---|
| `pwd` | `/Users/Shared/projects/jhzy-v2` | ✅ |
| `git rev-parse --show-toplevel` | `/Users/Shared/projects/jhzy-v2` | ✅ |
| `git branch --show-current` | `master` | ✅ |
| `git rev-parse HEAD` | `521635c6240049e280be6b00c591ca57b2ad905e` | ✅ |
| 授权锚点 commit `9c4c122…` | 存在（`git cat-file -t` = commit） | ✅ |

### 1.1 锚点漂移说明（**符合预期，非问题**）

授权文本写的是 `9c4c122`，而执行时 HEAD 已前移至 `521635c`。核查差异：

```
git diff --name-only 9c4c122..HEAD
→ workers/docs/audits/2026-10-03-post-cutover-assurance/42-production-deploy-authorization-gate.md
```

**唯一差异是 doc 42 本身（纯文档）**。`workers/src`、`workers/wrangler.jsonc`、`workers/migrations` 相对锚点**零差异**：

```
WORKERS_CODE_DIFF_EMPTY = YES
DIRTY_SRC_COUNT (相对 commit) = 0
```

→ **授权锚点的代码意图与 HEAD 代码完全一致**，doc 42 的前移不构成授权偏差。

---

## 2. ⛔ 阻断发现：工作树含未验证的并行流改动

### 2.1 规模

| 指标 | 值 |
|---|---|
| `workers/src` 已修改（tracked） | **20** 个文件 |
| `workers/src` 未跟踪（untracked） | **8** 个文件/目录 |
| src 变更行数合计 | **3,708** 行 |
| 最后修改时间 | 2026-09-30 00:20 ~ 01:05（约 5 天前） |
| `git stash list` | **0**（并行流工作**未**被 stash 保护） |

> 文件 mtime 均为 2026-09-30 凌晨，与 P5/P6/P7 提交时间（2026-10-03/04）不重叠 → 属**独立并行流遗留**，非本流产物。

### 2.2 改动性质：直接改写路由注册与全局中间件

`workers/src/app.ts`（+20/−1）未提交 diff 引入了：

| 引入项 | 所属并行流 | 生产影响面 |
|---|---|---|
| `import securityHeadersMiddleware` + `app.use('*', ...)` | P11-WP4 | **全局**响应头作用于所有端点 |
| `v2.route('/admin/notification-templates', ...)` | P11-WP2 | 新增平台管理员配置端点 |
| `v2.route('/notifications/wechat', ...)` | P11-WP2 | 新增微信通知触发端点 |
| `v2.route('/public', publicRoutes)` | P11-WP3 | **新增匿名可读** `/api/v2/public/*` |
| `app.route('/h5', h5)` + `src/h5/` | S18 | **新增匿名可读** `/h5/*` 页面路由 |
| `new Hono({ strict: false })` | P6-2 | **改变全站路由匹配语义**（尾斜杠容忍） |
| `v2.route('/health', health)` | P6-2 | 新增 `/api/v2/health` |

### 2.3 改动性质：改写证书数据暴露面

`workers/src/services/certificate-service.ts`（+24）与 `workers/src/repository/certificate.ts`（+42/−8）新增**匿名公开验真**能力：

- 新增 `CertificateService.verifyPublic(certNo, verifyCode)`，注释明示「**匿名可读，绕过 `ensureTableRead` 鉴权门禁**」
- 新增 `maskHolderName()` 姓名脱敏（保留首字符 + 掩码）
- 经由 `publicRoutes`（`/api/v2/public/*`）对外暴露

> **风险要点**：`verifyPublic` 明确绕过既有鉴权门禁。P5/P6/P6B 全部质量门与 RBAC 验证均建立在「证书读取必须经 `cert.view` / team scope」的不变式上（见 doc 40 §8、doc 41）。该不变式在本次部署对象中**已被未提交改动推翻**，且此改动**从未经过 staging 验证、无对应 audit doc、无授权**。

### 2.4 改动性质：改写鉴权会话写入

`workers/src/routes/auth.ts`（+13/−4）按「冻结裁决 P5_FINAL_FREEZE §3」在**微信登录时写入** `sessions.device` / `sessions.platform`：

```
SessionService.create(user.id, { userAgent, ipHash, device, platform, ttlSeconds })
```

**缓解事实（已核实）**：迁移 `0043_session_device_platform.sql` 存在且 `migration_max = 46 ≥ 43`，即该两列在生产库**已存在** → 不会因缺列而 500。
但这**不改变阻断结论**：该改动属于 `P5_FINAL_FREEZE` 另一裁决线的交付物，**不在本次授权范围**，且其线上行为（多设备会话字段落库 + `/auth/sessions` 响应体新增 `device`/`platform`）未经本次任何验证。

### 2.5 P6 已验证的发证路径：**全部干净**（重要正面结论）

| 文件 | 状态 |
|---|---|
| `workers/src/routes/activities.ts` | **CLEAN** |
| `workers/src/routes/service-records.ts` | **CLEAN** |
| `workers/src/routes/certificates.ts` | **CLEAN** |
| `workers/src/services/certificate-issuance-service.ts` | **CLEAN** |
| `workers/src/repository/certificate-issuance.ts` | **CLEAN** |
| `workers/src/services/certificate-number-allocator.ts` | **CLEAN** |
| `workers/src/domain/certificate.ts` | **CLEAN** |

→ P5 实现的 activity/service 发证 wiring（含 0045 四列幂等命名空间、`issue_source` 判别列、`cert_srv` 号池 selector）**未被并行流触碰**。阻断原因**不是**发证代码被污染，而是**打包边界不可分离**。

---

## 3. 为何不能「顺手一起部署」

1. **超出授权**：用户授权的是「HEAD `9c4c122` 的 activity/service 证书发放 wiring」。并行流代码不在其中。
2. **无质量门**：并行流从未跑过 P5 测试（40/40）、P6B 契约测试（32/32）、P6 A–I staging 验证，亦无 audit doc。
3. **安全不变式被推翻**：`verifyPublic` 绕过鉴权 + `strict:false` 改全站路由语义 + 全局新中间件，三者叠加的组合行为**不在任何既有验证覆盖内**。
4. **回滚粒度不可分**：Worker 版本是整体 bundle，无法只回滚发证 wiring 而保留/撤销 H5 端点。一旦上线后需回滚，将连带撤销已验证的发证 wiring（或反之），失去 doc 42 §5.D 的干净回滚语义。
5. **生产数据风险**：新增 `/api/v2/public/*` + `/h5/*` 为匿名可读面，其输入校验/限流/隐私脱敏完整性未经验证，错误放行将直接作用于 413 张生产证书（含持证人姓名）。

---

## 4. 三个可选方案（提请裁决，**均未执行**）

### 方案 A — 从干净 commit 构建并部署（**推荐**）

在**不触碰**当前工作树的前提下，用 git 取出纯净 `9c4c122` 树到独立目录，构建后以该产物部署。

- 优点：部署对象 = 授权锚点的精确代码状态；并行流工作**零影响**（工作树不 clean、不 stash、不 reset）
- 实现：`git worktree add <临时目录> 9c4c122` → 在该目录 `npm ci` → `wrangler deploy --env production`
- 风险：需临时目录内安装依赖（只读生产，不写生产 D1）；worktree 需事后清理
- 需注意：`wrangler.jsonc` 在 `9c4c122` 处的 `[env.production]` 绑定须复核（doc 42 §3.D 已验证 `521635c` 版本，锚点版本极可能相同，需再确认一次）

### 方案 B — 先由并行流所有者提交并走独立闸门，再统一部署

要求 P11-WP2/WP3/WP4 + S18 H5 + P6-2 先 commit、补 staging 验证与 audit doc（尤其 `verifyPublic` 匿名面与 `strict:false` 的回归），之后重新走一次授权闸门。

- 优点：一次部署覆盖全部已验证代码，无版本碎片
- 代价：周期长；发证 wiring 上线被并行流阻塞

### 方案 C — 显式扩大授权范围

用户明确授权「同时部署工作树当前状态（含并行流）」，并接受其未验证风险。

- 优点：最快
- 代价：**不建议**。授权文本明确「activity/service 证书发放 wiring」为部署对象；扩范围需用户显式重写授权，且匿名验真面风险应先做独立安全评估

---

## 5. 本次执行未发生的动作（负向清单）

| 动作 | 状态 | 证据 |
|---|---|---|
| `wrangler deploy --env production` | **NOT EXECUTED** | production active version 仍为 `bfff110b-4787-40cb-b982-6c692e699429` |
| production D1 写入 | **NO** | 本阶段全部 D1 调用均为 `--command SELECT` 只读 |
| production 证书签发 | **NO** | 未调用任何 issue 端点 |
| production secrets 修改 | **NO** | 未执行任何 secret 写操作 |
| JHZY 1.0 live 触碰 | **NO** | 未访问 |
| `git push` | **NO** | 本次仅本地 commit |
| `git stash` / `reset` / `clean` | **NO** | 工作树 28 项并行流改动原样保留 |
| staging D1 写入 | **NO** | — |
| 无关修复 | **NO** | 未修改任何代码 |

**部署前后 production D1 快照**（本阶段只读复核，与 doc 42 §3.B 完全一致）：

```
migration_count=46  migration_max=46
id_pools_total=450500  legacy_migrated=450000  synthetic_compat=500  null_provenance=0
cert_srv_available_legacy=149692
certificates_count=413
```

→ 生产 D1 状态与 P7 闸门时**逐项一致**，无漂移。

---

## 6. Final return

```
POST_R5_P7_EXECUTION_STATUS      : BLOCKED_ON_DIRTY_WORKTREE
BLOCK_REASON                     : wrangler deploy 打包工作树；workers/src 含 28 项未提交并行流改动
                                  （P11-WP2/WP3/WP4 + S18 H5 + P6-2，3708 行），部署对象 ≠ 授权锚点
AUTHORIZED_ANCHOR               : 9c4c1228d9cfa5cfb49214fecb5ca9c802aa9aa9
START_HEAD                       : 521635c6240049e280be6b00c591ca57b2ad905e
ANCHOR_TO_HEAD_CODE_DIFF         : EMPTY（仅 doc 42 文档差异，授权意图无偏差）
DIRTY_SRC_FILES                  : 28（20 modified + 8 untracked）
DIRTY_SRC_LINES                  : 3708
DIRTY_SRC_LAST_MTIME             : 2026-09-30 00:20~01:05（独立并行流，非本流）
GIT_STASH_COUNT                  : 0
P6_ISSUANCE_FILES_DIRTY          : 0 / 7（activities / service-records / certificates /
                                   certificate-issuance-service / certificate-issuance /
                                   certificate-number-allocator / domain-certificate 全 CLEAN）
UNAUTHENTICATED_NEW_SURFACE      : /api/v2/public/*（P11-WP3）、/h5/*（S18）
AUTH_BYPASS_RISK                 : CertificateService.verifyPublic 注释明示绕过 ensureTableRead
GLOBAL_ROUTE_SEMANTICS_CHANGED   : app.ts new Hono({ strict:false })（P6-2）
SESSIONS_COLUMN_MIGRATION        : 0043 存在且已应用（migration_max=46）→ 非缺列 500 风险
PRODUCTION_WORKER_BEFORE          : bfff110b-4787-40cb-b982-6c692e699429
PRODUCTION_WORKER_AFTER           : bfff110b-4787-40cb-b982-6c692e699429（未变）
PRODUCTION_D1_PREFLIGHT_RECHECK  : PASS（9 指标与 doc 42 §3.B 逐项一致，零漂移）
PRODUCTION_TARGET_SAFE           : YES（[env.production] → jhzy-v2-prod / d372229f…）
PRODUCTION_WORKER_DEPLOYED       : NO
PRODUCTION_D1_MUTATED            : NO
PRODUCTION_CERTIFICATE_ISSUED    : NO
SECRET_MUTATED                   : NO
JHZY_1_0_LIVE_TOUCHED            : NO
GIT_PUSH_PERFORMED               : NO
GIT_STASH_RESET_CLEAN_PERFORMED  : NO（并行流工作原样保留）
UNRELATED_FIXES                  : NO
SECRET_PII_SCAN                  : PASS
READY_FOR_PRODUCTION_DEPLOY      : BLOCKED（需先裁决部署产物边界）
RECOMMENDED_OPTION               : 方案 A —— git worktree 取出纯净 9c4c122 构建部署，
                                   不触碰当前工作树
NEXT_ACTION                      : 用户裁决 §4 方案 A/B/C；若选 A，额外授权创建临时 git worktree
                                   并在其中执行 npm ci + wrangler deploy --env production
```

---

## 7. 纪律声明

- 本阶段**未执行**任何生产写动作；`wrangler deploy` 未被调用。
- 未对并行流的 28 项未提交改动做任何写操作（未 stash / 未 reset / 未 clean / 未 commit）。
- 未修改任何源代码、配置或 secret。
- 本文档为唯一新增文件；`git commit` 仅含本文件，**不 push**。
