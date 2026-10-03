# 27 — CERT-R3F: Staging Runtime Deployment & Certificate Acceptance（执行报告）

> 基线：WORKSPACE `/Users/Shared/projects/jhzy-v2` · BRANCH `master`
> 基线 HEAD（R3E 冻结）`9b31f1170f390380dd48fb41937cf7147a074020`
> 证据提交后 HEAD `f3e40b4617f3c6abf10e058df038c2d8e5713b5e`
> 模式：**STAGING-ONLY 受控运行时部署 + 受控验收** —— 不触碰生产、不导入生产、不发证。
>
> 续 CERT-R3E（staging 号池迁移，PASS_WITH_FINDINGS）。本 Gate 仅部署 staging Worker、
> 运行时/健康/RBAC 烟测、验收决策。
> 绝对禁止项均已遵守：未触碰生产 D1、未部署生产 Worker、未真实发证、未 push、
> 未应用生产 0045/0046、未导入生产 450k 池。

---

## 0. 续跑说明（Bash 工具故障恢复）

- 上一轮 CERT-R3F 因 Bash 工具连续 9 次 `Command rejected: undefined` 阻断（工具后端故障，非任务失败）。
- 本轮 Bash 恢复后，从原 CERT-R3F Prompt §1 起重新执行所有"需命令实证"的 Gate，并保留此前已完成的只读路由/配置分析。
- 此前 Bash 故障期间已对 `26-cert-r3e-...md` 补写 §6.3 两项生产前向纪律（D / F），本次通过 git 证据分类确认其归属。

---

## 1. 工作区门（§1–§4，全部 PASS）

| 项 | 实测 | 预期 | 结果 |
| --- | --- | --- | --- |
| pwd / workspace | `/Users/Shared/projects/jhzy-v2` | 项目根 | ✅ |
| branch | `master` | `master` | ✅ |
| HEAD（基线） | `9b31f1170f390380dd48fb41937cf7147a074020` | `9b31f117…` | ✅ MATCH |
| staged（证据提交前） | `0` | `0` | ✅ |
| `.var` 跟踪 | 未受 git 跟踪（`git check-ignore .var` 命中） | 不进 Git | ✅ |
| dirty baseline | 348 modified + 8486 untracked（miniprogram H5 / workers/src S2-6d / P9 文档等） | 隔离排除 | ✅ |

**R3E 证据分类（§4，重分类）**：

- **R3E_EVIDENCE（2 个文件，已选择性提交）**：
  1. `workers/docs/audits/2026-10-03-post-cutover-assurance/26-cert-r3e-staging-legacy-pool-migration.md`（新建，333 行；含 §6.3 前向纪律 D「生产禁止写式探测」、F「生产不可假定单条应用」）
  2. `workers/docs/certificate/legacy-id-pool-migration.md`（修正：+30 行 §17 STAGING R3E 执行证据，含 `85853fb1` / `450,000` / `450500` / `0045` / `0046` 标记）
- **UNRELATED（全部排除，未提交）**：`miniprogram/*`（287+ 个 H5 改动）、`workers/src/*` / `workers/scripts/*` / `workers/tests/*`（S2-6d 等并行开发）、`docs/production-audit/*`（P9 WP4E）、`register/*`、各配置文件、`.var/`（gitignored）。

> 证明方式：`26-cert-r3e…md` 为 untracked 新建（整文件即 R3E 证据）；`legacy-id-pool-migration.md` 以 `git diff` 证明其 +30 行全部为 §17 STAGING R3E 证据（非无关编辑）。

---

## 2. Staging R3E 终态重验证（§5，全部 PASS，READ-ONLY）

命令实证（`wrangler d1 execute jhzy-v2-staging --remote -e staging`，全部 `changes:0 / changed_db:false / rows_written:0`）：

| 维度 | 实测 | 预期 | 结果 |
| --- | --- | --- | --- |
| d1_migrations 总数 / max | 46 / 46 | 46 / 46 | ✅ |
| 0045 应用次数 | 1 | 1 | ✅ |
| 0046 应用次数 | 1 | 1 | ✅ |
| id_pools 总量 | 450,500 | 450,500 | ✅ |
| legacy_migrated | 450,000 | 450,000 | ✅ |
| v2_synthetic_compat | 500 | 500 | ✅ |
| provenance NULL | 0 | 0 | ✅ |
| status 0 | 448,812 | 448,812 | ✅ |
| status 1 | 1,661 | 1,661 | ✅ |
| status 2 | 27 | 27 | ✅ |
| 全局重复 code 组/行 | 0 / 0 | 0 / 0 | ✅ |
| certificates | 413 | 413 | ✅ |
| 重复 cert_no | 0 | 0 | ✅ |
| FK 违规 | 0（DDL 无声明 FK；`assigned_to`/`batch_id` 非 NULL = 0） | 0 | ✅ |

> 目标 `jhzy-v2-staging` / `85853fb1-1384-486e-9be3-566f72f45c5d`（WNAM）。全程只读，无任何写。

---

## 3. 快照 SHA256 重验证（§6，全部 PASS）

| 快照 | 实测 SHA256 | 记录值 | 字节 | 结果 |
| --- | --- | --- | --- | --- |
| pre `cert_r3e_staging_pre_20261003T051322Z/schema.sql` | `b6a579b807da4b76e6fcbaa5472bd7449dcf853d582a9677167dccb03ebb4550` | 一致 | 3,617,578 | ✅ |
| post `cert_r3e_staging_post_20261003T085132Z/schema.sql` | `75cc8cc293b4c7d9b193d237a8fde914949932e8db55126c179ae2c5067345c3` | 一致 | 2,500,352 | ✅ |

> 两份 manifest 同时记录 run_id / 目标 DB 与 UUID / HEAD / 计数 / 对账 / 烟测 / 禁止项，均一致。

---

## 4. 选择性提交 R3E 证据（§7–§8）

```
git add workers/docs/audits/2026-10-03-post-cutover-assurance/26-cert-r3e-staging-legacy-pool-migration.md \
        workers/docs/certificate/legacy-id-pool-migration.md
git commit -m "docs(certificates): record staging legacy pool migration"
```

- 新授权 HEAD：`f3e40b4617f3c6abf10e058df038c2d8e5713b5e`（`f3e40b4`，parent `9b31f117…`）
- 仅 2 文件 / 364 插入；dirty baseline（347 modified + 8485 untracked）**未**卷入提交。
- **未 push**（HARD STOP 要求）。

---

## 5. 隔离 clean worktree（§10–§11）

- 创建：`git worktree add /Users/Shared/jhzy-v2-r3f-deploy-20261003T174948 f3e40b4`（detached HEAD，状态 clean）。
- 目的：排除 primary worktree 全部并行 H5 / S2-6d 脏改动；部署源 = 已提交冻结代码（含 R3E 证据提交）。
- `node_modules` 以符号链接复用（gitignored，不入树）。
- **部署源纯净**：worktree 仅含已提交内容，无未提交 H5 / 并行代码。

### 5.1 预部署回归（§11，PASS）

| Gate | 结果 |
| --- | --- |
| `tsc --noEmit` | ✅ exit 0，零输出 |
| `wrangler deploy --dry-run -e staging` | ✅ 838.72 KiB / gzip 191.72 KiB；bindings: `env.DB (jhzy-v2-staging)` + `env.ENVIRONMENT("staging")`；无其他 DB |

> 注：R3D(79/0)/R3B(63/0)/R2(57/0) 集成套件在 HEAD `9b31f117`（→ f3e40b4 仅文档增量，无代码变更）已由 R3E 全量回归 PASS；本 Gate 代码 delta 为纯文档，故以轻量 typecheck + dry-run 作为部署产物完整性门禁，套件未重跑（需本地 D1 + fixtures，超出文档增量比例）。

---

## 6. Staging Worker 部署（§13–§15，SUCCESS）

### 6.1 账户解析问题与修复（重要运维记录）

- `wrangler.jsonc` 默认 env（local）binding = 被禁的 `jhzy-v2-db`（`ea603f43-…`）；正确目标为 `env.staging` → `jhzy-v2-staging` / `85853fb1`。
- `jhzy` profile（OAuth 身份 `lsv3255@gmail.com`）可访问**多** Cloudflare 账户；`whoami` / `d1 list` / `d1 execute` 解析到选中账户 `8770e4917f904aed5df91c883cf058af`（即 `85853fb1` 所在账户），但 `deploy` 默认回落到 token 主账户 `6bbedf3d4f904606559e551e6c19bc9a` → 报「85853fb1 未找到」。
- `wrangler deploy` 4.143.0 **不接受** `--account-id` 参数（unknown argument）。
- 单独设 `CLOUDFLARE_ACCOUNT_ID` 环境变量会使 wrangler 回落到 `default` profile（`jxmm2025@my.com` / `6bbedf3…`，无权访问 `8770e49`）→ Authentication error 10000。
- **最终修复**：同时显式 `--profile jhzy` + `CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af` → 使用 jhzy 令牌（有权访问 8770e49）且目标账户显式锁定 8770e49。部署成功。

> 教训（建议沉淀）：多账户 OAuth profile 下，`deploy` 的账户选择不可依赖隐式解析；应以 `--profile` + `CLOUDFLARE_ACCOUNT_ID` 双锁，或在该 profile 配置显式 `account_id`。

### 6.2 部署结果

| 项 | 值 |
| --- | --- |
| 环境（显式） | `staging` |
| 目标 Worker | `jhzy-v2-worker-staging` |
| 目标 D1 | `jhzy-v2-staging` / `85853fb1-1384-486e-9be3-566f72f45c5d` |
| 账户 | `8770e4917f904aed5df91c883cf058af` |
| 版本 ID | `026e5345-cd46-4dd8-8cfb-1bdcb1a91a89`（经 `wrangler deployments list` 确认为 active 100%） |
| 公开 URL | `https://jhzy-v2-worker-staging.lsv3255.workers.dev` |
| 上传体积 | 838.72 KiB / gzip 191.72 KiB |
| bindings | `env.DB (jhzy-v2-staging)` D1 · `env.ENVIRONMENT("staging")` |

- **生产/default 写目标检查（§12）**：部署仅写入 `jhzy-v2-worker-staging` Worker 脚本，绑定 `jhzy-v2-staging`/`85853fb1`；**未**出现 `jhzy-v2-prod`/`d372229f`、未出现 `jhzy-v2-db`/`ea603f43` 作为写目标。✅ STOP 条件未触发。
- 未触碰生产 D1、未部署生产 Worker、未应用生产迁移、未导入生产 450k 池。

---

## 7. 运行时 / 健康 / RBAC 验收（§19–§36，PASS — 经本地 dev 镜像执行）

### 7.1 网络限制与执行路径（重要说明）

- 沙箱本地代理对 **Cloudflare API 主机**放行（wrangler 命令成功），但对 **Worker 公开运行时 URL（`*.workers.dev:443`）返回 502**；且 `wrangler dev --remote` 的 remote preview tunnel 亦无法建立（TCP 已 accept 但无响应，约 20s 超时）。故**无法直连已部署的 `jhzy-v2-worker-staging` 公开端点**。
- 为在受控条件下完成 HTTP 运行时烟测，采用 **本地 `wrangler dev`（无 `--remote`）绑定 LOCAL D1 镜像** 的方式：
  - 本地 D1 = `jhzy-v2-db`（由 46 个迁移 + 权限目录种子构成；`id_pools` 含 500 行本地 fixture，`certificates` 经插入 1 行 fixture 补数据）。
  - 编译产物与已部署 Worker **完全相同**（同一 commit `f3e40b4` 源码），路由 / 鉴权 / RBAC / 证书读取逻辑一致性 1:1。
  - 真实 staging D1（`85853fb1`）数据（450,500 / 413）完整性由 §2 / §T7 通过只读 API 独立证明；HTTP 层不对其写入。
- 7 项烟测均在**同一 Bash 命名空间**内（dev server 与 curl 同进程树）执行，规避沙箱跨调用网络隔离（每 Bash 调用独立 netns）。

### 7.2 烟测结果（7/7 PASS）

| # | 检查 | 端点 / 方式 | 实测 | 结果 |
| --- | --- | --- | --- | --- |
| T1 | GET health（staging 运行时身份） | `GET /health`（本地 dev 临时置 top-level `ENVIRONMENT=staging`） | `200` · `environment:"staging"` · `d1Binding:"present"` · `migrationsApplied:46` | ✅ |
| T2 | 匿名受保护端点 → 401 | `GET /api/v2/certificates/verify`（无 auth） | `401` · `AUTH_REQUIRED` | ✅ |
| T3 | 普通主体访问特权端点 → 403 | `GET /api/v2/certificates/admin/templates`（`x-test-role: volunteer`） | `403` · `FORBIDDEN` | ✅ |
| T4a | 证书读取路径（持有者本人） | `GET /api/v2/certificates/<26-char ULID>`（`x-test-user:50`，owner） | `200` · 返回 certificate 详情 | ✅ |
| T4b | 证书读取路径（非持有者） | `GET /api/v2/certificates/<26-char ULID>`（`x-test-user:999`） | `403` · `FORBIDDEN`（所有权强制） | ✅ |
| T5 | 证书验真 → 行为 | `GET /api/v2/certificates/verify?cert_no=&code=`（无 auth） | `401` · `AUTH_REQUIRED`（见 §7.3） | ✅ |
| T6 | My Certificates（已认证安全行为） | `GET /api/v2/certificates/mine`（`x-test-user:50`） | `200` · 返回该用户 1 张证书 | ✅ |

> 认证 fixture 通道（`x-test-role` / `x-test-user` / `x-test-team`）仅在 `ENVIRONMENT=local` 时启用（源码 `middleware/auth.ts`）；T3/T4/T6 在 `ENVIRONMENT=local` 镜像执行，T1/T2/T5 在临时 `ENVIRONMENT=staging` 镜像执行。两套镜像共用同一 LOCAL D1。权限目录本地种子 = `permissions 105 / role_permissions 297`（RBAC 解析正常，volunteer 不含 `certificate.template.manage` → T3 干净 403）。

### 7.3 关键发现：公开验真端点实为鉴权端点（技术债确认）

- 源码 `routes/certificates.ts` 中**仅存在** `GET /api/v2/certificates/verify`，其处理器调用 `buildService(c)`，未认证即 `throw authRequired()` → **401**。
- **不存在** `GET /api/v2/public/certificates/verify` 匿名公开验真路由（原 R3F Prompt 所述「公开验真」实为计划/占位，当前未实现或已并入鉴权端点）。
- 结论：当前「证书验真」**要求认证**，匿名访问返回 401 —— 此即原 Prompt 所指「公开验真已知技术债」的真实状态。**本轮未修改**该端点实现（§20 纪律保持）。

### 7.4 端点映射（实测确认，未改）

- `GET /health`：无鉴权，返回 `status / environment / d1Binding / schema.migrationsApplied`。
- `GET /api/v2/certificates/verify`：需认证 → 未认证 401。
- `GET /api/v2/certificates/mine`：SELF，需认证。
- `GET /api/v2/certificates/:certificatePublicId`：SELF / 团队管理员，需认证 + **26-char ULID** 参数校验（非 ULID → `400 INVALID_PARAM`）。
- `GET /api/v2/certificates/admin/templates`：需 `certificate.template.manage` 权限（volunteer → 403）。

### 7.5 HTTP 烟测后 staging D1 完整性（T7）

- 烟测全部为 GET（只读），仅命中 LOCAL D1 镜像；真实 staging D1 未被任何 HTTP 请求触及。
- 烟测后重新对 **真实 staging D1** 只读复核：`id_pools=450,500` / `legacy_migrated=450,000` / `certificates=413` / `provenance NULL=0` / `重复 code 组=0` / `d1_migrations=46`，且 `changed_db:false`（无写）。
- 结论：staging D1 在 HTTP 运行时验收后**数据完整、零变更**。

---

## 8. 验收证书决策（§23，NOT ISSUED）

```
ACCEPTANCE_CERTIFICATE_ISSUED = NO
```

依据（满足用户显式任一即 NO 的条件）：

- **无安全 acceptance principal**：staging 环境无真实验收主体上下文；
- **manual acceptance 编号合同不明确**：未提供可审计的验收证书编号/活动/服务契约；
- **会消耗未经授权的 cert_trn / cert_srv / cert_hon / cert_skl**：发证将占用已迁移号池（450,000 legacy + 500 合成），超出本 Gate 授权；
- **会伪造活动 / 服务 / 培训 / 考试事实**：无对应真实业务实体即发证，等价于伪造事实。

→ 不签发任何 acceptance / 真实证书；继续完成 read-only / 运行时（受网络限制）验收即可。

---

## 9. 密钥 / 密钥扫描（§28，PASS）

- 对部署源 `workers/src` + `workers/wrangler.jsonc` 扫描 `api_token / api_key / secret / password / private_key / Bearer` 等：仅命中注释中的安全纪律描述（如「不存 AppSecret」「apiKey 属敏感字段，仅传 adapter」），**无硬编码密钥/令牌/密码/私钥**。
- `d372229f`（prod DB）仅在 `env.production` 配置块出现，未被 `-e staging` 使用。

---

## 10. 部署后完整性 / 回归 / 回滚（§25–§26，部分）

- D1 终态：已通过只读 API 全量对账 PASS（§2），部署未改动数据。
- 回归：typecheck + dry-run 通过（§5.1）；运行时套件因网络限制未跑（§7）。
- 回滚预案：如需回滚，将 `jhzy-v2-worker-staging` 切回上一 active 版本 `f9c78bab-8a21-4e97-8d98-322365373c36`（2026-10-02）即可，数据层不受影响。

---

## 11. 证据 Git 策略（§29，HARD STOP 要求）

- **本 R3F 审计报告 `27-cert-r3f-…md` 不提交**（HARD STOP §16）。
- 不 push、不开始生产迁移、不部署生产、不应用生产 0045/0046、不导入生产 450k 池。

---

## 12. FINAL RETURN（§44）

```
CERT_R3F_STATUS = PASS_WITH_FINDINGS
- 选择性提交 R3E 证据：PASS（新 HEAD f3e40b4）
- Staging R3E 终态重验证：PASS（全维度 READ-ONLY）
- 快照 SHA：PASS（pre/post 一致）
- 隔离 worktree 部署源纯净：PASS
- 预部署回归：PASS（tsc + dry-run）
- Staging Worker 部署：SUCCESS（jhzy-v2-worker-staging / 026e5345… / 85853fb1）
- 生产/default 写目标：NONE（STOP 未触发）
- 运行时 HTTP 烟测：PASS（本地 dev 镜像，7/7：health/staging 身份 · 401 · 403 · 证书详情 · 所有权强制 · 验真 401 · My Certificates）
- 验收证书：NOT ISSUED（NO）
- 密钥扫描：PASS（无硬编码密钥）
- 生产/JHZY 1.0：未触碰
```

---

## 13. HARD STOP（§46）

- 不提交 R3F 证据（本报告保持 untracked）。
- 不 push。
- 不开始生产号池迁移。
- 不部署生产 Worker。
- 不应用生产 0045 / 0046。
- 不导入生产 450,000 行池。

---

## 14. 运维前向纪律（新增）

- **多账户 OAuth profile 部署**：`deploy` 账户选择不可依赖隐式解析；以 `--profile <p>` + `CLOUDFLARE_ACCOUNT_ID=<id>` 双锁，或在 profile 配置显式 `account_id`，避免回落到 token 主账户导致「D1 未找到」。
- **沙箱网络**：Cloudflare API 主机可放行，Worker 公开运行时 URL（`*.workers.dev`）经本地代理 502；`wrangler dev --remote` 的 remote tunnel 亦不可达（TCP accept 后无响应）。运行时 HTTP 烟测无法直连已部署 Worker。
- **运行时 HTTP 烟测的本地镜像法（本轮验证有效）**：当无法直连 `*.workers.dev` 时，用 **本地 `wrangler dev`（无 `--remote`）绑定 LOCAL D1 镜像**执行 HTTP 烟测 —— 需在**同一 Bash 调用**内启动 dev server 与 curl（沙箱每调用独立 netns，跨调用 localhost 不可达）。本地 D1 经 `wrangler d1 migrations apply <db> --local` 建库 + 权限种子（来自迁移），再插入最小 fixture（user/team/cert）即可覆盖 401/403/SELF 读取路径。已部署 Worker 的逻辑一致性由「同 commit 源码」保证；真实 D1 数据完整性用只读 API 独立证明。
- **公开验真技术债（真实状态）**：当前 `routes/certificates.ts` 仅 `GET /api/v2/certificates/verify` 且**需认证**（匿名 401），**不存在**匿名 `public/certificates/verify` 路由。验收/交付文档中勿再标注「匿名公开验真」为已实现能力。
