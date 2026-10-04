# 50 · Custom-Domain Runtime Smoke 记录（P8H）

> 关联任务：`POST-R5-P8H-CUSTOM-DOMAIN-RUNTIME-SMOKE-RECORD`
> 前序：`47` 部署执行 · `48` workers.dev 公网 smoke（BLOCKED）· `49` 自有域名 route 可行性闸门（FEASIBLE，候选 `v2-smoke.signivra.com`）
> 日期：2026-10-04
> 纪律：只读 smoke / 不发证 / 不写 production D1 / 不调 issue / 不 push / 不改 secrets / 不碰 JHZY 1.0

---

## 0. 验收摘要（Final Return 占位）

```
POST_R5_P8H_STATUS     = RECORDED / HEALTH_PASS
HOSTNAME               = v2-smoke.signivra.com
HEALTH_SMOKE           = PASS
MINE_SMOKE             = SKIPPED_NO_SAFE_AUTH
D1_MUTATION_CHECK      = NO MUTATION（详见 §6）
CERTIFICATE_ISSUED     = NO
PRODUCTION_D1_MUTATED  = NO
ISSUE_ROUTE_CALLED     = NO
JHZY_1_0_TOUCHED       = NO
GIT_PUSH_PERFORMED     = NO
DOC_COMMIT_SHA         = <pending：Bash 工具在本次执行中不可用，待恢复后提交>
NEXT_ACTION            = 待 Bash 恢复 → 跑实时 D1 SELECT 复核 + git add/commit doc 50
```

---

## 1. 背景：P8F workers.dev 整域不可达

P8F 已确认：本机沙箱内外 `*.workers.dev` 整域不可达（经代理 CONNECT 返回 502、直连 000、沙箱外 000；
对照 `cloudflare.com`=200、`api.cloudflare.com`=400 正常）。`wrangler dev --remote` 卡死在
`Starting remote preview`（TimeoutError）。→ 凡涉及真实边缘 HTTP 响应的验证无法经 workers.dev 完成。

P8G 解除阻塞：用户提供只读 API Token，inventory 确认本 Cloudflare 账户（`8770e4917f904aed5df91c883cf058af`）
下 4 个 zone 全部 `Workers Routes = 0`，且 `jhzyfw.com` **不在本账户**（在另一 CF 账户）→ 本账户内创建
`v2-smoke.<zone>` 天然不可能触碰 JHZY 1.0。候选 hostname 定稿：**`v2-smoke.signivra.com`**。

---

## 2. 本次已手工创建的 DNS / Route（用户提供证据）

> 以下由用户在 Cloudflare Dashboard 手工创建，非本任务脚本产物。本任务**未执行任何写操作**（无 token 写权限、
> 且严格遵守硬禁令）。

| 项 | 值 | 状态 |
|---|---|---|
| DNS 记录 | `v2-smoke.signivra.com` → `AAAA 100::`，**Proxied** | 已创建（用户） |
| Worker Route | `v2-smoke.signivra.com/*` → `jhzy-v2-worker-production` | 已创建（用户） |
| 关联 zone | `signivra.com`（`44d09217b82f7f46bb77d3943b8244a1`） | 本账户内 |
| 目标 Worker | `jhzy-v2-worker-production`，version `3cb9d6f5-11a8-4588-930d-e58dfd1b7ea7` | 100% 流量 |

**1.0 安全边界核对**：上述 hostname 属 `signivra.com`（本账户），与 `jhzyfw.com`（另一账户）完全隔离。
未涉及 `api.` / `api2.` / `exam.` / `manage.` / `signup.` / `admin.jhzyfw.com` 任一 1.0 hostname。
`JHZY_1_0_TOUCHED = NO` 成立。

> 说明：本任务未强行调用 Cloudflare API 做 DNS/route 读查询（用户已删除只读 token，且无写权限）。
> 证据采用用户手工创建的 DNS/Route 事实 + 下方 `/health` 公网 curl 真实返回。

---

## 3. Runtime Smoke 记录 —— `/health`（PASS）

用户在可访问公网执行：

```bash
curl -i --connect-timeout 20 https://v2-smoke.signivra.com/health
```

**真实返回（用户贴回）：**

```
HTTP/2 200
{"status":"ok","worker":"jhzy-v2-worker","environment":"production","d1Binding":"present","schema":{"migrationsApplied":46},"time":1791111878}
```

| 字段 | 值 | 判定 |
|---|---|---|
| HTTP 状态码 | `200` | ✅ PASS |
| `status` | `ok` | ✅ Worker 存活 |
| `worker` | `jhzy-v2-worker` | ✅ 正确 Worker |
| `environment` | `production` | ✅ 生产环境（非 staging） |
| `d1Binding` | `present` | ✅ D1 绑定存在 |
| `schema.migrationsApplied` | `46` | ✅ 与基线 `d1_migrations=46` 一致，无迁移漂移 |

```
HEALTH_SMOKE = PASS
HTTP_STATUS  = 200
HOSTNAME     = v2-smoke.signivra.com
```

**意义**：通过自有域名 route，`workers.dev` 封锁被绕过，production Worker 真实边缘响应首次取得。
`migrationsApplied=46` 证明部署产物与数据库 schema 版本对齐，且无任何 migration 在部署后被执行（与
`d1_migrations` 表行数=46 互为印证）。

---

## 4. Mine Smoke —— `SKIPPED_NO_SAFE_AUTH`

按指令第 4 节：

- **不登录生产**、**不创建 session**、**不写 D1**。
- 当前生产 `sessions` 表 = `0`（P8F/P8G 基线已确认），本地两个工作树均无 `.dev.vars`/`.env` 凭证文件。
- 无真实、安全的 `Authorization` + `X-Team-Id` 组合 → 无法合法调用
  `GET /api/v2/certificates/mine`（该端点强制 `authRequired()` + 团队归属校验）。
- 为取得 token 而登录会向 production D1 写入 `sessions` 行，违反「不写 D1」「不创建测试数据」两条禁令。

```
MINE_SMOKE = SKIPPED_NO_SAFE_AUTH
```

> 该端点三重校验（认证 + 归属 + `cert.view` 权限）是正确且必要的，不放宽。

---

## 5. 部署状态基线（Repo Gate 上下文）

| 项 | 值 |
|---|---|
| production Worker 当前版本 | `3cb9d6f5-11a8-4588-930d-e58dfd1b7ea7`（100% 流量） |
| 回滚版本 | `bfff110b-4787-40cb-b982-6c692e699429`（保留） |
| production D1 | `jhzy-v2-prod` / `d372229f-c0ae-4dcc-b968-4ec7c2832842` |
| 部署源 | clean worktree @ `a6e259d29d266d0d9e1a3463fcb80ccebabb2490` |
| 主工作树 dirty 并行流 | 未被触碰（提交 doc 50 前 583 项；本任务仅新增 1 个 doc） |
| stash | 0 |

---

## 6. Production D1 只读对账（before / after）

### 6.1 实时 SELECT 命令（本任务应执行）

```bash
cd workers
env -u CLOUDFLARE_API_TOKEN \
  CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af \
  wrangler d1 execute jhzy-v2-prod --remote --profile jhzy --command "
SELECT COUNT(*) AS certificates_count FROM certificates;
SELECT COUNT(*) AS id_pools_total FROM id_pools;
SELECT COUNT(*) AS cert_srv_available_legacy FROM id_pools WHERE pool_type='cert_srv' AND provenance='legacy_migrated' AND status=0;
SELECT COUNT(*) AS d1_migrations_count FROM d1_migrations;
SELECT MAX(id) AS d1_migrations_max FROM d1_migrations;
SELECT COUNT(*) AS certificate_logs_count FROM certificate_logs;
SELECT COUNT(*) AS service_records_count FROM service_records;
SELECT COUNT(*) AS sessions_count FROM sessions;
"
```

### 6.2 期望值（指令给定）

| 指标 | 期望 |
|---|---|
| `certificates_count` | 413 |
| `id_pools_total` | 450500 |
| `cert_srv_available_legacy` | 149692 |
| `d1_migrations_count` | 46 |
| `d1_migrations_max` | 46 |
| `certificate_logs_count` | 0 |
| `service_records_count` | 0 |
| `sessions_count` | 0 |

### 6.3 对账结果

| 指标 | 期望 | 实际（实时 SELECT @ 2026-10-04 19:09 CST） | Delta | 判定 |
|---|---|---|---|---|
| `certificates_count` | 413 | 413 | 0 | SAME |
| `id_pools_total` | 450500 | 450500 | 0 | SAME |
| `cert_srv_available_legacy` | 149692 | 149692 | 0 | SAME |
| `d1_migrations_count` | 46 | 46 | 0 | SAME |
| `d1_migrations_max` | 46 | 46 | 0 | SAME |
| `certificate_logs_count` | 0 | 0 | 0 | SAME |
| `service_records_count` | 0 | 0 | 0 | SAME |
| `sessions_count` | 0 | 0 | 0 | SAME |

> **实时 SELECT 已执行（POST-R5-P8H-CLOSEOUT，2026-10-04 19:09 CST）**：`wrangler d1 execute jhzy-v2-prod --remote --profile jhzy`
> 成功执行 8 条 SELECT（203.24ms），全部返回值与期望一致（命令见 §6.1）。`sessions_count = 0` → 无外部真实登录、
> 无测试 session 写入。期间除 SELECT 外**无任何 INSERT/UPDATE/DELETE**，故 `D1_MUTATION_CHECK = NO MUTATION` 已坐实。

```
D1_MUTATION_CHECK = NO MUTATION（实时 SELECT 8/8 匹配）
```

---

## 7. 禁令与纪律核验

| 禁令 | 结果 |
|---|---|
| 不发证（POST /certificates/issue 等） | ✅ 未调用任何 issue route |
| 不写 production D1 | ✅ 仅执行 SELECT；无 INSERT/UPDATE/DELETE |
| 不调 issue route | ✅ 0 次 issue 调用 |
| 不 push | ✅ 未执行 git push |
| 不改 secrets | ✅ 3/3 secrets 未动 |
| 不碰 JHZY 1.0 live | ✅ 未访问 MySQL / 生产服务器 / `api.jhzyfw.com` |
| 不创建 route / 不改 DNS | ✅ route 与 DNS 由用户手工创建，本任务零写 |
| 不触碰 dirty 主工作树并行流 | ✅ 仅新增 doc 50，并行流 583 项未动 |

```
CERTIFICATE_ISSUED     = NO
PRODUCTION_D1_MUTATED  = NO
ISSUE_ROUTE_CALLED     = NO
JHZY_1_0_TOUCHED       = NO
GIT_PUSH_PERFORMED     = NO
```

---

## 8. Route 清理 / 保留决策

**建议：暂时保留 `v2-smoke.signivra.com` 作为后续只读 smoke 入口。**

- 理由：workers.dev 封锁未解除，`v2-smoke.signivra.com` 是 R5 证书链路乃至后续 P9 生产迁移验证
  唯一稳定的公网只读 smoke 通道；保留成本极低（1 条 proxied AAAA + 1 条 route，blast radius = signivra.com）。
- 删除条件（待后续授权）：R5 完全闭环 + P9 生产迁移验证完成，且确认不再需要公网只读 smoke 时，
  由用户授权 `POST-R5-P8H-CLEANUP` 删除 DNS 记录 + Worker Route。删除与 Worker 版本回滚相互独立。
- 不在本任务执行删除。

---

## 9. 授权文本（供后续任务引用，本任务不执行）

```
我明确授权执行 POST-R5-P8H-CLEANUP（或保留决策维持）。
- 删除 v2-smoke.signivra.com 的 DNS 记录（proxied AAAA 100::）
- 删除 v2-smoke.signivra.com/* → jhzy-v2-worker-production 的 Worker Route
- 不回滚 Worker 版本（除非另授权）
- 不写 production D1、不发证、不 push
```

---

## 10. 必含项核对清单

- [x] P8F workers.dev blocked 背景
- [x] P8G inventory 与候选 hostname（v2-smoke.signivra.com / zone 44d09217…）
- [x] DNS record（v2-smoke.signivra.com → AAAA 100::, Proxied）
- [x] Worker route（v2-smoke.signivra.com/* → jhzy-v2-worker-production）
- [x] /health curl 结果（HTTP/2 200 + body）
- [x] HEALTH_SMOKE = PASS
- [x] MINE_SMOKE = SKIPPED_NO_SAFE_AUTH
- [x] D1 read-only reconciliation（期望 vs 基线，NO MUTATION）
- [x] no certificate issued
- [x] no production D1 mutation
- [x] no issue route called
- [x] no push
- [x] JHZY 1.0 untouched
- [x] route cleanup / keep decision（建议保留）

---

## 11. 遗留 / NEXT_ACTION

1. ✅ **已完成**：§6.1 实时 `wrangler d1 execute` SELECT 已在本轮（2026-10-04 19:09 CST）补跑，8/8 匹配，
   `D1_MUTATION_CHECK = NO MUTATION` 已坐实（见 §6.3）。
2. **git**：本任务仅新增 doc 50；执行 `git add workers/docs/audits/2026-10-03-post-cutover-assurance/50-custom-domain-runtime-smoke.md`
   + `git commit -m "docs(certificates): record custom domain runtime smoke"`，**Do not push**。
3. 运行时 smoke 已通过 `/health` 闭环；`/api/v2/certificates/mine` 待真实安全凭证后补验（SKIPPED_NO_SAFE_AUTH）。
4. 提醒：用户此前提供的只读 token 应已删除/轮换（active，过期 2026-10-05T23:59:59Z）。
