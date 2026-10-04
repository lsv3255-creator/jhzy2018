# 48 —— 公网运行时只读 smoke（P8F）

> 阶段：POST-R5-P8F-MANUAL-PUBLIC-RUNTIME-SMOKE
> 日期：2026-10-04
> 目标：对 production Worker 新版本做公网只读 smoke
> 部署版本：`3cb9d6f5-11a8-4588-930d-e58dfd1b7ea7`
> 生产 D1：`jhzy-v2-prod / d372229f-c0ae-4dcc-b968-4ec7c2832842`
>
> **结论：三项 smoke 全部未能执行。D1_MUTATION_CHECK = NO MUTATION。**
> **根因是本机网络环境对 `workers.dev` 的域级封锁，与部署质量无关。**

---

## 0. 验收结果摘要

| 验收项 | 结果 | 根因 |
|---|---|---|
| `HEALTH_SMOKE` | **FAIL**（不可达，非应用故障） | workers.dev 域级封锁 |
| `MINE_SMOKE` | **SKIPPED_NO_SAFE_AUTH** | 双重阻断：网络不可达 + 无任何真实凭证 |
| `DETAIL_SMOKE` | **SKIPPED_NO_SAFE_CERT** | 双重阻断：网络不可达 + 端点强制归属校验 |
| `D1_MUTATION_CHECK` | **NO MUTATION** | 11/11 表 delta=0 |
| `CERTIFICATE_ISSUED` | **NO** | certificates 413 → 413 |

> **重要区分**：`HEALTH_SMOKE = FAIL` 指的是「**未能取得 HTTP 响应**」，
> **不是**「Worker 返回了错误响应」。本轮**没有收到任何来自 Worker 的响应体**，
> 因此对 Worker 运行时行为**不作任何判定**——既不能判为健康，也不能判为故障。

---

## 1. HEALTH_SMOKE —— 未能执行

### 1.1 目标端点

```
GET https://jhzy-v2-worker-production.lsv3255.workers.dev/health
```

`/health` 经源码核验为**纯只读**端点，仅执行
`SELECT COUNT(*) AS n FROM d1_migrations`，无任何写入路径，
是本次 smoke 中最安全的探测目标。

### 1.2 实测结果：六条路径全部失败

| # | 路径 | 结果 | 耗时 |
|---|---|---|---|
| 1 | 经沙箱代理 HTTPS | `HTTP=000` | 10.03s（超时） |
| 2 | `--noproxy '*'` 直连 HTTPS | `HTTP=000` | 20.01s（超时） |
| 3 | 明文 HTTP（80 端口） | `HTTP=502` | 10.00s |
| 4 | IPv6 强制（`-6`） | `HTTP=000` | — |
| 5 | `--resolve` 强制 IP `108.160.169.37` | `HTTP=000` | — |
| 6 | 显式代理 `-x http://127.0.0.1:56226` | `HTTP=000` | — |
| 7 | 对照：staging 子域 `jhzy-v2-worker-staging...` | `HTTP=000` | — |

### 1.3 根因判定：workers.dev 域级封锁

**DNS 解析正常**：

```
$ nslookup jhzy-v2-worker-production.lsv3255.workers.dev
Name:  jhzy-v2-worker-production.lsv3255.workers.dev
Address: 108.160.169.37        ← 正常解析
```

**对照实验锁定封锁范围**（这是本次判定的关键证据）：

| 目标 | 结果 | 含义 |
|---|---|---|
| `https://www.cloudflare.com/` | **`HTTP=200`** | Cloudflare 域名本身可达 |
| `https://api.cloudflare.com/client/v4/user/tokens/verify` | **`HTTP=400`** | CF API 正常连通（400 为缺 token 的正常业务响应） |
| `https://workers.dev/`（根域） | **`HTTP=000`** | **workers.dev 整个域被封锁** |
| `https://<任意子域>.workers.dev/` | **`HTTP=000`** | 与具体 Worker 无关 |

**结论**：本机出网正常，Cloudflare 域名族可达，**唯独 `workers.dev` 及其任意子域
不可达**。这是本地网络策略（或上游链路）的**域级封锁**，
**与 Worker 是否部署成功、代码是否正确、版本是否激活完全无关**。

### 1.4 与 P8C 的交叉印证

P8C 阶段已独立记录同一现象（代理 CONNECT 返回 502、直连 000、
`wrangler dev --remote` 卡死于 `Starting remote preview`）。
本轮新增的**对照实验**进一步把根因从「疑似网络问题」收窄为
「workers.dev 域级封锁」——这是一个**更强的事实**，此前未建立。

---

## 2. MINE_SMOKE —— SKIPPED_NO_SAFE_AUTH

指令要求「必须带真实有效 Authorization 与 X-Team-Id」。核查是否具备：

### 2.1 生产库无任何会话

```
$ wrangler d1 execute jhzy-v2-prod --remote \
    --command "SELECT COUNT(*) AS n FROM sessions"
sessions rows = 0
```

`sessions` 表 **0 行** → 生产环境**不存在任何有效会话 token**。

### 2.2 本地无任何凭证材料

```
$ ls .dev.vars* .env*        → 无匹配文件
$ ls .dev.vars* workers/.env* → 无匹配文件
```

clean worktree 与主工作树**均无** `.dev.vars` / `.env` 凭证文件。

### 2.3 结论

**无真实可用 Authorization**。且即使有网络，也无凭证。
判定 **`SKIPPED_NO_SAFE_AUTH`**。

> **明确未做的事**：未尝试通过 `POST /auth/login` 等价端点**登录取 token**——
> 该动作会在生产 D1 写入 `sessions` 行，直接违反「不得写 production D1」与
> 「不得创建测试数据」两条禁令。故即使网络可达，MINE_SMOKE 仍应判 SKIPPED。

---

## 3. DETAIL_SMOKE —— SKIPPED_NO_SAFE_CERT

### 3.1 端点存在，但强制归属校验

源码核验（`workers/src/services/certificate-service.ts` 第 55–64 行）：

```ts
async detail(certificatePublicId: string) {
  if (!this.auth.authenticated || this.auth.userId == null) throw authRequired();   // ← L56 强制认证
  const detail = await this.repo.getCertDetailByPublicId(certificatePublicId);
  if (!detail) throw notFound('Certificate');
  const isOwner = detail.user_id === this.auth.userId;
  if (!isOwner) {
    // 团队管理员浏览：需同团队 + cert.view
    if (this.tenant.teamId == null || detail.team_id !== this.tenant.teamId) throw notFound('Certificate');
    await authorizePermission(this.env, this.auth, 'certificate.certificate.view');
  }
  ...
}
```

**该端点并非公开端点**：

1. 第 56 行 `authRequired()` —— 无有效身份直接抛 401。
2. 第 59 行归属校验 —— 仅证书持有人本人可查。
3. 第 60–63 行 —— 非本人须**同团队**且持有 `certificate.certificate.view` 权限。

### 3.2 结论

**不存在「安全的证书 publicId」**——任何真实证书的 publicId 都属于真实用户 PII 范畴，
且在无合法身份时必然被 L56 拒绝。判定 **`SKIPPED_NO_SAFE_CERT`**。

> 顺带确认：若该端点被公开，将构成**越权读取他人证书信息（含 holder_name / cert_no）**
> 的安全漏洞。当前实现的三重校验是正确且必要的，不应放宽。

---

## 4. D1_MUTATION_CHECK —— NO MUTATION

smoke 前后执行**完全相同**的只读查询，逐表对账：

| 表 | 前 | 后 | Delta | 判定 |
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
| sessions | 0 | 0 | +0 | SAME |
| d1_migrations | 46 | 46 | +0 | SAME |

**D1_MUTATION_CHECK = NO MUTATION（11/11 表 delta=0）**

- `sessions` 保持 0 → 侧面印证本轮**未发生任何登录动作**。
- `certificates` 保持 413 → **未发生任何真实发证**。
- `certificate_logs` / `operation_logs` 保持 0 → 无任何业务写入被触发。
- `d1_migrations` 保持 46 → 未执行任何 migration apply。

---

## 5. 禁令遵守对照

| 禁令 | 遵守情况 | 证据 |
|---|---|---|
| 不得发证 | 遵守 | certificates 413 → 413；未调用任何 issue route |
| 不得写 production D1 | 遵守 | 11 表 delta=0；仅执行 `SELECT` |
| 不得调用 issue route | 遵守 | 全程零 POST 请求（所有 curl 均为 GET/HEAD，且全部超时未送达） |
| 不得 push | 遵守 | 无 `git push`；本轮唯一写动作是 doc 48 落盘 |
| 不得改 secrets | 遵守 | 未执行任何 secret 写操作 |
| 不得创建测试数据 | 遵守 | 未尝试登录取 token（该动作会写 sessions） |
| 不得触碰 JHZY 1.0 | 遵守 | 未访问 MySQL / 101.43.30.163 |

---

## 6. 已获得的等价证据（API 侧）

尽管公网 smoke 受阻，Cloudflare **API 侧**全部通道正常，可提供部分等价证据：

| 验证项 | 方法 | 结果 |
|---|---|---|
| 部署版本 100% 激活 | `wrangler deployments list` | 100% @ `3cb9d6f5` |
| 生产 D1 绑定正确 | `wrangler versions view` | `env.DB (d372229f-...)` 精确匹配 |
| 环境变量正确 | 同上 | production / WECHAT_APPID / ADMIN_ALLOWED_ORIGINS |
| Secrets 完整 3/3 | 同上 | DELIVERY_IDENTITY_ENC_KEY / IDENTITY_HMAC_KEY / WECHAT_APP_SECRET |
| 路由表已挂载 | Handlers 列表 | `get/post/put/delete/options/patch/query/all/on/use/router/…/fetch` |
| 兼容性标志 | 同上 | `nodejs_compat` + `2025-08-01` |
| D1 可连通可查询 | `d1 execute --remote` 多次成功 | 11 表全部读出 |
| `/health` 只读性 | 源码核验 | 纯 SELECT，无写入路径 |
| `/certificates/:id` 鉴权 | 源码核验 | 三重校验（认证 + 归属 + 权限） |

**这些证据能证明「部署产物与配置正确」，但不能替代「真实边缘 HTTP 响应」——
后者仍是本轮未取得、且在本机无法取得的缺口。**

---

## 7. 缺口移交与补验清单

### 7.1 阻塞项

**公网运行时 smoke 需在可访问 `workers.dev` 的网络环境中由人工执行。**
建议命令（全部为只读 GET，可直接复制）：

```bash
# 1) 健康检查 —— 应返回 status=ok, environment=production,
#    d1Binding=present, schema.migrationsApplied=46
curl -sS https://jhzy-v2-worker-production.lsv3255.workers.dev/health

# 2) 我的证书 —— 必须同时带真实 Authorization 与 X-Team-Id
curl -sS -H "Authorization: Bearer <真实token>" \
        -H "X-Team-Id: <真实teamId>" \
        https://jhzy-v2-worker-production.lsv3255.workers.dev/api/v2/certificates/mine

# 3) 证书详情 —— 仅限本人证书或同团队且具 cert.view 权限者
curl -sS -H "Authorization: Bearer <真实token>" \
        -H "X-Team-Id: <真实teamId>" \
        https://jhzy-v2-worker-production.lsv3255.workers.dev/api/v2/certificates/<publicId>
```

**执行时禁止**：任何 POST/PUT/PATCH/DELETE；任何 issue 端点；
任何携带真实 openid / 手机号的请求转发至非受控环境。

### 7.2 补验通过后的判定口径

| 观察结果 | 判定 |
|---|---|
| `/health` 返回 `status=ok` + `migrationsApplied=46` | `HEALTH_SMOKE = PASS` |
| `/certificates/mine` 返回 200 且结构符合契约 | `MINE_SMOKE = PASS` |
| `/certificates/mine` 返回 4xx 但符合预期鉴权语义 | `MINE_SMOKE = PASS`（鉴权生效亦为正确行为） |
| 任一端点返回 5xx | 对应项 `FAIL`，需立即回滚至 `bfff110b` |

### 7.3 回滚路径（随时可用）

```
wrangler rollback --env production --profile jhzy
# 或显式指定：目标版本 bfff110b-4787-40cb-b982-6c692e699429
```

---

## 8. 结论

```
HEALTH_SMOKE        = FAIL（不可达；未收到任何 Worker 响应，非应用故障）
MINE_SMOKE          = SKIPPED_NO_SAFE_AUTH（sessions 0 行 + 无凭证文件 + 禁止登录取 token）
DETAIL_SMOKE        = SKIPPED_NO_SAFE_CERT（端点强制归属校验，无合法身份不可查）
D1_MUTATION_CHECK   = NO MUTATION（11/11 表 delta=0）
CERTIFICATE_ISSUED  = NO（certificates 413 → 413）

ROOT_CAUSE          = workers.dev 域级封锁
  证据               = DNS 正常解析(108.160.169.37)
                     + cloudflare.com=200 / api.cloudflare.com=400
                     + workers.dev 根域=000 / 任意子域=000
                     + 六条访问路径（代理/直连/HTTP/IPv6/--resolve/staging）全部失败
  性质               = 本地网络策略问题，与部署质量无关

PRODUCTION_WORKER_VERSION = 3cb9d6f5-11a8-4588-930d-e58dfd1b7ea7（100% 激活）
PUSH                       = NONE
SECRETS                    = UNCHANGED（3/3 保留）
JHZY_1.0                   = UNTOUCHED
```

**当前状态**：部署本身证据链完整（配置、绑定、secrets、路由、D1 schema 全部正确），
唯一缺口是「真实边缘 HTTP 响应」这一级证据，需人工在可达网络补验。
在此之前，**不应将 R5 上线判定为完全闭环**。

---

*本记录全部结论均基于真实命令输出；未取得任何 Worker 响应体的地方均如实标注为
「不可达」而非「通过」或「失败」。*
