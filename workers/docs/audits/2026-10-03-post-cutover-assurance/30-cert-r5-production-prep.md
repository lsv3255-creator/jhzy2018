# CERT-R5-PREP: Production Execution Pre-Conditions

> STATUS = **PREP ONLY**
> PRODUCTION EXECUTION = **NOT AUTHORIZED**
>
> 依据：`29-cert-r5-production-authorization-review.md`（CERT-R5-AUTH，PASS_WITH_FINDINGS）
> 与 `certificate-production-pool-migration-runbook.md`（§9 / §10）
>
> 本文件**仅补齐 R5 生产执行前的人工条件**，未执行任何生产写入。
> 全部写入命令仍为 TEMPLATE ONLY（见 R5-AUTH §10 / runbook §9）。

---

## 0. 输入基线

| 项 | 值 |
| --- | --- |
| 前置审查 | CERT-R5-AUTH = PASS_WITH_FINDINGS（`29-cert-r5-*.md`，commit `e85459f`） |
| READY_FOR_CERT_R5_PRODUCTION_EXECUTION | NO |
| PRODUCTION_EXECUTION_AUTHORIZED | NO |
| 本任务动作 | 维护窗口 / 角色分工 / 关闭入口 / HTTP E2E 方案 / Go-No-Go 表 |
| 生产写入 | 0（本任务零写） |

---

## 1. 建议维护窗口

| 项 | 建议 |
| --- | --- |
| 建议时段 | **02:00–04:00 CST**（与 runbook §0 一致） |
| 建议时长 | **120 分钟**（硬截止 04:00，不续做） |
| 下限 | 90 分钟（若 import + 对账顺畅） |
| 上限 | 120 分钟；超 04:00 立即触发回滚沟通预案，停止续做 |
| 选择理由 | 生产低峰；450k import + 对账 + Worker deploy + HTTP E2E 需缓冲；与既有快照窗口习惯一致 |
| 具体日期 | **不虚构** —— 由人工填入 `YYYY-MM-DD` |

> 若实际流量画像显示 02:00–04:00 非最低峰，须在授权前由人工调整并重新记录。

---

## 2. 执行人 / 复核人分工

三个**独立检查点**（可由同一人兼任，但须分阶段 gate，禁止静默连续执行）：

| 角色 | 职责 | 对应阶段 |
| --- | --- | --- |
| **执行操作员 (Operator)** | 运行 P1–P15 命令；双锁凭证持有者 | 全部写阶段 |
| **独立复核人 (Reviewer)** | 每阶段 `PRECONDITION` / `ABORT` 判定；确认后再放行 | 每阶段 gate |
| **沟通负责人 (Communicator)** | 窗口前内部公告、窗口后完成通知、回滚沟通预案触发 | P0 / P14 / P15 |

当前项目为单人主导（管理员），故三角色实为同一人 —— **但须在 runbook 每步显式打卡**（时间戳 + 阶段 + RESULT + 复核签名），自审自过须显式记录，不得静默连跑。

---

## 3. 维护窗口期间必须关闭的证书入口

### 3.1 源码扫描结论（read-only，本次新增）

- v2 Worker 当前**无运行时发证 POST 路由**：
  - `CertificateIssuanceService` 已定义，但仅被自身文件 / `certificate-number-allocator.ts`（注释）/ `domain/certificate.ts`（接口）引用，**未被任何 `routes/*` 调用**。
  - `routes/training.ts`、`routes/activities.ts` 均不含 `cert` / `issu` 引用。
  - 公开验真 `GET /api/v2/certificates/verify` 为只读，不写。
- 现有 413 张证书来源为 seed / migration，**非运行时签发**。

**结论**：当前 v2 Worker 在结构上已满足 `CLOSED_FOR_WRITES`。R5 仍须在 P3 显式确认 + 加固。

### 3.2 关闭清单（P3 阶段落实）

| # | 入口 | 类型 | 窗口期动作 |
| --- | --- | --- | --- |
| 1 | 运行时发证（training/activity/service/manual-acceptance） | 写（当前未接线） | 以只读 `SELECT` 验证无活跃写入路径；部署新 worker(P11) 前后比对路由表，确认新 worker 未引入发证写入 |
| 2 | `POST /api/v2/certificates/admin/templates` | 写（模板，非发证） | 窗口期冻结；确认无人操作 |
| 3 | `PUT /api/v2/certificates/admin/templates/:id` | 写（模板） | 窗口期冻结 |
| 4 | 定时/后台发证任务 | 写 | 确认 v2 无 cron 发证（legacy `cron_generate_certs` 属 1.0，不在 v2 范围） |
| 5 | `GET /api/v2/certificates/verify` | 只读 | **不关闭**（HTTP E2E 依赖） |

- 关闭机制：当前无运营开关 → 以「人工运营关闭 + 路由层比对确认」记录；若 R5 新 worker 引入开关则用之。
- 本任务**不新建开关**。

---

## 4. HTTP E2E 需验证的 URL 与接口

### 4.1 环境状态

> **HTTP_E2E_ENVIRONMENT_AVAILABLE = UNKNOWN**
> 本执行环境可能不可达 `*.workers.dev`；须在 R5 执行前由人工确认一个可触达生产端点的环境。

### 4.2 接口清单

| # | 方法 + 路径 | 用途 | 阶段 |
| --- | --- | --- | --- |
| 1 | `GET <PROD_BASE_URL>/health` | 健康检查 | P12 后 |
| 2 | `GET <PROD_BASE_URL>/api/v2/certificates/verify?cert_no=<existing>&code=<existing>` | 既有证书(413 中一条)验真返回预期 | P13 |
| 3 | `GET <PROD_BASE_URL>/api/v2/certificates/verify?cert_no=<imported>&code=<imported>` | 导入后 legacy 码可验真 | P13 |
| 4 | `GET <PROD_BASE_URL>/h5/cert` | H5 验真页可加载 | P13 |

- `<PROD_BASE_URL>` = workers.dev 子域或自定义域，**执行前由人工提供**（源码 `app.ts` 暴露 `/api/v2`，但生产域名未在本仓库记录）。
- **已知技术债**（R5-AUTH §14）：public verify route 与实现不匹配 → 验真 E2E 可能部分失败；须记录并归未来独立 WP，**不阻塞 R5**（除非返回 5xx）。
- **失败判定**：环境可达但返回 5xx / 路由缺失 → `ABORT(P13)`；环境与实现不匹配(已知债) → 记录不阻断。

---

## 5. R5 执行前 Go / No-Go Checklist

| # | 检查项 | 通过条件 | 当前状态 | Go/No-Go |
| --- | --- | --- | --- | --- |
| 1 | 生产 prestate 未变 | 44 / 0 / 0 / 413 / 500（P1 再确认） | 最近已验证(R5-AUTH) | 条件满足，P1 复核 |
| 2 | 快照有效 | SHA `aa3d2f06…` MATCH | ✅ YES | GO |
| 3 | legacy 源有效 | SHA `d51563b0…` MATCH | ✅ YES | GO |
| 4 | runner 安全 | 35/0 + 18 闸门 YES | ✅ YES | GO |
| 5 | 回归绿 | R3D/R3B/R2 + tsc + dry-run | ✅ YES | GO |
| 6 | 维护窗口时间已分配 | 填入 `YYYY-MM-DD 02:00–04:00 CST` | ❌ 人工 | **NO-GO** |
| 7 | 角色分工已指定 | Operator/Reviewer/Communicator 打卡机制就位 | ⚠️ 单人，须打卡 | 条件满足，须记录 |
| 8 | 写入前签发已关闭 | `CLOSED_FOR_WRITES` 经 P3 确认 | ⚠️ 结构满足，P3 确认 | 条件满足，P3 复核 |
| 9 | 窗口内无管理员/批量签发 + 无公开可用性声明 | 人工确认 | ❌ 人工 | **NO-GO** |
| 10 | 回滚沟通预案已备 | 负责人 + 模板就位 | ❌ 人工 | **NO-GO** |
| 11 | HTTP E2E 环境可达 | 可达环境已确认 | ❓ UNKNOWN | **NO-GO** |
| 12 | 收到显式授权短语 | 原样提供 §6 短语 | ❌ NO | **NO-GO** |
| 13 | 双锁凭证就绪 | `--profile jhzy` + `CLOUDFLARE_ACCOUNT_ID` | ✅ YES | GO |

---

## 6. 用户需提供的最终授权短语

仅当管理员**原样**提供以下短语（或实质等同的明确授权）方可执行 R5：

> **我明确授权执行 CERT-R5 生产证书号池迁移：允许在维护窗口内对 jhzy-v2-prod 应用 0045/0046、导入 450000 legacy id_pools、使用受保护 runner 执行生产写入，并按 runbook 部署 production Worker 与完成验收。**

以下**不视为**授权：“继续” / “开始” / “执行下一步” / 任何模糊指令。

---

## 7. 当前是否可以执行 R5

**NO。**

- `READY_FOR_CERT_R5_PRODUCTION_EXECUTION = NO`
- `PRODUCTION_EXECUTION_AUTHORIZED = NO`
- 阻塞人工项（须全部满足方翻转）：
  1. 维护窗口具体时间（§1）
  2. HTTP E2E 可达环境确认（§4.1）
  3. 显式授权短语（§6）

---

## 8. Go / No-Go 汇总

| 维度 | 结论 |
| --- | --- |
| 技术闸门（快照/源/runner/回归） | ✅ 全过 |
| 人工条件（窗口/角色/关闭/回滚/E2E/短语） | ❌ 未齐（6 / 13 项 NO-GO） |
| 综合裁定 | **NO-GO**（技术就绪，人工前置未满足） |

---

## 9. 非突变确认

本任务仅执行：文档撰写 + 本地源码只读扫描（`routes/*`、`services/certificate-issuance-service.ts`）。
- 未 apply 0045/0046
- 未 import 450k
- 未 deploy 生产 Worker
- 未变更 secret / RBAC
- 未签发证书
- 未 push Git
- 未触达 JHZY 1.0 live

> 本 prep 文档留作 **untracked**，待人工确认后随 R5 证据一并提交（不 push）。

**NEXT_ACTION = STOP. Await explicit human authorization + maintenance window + E2E environment.**
