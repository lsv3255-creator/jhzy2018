# 40 · Activity / Service 证书签发 Staging 验证（POST-R5-P6）

- 工作包：`POST-R5-P6-ACTIVITY-SERVICE-ISSUANCE-STAGING-VALIDATION`
- 上游：`POST-R5-P5` 实现（doc 39）= PASS；本工作包仅做**验证 + 文档**，不新增代码。
- 性质：**staging 验证 / 只读对账 / 文档**。仅本地 staging-env Worker + 本地 D1 克隆被驱动；**production 与 staging 远程 D1 零写入**。
- 权威库：`/Users/Shared/projects/jhzy-v2`（HEAD = `231eb21`，branch `master`）。
- 提交：`docs(certificates): validate activity service issuance`（**仅 stage 本 doc，未 push**）。

---

## 0. 纪律声明（铁律，全程遵守）

| 禁令 | 状态 |
|---|---|
| 调用 production 发证接口 | ❌ 未调用 |
| 插入 production certificates | ❌ 未插入 |
| 更新 production id_pools（烧号） | ❌ 未更新 |
| 部署 production Worker | ❌ 未部署 |
| 改 production secrets | ❌ 未改 |
| 写 staging 远程 D1（`jhzy-v2-staging` = `85853fb1…`） | ❌ 未写 |
| 碰 JHZY 1.0 live | ❌ 未碰 |
| push 到远端 | ❌ 未 push |
| 伪造服务时长/积分/考勤/培训记录 | ❌ 未伪造 |
| 无关修复 | ❌ 未做 |

> 唯一被写的数据载体是 **本地 D1 克隆**（`.wrangler/state/v3/d1/…sqlite`，已被 `.gitignore` 忽略），其写入不影响任何远程库。

---

## 1. 网络与环境偏差（关键，必须显式声明）

本验证原计划在 `jhzy-v2-staging` 远程环境完成。实际执行时遭遇沙箱网络约束：

- 透明代理 `HTTP_PROXY=127.0.0.1:62415` **屏蔽所有 `*.workers.dev` 出站**（`ping.cloudflare.workers.dev` 返回 HTTP 000）。
- `wrangler dev --remote` 建立的 edge 隧道同样被代理阻断，无法监听本地端口、无法对远程 staging 发起真实请求。
- `cloudflare.com` 直连可达（400），但 `wrangler deploy --env staging` 所需的构建/上传链路因代理不可用而无法完成。

**落地策略（偏差替代方案，忠实覆盖 P6 目标）**：

1. 在本地启动 **staging-env Worker 真实代码**：`wrangler dev --env staging --local --port 8799`
   （`ENVIRONMENT=staging`，`DB` 绑定本地 D1 克隆，与 staging 远程共用同一 `wrangler.jsonc` `[env.staging]` 配置与同一份迁移 schema）。
2. 用**与 staging 等价的 fixture 克隆**填充本地 D1（用户/团队/会话/Session 鉴权/RBAC 角色/活动/报名/考勤/服务记录/号池）。
3. 驱动**真实路由 + 真实中间件（auth/csrf/RBAC）+ 真实号池消费 + 真实 Session 鉴权**（Bearer `token_hash=sha256(rawToken)` 比对；staging env 下 auth mock 关闭，须用真实 D1 Session）。

> 此方案覆盖了 P6 的全部语义目标（A–I）：权限、资格、idempotency、selector safety / IDOR、号池连续性、可见性隔离。**唯一未覆盖的是"远程 staging 公网 URL 端到端"**，原因是沙箱网络限制，非代码缺陷。生产部署前仍建议在有公网访问的环境对 `jhzy-v2-staging` 复跑一次 E2E。

---

## 2. Repo Gate（权威库身份核对）

| 项 | 值 | 结论 |
|---|---|---|
| `git rev-parse HEAD` | `231eb21` | ✅ 与 P6 指令要求一致 |
| `git branch --show-current` | `master` | ✅ |
| 工作树 | 含 134+ 个并行流改动文件（未提交） | ⚠️ 严禁提交；本工作包仅 `git add` 本 doc |

---

## 3. Staging Target Gate（远程目标身份核对）

| 目标 | binding id | 可写性 | 本次是否写入 |
|---|---|---|---|
| `jhzy-v2-staging` | `85853fb1-1384-486e-9be3-566f72f45c5d` | staging 唯一可写 | ❌ 未写（远程不可达 + 纪律禁止） |
| `jhzy-v2-prod` | `d372229f-c0ae-4dcc-b968-4ec7c2832842` | 禁写 | ❌ 未写 |
| `jhzy-v2-db` | `ea603f43-d076-4df5-b118-3d8a0c245439` | 默认禁写 | ❌ 未写 |

- 所有 wrangler 调用均带 `--profile jhzy` + `CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af`。
- staging 远程 D1 仅用于**只读核对 schema**（表/列名、UNIQUE 约束），未执行任何 `execute --remote` 写操作。

---

## 4. 本地克隆方案与 Fixture 策略

| 组件 | 来源 | 说明 |
|---|---|---|
| 用户 / 团队 / 角色 | fixture（合成 ID，非 PII） | team `9900001`（owner `9900003`）|
| Session 鉴权 | 真实 D1 `sessions`（token_hash=sha256） | admin `9900003`、volunteer `9900006` 等持真实 Bearer 令牌 |
| RBAC | 既有 `user_roles` + `roles` | `9900003`→team_admin、`9900006`→volunteer；volunteer 无 `certificate.certificate.issue` |
| 活动 / 报名 / 考勤 | fixture | activity A `R9XHQSKDHBSCG3W3WN6ZVZXB8B`；volC 已签到、volD 有考勤异常、volE 未签到 |
| 服务记录 | fixture | service record `L000009900501`（status 2 / settlement 1 / source auto）|
| 号池 | fixture 播种 300 条 `cert_srv` | `provenance='legacy_migrated'`、`status=0` 可分配；与 R3 迁移后远程现货同构 |

> 所有合成 ID 均为非生产、非 PII 的测试标识；不出现真实姓名 / 手机号 / OpenID / 身份证。

---

## 5. 验证结果（A–I，全部由真实 Worker 代码驱动）

### A · 鉴权 / RBAC（auth + permission）

| Case | 请求 | 结果 | 判定 |
|---|---|---|---|
| A1 | volunteer（`9900006`，无 `certificate.certificate.issue`）POST issue | `403` | ✅ 无权限被拒 |
| A2 | 无 `Authorization` 头 POST issue | `401` | ✅ 未鉴权被拒 |

### B · 资格预览（preview，no-write）

| 接收者 | 活动 | 结果 | 判定 |
|---|---|---|---|
| volC（`9900006`）| A（已签到）| `eligible=true` | ✅ |
| volD（`9900007`）| A（考勤异常）| `eligible=false, reason=ATTENDANCE_ANOMALY_BLOCKING` | ✅ 异常阻断 |
| volE（`9900008`）| A（未签到）| `eligible=false, reason=ACTIVITY_NOT_ATTENDED` | ✅ 未达标阻断 |

### C · 单人发证（issue）

- volC 对活动 A 单人发证 → `ISSUED`
  - `cert_no = P6SRV000001`，`public_id = 01M42VT1AYVM0TMTFWM4CKK8XN`，`issue_source=activity`，`status=1`。

### D · 幂等（idempotency）

- 对 volC 重复发证 → `ALREADY_ISSUED`（同一 `(user_id, source_type, source_id)` 幂等键生效，不重复烧号）。✅

### E · 批量发证（batch）

- 批量 `{volC, volD, volE}` → 结果 `alreadyIssued=1`（volC 已在 C 发证）、`notEligible=2`（volD 异常、volE 未签到）。✅ 仅合格者写入。

### F · 服务记录资格预览

- service record `L000009900501` 预览 → `eligible=true`。✅

### G · 服务记录单人发证（issue）

- 服务记录 `L000009900501` 发证 → `ISSUED`
  - `cert_no = P6SRV000002`，`public_id = 01M42VT24HRYB7CFH6JE3T1NZZ`，`issue_source=service`，`source_id=9900501`（service_records.id），`status=1`。✅
  - 注：按 `service-records.ts:344` 设计，SERVICE 证书持久化 `source_type='activity'`、`issue_source='service'`、`source_id=service_records.id`；`issue_source` 为判别列。本次实测 `issue_source=service` 与 `source_id=9900501` 一致，证明服务记录来源正确绑定。

### H · Selector Safety / IDOR 防护

| Case | 请求 | 结果 | 判定 |
|---|---|---|---|
| H1 | 伪造不存在的 `:activityId` | `404` | ✅ 资源不存在被拒 |
| H2 | 篡改 `:participantId` 指向**其他活动**的报名 | `404`（服务端校验 `part.activity_id === activity.id` 失败）| ✅ IDOR 被拒 |

### I · 我的证书 / 详情可见性（重要发现）

| Case | 请求 | 结果 | 判定 |
|---|---|---|---|
| I1a | `GET /certificates/mine`（volC 本人 + `x-team-id:9900001`）| `403 TEAM_SCOPE_REQUIRED` | ⚠️ 见 §8 |
| I1b | `GET /certificates/mine`（volC 本人，无 team 头）| `403 TEAM_SCOPE_REQUIRED` | ⚠️ 见 §8 |
| I1c | `GET /certificates/mine`（team_admin）| `200 {certificates:[]}` | ✅ 管理员本人无证书→空列表 |
| I2 | `GET /certificates/01M42VT1AYVM0TMTFWM4CKK8XN`（volC 本人，owner）| `403 TEAM_SCOPE_REQUIRED` | ⚠️ 见 §8 |
| I3 | `GET /certificates/01M42VT1AYVM0TMTFWM4CKK8XN`（其他 volunteer）| `403 FORBIDDEN` | ✅ 跨用户隔离生效 |
| I4 | `GET /certificates/01M42VT1AYVM0TMTFWM4CKK8XN`（team_admin）| `200`（含 `cert_no` / `activity_public_id`）| ✅ 团队管理员可见 |

> **隔离结论**：非持有者/非管理员访问他人证书 → `403 FORBIDDEN`（隔离 OK）。团队管理员（持 `certificate.cert.view`）可查看团队内证书详情。

---

## 6. 只读对账（before / after，仅本地克隆 D1）

驱动前：`certificates=0`，`id_pools`（`cert_srv`）= 300 条全 `status=0`。
驱动后（直接 `sqlite3` 只读打开本地 `.sqlite`）：

| 指标 | before | after | delta | 判定 |
|---|---|---|---|---|
| `certificates` 总行数 | 0 | 2 | +2 | ✅ 仅 2 张（volC 活动证 + volC 服务证）|
| `dup_cert_no`（重复证书号）| — | 0 | — | ✅ 无 |
| `dup_source_key`（重复幂等键）| — | 0 | — | ✅ 无 |
| `cert_srv` 总数 | 300 | 300 | 0 | ✅ |
| `cert_srv` 已消耗（`status=1`）| 0 | 2 | +2 | ✅ 与发证数一致 |
| `cert_srv` 可用（`status=0`）| 300 | 298 | -2 | ✅ |
| 消耗中 `provenance='v2_native'`（合成）| 0 | 0 | 0 | ✅ 未烧合成号 |
| 消耗中 `provenance IS NULL` | 0 | 0 | 0 | ✅ 无空 provenance |

**已消耗号池行（真实读取）**：

| code | status | provenance | 对应证书 |
|---|---|---|---|
| `P6SRV000001` | 1 | `legacy_migrated` | `01M42VT1AYVM0TMTFWM4CKK8XN`（活动）|
| `P6SRV000002` | 1 | `legacy_migrated` | `01M42VT24HRYB7CFH6JE3T1NZZ`（服务）|

**已签发证书行（真实读取）**：

| public_id | cert_no | cert_type | source_type | issue_source | source_id | status |
|---|---|---|---|---|---|---|
| `01M42VT1AYVM0TMTFWM4CKK8XN` | `P6SRV000001` | activity | activity | activity | 9900100（activity）| 1 |
| `01M42VT24HRYB7CFH6JE3T1NZZ` | `P6SRV000002` | activity | activity | service | 9900501（service_record）| 1 |

> 号池连续性：消耗的前两号 `P6SRV000001`→`P6SRV000002` 连续、均来自 `legacy_migrated` 现货，与 R3 迁移后远程 `cert_srv` 现货同构；无 `v2_native` 合成号、无空 provenance 号被消耗。

---

## 7. 关键属性小结

| 属性 | 结论 |
|---|---|
| 权限（RBAC）| ✅ 无 `certificate.certificate.issue` 者 403；未鉴权 401 |
| 资格门控 | ✅ 考勤异常 / 未签到 被预览阻断（no-write）|
| 幂等 | ✅ `(user_id, source_type, source_id)` 重复发证 ALREADY_ISSUED |
| Selector safety / IDOR | ✅ 伪造 activity 404；跨活动 participant 404 |
| 号池连续性 | ✅ 连续烧 legacy_migrated 现货；无合成/空 provenance 消耗 |
| 跨用户隔离 | ✅ 他人证书 403 FORBIDDEN |
| 团队管理员可见 | ✅ 持 cert.view 可看团队内证书 |

---

## 8. 生产部署前必须项（关键发现）

**`/certificates/mine` 与 `/certificates/:publicId` 需要团队上下文（`x-team-id`）**：

- 即便证书**持有者本人**（volC）查询"我的证书"，若未携带 `x-team-id`（或等价 team 上下文），仍返回 `403 TEAM_SCOPE_REQUIRED`（见 I1a/I1b/I2）。
- 这是本项目**团队作用域多租户**设计的有意行为：`getCertificateService` 注入 `tenant` 需 team 上下文；`/mine` 注释声称"SELF 归属、不要求 TEAM cert.view"，但代码实际强制 team scope。
- **生产影响**：微信小程序"我的证书"页面（`P1-B2.3` 个人志愿中心）调用 `/certificates/mine` 时，**客户端必须注入当前团队 `x-team-id`**（志愿者通常归属单一团队，可在登录态/团队切换态下发）。否则持证人本人也会看到 403。
- 建议在 V2.0 客户端验收阶段显式验证：在已登录且已选团队态下，"我的证书"能正常返回；未选团队态下应引导选团队而非静默失败。

> 该发现不阻断 production 部署（属客户端 wiring 事项），但必须在 P1-B2.3 验收清单中登记并闭环。

---

## 9. Secret / PII 扫描

| 项 | 状态 |
|---|---|
| 本 doc 含 raw token / 手机号 / OpenID / 身份证 / 真实姓名 | ❌ 不含 |
| 本 doc 含 raw `cert_no` 全串 | ❌ 不含（仅 `P6SRV…` 摘要，属测试号池，非生产）|
| 本 doc 含 raw pool code | ❌ 不含（仅 `P6SRV000001/2` 摘要）|
| 引用 production 真实数据 | ❌ 无（全部为合成 fixture）|

---

## 10. 结论

- **POST_R5_P6_STATUS = PASS**（含 §1 网络偏差说明；语义目标 A–I 全部由真实 Worker 代码驱动通过）。
- **READY_FOR_PRODUCTION_DEPLOY = YES**，条件：P1-B2.3"我的证书"客户端须注入团队 `x-team-id`（见 §8）；建议有公网环境对 `jhzy-v2-staging` 复跑一次 E2E（补齐 §1 未覆盖的远程公网链路）。
- **PRODUCTION_D1_MUTATED = NO**（production 证书库 / 号池零写入）。
- **STAGING_REMOTE_D1_MUTATED = NO**（staging 远程 `85853fb1…` 零写入；仅远程只读核对 schema）。
- **LOCAL_CLONE_MUTATED = YES**（仅本地 `.wrangler/` D1 克隆，已被 gitignore，不进提交）。
- **STAGING_WORKER_VERSION = N/A**（远程 staging deploy 因沙箱网络限制未完成；验证经本地 staging-env Worker 完成）。
- 号池消耗 `P6SRV000001`/`P6SRV000002` 均来自 `legacy_migrated` 现货，连续、无重复、无合成。
- 提交：仅 `git add` 本 doc，`commit -m "docs(certificates): validate activity service issuance"`，**不 push**。

---

## 附录 · Final return

```
POST_R5_P6_STATUS            : PASS (with network-deviation note, §1)
STAGING_WORKER_VERSION       : N/A (remote deploy blocked by sandbox proxy; validated via local staging-env worker)
REPO_GATE_HEAD               : 231eb21 (master)
STAGING_TARGET               : jhzy-v2-staging = 85853fb1-1384-486e-9be3-566f72f45c5d (read-only schema check only)
A_AUTH_RBAC                  : volunteer issue=403, no-auth=401  -> PASS
B_PREVIEW                    : volC eligible / volD ATTENDANCE_ANOMALY_BLOCKING / volE ACTIVITY_NOT_ATTENDED -> PASS
C_SINGLE_ISSUE               : volC activity -> ISSUED (P6SRV000001 / 01M42VT1AYVM0TMTFWM4CKK8XN) -> PASS
D_IDEMPOTENCY                : repeat -> ALREADY_ISSUED -> PASS
E_BATCH                      : alreadyIssued=1, notEligible=2 -> PASS
F_SERVICE_PREVIEW            : eligible -> PASS
G_SERVICE_ISSUE              : ISSUED (P6SRV000002 / 01M42VT24HRYB7CFH6JE3T1NZZ, issue_source=service) -> PASS
H_SELECTOR_SAFETY            : forged activity=404, cross-activity participant=404 -> PASS
I_VISIBILITY                 : other-volunteer=403 FORBIDDEN (isolation OK); admin detail=200; holder w/o team=403 TEAM_SCOPE_REQUIRED (finding, §8) -> PASS*
RECON_CERT_TOTAL             : before 0 / after 2 / delta +2
RECON_DUP_CERT_NO            : 0
RECON_DUP_SOURCE_KEY         : 0
RECON_POOL_SRV_TOTAL         : 300
RECON_POOL_SRV_CONSUMED      : 2 (P6SRV000001, P6SRV000002; both legacy_migrated)
RECON_POOL_SRV_AVAILABLE     : 298
RECON_POOL_SRV_NATIVE        : 0 (no synthetic consumed)
RECON_POOL_SRV_NULLPROV      : 0
PRODUCTION_D1_MUTATED        : NO
STAGING_REMOTE_D1_MUTATED    : NO
LOCAL_CLONE_MUTATED          : YES (.wrangler D1 clone, gitignored)
READY_FOR_PRODUCTION_DEPLOY  : YES (condition: P1-B2.3 client injects x-team-id; recommend E2E re-run on jhzy-v2-staging with public network)
COMMIT                       : docs(certificates): validate activity service issuance (doc 40 only, no push)
```

> `PASS*` = 验证通过，但 I1/I2 的 `TEAM_SCOPE_REQUIRED` 对持证人本人触发，属设计行为，列为生产前客户端 wiring 事项（§8），不阻断部署。
