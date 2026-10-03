-- =============================================================================
-- 嘉禾志愿 2.0 — D1 Migration 0045：Certificate Domain & Schema Contract (CERT-R2)
--   依据：workers/docs/audits/2026-10-03-post-cutover-assurance/20-cert-r1-...md
--   模式：纯增量 / 非破坏 / 兼容既有 413 张证书 / D1 兼容。
--
-- ⚠ 源修订记录（CERT-R3A-FIX，2026-10-03）：
--   CERT-R3A 证明原 M2 索引键 (user_id, source_type, source_id) 不足——域 ACTIVITY 与
--   域 SERVICE 同持久化为 source_type='activity'，而 source_id 分属 activities.id 与
--   service_records.id 两个独立命名空间，相同数值会互相误判为重复。
--   修正：M1 增 `issue_source`（namespace 判别器）；M2 索引键纳入该列。
--   本修订为「未远端应用前的源基线更正」，故直接改写 0045 源文件，
--   未新增 0046，未引入 DROP INDEX 编排。commit c698e667 保留原契约作为历史证据。
--   修订后 0045 仍未在任何环境 APPLY（staging / production 均 NOT_APPLIED）。
--
-- 安全与兼容性（经 2026-10-03 生产只读核验 jhzy-v2-prod，rows_written=0）：
--   1) 既有 413 张证书业务列不变：cert_no / user_id / team_id / source_type /
--      source_id / status / cert_type 均不修改；仅新增可空/默认值列。
--   2) cert_kind NOT NULL DEFAULT 'participant'：全部 413 历史行映射为真实参与者
--      （participant），语义真实，不伪造历史。
--   3) issue_source 可空且历史行恒为 NULL：不回填、不 UPDATE、不改写任何历史行。
--   4) uq_cert_user_source 部分唯一索引，谓词
--        WHERE status = 1 AND source_type = 'activity'
--          AND issue_source IS NOT NULL AND source_id IS NOT NULL
--      生产 413 行 source_id 与 issue_source 均为 NULL → 全部落在谓词之外，
--      索引可安全创建，不阻塞任何历史行；仅未来新发且声明命名空间的证书受唯一性保护。
--   5) 8 组历史 (user, exam_paper) 重复行属 source_type='course'、exam_paper_id 维度，
--      不在本索引列/谓词范围内，0 行被本迁移改动或删除。
--   6) id_pools 本轮【不播种】任何 pool（含 cert_act / cert_srv）。理由见 M3 正文：
--      id_pools CHECK 不含 'cert_act'；编号策略候选复用既有 cert_srv（V1.0 服务证书
--      语义），但【外部编号格式】推迟 CERT-R3B 分配器实现决策，本轮不臆造对外契约。
--   7) 索引与建表均用 IF NOT EXISTS；无数据回填 UPDATE；可重复执行（幂等）。
-- =============================================================================

PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- M1) certificates：域字段（全部向后兼容；既有 413 行默认值映射，零修改业务列）
--
-- issue_source（namespace 判别器，CERT-R3A-FIX 增补）：
--   域 SOURCE  → source_type='activity' + issue_source='service'  + source_id=service_records.id
--   域 ACTIVITY→ source_type='activity' + issue_source='activity' + source_id=activities.id
--   训练/验收/历史 → issue_source=NULL（source_type 单独已足以判别，无需命名空间）
--   语义最小化：仅 activity / service 两个值——它只承担「source_type 单独不足时的命名空间判别」。
--   历史 413 行保持 NULL：不回填、不 UPDATE、不改写、不伪造。
-- ---------------------------------------------------------------------------
ALTER TABLE certificates ADD COLUMN cert_kind TEXT NOT NULL DEFAULT 'participant'
  CHECK (cert_kind IN ('participant', 'acceptance'));

ALTER TABLE certificates ADD COLUMN issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE certificates ADD COLUMN issue_reason TEXT;
ALTER TABLE certificates ADD COLUMN revoked_at INTEGER;
ALTER TABLE certificates ADD COLUMN revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE certificates ADD COLUMN revoke_reason TEXT;
ALTER TABLE certificates ADD COLUMN issue_source TEXT
  CHECK (issue_source IS NULL OR issue_source IN ('activity', 'service'));

-- ---------------------------------------------------------------------------
-- M2) certificates：活动/服务证书重复防护（仅 activity；排除 exam/course → 历史 8 组不冲突）
--
-- 精确索引契约（EXACT_0045_INDEX_CONTRACT，CERT-R3A-FIX 修正版）：
--   columns  : (user_id, source_type, issue_source, source_id)
--   predicate: WHERE status = 1 AND source_type = 'activity'
--                AND issue_source IS NOT NULL AND source_id IS NOT NULL
--   覆盖 source_type：仅 'activity'。排除 course/exam/manual/NULL。
--   status 语义：status CHECK(1,2)，1=active / 2=revoked。谓词仅锁 status=1（active）；
--                已撤销(2)证书不参与唯一性 → 撤销后可重发，符合业务预期。
--   NULL 行为（两个维度均显式排除）：
--     · source_id IS NULL  → 无权威 source identity（生产 413/413 历史行）→ 不受约束
--     · issue_source IS NULL → 未声明命名空间（历史/训练/验收）→ 不受约束
--   为何必须含 issue_source（CERT-R3A 证明的缺陷）：
--     域 ACTIVITY 与域 SERVICE 都持久化为 source_type='activity'，而其 source_id 分属
--     不同命名空间（activities.id 与 service_records.id 为两个独立表的独立 INTEGER PK，
--     数值空间天然重叠）。若索引不含 issue_source，则「参加活动 #5」与「服务记录 #5」
--     会被判为同一成就 → 误拒合法发放。纳入 issue_source 后二者键不同，互不冲突。
--   历史兼容：8 组 (user, exam_paper) 重复属 exam_paper_id 维度，不在本索引列/谓词内，
--     0 行被改动；生产 413 行 source_id 与 issue_source 均为 NULL，全部在谓词之外。
--     因 0045 从未远端应用，本定义直接替换旧版，无需 DROP INDEX 编排。
--   生产核验依据：原三列谓词冲突数 = 0（且 0 行 source_id 非 NULL），故本修正
--     不改变任何存量行的索引归属，纯为未来新发证书的正确性。
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_cert_user_source
  ON certificates(user_id, source_type, issue_source, source_id)
  WHERE status = 1 AND source_type = 'activity'
    AND issue_source IS NOT NULL AND source_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- M3) 编号池（id_pools）播种 —— 本轮【不执行】，理由见下：
--   id_pools.pool_type CHECK = ('cert_trn','cert_srv','cert_hon','volunteer')，
--   既不包含 'cert_act'；向其 INSERT 'cert_act' 会违反 CHECK。扩展该 CHECK 需重建
--   id_pools 表（非增量，违背 ADDITIVE 原则），故 CERT-R3A-FIX 亦不创建该池。
--   CERT-R3A 结论：'cert_srv' 保留 V1.0 服务证书语义且在 CHECK 内，可作为未来
--   activity/service 发号的【候选池】——即 ACTIVITY/SERVICE POOL STRATEGY =
--   candidate reuse of cert_srv（零迁移、零表重建）。
--   但【对外可见编号格式】本轮不冻结：EXTERNAL NUMBER FORMAT =
--   DEFERRED_TO_CERT_R3B allocator implementation decision。
--   理由：V2 唯一运行格式为 CTRN%06d（0022 播种）；V1.0 的 JHCRT-* 未在 V2 落地且
--   历史上已出现 cert_no 碰撞；无权威既有规则可循 → 先定池、后定格式。
--   本轮【不播种 cert_srv、不改 id_pools、不臆造对外编号】。
--   播种与格式均属 CERT-R3B 分配器实现范畴（独立迁移 Gate）。
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
