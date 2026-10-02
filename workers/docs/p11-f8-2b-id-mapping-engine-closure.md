# P11-F8-2B — ID Mapping Engine Closure Report

> Mode: `CLOSURE_EVIDENCE_ONLY`
> Target: `JHZY-V2`
> Project root: `/Users/Shared/projects/jhzy-v2`
> HEAD: `74c93fd9f3b8d65ded5bcfdfaf3500d5b222c354`
> Generated: 2026-10-02

---

## 1. Scope

P11-F8-2B（ID Mapping Engine）是 JHZY 2.0 迁移工具链的**离线反查设施**，负责：

- 管理 `legacy_id_maps` 的读写（内存缓存 + 可插拔持久化后端）。
- 提供 `resolve` / `tryResolve` 反查，禁止在 ETL 中硬编码旧→新 ID。
- 复用 `utils/crypto.generateUlid` 生成与 V2 运行时一致的 `public_id`。

**本 artifact 的范围边界**（依据任务 §10）：

- **包含**：F8-2B 的 8 个 production 实现文件 + 3 个专用测试文件 + 本 closure artifact。
- **明确排除**：F8-3（PII 加密引擎）、F8-4（ETL 编排 `etl/*`）、迁移 0044（维护窗口迁移）、其余 P11 / WP 工作、生产 1.0 代码、任何部署与线上 D1 写入。

**纪律边界**：本 artifact 只形成 closure 证据。**未 commit、未 deploy、未 apply 任何 migration、未进入 WP5 implementation。**

---

## 2. Implementation Inventory

8 个 production 实现文件，全部位于 `workers/src/migration/`。**git status 全部为 `??`（untracked，未提交于 HEAD）**。

| # | Path | Lines | SHA256 | git status | TODO/STUB/PLACEHOLDER |
|---|------|------:|--------|-----------|----------------------|
| 1 | `workers/src/migration/mapping-types.ts` | 143 | `18db7d985a67822e808a9a6965b0e5f6c8dcf6474ea165768cefcf5f62de7164` | `??` | NONE |
| 2 | `workers/src/migration/mapping-builder.ts` | 110 | `7b14359c52fd8c956db1a9cd58706ae608bdbafb4b24bfe449549235ec30585d` | `??` | NONE |
| 3 | `workers/src/migration/foreign-key-resolver.ts` | 115 | `61a7597ac538e84c45599501061c94654a148a0afaedd33ee62166291cd582f7` | `??` | NONE |
| 4 | `workers/src/migration/collision-checker.ts` | 74 | `0925f0dcab25fbe9b051a6ad9547b1f974cd9c536a6c6cfb065eab3494b00ef7` | `??` | NONE |
| 5 | `workers/src/migration/verify-engine.ts` | 49 | `661ae4f29ef9278af867f6c90249be003edf8ce580eb0b0a1d795bdab48f04b3` | `??` | NONE |
| 6 | `workers/src/migration/migration-resume.ts` | 294 | `20ac43a608db5fd1f9e51360872bdeb25116bf2cea7946f3f824cc8a399aaeac` | `??` | NONE |
| 7 | `workers/src/migration/id-mapping-engine.ts` | 239 | `c3bf2fe3341ca7e2a3bd39fbc8ed23516516c323e0d706ca74872159caf3d066` | `??` | NONE |
| 8 | `workers/src/migration/id-mapping-library.ts` | 38 | `66e5594e22773b9ec2f3aa1444911ca0df645c514cd5f79e5020845972cb6422` | `??` | NONE |

Grep 扫描（大小写不敏感）确认 8 个文件中 **零** `TODO` / `FIXME` / `STUB` / `PLACEHOLDER` / `not implemented` / 抛出 "not" 类占位异常。

> 注：第 8 项 `id-mapping-library.ts` 是 barrel 聚合文件，`export *` 了 F8-2B 全部模块，**同时**也 `export *` 了 `./pii-encryption-engine`（F8-3）与 `./etl/index`（F8-4）。这只是打包聚合，F8-2B 的 7 个核心文件**不**反向依赖 F8-3/F8-4。见 §8、§11。

---

## 3. Architecture Contract

依据真实源码（`id-mapping-engine.ts` 等）与专用测试，F8-2B 当前正式 contract：

**A. Mapping key model**
- 内存键（`InMemoryIdMappingStore.keyOf` / `IdMappingEngine.keyOf`）：`legacyTable + MAP_KEY_SEP(0x1F) + legacyId + MAP_KEY_SEP + newTable`。
- D1 自然键：`UNIQUE(legacy_table, legacy_id, new_table)`（`migrations/0001`）。

**B. legacy → new / public ID mapping**
- `IdMappingRecord { legacyTable, legacyId, newTable, newId }`。
- `register(res)` / `registerResolved(...)`：写入 store + 缓存，返回 `newId`。
- `newPublicId()`：通过 `generateUlid()` 生成 26 位 Crockford ULID（与 V2 运行时一致）。

**C. Idempotency**
- `register`：键已存在 → 直接返回首次 `newId`，**不二次写入**。
- D1 层：`INSERT OR IGNORE` + `UNIQUE` 约束，从数据库层面再保险去重。

**D. ULID generation**
- 复用 `utils/crypto.generateUlid`（Web Crypto `crypto.getRandomValues` / `crypto.subtle` / `btoa` / `atob`），Node ≥ 20 可用。
- 格式 `^[0-9A-HJKMNP-TV-Z]{26}$`；专用测试生成 5000 个全部唯一（见 §5）。

**E. InMemory store**
- `InMemoryIdMappingStore`：基于 `Map<key, IdMappingRecord>`；`loadAll()` / `save()` / 调试用 `peek()`。
- `IdMappingEngine.warm()` 启动时全量加载到内存，之后 `resolve` 走 O(1) 内存命中。

**F. D1 store**
- `D1IdMappingStore implements IdMappingStore`，包裹最小 `D1DatabaseLike`（`prepare` / `bind` / `first` / `all` / `run`）。
- `loadAll`：`SELECT legacy_table AS legacyTable, legacy_id AS legacyId, new_table AS newTable, new_id AS newId FROM legacy_id_maps`。
- `save`：`INSERT OR IGNORE INTO legacy_id_maps (legacy_table, legacy_id, new_table, new_id, created_at) VALUES (?, ?, ?, ?, unixepoch())`，4 个位置绑定（`legacyTable, legacyId, newTable, newId`），`created_at` 由 `unixepoch()` 自动填充。

**G. FK resolution**
- `resolveForeignKeys(plan, records, engine, options)`：遍历声明式 `MappingPlan` 的 FK 字段；已知 FK → 解析为 new/public ID；可空 FK 缺失 → `SKIPPED`；必需 FK 缺失 → `FAILED`。
- 返回摘要 `{ resolved, skipped, failed }`。

**H. Missing FK behavior**
- `tryResolve`：输入 `null` / `''` / `undefined` → 返回 `null`（由调用方决定默认值）。
- 非空但映射缺失的**必需** FK → `FAILED`；**可空** FK 缺失 → `SKIPPED`。
- `resolve`（非空缺失）→ 抛错 fail-fast（禁止硬编码旧 ID）。

**I. Collision semantics**
- `checkCollisions(plan)`：
  - 同 legacy → 同 new：**阻断性**（DUPLICATE）。
  - 同 legacy → 不同 new：**阻断性**（COLLISION）。
  - 不同 legacy → 同 new：按正式 contract **ALLOWED**（不触发阻断冲突）。

**J. Verification semantics**
- `verifyMappings(plan, engine)`：逐实体校验 `source` 计数 == `target` 计数 + FK 检查（`fkCheck.pass`）→ `verify.pass`。任一不匹配或存在 `FAILED` FK → `pass=false`。

**K. Resume semantics**
- `runMigration(state, ...)` 支持 partial state 续跑；已有 mapping **不丢失**；既有 mapping 在 resume 中**不被重建为不同 ID**（ULID 稳定一致）。
- `deserializeState` 对版本不匹配按规定抛错。

**L. Rollback convergence relationship**
- ETL self-test（`etl/self-test.ts`）证明：`rollback + resume` 后得到的 mapping 与全新 mapping **完全一致**（5 项断言全部 PASS）。F8-2B 的 `IdMappingEngine` 幂等与 `register` 不重建语义是 rollback convergence 的基石。

---

## 4. Test Contract Matrix

> 每一项均能从具体 source / test assertion 追溯到证据。反向反查（new→legacy）**不属于**当前正式 `IdMappingEngine` contract，因此 T02 仅断言正向反查与缺失行为，未把"未实现的 reverse API"伪装成测试缺失。

| Item | IMPLEMENTATION | TEST | RESULT | EVIDENCE |
|------|---------------|------|--------|----------|
| CREATE_MAPPING | `buildMappings`（`mapping-builder.ts`）+ `IdMappingEngine.register/registerResolved` + `InMemoryIdMappingStore.save/peek` | `id-mapping-engine.test.ts` → CREATE_MAPPING (12 checks) | PASS | "OK buildMappings 生成 2 条映射" / "OK store.peek 持久化记录正确" / "OK registerResolved 返回 newId=7" |
| LOOKUP | `IdMappingEngine.resolve` / `tryResolve` | LOOKUP (6 checks) | PASS | "OK 正向 legacy→new 反查正确" / "OK resolve 未命中按规定抛错 (fail-fast)" / "reverse 非合同能力：跳过（不构成 FAIL）" |
| IDEMPOTENCY | `IdMappingEngine.register` 幂等 + D1 `INSERT OR IGNORE` | IDEMPOTENCY (6 checks) | PASS | "OK 重复注册返回【首次】newId=1（幂等）" / "OK 内存仅 1 条映射（未重复写入）" |
| ULID | `generateUlid`（`utils/crypto` via `newPublicId`） | ULID (2 checks) | PASS | "OK 5000 个 ULID 格式全部合法（Crockford 26 位）" / "OK 5000 个 ULID 全部唯一（无重复）" |
| INMEMORY_STORAGE | `InMemoryIdMappingStore` | INMEMORY_STORAGE (6 checks) | PASS | "OK save×2 → loadAll=2" / "OK 重复 save 同 key 不新增行（仍为 2）" / "OK peek 缺失 key 返回 undefined" |
| D1_STORAGE | `D1IdMappingStore` + Mock D1 | D1_STORAGE (9 checks) | PASS | "OK register 经 D1 落库返回 newId=5" / "OK D1 INSERT OR IGNORE 去重" / "OK mock 拒绝未知 SQL（DELETE）" / "OK mock 拒绝错误绑定参数个数（应为 4）" / 新增：mock 校验 INSERT/SELECT 列名契约（见 §10 备注） |
| FK_BEHAVIOR | `resolveForeignKeys`（`foreign-key-resolver.ts`） | FK_BEHAVIOR (8 checks) | PASS | "OK 已知 FK 解析数=4（team_id×3 + creator_id×1）" / "OK 可空 creator_id 缺失 → SKIPPED" / "OK 必需 team_id 缺失 → FAILED" |
| MOCK_FK | `resolveForeignKeys` + 合成 legacy 关系（user 100 → signup 500/501） | MOCK_FK (3 checks) | PASS | "OK signup 500 的 user_id=100 解析为 user 的 newId=100" / "OK signup 501 的 user_id=999999（无映射）按规定 FAILED" / `MOCK_FK_TEST=PASS` |
| DUPLICATE_COLLISION | `checkCollisions`（`collision-checker.ts`） | DUPLICATE_COLLISION (6 checks) | PASS | "OK A: 同 legacy→同 new 触发 oldIdDuplicates（DUPLICATE）" / "OK B: 同 legacy→不同 new 触发 oldIdDuplicates（COLLISION）" / "OK C: 不同 legacy→同 new 不触发（ALLOWED）" |
| VERIFY_ENGINE | `verifyMappings`（`verify-engine.ts`） | VERIFY_ENGINE (6 checks) | PASS | "OK 一致映射 → verify.pass=true" / "OK 缺失映射 → verify.pass=false" / "OK 存在 FAILED FK → fkCheck.pass=false" |
| RESUME_STABILITY | `runMigration` / `serializeState` / `deserializeState`（`migration-resume.ts`） | RESUME_STABILITY (6 checks) | PASS | "OK resume 后 mapped 不丢失" / "OK 已有 mapping 在 resume 中未被重建为不同 ID（含 ULID 完全一致）" / "OK deserializeState 版本不匹配按规定抛错" |
| ROLLBACK_CONVERGENCE | ETL pipeline rollback+resume（`etl/self-test.ts`） | ETL self-test（30 checks） | PASS | 30/30 PASS，其中 rollback convergence 5 项断言：rollback 截断 / 统计回退 / IdMapping 不丢失 / resume 补齐 / rollback+resume == 全新映射 |

---

## 5. Dedicated Test Evidence

- 专用测试文件：`workers/src/migration/id-mapping-engine.test.ts`
- 运行命令：`cd workers && npx tsc -p tsconfig.test.json && node /tmp/jhzy_test_build/migration/id-mapping-engine.test.js`
- **DEDICATED_PASS_COUNT = 70 / DEDICATED_FAIL_COUNT = 0 → GATE: PASS**
- 编译产物落 `/tmp/jhzy_test_build`（不污染仓库）。
- 覆盖 T01–T11（含 MOCK_FK / DUPLICATE_COLLISION / ROLLBACK_CONVERGENCE 引用）。
- 全部直接 `import` 真实 production 模块，**未复制实现逻辑到测试**。

测试内部分组计数（重新核验）：
CREATE_MAPPING 12 · LOOKUP 6 · IDEMPOTENCY 6 · ULID 2 · INMEMORY_STORAGE 6 · D1_STORAGE 9 · FK_BEHAVIOR 8 · MOCK_FK 3 · DUPLICATE_COLLISION 6 · VERIFY_ENGINE 6 · RESUME_STABILITY 6 = 70。

---

## 6. ETL Rollback Convergence Evidence

- 现有 ETL self-test（`workers/src/migration/etl/self-test.ts`）：**30/30 PASS / 0 FAIL**。
- 其中 rollback convergence 断言全部 PASS，直接证明 F8-2B 的 `IdMappingEngine` 幂等 + 不重建语义使 `rollback + resume` 得到与全新运行一致的 mapping。
- 本 artifact 同时引用：ETL rollback convergence = PASS。

---

## 7. D1 Storage Contract

**Real table**：`legacy_id_maps`
- 定义于 `workers/migrations/0001_initial_schema.sql`（第 1055 行），注释 `PLATFORM_GLOBAL，DEFER`。
- 列：`id INTEGER PRIMARY KEY` / `legacy_table TEXT NOT NULL` / `legacy_id TEXT NOT NULL` / `new_table TEXT NOT NULL` / `new_id INTEGER NOT NULL` / `created_at INTEGER NOT NULL DEFAULT (unixepoch())`。
- 约束：`UNIQUE (legacy_table, legacy_id, new_table)`；索引 `idx_lim_new(new_table, new_id)`。

**Real SQL operations（来自 `D1IdMappingStore`）**：
1. `loadAll`：`SELECT legacy_table AS legacyTable, legacy_id AS legacyId, new_table AS newTable, new_id AS newId FROM legacy_id_maps`
2. `save`：`INSERT OR IGNORE INTO legacy_id_maps (legacy_table, legacy_id, new_table, new_id, created_at) VALUES (?, ?, ?, ?, unixepoch())`

**Binding contract**：
- 4 个位置绑定 `(legacyTable, legacyId, newTable, newId)`；`created_at` 由 `unixepoch()` 自动填充。
- `UNIQUE` + `INSERT OR IGNORE` → 幂等写入（重复键被静默忽略，不新增行）。

**Column-to-schema 一致性（本次 closure 核验重点）**：正式 store 使用的列名 `legacy_table / legacy_id / new_table / new_id / created_at` 与 `0001` DDL **逐列一致**——**无列名错配**。

**Schema dependency = EXISTS**（表已在 `0001` 建立）→ **CLOSURE_BLOCKER = NO**。

> Mock D1（`mock-d1-store.ts`）质量门（任务 §5）：mock 仅识别 `SELECT ... FROM legacy_id_maps` 与 `INSERT OR IGNORE INTO legacy_id_maps` 两类契约；维护测试内 mapping state 并模拟 `OR IGNORE` 去重；对未知 SQL（DELETE）与错误绑定参数个数（非 4）主动抛错。**本轮进一步增强**：mock 现额外断言 INSERT 列清单必须等于 `legacy_table, legacy_id, new_table, new_id, created_at`，以及 SELECT 必须引用 `legacy_table/legacy_id/new_table/new_id` 四列——从根源堵住"store SQL 列名与 schema 错配却仍 PASS"的隐患（见 §10 备注）。

---

## 8. Consumer / Integration Status

Grep 全仓库（`workers/src`，排除 F8-2B 库自身）后，consumer 分类如下：

| Consumer | Classification | Evidence |
|----------|---------------|----------|
| `etl/transform.ts` | **production consumer（迁移编排 F8-4）** | `import { IdMappingEngine } from '../id-mapping-engine'`（L13）；L74/L135 等经引擎反查 |
| `etl/pipeline.ts` | **production consumer（迁移编排 F8-4）** | `import { IdMappingEngine, InMemoryIdMappingStore }`（L12）；`new IdMappingEngine(this.store)`（L77） |
| `etl/types.ts` / `etl/checkpoint.ts` | migration orchestration（引用 `IdMappingEngine` 状态/类型） | 注释与类型引用 |
| `etl/self-test.ts` | test-only | 引用 `IdMappingEngine` 做 sanity check |
| `mock-d1-store.ts` / `id-mapping-engine.test.ts` | test-only | 专用测试支持 |

**结论**：F8-2B 已实现并**接入**迁移编排（`etl/*` 即 F8-4），属于"已连接的生产迁移工具链"，**非**"未接线"。但 F8-2B **不进入 Worker 线上请求路径**（文件头注释明确定界：仅作为迁移工具被调用）。

`id-mapping-library.ts` 是 barrel，被 F8-4（`etl/index` 等）间接消费，但聚合不构成新的 functional 依赖。

---

## 9. Explicit Exclusions

- **F8-3（PII 加密引擎）**：`workers/src/migration/pii-encryption-engine.ts` 是独立模块，**零**对 F8-2B 的 import（`grep` 确认）。F8-3 不在 F8-2B closure 范围。仅在 `id-mapping-library.ts` 被 barrel 聚合导出。
- **F8-4（ETL 编排 `etl/*`）**：是 F8-2B 的 consumer，但属于下一阶段集成，不混入 F8-2B closure 实现范围。F8-2B 的核心 7 文件不依赖 `etl/*`。
- **迁移 0044**：`latest repo migration = 0044`，`0042/0043/0044` 当前 untracked；现有仓库证据支持生产 43/43；**0044 生产 apply 未经核实**。**0044 不是 F8-2B closure 的一部分**——禁止 apply 0044、禁止 remote D1 write、禁止 deploy。
- **JHZY 1.0**：`/www/wwwroot/api.jhzyfw.com/` 全程未触碰；V1 保护未触发。
- **WP5 implementation**：本轮不进入。

---

## 10. Known Limitations

1. **反向反查（new→legacy）不在 contract**：正式 `IdMappingEngine` 仅提供 `resolve` / `tryResolve`（legacy→new），未提供 reverse 接口。测试未把"未实现的 reverse"伪装成缺失。
2. **Mock D1 不是万能 stub**：仅覆盖 `D1IdMappingStore` 实际调用的 `SELECT` / `INSERT OR IGNORE` 契约 + 4 绑定 + 列名校验；不模拟 transaction/batch（生产 store 也不使用）。
3. **本轮测试文件改动（gate §13 合规声明）**：闭包证据阶段，为堵住"store SQL 列名与 schema 错配仍 PASS"的隐患，**修改了 `mock-d1-store.ts`（测试支持文件）**，新增：
   - 常量 `EXPECTED_INSERT_COLUMNS = ['LEGACY_TABLE','LEGACY_ID','NEW_TABLE','NEW_ID','CREATED_AT']`、`EXPECTED_SELECT_COLUMNS = [...]`。
   - 方法 `assertInsertColumns()`（校验 INSERT 列清单顺序与 schema 一致）、`assertSelectColumns()`（校验 SELECT 引用四列）。
   - diff 性质：**纯测试质量增强，未触碰任何 production 实现**，不影响 8/8 生产 SHA；重新核验 70/70 PASS、30/30 PASS、typecheck 0 错误。
4. **生产文件未提交**：8 个 production 文件 + 3 个测试文件均为 `??` untracked（仓库整体极脏）。closure 仅建立证据，未 commit。

---

## 11. Production Safety

- **JHZY 1.0 绝对保护**：未 SSH 修改 1.0、未改 1.0 代码/DB、未部署到 1.0、未同步文件、未为 closure 查询改动 1.0。`V1_PROTECTION_TRIGGERED = NO`。
- **无 production / staging D1 连接**：测试全部 LOCAL / IN-MEMORY / MOCK。禁用 `wrangler d1 --remote` / `wrangler deploy` / Cloudflare API write / 真实远程 Worker。
- **无迁移 apply**：未 apply 0044 或任何 migration；未改 schema。
- **无部署 / 无 commit**：`DEPLOYMENT = NONE`、`REMOTE_DB_WRITES = NONE`、`GIT_COMMIT = NONE`。
- **生产实现字节级未变**：8 个 production 文件 SHA256 在 closure 前后 8/8 一致（见 §13 / FINAL OUTPUT）。

---

## 12. Closure Decision

**PASS**

PASS 条件逐项核对：

- [x] typecheck PASS（0 errors）
- [x] dedicated 70/70 PASS
- [x] ETL 30/30 PASS（含 rollback convergence）
- [x] MOCK_FK PASS
- [x] D1_STORAGE PASS（列名契约已校验）
- [x] production implementation defect = NONE（无 TODO/STUB/PLACEHOLDER，运行期无异常）
- [x] schema dependency EXISTS（`legacy_id_maps` 在 `0001`）
- [x] 无未解决的 F8-2B blocker

→ **F8-2B 可进入 closure，下一授权状态为 `P11-F8-2B-SAFE-COMMIT`。**

---

## 13. Exact File Inventory

**F8_2B_PRODUCTION_FILES**
```
workers/src/migration/mapping-types.ts
workers/src/migration/mapping-builder.ts
workers/src/migration/foreign-key-resolver.ts
workers/src/migration/collision-checker.ts
workers/src/migration/verify-engine.ts
workers/src/migration/migration-resume.ts
workers/src/migration/id-mapping-engine.ts
workers/src/migration/id-mapping-library.ts
```

**F8_2B_TEST_FILES**
```
workers/src/migration/id-mapping-engine.test.ts
workers/src/migration/mock-d1-store.ts
workers/tsconfig.test.json
```

**F8_2B_CLOSURE_FILE**
```
workers/docs/p11-f8-2b-id-mapping-engine-closure.md
```

**本轮 SAFE_COMMIT 候选（仅预览，未执行）**
- 上述 8 production + 3 test + 1 closure artifact。

**UNTRACKED_DEPENDENCY（必须与候选同批提交，否则 `id-mapping-library.ts` 的 barrel re-export 会断树）**
```
workers/src/migration/pii-encryption-engine.ts          # F8-3 范围（被 library barrel 聚合）
workers/src/migration/etl/index.ts                       # F8-4 范围（被 library barrel 聚合）
workers/src/migration/etl/types.ts
workers/src/migration/etl/extract.ts
workers/src/migration/etl/transform-utils.ts
workers/src/migration/etl/transform.ts
workers/src/migration/etl/load.ts
workers/src/migration/etl/checkpoint.ts
workers/src/migration/etl/pipeline.ts
workers/src/migration/etl/self-test.ts
workers/tsconfig.etl-run.json                           # tsconfig.test.json 的 extends 目标（config）
```
> 说明：上述依赖均为 untracked（与 F8-2B 同源，属仓库整体脏状态的一部分）。`workers/src/utils/crypto.ts` 是**唯一** pre-existing 外部依赖，已 TRACKED + clean，无需提交。建议 F8-2B 与 F8-3/F8-4 作为同一迁移特性集**协调提交**；或先在 F8-2B 提交中排除 `id-mapping-library.ts`（其 barrel 角色）直至 F8-3/F8-4 一并落地。

---

## 14. Next Authorized State

**`P11-F8-2B-SAFE-COMMIT`**

- 由管理员在确认本 closure 报告后，决定提交边界（见 §13 的 SAFE_COMMIT_CANDIDATES + UNTRACKED_DEPENDENCY）。
- 在此之前：**不得** commit / deploy / apply 0044 / 进入 WP5 implementation。
- 后续 F8-3 / F8-4 的 closure 应各自独立成 artifact，不借用本 F8-2B closure 范围。

---

*Generated under CLOSURE_EVIDENCE_ONLY. No commit, no deploy, no migration apply, no WP5 entry. V1 protection not triggered.*
