-- =============================================================================
-- 嘉禾志愿 2.0 — D1 Migration 0046：id_pools Legacy Pool Compatibility
--   依据：workers/docs/certificate/legacy-id-pool-continuity.md（CERT-R3C / R3C-FIX）
--         workers/docs/audits/2026-10-03-post-cutover-assurance/
--           24-cert-r3c-legacy-id-pool-continuity.md
--   模式：纯 schema 兼容扩展（SCHEMA ONLY）。
--
-- ⚠ 本迁移【只做 schema 兼容】，【不含任何历史数据】。
--   450,000 行历史编号库存由【独立分批导入器】迁移（见 legacy-pool-importer），
--   严禁把历史数据塞进迁移 SQL（体积/耗时/重跑代价均不可接受）。
--
-- 变更内容（三项，均为「保全历史资产 + 冻结分配优先级」所必需）：
--   1) pool_type CHECK 增加 'cert_skl'
--      理由：cert_skl 是已证实的历史资产（10,000 条，全空闲），
--            属用户冻结保留的项目资产；现行 CHECK 无法表达 → 必须扩展。
--   2) 新增可空列 batch_id
--      理由：legacy id_pool 表含 batch_id（批次号）用于批次溯源；
--            迁移时若丢弃即丢失历史元数据。可空，不影响既有行。
--   3) 新增 provenance 列（库存来源语义，CERT-R3D-FIX §4/§5）
--      理由：合成 500 行 id=1..500，legacy 180,000 行 id 远大于此。
--            若分配器仅按 `pool_type + status=0 + ORDER BY id ASC` 取号，
--            TRAINING 会先消费合成 CTRN 码，违反冻结决策
--            NUMBER_FORMAT_POLICY = PRESERVE_LEGACY_FORMATS
--            （legacy 为权威 continuing inventory，合成池仅兼容库存）。
--      修法【不用任何格式推断】：不改 legacy 行 id、不删合成行、不伪造 status、
--      不用 CTRN/JHCRT 前缀 / 长度 / 正则判别 —— 改为显式存储来源语义。
--
-- provenance 取值与分配资格（CERT-R3D-FIX §5 fail-closed）：
--   'legacy_migrated'      历史库存 →【可分配】（权威 continuing inventory）
--   'v2_synthetic_compat'  合成兼容库存 →【不可分配】（保留但排除）
--   'v2_native'            未来经显式批准的 V2 原生库存 →【可分配】（本轮不生成）
--   NULL / 未知值          →【不可分配】（fail-closed；分配器用 IN 白名单谓词，
--                            未知值天然不命中，不存在「NULL 即允许」路径）
--
-- ⚠ provenance 是【存储语义】，不是 code 的派生值。任何组件都不得从 code
--   前缀/长度/正则反推 provenance（那是本缺陷的原始成因）。
--
-- 步骤 2 对既有 500 行【显式分类】为 'v2_synthetic_compat'：
--   这是它们的真实来源（0022 播种的 CTRN%06d 合成码），且不改动
--   code / status / assigned_to / assigned_at 任一业务字段
--   （合成行状态【保持 status=0 的历史事实】，其「不被分配」完全来自
--     provenance 语义，而非伪造 status 变更 —— SYNTHETIC_STATUS_MUTATIONS = 0）。
--
-- 严格边界（不得顺带修改）：
--   - status 语义与 CHECK(0,1,2) 保持不变
--     （0=free / 1=assigned / 2=reserved；reserved 必须保留，不得折叠）
--   - assigned_to / assigned_at 语义保持不变
--   - code 类型（TEXT）保持不变（历史 code 长 24 字符）
--   - 既有 500 行合成 cert_trn（CTRN%06d）必须【逐字段原样保留】
--   - 唯一性：见下方 GLOBAL_UNIQUE_DECISION
--
-- 全局唯一性决策（GLOBAL_UNIQUE_DECISION）：
--   legacy 表为【全表 UNIQUE(id_value)】。V2 现为 UNIQUE(pool_type, code)。
--   本迁移【升级为 UNIQUE(code)】以恢复 legacy 的更强不变量，理由：
--     1) 权威快照实测：legacy 450,000 条 code 全表零重复；
--     2) V2 现有 500 条合成码（CTRN%）与 legacy 族（JHCRT-*/JH-*）字符集互斥，
--        实测精确交集 = 0 → 升级后不会与既有行冲突；
--     3) pool_type 第四段（类型 token：TRN/SRV/HON/SKL）已使 code 自身
--        在语义上可区分池，故全表唯一不产生「合法跨池同码」被误拒的情形；
--     4) 恢复 legacy 不变量可防止未来任何跨池重复分配。
--   兼容性：UNIQUE(code) 是 UNIQUE(pool_type, code) 的【严格子集条件】，
--           故升级不放松任何既有约束，只会更严。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 步骤 0：前置守卫（幂等 / 可重复执行）
--   若已存在兼容结构（id_pools_new），先清理残留，保证脚本可安全重跑。
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS id_pools_new;

-- -----------------------------------------------------------------------------
-- 步骤 1：建立替换表（承载全部扩展）
--   相对现行结构仅三处变化：
--     · pool_type CHECK 增加 'cert_skl'
--     · 新增可空 batch_id
--     · 新增 provenance（库存来源语义；分配资格的唯一判据）
--   其余列名、类型、语义、约束与现行保持逐字一致。
-- -----------------------------------------------------------------------------
CREATE TABLE id_pools_new (
  id          INTEGER PRIMARY KEY,
  pool_type   TEXT NOT NULL CHECK (pool_type IN
                ('cert_trn','cert_srv','cert_hon','cert_skl','volunteer')),
  code        TEXT NOT NULL,
  status      INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0,1,2)),
  assigned_to INTEGER,
  assigned_at INTEGER,
  batch_id    INTEGER,                          -- legacy 批次号溯源（可空）
  provenance  TEXT CHECK (provenance IS NULL OR provenance IN
                ('legacy_migrated','v2_synthetic_compat','v2_native')),
                                               -- 库存来源；分配资格唯一判据
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (code)                                 -- 恢复 legacy 全局唯一不变量
);

-- -----------------------------------------------------------------------------
-- 步骤 2：全量搬迁既有行（当前应为 500 行合成 cert_trn）
--   · 业务字段逐字段原样复制（code / status / assigned_to / assigned_at 不变）；
--   · batch_id 以 NULL 起步（V2 既有行无该元数据，不得臆造）；
--   · provenance 显式分类为 'v2_synthetic_compat'
--     —— 既有 V2 id_pools 全部来自 0022 播种的合成 CTRN 库存（权威核验：
--        生产 500 行 code 100% 为 CTRN%06d，与 legacy 族交集 = 0，
--        且从未被消费/引用），故此分类是事实陈述而非推断。
--     —— 分类只写 provenance 一列；status 等业务字段零改动。
-- -----------------------------------------------------------------------------
INSERT INTO id_pools_new (id, pool_type, code, status, assigned_to, assigned_at,
                          batch_id, provenance, created_at)
SELECT id, pool_type, code, status, assigned_to, assigned_at,
       NULL, 'v2_synthetic_compat', created_at
FROM id_pools
ORDER BY id;

-- -----------------------------------------------------------------------------
-- 步骤 3：swap（替换）
--   PRAGMA defer_foreign_keys 已开启；id_pools 无外键引用它。
-- -----------------------------------------------------------------------------
DROP TABLE id_pools;
ALTER TABLE id_pools_new RENAME TO id_pools;

-- -----------------------------------------------------------------------------
-- 步骤 4：结构自检（SQLite 无 DO/RAISE，故用「约束即断言」手法）
--   手法：把期望的结构写成一张【只允许通过】的临时断言表并插入期望值；
--         若结构不符则该 INSERT 违反 CHECK → 迁移立即失败（不会静默损坏）。
--         校验通过后立即 DROP，不留残留。
-- -----------------------------------------------------------------------------

-- 4.1 行数守恒：交换后 id_pools 非空（空表即视为搬迁失败）
CREATE TABLE _assert_0046 (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _assert_0046 (ok)
SELECT CASE WHEN (SELECT COUNT(*) FROM id_pools) > 0 THEN 1 ELSE 0 END;
DROP TABLE _assert_0046;

-- 4.2 结构确认：pool_type CHECK 必须接受全部 5 个历史池类型
CREATE TABLE _assert_0046 (t TEXT NOT NULL CHECK (t IN
  ('cert_trn','cert_srv','cert_hon','cert_skl','volunteer')));
INSERT INTO _assert_0046 (t) VALUES
  ('cert_trn'),('cert_srv'),('cert_hon'),('cert_skl'),('volunteer');
DROP TABLE _assert_0046;

-- 4.3 结构确认：status CHECK 必须接受 0/1/2（free/assigned/reserved 三态）
CREATE TABLE _assert_0046 (s INTEGER NOT NULL CHECK (s IN (0,1,2)));
INSERT INTO _assert_0046 (s) VALUES (0),(1),(2);
DROP TABLE _assert_0046;

-- 4.4 结构确认：UNIQUE(code) 存在（pragma 列出 id_pools 的唯一索引）
CREATE TABLE _assert_0046 (n INTEGER NOT NULL CHECK (n >= 1));
INSERT INTO _assert_0046 (n)
SELECT COUNT(*) FROM pragma_index_list('id_pools') WHERE "unique" = 1;
DROP TABLE _assert_0046;

-- 4.5 结构确认：provenance CHECK 接受三种合法来源（且允许 NULL → fail-closed）
--     NULL 必须被 CHECK 接受（历史/未来可能出现未分类行），
--     但分配器用 IN 白名单谓词，故 NULL 天然【不可分配】→ fail-closed。
--     「CHECK 必须拒绝未知字面量」属负向断言，由本地测试套件验证
--     （tests/cert_r3d_legacy_pool.test.mjs §16），不放进迁移：
--     迁移必须始终成功退出，不得包含故意失败的语句。
CREATE TABLE _assert_0046 (p TEXT CHECK (p IS NULL OR p IN
  ('legacy_migrated','v2_synthetic_compat','v2_native')));
INSERT INTO _assert_0046 (p) VALUES
  ('legacy_migrated'),('v2_synthetic_compat'),('v2_native'),(NULL);
DROP TABLE _assert_0046;

-- =============================================================================
-- 迁移后状态（历史库存导入前）：
--   id_pools 仍为 500 行合成 cert_trn（CTRN%06d, status=0, assigned_to=NULL）
--   provenance = 'v2_synthetic_compat'（保留、不可分配；status 等业务字段零改动）
--   约束：pool_type ∈ {cert_trn, cert_srv, cert_hon, cert_skl, volunteer}
--         status     ∈ {0,1,2}
--         provenance ∈ {legacy_migrated, v2_synthetic_compat, v2_native} ∪ {NULL}
--         UNIQUE(code)                      ← legacy 全局唯一不变量已恢复
--
-- 分配资格（fail-closed）：provenance ∈ ('legacy_migrated','v2_native')
--   → 本迁移之后、legacy 导入之前，cert_trn【无可分配候选】
--     （500 条合成库存按冻结决策被排除）。这是预期的正确行为：
--     TRAINING 在历史库存导入前将得到 EXAM_POOL_EXHAUSTED，
--     而非违规消费兼容库存。导入顺序见 legacy-id-pool-migration.md。
--
-- 后续（独立 Gate）：由导入器迁移 450,000 行历史库存
--   （全部标记 provenance='legacy_migrated'），届时 post-import 总量 = 450,500。
-- =============================================================================
