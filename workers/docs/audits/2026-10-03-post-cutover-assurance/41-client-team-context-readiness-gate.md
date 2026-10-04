# 41 · 客户端 Team Context 就绪闸门（POST-R5-P6B）

- 工作包：`POST-R5-P6B-CLIENT-TEAM-CONTEXT-GATE`
- 上游：`POST-R5-P6` staging validation = `PASS_WITH_FINDINGS`（doc 40 关键 finding：证书接口强制 team scope）。
- 性质：**客户端审计 / 静态契约验证 / 文档 + 测试（无业务代码改动）**。仅本地静态检查 + 新建验证测试；**绝不**触碰 production。
- 权威库：`/Users/Shared/projects/jhzy-v2`（HEAD = `bbc1459`，branch `master`）。
- 提交：`docs(certificates): confirm client team context readiness`（**stage 本 doc + 新建测试文件，未 push**）。

---

## 0. 纪律声明（铁律，全程遵守）

| 禁令 | 状态 |
|---|---|
| 调用 production 发证接口 | ❌ 未调用 |
| 写 production D1 | ❌ 未写 |
| 部署 production Worker | ❌ 未部署 |
| 改 production secrets | ❌ 未改 |
| 碰 JHZY 1.0 live | ❌ 未碰 |
| 真实发证（本地/远程）| ❌ 未发 |
| push 到远端 | ❌ 未 push |
| 改证书发放业务逻辑 | ❌ 未改（仅新增静态测试，非业务代码）|
| 无关修复 | ❌ 未做 |

---

## 1. P6 Finding 背景

doc 40（§8）发现：后端 `/certificates/mine` 与 `/certificates/:certificatePublicId` 强制**团队作用域**（team scope）。即便持证人本人查询，若请求未携带 `x-team-id`（或等价团队上下文），后端返回 `403 TEAM_SCOPE_REQUIRED`。

该行为不阻断后端 production deploy，但必须在**客户端/前端**闭环：否则志愿者“已有证书却看不到”（静默空列表或 403 裸错误）。本闸门审计小程序/前端/管理端的证书接口调用是否可靠注入当前团队上下文 `x-team-id`，并在缺失时给出明确提示（而非误导性的“暂无证书”）。

---

## 2. 审计范围

| 范围 | 路径 | 说明 |
|---|---|---|
| 统一 Request Client | `miniprogram/utils/transport.ts` | 唯一 Header Builder（`buildHeaders`）+ 唯一请求核心 |
| 志愿者证书客户端 | `miniprogram/utils/trainingApi.ts` | `listMyCertificates` / `getCertificate` |
| 管理端证书客户端 | `miniprogram/utils/adminApi.ts` | `listTrainingCertificates` |
| 团队上下文存储 | `miniprogram/utils/session.ts` | `getActiveTeamId` / `setActiveTeamId` / `clearActiveTeamId` |
| 我的证书页 | `miniprogram/pages/certificates/certificates.ts` (+`.wxml`) | 志愿者端 |
| 证书详情页 | `miniprogram/pages/certificates/detail/detail.ts` | 志愿者端 |
| 管理端证书列表页 | `miniprogram/pages/admin/training-certificates/index.ts` | 管理端 |
| 管理面板（团队门控）| `miniprogram/pages/adminPanel/adminPanel.ts` | `checkTeamContext` |
| 团队选择 | `miniprogram/utils/teamApi.ts` / `pages/teams/select/select.ts` | `selectActiveTeam` → `setActiveTeamId` |

> 本仓库无独立 web 管理前端；"管理端"即小程序 admin 页面（`pages/admin*`），统一经 `adminApi` 调用。

---

## 3. 客户端请求链路（team context 如何注入）

1. **统一 Header Builder**（`transport.ts:68-83`）：`buildHeaders(opts)` 当 `opts.teamScoped` 为真且 `getActiveTeamId()` 非空时，注入 `header['X-Team-Id'] = teamId`。**不硬编码 team id**。
2. **wrapper 默认团队作用域**：
   - `trainingApi.request`（trainingApi.ts:133-138）：`const teamScoped = opts.teamScoped !== false;` → 默认 `true`。`listMyCertificates` / `getCertificate` 均未传 `teamScoped:false`，故均注入 `X-Team-Id`。
   - `adminApi.request`（adminApi.ts:445-449）：`const teamScoped = opts.teamScoped !== false;` → 默认 `true`。`listTrainingCertificates` 注入 `X-Team-Id`。
3. **团队上下文来源**：`session.getActiveTeamId()` 读 `wx.getStorageSync('activeTeamPublicId')`。用户在 `pages/teams/select` 加入/选择团队时经 `teamApi.selectActiveTeam` → `session.setActiveTeamId` 持久化。
4. **请求时实时读取**：`buildHeaders` 在每次请求时调用 `getActiveTeamId()`，故**切换团队后下一次请求自动使用新团队 id**（无需刷新页面）。
5. **志愿者证书页 pre-guard**：`certificates.ts` / `detail.ts` 在调用 API 前执行 `ensureTeam()` → `hasTeamContext()`（`getActiveTeamId().length > 0`）。无团队时**不发起请求**，直接置 `teamMissing` 并渲染“请先选择团队”提示 + “去选择团队”按钮（`.wxml` `wx:if="{{teamMissing}}"`）。
6. **防御性错误兜底**：即便后端返回 `403` / `TEAM_SCOPE_REQUIRED`，页面对此置 `teamMissing` 并提示，绝不静默展示“暂无证书”。

---

## 4. 四个判定字段

| 判定 | 值 | 证据 |
|---|---|---|
| `MINIPROGRAM_CERT_MINE_TEAM_CONTEXT` | **YES** | `certificates.ts` → `trainingApi.listMyCertificates()`（→ `/certificates/mine`）；wrapper 默认 `teamScoped=true`；`ensureTeam()` pre-guard + `teamMissing` 显式提示 |
| `CERT_DETAIL_TEAM_CONTEXT` | **YES** | `detail.ts` → `trainingApi.getCertificate(publicId)`（→ `/certificates/:id`）；同上注入 + pre-guard + `TEAM_SCOPE_REQUIRED` 兜底 |
| `ADMIN_CERT_TEAM_CONTEXT` | **YES** | `admin/training-certificates/index.ts` → `adminApi.listTrainingCertificates()`（→ `/certificates/admin`）；`adminApi.request` 默认 `teamScoped=true`；入口受 `adminPanel.checkTeamContext()` 门控 |
| `GLOBAL_REQUEST_CLIENT_INJECTS_TEAM` | **YES** | `transport.buildHeaders` 在 `teamScoped` 时注入 `X-Team-Id`（取自 `getActiveTeamId`）；所有证书 wrapper（`trainingApi` + `adminApi`）默认 `teamScoped=true`；志愿者证书页另加 `hasTeamContext()` pre-guard 作为纵深防御 |

> 关于 `GLOBAL_REQUEST_CLIENT_INJECTS_TEAM` 的精确说明：`transport.buildHeaders` 本身是**显式 opt-in**（`opts.teamScoped` 才注入，非无条件注入——因为登录/whoami 等非团队端点不应带 team 头）。但在**证书作用域**内，所有调用方（trainingApi / adminApi）均默认开启 `teamScoped`，且志愿者证书页在调用前已 pre-guard。因此**实际效果上，每条证书请求在有活跃团队时都携带 `x-team-id`**。判为 YES。

---

## 5. 是否改代码

**未改业务代码。** 所有证书相关客户端请求已可靠注入 `x-team-id`（见 §3–§4），满足 P6B 决策分支“若所有证书相关客户端请求都已可靠注入 x-team-id：只写文档，不改代码”。

唯一新增文件为**静态验证测试**（非业务逻辑）：
`miniprogram/tests/cert_team_context_contract.mjs` —— 以源码正则断言上述不变量，作为回归护栏。

### 非阻断观察（建议后续，不在本闸门范围）

`pages/admin/training-certificates/index.ts` 本身**未**像志愿者页那样加 `ensureTeam()` pre-guard；它依赖 `adminPanel` 级团队门控 + 后端 403 的通用 toast。由于 `adminApi` 已注入 team 头且 `adminPanel` 已门控，不会出现“静默空列表”，但管理端证书页缺少专属“去选择团队”CTA（与志愿者页不对称）。建议后续在管理端证书页补 `ensureTeam()` 以完全对齐志愿者体验——**不阻断 production deploy**。

---

## 6. 测试 / 验证结果

- **静态契约测试**：`miniprogram/tests/cert_team_context_contract.mjs`（`node` 运行，managed Node 22）。
  - 结果：**32 passed, 0 failed**。
  - 覆盖：Header Builder 注入机制（无硬编码）、trainingApi/adminApi 默认 `teamScoped=true`、证书端点均非 `teamScoped:false`、志愿者证书页 `pre-guard` + 显式提示、证书调用一律经 V2 wrapper（无 legacy/散写 `wx.request` 绕过）。
- **手工代码走查**：已逐文件确认 `transport.ts` / `trainingApi.ts` / `adminApi.ts` / `session.ts` / `certificates.ts` / `detail.ts` / `adminPanel.ts` / `teamApi.ts` / `select.ts` 的 team context 链路（见 §3）。

---

## 7. Regression / 类型检查 / 构建

| 项 | 结果 |
|---|---|
| 前端 typecheck（`npm run typecheck`）| **不存在该脚本**（仓库 root `package.json` scripts 为空；小程序为微信原生 TS，由微信开发者工具编译，无 CI typecheck harness）|
| 前端 build | **不存在**（微信小程序构建由微信开发者工具完成，仓库无 build 脚本）|
| 后端 test / build | 本闸门**未改后端代码**，无需重跑后端测试套件 |
| 静态契约测试 | ✅ 32/0（见 §6）|

> `TEST_LIMITATION = NO_FRONTEND_TYPECHECK_HARNESS`：本仓库前端无 `npm` 类型检查/构建脚本，故以**静态源码契约测试 + 人工走查**替代。未伪造任何通过结果。

---

## 8. 是否阻断 production deploy

**不阻断。** 客户端 team context 就绪（`MINIPROGRAM_CERT_MINE_TEAM_CONTEXT = YES` / `CERT_DETAIL_TEAM_CONTEXT = YES` / `ADMIN_CERT_TEAM_CONTEXT = YES`）。P6（doc 40）提出的 production deploy 条件——“P1-B2.3 我的证书客户端须注入团队 x-team-id”——已闭环。

---

## 9. 禁令符合性声明

| 声明 | 值 |
|---|---|
| no production D1 mutation | **NO**（production 证书库/号池零写入）|
| no certificate issued | **NO**（未发起任何发证，本地/远程均未）|
| no production worker deployed | **NO**（未部署）|
| no secret mutated | **NO**（未改 secrets）|
| JHZY 1.0 live touched | **NO**（未碰）|
| git push performed | **NO**（仅本地 commit，未 push）|

---

## 10. Secret / PII 扫描（变更文件）

| 项 | doc 41 | cert_team_context_contract.mjs |
|---|---|---|
| token / session token | ❌ 不含 | ❌ 不含 |
| 手机号 / OpenID / 身份证 / 真实姓名 | ❌ 不含 | ❌ 不含 |
| raw cert_no / raw pool code | ❌ 不含（仅引用 `X-Team-Id` 头名与端点路径）| ❌ 不含 |
| 硬编码 team id / user id | ❌ 不含 | ❌ 不含（测试仅断言源码不硬编码）|

---

## 11. 结论

POST-R5-P6B 闸门 **PASS**：客户端证书调用链已可靠注入团队上下文 `x-team-id`，且在缺失团队时给出明确提示（非误导空列表）。production deploy 不被 team-context 就绪度阻断。新增静态契约测试（32/0）作为回归护栏；未改任何业务代码，未 push。

---

## 附录 · Final return

```
POST_R5_P6B_STATUS            : PASS
START_HEAD                    : bbc1459
END_HEAD                      : <commit 后 SHA，见 §0>
COMMIT_SHA                    : <见 git log>
MINIPROGRAM_CERT_MINE_TEAM_CONTEXT : YES
CERT_DETAIL_TEAM_CONTEXT      : YES
ADMIN_CERT_TEAM_CONTEXT       : YES
GLOBAL_REQUEST_CLIENT_INJECTS_TEAM : YES (transport opt-in; all cert wrappers default teamScoped=true + volunteer pages pre-guard)
CODE_CHANGED                  : NO (business logic unchanged; added static test only)
TESTS                         : cert_team_context_contract.mjs -> 32 passed, 0 failed
TYPECHECK                     : NO_FRONTEND_TYPECHECK_HARNESS (no npm typecheck script; WeChat IDE compiles)
BUILD                         : NO_FRONTEND_BUILD_HARNESS (WeChat IDE builds)
SECRET_PII_SCAN               : PASS (no token/PII/hardcoded id)
READY_FOR_PRODUCTION_DEPLOY_GATE : YES (P6 condition closed)
PRODUCTION_D1_MUTATED         : NO
CERTIFICATE_ISSUED            : NO
PRODUCTION_WORKER_DEPLOYED    : NO
SECRET_MUTATED                : NO
JHZY_1_0_LIVE_TOUCHED         : NO
GIT_PUSH_PERFORMED            : NO
NEXT_ACTION                   : 可选——管理端证书页补 ensureTeam() CTA（非阻断）；建议有公网环境对 jhzy-v2-staging 复跑证书 mine/detail E2E
```
