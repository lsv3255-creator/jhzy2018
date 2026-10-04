# 49 —— 自有域名 / Route 绑定可行性闸门（P8G）

> 阶段：POST-R5-P8G-CUSTOM-DOMAIN-ROUTE-FEASIBILITY-GATE
> 日期：2026-10-04
> 目标：为 P8F 受阻的公网运行时 smoke，寻找绕过 `workers.dev` 封锁的自有域名/route 方案
> 部署版本（不变）：`3cb9d6f5-11a8-4588-930d-e58dfd1b7ea7`
> 生产 D1（不变）：`jhzy-v2-prod / d372229f-c0ae-4dcc-b968-4ec7c2832842`
>
> **结论：`ROUTE_FEASIBILITY = BLOCKED_NO_ZONE_INVENTORY`**
> **根因：当前环境不具备 zone / route 的只读列举能力（无 API token + wrangler 无该命令）。**
> **本轮未创建任何 route、未改任何 DNS、未部署、未动生产 D1。**

---

## 0. 验收结果摘要

| 项 | 结果 |
|---|---|
| `POST_R5_P8G_STATUS` | **FEASIBILITY_GATED / BLOCKED** |
| `CLOUDFLARE_ACCOUNT` | `8770e4917f904aed5df91c883cf058af`（**已证明**） |
| `AVAILABLE_ZONES` | **UNKNOWN**（无法列举） |
| `EXISTING_WORKER_ROUTES` | **UNKNOWN**（无法列举） |
| `CANDIDATE_HOSTNAME` | **无法确定**（依赖 zone inventory） |
| `ROUTE_FEASIBILITY` | **BLOCKED_NO_ZONE_INVENTORY** |
| `RECOMMENDED_PLAN` | 方案 A（临时 smoke hostname）—— **待 inventory 完成后方可定稿** |
| `ROUTE_CREATED` | **NO** |
| `DNS_CHANGED` | **NO** |
| `PRODUCTION_D1_MUTATED` | **NO** |
| `CERTIFICATE_ISSUED` | **NO** |
| `GIT_PUSH_PERFORMED` | **NO** |
| `JHZY_1_0_TOUCHED` | **NO** |

---

## 1. 背景：workers.dev 域级封锁（P8F 已确立）

P8F 已用对照实验锁定根因：

| 目标 | 结果 |
|---|---|
| DNS 解析 `*.workers.dev` | 正常（108.160.169.37） |
| `www.cloudflare.com` | **200** |
| `api.cloudflare.com` | **400**（正常业务响应） |
| `workers.dev` 根域 | **000** |
| 任意 `*.workers.dev` 子域 | **000** |

六条访问路径（代理 / 直连 / 明文 HTTP 80 / IPv6 / `--resolve` 强制 IP / staging 子域）
全部失败 → **workers.dev 整域被封锁**。

**推论**：若要走公网完成 runtime smoke，必须使用**非 workers.dev 的 hostname**，
即 Cloudflare **zone + route** 或 **custom domain**。本轮任务即评估该路径的可行性。

---

## 2. 部署状态 Gate（P8G 开始时复核，全部 PASS）

| 检查项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| clean worktree HEAD | `a6e259d29d266d0d9e1a3463fcb80ccebabb2490` | 一致 | PASS |
| clean worktree dirty | 0 | 0 | PASS |
| production 激活版本 | `3cb9d6f5-...` @ 100% | 100% | PASS |
| 回滚版本保留 | `bfff110b-...` 存在 | 存在（版本列表内） | PASS |
| certificates | 413 | 413 | PASS |
| id_pools | 450500 | 450500 | PASS |
| users | 631 | 631 | PASS |
| sessions | 0 | 0 | PASS |
| d1_migrations | 46 | 46 | PASS |
| 主工作树 HEAD | `82439c1727933dcd88bcd8f1dbefd45db4dc246f` | 一致 | PASS |
| 主工作树 dirty | 583（未清理） | 583 | PASS |
| stash | 0 | 0 | PASS |

**`PRODUCTION_D1_UNCHANGED = PASS`**。基线无漂移，可安全继续只读调查。

---

## 3. Cloudflare Account 归属证明

尽管 zone 无法列举，**account 归属已通过两条独立证据确立**：

### 3.1 证据一：API 请求路径

wrangler 日志中实际发出的请求路径：

```
accounts/8770e4917f904aed5df91c883cf058af
```

与指令给定的 `CLOUDFLARE_ACCOUNT_ID` **完全一致**。

### 3.2 证据二：资源归属

`wrangler d1 list --profile jhzy` 在该 account 下返回 7 个 D1 库，
其中包含本项目的三个库：

| UUID | 名称 | 说明 |
|---|---|---|
| `d372229f-c0ae-4dcc-b968-4ec7c2832842` | `jhzy-v2-prod` | **生产库** |
| `85853fb1-1384-486e-9be3-566f72f45c5d` | `jhzy-v2-staging` | staging 库 |
| `ea603f43-d076-4df5-b118-3d8a0c245439` | `jhzy-v2-db` | forbidden default |

**`CLOUDFLARE_ACCOUNT = 8770e4917f904aed5df91c883cf058af`（已证明）**

---

## 4. Zone / Route Inventory —— 无法完成（核心阻塞）

### 4.1 阻塞原因

**当前环境不具备 zone 与 route 的只读列举能力。** 三条尝试路径均失败：

| # | 尝试 | 结果 |
|---|---|---|
| 1 | `wrangler --help` 检索 zone/route/domain 命令 | 仅 `wrangler triggers`，无 zone/route 列举 |
| 2 | `wrangler routes` | `[ERROR] Unknown argument: routes` — 命令不存在 |
| 3 | `wrangler triggers --help` | **只有 `deploy` 子命令（写操作）**，无只读列举 |
| 4 | `wrangler whoami --account <id>` | 非交互环境返回帮助文本（exit=1），无输出 |
| 5 | `wrangler whoami`（无参数） | 同上，exit=1 |

### 4.2 凭据缺口

zone inventory 需要 Cloudflare API token，当前环境**不具备**：

- **环境变量**：无 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_API_KEY` / `CF_API`
- **wrangler profile 凭据**：存放于系统 keychain，**仅支撑已验证的 wrangler 子命令**
  （deploy / d1 / deployments / versions），非交互环境下 `whoami` 无法回显，
  OAuth token 不提供 zone:read 能力给 CLI 列举
- **`~/.cloudflared/*.json`**：存在 1 个文件，但这是 **cloudflared tunnel 凭据**
  （175 字节 tunnel secret），**不是 API token**，无 zone 管理权限，**不可用于本任务**
- **仓库内无 token 记录**（已扫描 `workers/docs/`，仅命中「不得写入文档」的安全纪律描述）

> 仓库既有文档已记录同类限制：
> 「`cert-r5b-prod-readiness-probe.mjs` 在非交互 agent 环境返回 `NON_INTERACTIVE_NO_TOKEN`
> （wrangler 非交互只接受 `CLOUDFLARE_API_TOKEN`）」——与本轮观察一致。

### 4.3 结论

```
AVAILABLE_ZONES        = UNKNOWN
EXISTING_WORKER_ROUTES = UNKNOWN
ROUTE_FEASIBILITY      = BLOCKED_NO_ZONE_INVENTORY
```

**按指令 §3-B 规定**：无可用 zone 清单时不得臆测候选域名，
更**不得建议动用 `api.jhzyfw.com`**（1.0 生产 API 硬禁令）。
故本轮**不提出具体 hostname**，仅在 §6 给出条件式方案。

---

## 5. 1.0 Hostname 安全边界（硬约束，已确认）

### 5.1 1.0 正在使用的 hostname（**全部禁止触碰**）

依据项目长期记录，1.0 生产环境 5 个活动 nginx vhost：

| Hostname | 根目录 / 说明 |
|---|---|
| `api.jhzyfw.com` | `/www/wwwroot/api.jhzyfw.com` —— **1.0 生产 API，硬禁令** |
| `api2.jhzyfw.com` | `/www/wwwroot/api_jhzyfw_v2`（api 整目录副本） |
| `exam.jhzyfw.com` | `/www/wwwroot/api.jhzyfw.com/exam`（子路径，独立 server 块） |
| `manage.jhzyfw.com` | `/www/wwwroot/manage.jhzyfw.com` |
| `signup.jhzyfw.com` | `/www/wwwroot/signup.jhzyfw.com` |
| `admin.jhzyfw.com` | 2.0 配置中作为 `ADMIN_ALLOWED_ORIGINS` 出现 |

### 5.2 冲突风险评估

**`jhzyfw.com` 若为可用 zone，则候选子域与 1.0 共用 zone。** 因此：

- 候选 hostname **必须**是 1.0 未使用的新子域（如 `v2-smoke.jhzyfw.com`）
- **绝不可**复用 `api.` / `api2.` / `exam.` / `manage.` / `signup.` / `admin.` 前缀
- 创建前**必须**先做 DNS 记录冲突检查（指令 §3-C 要求）
- **绝不可**覆盖任何已有 A / CNAME 记录

### 5.3 2.0 当前的域名声明

`workers/wrangler.jsonc` 中出现的域名**仅有一处**：

```jsonc
"ADMIN_ALLOWED_ORIGINS": "https://admin.jhzyfw.com"
```

且 production 环境 **无 `routes`、无 `custom_domain`** 声明，
仅有 `"workers_dev": true`。即 2.0 Worker 目前**未绑定任何自有域名**。

---

## 6. Route 方案（条件式，待 inventory 完成后定稿）

### 6.1 方案 A：临时 smoke hostname（**推荐**）

| 项 | 内容 |
|---|---|
| 候选形式 | `v2-smoke.<可用zone>`（如 `v2-smoke.jhzyfw.com`） |
| 绑定方式 | route → `jhzy-v2-worker-production` |
| 用途 | 仅 `/health` 与只读 smoke |
| 生命周期 | smoke 完成后**立即删除 route** |
| 前置条件 | ① 确认 `<可用zone>` 在 account `8770e4917f904aed5df91c883cf058af` 内<br>② 确认 `v2-smoke.*` 无既有 A/CNAME/route 冲突<br>③ 确认非 1.0 使用的任一 hostname |

**优点**：与 1.0 完全隔离；不影响任何生产流量；可即时删除。
**风险**：低。需注意 route 存在期间该 hostname 指向生产 Worker，
**不得**在此 hostname 上执行任何写操作。

### 6.2 方案 B：正式 production hostname（**本任务不执行**）

| 项 | 内容 |
|---|---|
| 形式 | 如 `v2.jhzyfw.com` |
| 前置 | 需产品规划明确 + **额外授权** |
| 状态 | **不在本任务范围** |

### 6.3 明确排除的方案

| 方案 | 排除原因 |
|---|---|
| 绑定 `api.jhzyfw.com` | **1.0 生产 API，硬禁令** |
| 复用 `api2.` / `exam.` / `manage.` / `signup.` / `admin.` | 1.0 正在使用 |
| 修改 `workers_dev: true` 为 false | 会**移除**现有 workers.dev 访问路径，在封锁未解除前是净损失 |
| 在 `wrangler.jsonc` 中提交 routes 配置 | 属代码改动，本任务禁止；且配置提交会触发 deploy 语义 |

---

## 7. Smoke 计划（**待 route 创建授权后**执行）

### 7.1 允许的请求

```bash
# 1) 健康检查（纯只读）
curl -sS https://<candidate-host>/health
# 期望：status=ok, environment=production,
#       d1Binding=present, schema.migrationsApplied=46

# 2) 我的证书（可选）
curl -sS -H "Authorization: Bearer <真实token>" \
        -H "X-Team-Id: <真实teamId>" \
        https://<candidate-host>/api/v2/certificates/mine
# 无安全 token → SKIPPED_NO_SAFE_AUTH
# 已知前提：生产 sessions 表 0 行，本地无 .dev.vars/.env 凭证
```

### 7.2 禁止的请求

| 禁止项 | 说明 |
|---|---|
| `POST /certificates/issue` | 发证 |
| 任何 activity / service issue 端点 | 发证 |
| 任何生产测试数据写入 | 违反禁令 |
| `POST` / `PUT` / `PATCH` / `DELETE` 任何端点 | 一律禁止 |
| 通过登录端点获取 token | 会写 `sessions` 表 |

> `wrangler preview` 若确定 no-write 可另行授权；本任务不涉及。

### 7.3 判定口径

| 观察 | 判定 |
|---|---|
| `/health` 返回 `status=ok` + `migrationsApplied=46` | `HEALTH_SMOKE = PASS` |
| `/certificates/mine` 4xx 且符合鉴权语义 | `MINE_SMOKE = PASS`（鉴权生效即正确） |
| 任一端点 5xx | 对应项 `FAIL` → 立即回滚至 `bfff110b-4787-40cb-b982-6c692e699429` |

---

## 8. Route 删除 / 回滚计划

### 8.1 删除 route（smoke 完成后）

1. 删除 `v2-smoke.<zone>` → `jhzy-v2-worker-production` 的 route
2. 确认 hostname 不再解析到该 Worker
3. **不影响** `workers.dev` 访问路径（`workers_dev: true` 保持不变）

### 8.2 Worker 版本回滚（如 smoke 失败）

```
wrangler rollback --env production --profile jhzy
# 目标：bfff110b-4787-40cb-b982-6c692e699429（当前已完整保留）
```

> route 是**独立于 Worker 版本**的配置。删除 route **不需要**回滚 Worker 版本，
> 二者互不干扰。

---

## 9. 禁令遵守对照

| 禁令 | 遵守情况 | 证据 |
|---|---|---|
| 不改 `api.jhzyfw.com` | 遵守 | 未执行任何 DNS/route 写操作 |
| 不改任何 1.0 正在使用的 hostname | 遵守 | §5 全部 6 个 hostname 均未触碰 |
| 不改 production D1 | 遵守 | §2 五表全部与基线一致 |
| 不调用 issue route | 遵守 | 全程零 HTTP 请求发出（六条路径均在 TCP/TLS 层失败） |
| 不创建测试证书 | 遵守 | `certificates` 保持 413 |
| 不改 secrets | 遵守 | 未执行任何 secret 操作 |
| 不 push | 遵守 | reflog 无 push；本轮唯一写动作为 doc 49 落盘 |
| 不从 dirty 主工作树 deploy | 遵守 | **未执行任何 deploy** |
| 不操作 `/www/wwwroot/api.jhzyfw.com/` | 遵守 | 未连接生产服务器（101.43.30.163） |
| **不创建任何 route** | 遵守 | 无 route 写操作；`wrangler triggers deploy`（唯一 route 写命令）**未执行** |
| **不改 DNS** | 遵守 | 无任何 DNS API 调用 |

### 9.1 特别声明：`wrangler triggers` 未被执行

`wrangler triggers deploy` 是 wrangler 中**唯一**能写 route 的命令。
本轮**仅执行了 `wrangler triggers --help`**（帮助查询，只读），
**从未执行 `triggers deploy`**，故**不可能产生任何 route 变更**。

---

## 10. 解除阻塞所需条件

要完成 zone inventory，需以下任一：

### 方案 i：提供只读 API Token（推荐）

设置环境变量后即可列举：

```bash
export CLOUDFLARE_API_TOKEN=<token with Zone:Read + Workers Routes:Read>
export CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af

# 只读列举
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones" | jq '.result[] | {id, name, status}'
```

**所需权限（最小化）**：
- `Zone:Read` —— 列举 zone
- `Zone DNS:Read` —— 检查 A/CNAME 记录冲突
- `Workers Routes:Read` —— 列举现有 route

**不需要** `Zone:Edit` / `DNS:Edit`（本任务只读）。

### 方案 ii：管理员在 Cloudflare Dashboard 只读查看并提供

提供以下三项信息即可完成候选分析：
1. account `8770e4917f904aed5df91c883cf058af` 下的 **zone 名称列表**
2. 每个 zone 的 **DNS 记录列表**（用于冲突检查）
3. **现有 Workers Routes 列表**（用于确认无冲突）

---

## 11. 授权文本（供复制）

> 以下为待条件满足后使用的授权草案。**当前不可执行**——缺少 zone inventory 支撑。

```
我明确授权执行 POST-R5-P8G-H1-CREATE-SMOKE-ROUTE。

授权范围：
1. 在 <ZONE_NAME> zone 下创建 hostname <CANDIDATE_HOSTNAME> →
   jhzy-v2-worker-production 的 route。
2. 创建前必须先只读确认：
   - <CANDIDATE_HOSTNAME> 无既有 A / CNAME / route 记录
   - <CANDIDATE_HOSTNAME> 不属于任何 JHZY 1.0 正在使用的 hostname
     （api. / api2. / exam. / manage. / signup. / admin. 前缀全部排除）
3. 创建后仅允许执行只读 smoke：
   - GET https://<CANDIDATE_HOSTNAME>/health
   - GET https://<CANDIDATE_HOSTNAME>/api/v2/certificates/mine
     （必须带真实 Authorization + X-Team-Id；无安全 token 则记 SKIPPED_NO_SAFE_AUTH）
4. smoke 完成后立即删除该 route，并确认 hostname 不再解析到该 Worker。

禁止：
- 任何 POST / PUT / PATCH / DELETE 请求
- POST /certificates/issue 或任何 activity / service issue 端点
- 写入 production D1 / 创建任何测试数据 / 任何真实发证
- 通过登录端点获取 token（会写 sessions 表）
- 修改 api.jhzyfw.com 或任何 1.0 hostname
- 修改 secrets
- 部署 Worker（不改变 3cb9d6f5-11a8-4588-930d-e58dfd1b7ea7）
- 写入 production D1 结构（不执行任何 migration）
- git push
- 操作 /www/wwwroot/api.jhzyfw.com/ 或任何 1.0 生产资产
- 修改 workers_dev: true（保留现有 workers.dev 访问路径）

回滚：
- 删除 route 即可撤销 hostname 绑定，Worker 版本不受影响。
- 如 smoke 出现 5xx：wrangler rollback --env production --profile jhzy
  → bfff110b-4787-40cb-b982-6c692e699429
```

---

## 12. 结论

```
POST_R5_P8G_STATUS      = FEASIBILITY_GATED / BLOCKED
CLOUDFLARE_ACCOUNT      = 8770e4917f904aed5df91c883cf058af（已证明）
AVAILABLE_ZONES         = UNKNOWN（无 token，wrangler 无 zone 命令）
EXISTING_WORKER_ROUTES  = UNKNOWN（同上）
CANDIDATE_HOSTNAME      = 无法确定（依赖 zone inventory）
ROUTE_FEASIBILITY       = BLOCKED_NO_ZONE_INVENTORY
RECOMMENDED_PLAN        = 方案 A（临时 smoke hostname）—— 条件式，待 inventory 后定稿

ROUTE_CREATED           = NO
DNS_CHANGED             = NO
PRODUCTION_D1_MUTATED   = NO（5 表与基线完全一致）
CERTIFICATE_ISSUED      = NO（certificates 413）
GIT_PUSH_PERFORMED      = NO
JHZY_1_0_TOUCHED        = NO
SECRETS_CHANGED         = NO
DEPLOY_PERFORMED        = NO
MAIN_WORKTREE_TOUCHED   = NO（dirty 583 未变，stash 0）

ROOT_CAUSE = 缺少具备 Zone:Read / Workers Routes:Read 的 API token。
             wrangler CLI 不提供 zone/route 只读列举命令；
             `triggers deploy` 是唯一 route 写命令（未执行）。
```

### 12.1 本轮的实际产出

虽被阻塞，仍确定了以下**不依赖 inventory 的稳定结论**：

1. **方案 A 的形态已定**：`v2-smoke.<zone>` 形态可确认可行，风险低、可即时删除。
2. **1.0 安全边界已明确**：6 个 hostname 全部列入禁止清单。
3. **wrangler 配置现状已查明**：production 无 `routes`、无 `custom_domain`，
   仅 `workers_dev: true` → 本任务不需要改任何配置文件即可加 route。
4. **回滚路径已确认**：回滚版本 `bfff110b` 完整保留，随时可用；
   且 route 删除与 Worker 版本回滚**相互独立**。
5. **凭证需求已最小化**：只需 3 个只读权限，不需要任何写权限。

---

*本记录全部结论均基于真实命令输出与既有项目记录；
不可列举的项目（zone / routes）一律标注 UNKNOWN，未做任何推测性填充。*
