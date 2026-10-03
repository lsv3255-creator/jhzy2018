-- =============================================================================
-- 嘉禾志愿 2.0 — D1 Migration 0045：Certificate Domain & Schema Contract (CERT-R2)
--   依据：workers/docs/audits/2026-10-03-post-cutover-assurance/20-cert-r1-...md
--   模式：纯增量 / 非破坏 / 兼容既有 413 张证书 / D1 兼容。
--
-- 安全与兼容性（经 2026-10-03 生产只读核验 jhzy-v2-prod）：
--   1) 既有 413 张证书业务列不变：cert_no / user_id / team_id / source_type /
--      source_id / status / cert_type 均不修改；仅新增可空/默认值列。
--   2) cert_kind NOT NULL DEFAULT 'participant'：全部 413 历史行映射为真实参与者
--      （participant），语义真实，不伪造历史。
--   3) uq_cert_user_source 部分唯一索引，谓词
--        WHERE status = 1 AND source_type = 'activity' AND source_id IS NOT NULL
--      生产只读核验（2026-10-03，rows_written=0）：
--        - EXACT_PRED_CONFLICT_GROUPS = 0
--        - 413 张证书 source_id 全为 NULL（ROWS_WITH_NONNULL_SOURCE_ID=0）
--      即：生产现存证书均无权威 source identity，全部落在谓词之外，
--      索引可安全创建，不阻塞任何历史行；新发带 source_id 的证书才受唯一性保护。
--   4) 8 组历史 (user, exam_paper) 重复行属 source_type='course'、exam_paper_id 维度，
--      不在本索引列/谓词范围内，0 行被本迁移改动或删除。
--   5) id_pools 本轮【不播种】任何 pool（含 cert_act）。理由见 M3 正文：id_pools
--      CHECK 不含 'cert_act'，且生产 activity/service 证书并非以 id_pools 模式编号
--      （service 用 JHCRT-SRV-* 字母数字前缀）。编号分配在 CERT-R2 仅落到接口/契约，
--      具体 pool 命名/前缀决策推迟 CERT-R3（见 src/domain/certificate.ts 的
--      CertificateNumberAllocator）。
--   6) 索引与建表均用 IF NOT EXISTS；无数据回填 UPDATE；可重复执行（幂等）。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- M1) certificates：域字段（全部向后兼容；既有 413 行默认值映射，零修改业务列）
-- ---------------------------------------------------------------------------
ALTER TABLE certificates ADD COLUMN cert_kind TEXT NOT NULL DEFAULT 'participant'
  CHECK (cert_kind IN ('participant', 'acceptance'));

ALTER TABLE certificates ADD COLUMN issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE certificates ADD COLUMN issue_reason TEXT;
ALTER TABLE certificates ADD COLUMN revoked_at INTEGER;
ALTER TABLE certificates ADD COLUMN revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE certificates ADD COLUMN revoke_reason TEXT;

-- ---------------------------------------------------------------------------
-- M2) certificates：活动/服务证书重复防护（仅 activity；排除 exam/course → 历史 8 组不冲突）
--
-- 精确索引契约（EXACT_0045_INDEX_CONTRACT）：
--   columns  : (user_id, source_type, source_id)
--   predicate: WHERE status = 1 AND source_type = 'activity' AND source_id IS NOT NULL
--   覆盖 source_type：仅 'activity'（含复用 'activity' 的 service）。排除 course/exam/manual/NULL。
--   status 语义：status CHECK(1,2)，1=active / 2=revoked。谓词仅锁 status=1（active）；
--                已撤销(2)证书不参与唯一性 → 撤销后可重发，符合业务预期。
--   NULL 行为：显式排除 source_id IS NULL。生产 413 张证书 source_id 全为 NULL
--              （legacy/service 种子形状），这些行永远不进入索引、不受约束、
--              不阻塞迁移，且未来新发带权威 source_id 的证书才受保护。
--   历史兼容：course/exam 的 8 组历史 (user,exam_paper) 重复属 exam_paper_id 维度，
--              不在本索引列/谓词内，0 行被改动。
--   生产核验：按本谓词 status=1 AND source_type='activity' AND source_id IS NOT NULL
--              的 (user_id, source_id) 冲突组 = 0（EXACT_PRED_CONFLICT_GROUPS=0）。
--
-- 说明：生产中以 source_type='activity' 同时承载「活动证书」与「服务证书」
--   （service 用 cert_no 前缀 JHCRT-SRV-* 标识），二者真实用户发放均带非 NULL
--   source_id，故同一索引即可覆盖活动与服务的幂等防护。
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_cert_user_source
  ON certificates(user_id, source_type, source_id)
  WHERE status = 1 AND source_type = 'activity' AND source_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- M3) 编号池（id_pools）播种 —— 本轮【不执行】，理由见下：
--   id_pools.pool_type CHECK = ('cert_trn','cert_srv','cert_hon','volunteer')，
--   既不包含 'cert_act' 亦无 activity 专用值；向其 INSERT 'cert_act' 会违反 CHECK。
--   扩展该 CHECK 需重建 id_pools 表（非增量，违背 §5 增量策略 / §31 STOP 精神，
--   且 production 现实表明 activity / service 证书并非以 id_pools 模式编号——
--   生产 55 张 service 证书使用字母数字前缀 JHCRT-SRV-*，而非 pool code）。
--   故编号分配在 CERT-R2 仅落到「接口/契约」（见 src/domain/certificate.ts 的
--   CertificateNumberAllocator），具体 pool 命名/前缀决策推迟 CERT-R3：
--   选项 A = 新建迁移扩展 id_pools CHECK 新增 cert_act/cert_svc 并播种；
--   选项 B = 对齐生产 JHCRT-SRV-* 既有约定。CERT-R2 不臆造对外编号。
--
-- ---------------------------------------------------------------------------
-- M4) certificate_logs：扩展审计字段（复用既有表，不新建表）
--     batch_id：关联 certificate_batches.public_id（TEXT，非 FK，避免建表顺序依赖）
--     result：单次发放结果（success/failure）；failure_code：失败码（如 PDF_GEN_FAILED）
-- ---------------------------------------------------------------------------
ALTER TABLE certificate_logs ADD COLUMN batch_id TEXT;
ALTER TABLE certificate_logs ADD COLUMN result TEXT CHECK (result IS NULL OR result IN ('success', 'failure'));
ALTER TABLE certificate_logs ADD COLUMN failure_code TEXT;

-- ---------------------------------------------------------------------------
-- M5) certificate_batches：批量发证结果/可观测性（最小表）
--     status: 0 PENDING / 1 RUNNING / 2 COMPLETED / 3 COMPLETED_WITH_FAILURES
--     计数用于批量结果屏与重试判定；不存储逐接收者 PII 快照。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS certificate_batches (
  id             INTEGER PRIMARY KEY,
  public_id      TEXT NOT NULL UNIQUE,
  team_id        INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  operator_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_type    TEXT NOT NULL,
  source_id      INTEGER,
  status         INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0, 1, 2, 3)),
  total          INTEGER NOT NULL DEFAULT 0,
  eligible       INTEGER NOT NULL DEFAULT 0,
  ineligible     INTEGER NOT NULL DEFAULT 0,
  already_issued INTEGER NOT NULL DEFAULT 0,
  issued         INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  skipped        INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at     INTEGER,
  completed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cb_team ON certificate_batches(team_id, created_at);
