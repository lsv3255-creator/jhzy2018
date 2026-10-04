-- ============================================================================
-- 56-test-artifact-cleanup-policy.sql
-- POST-R5-T3 — TEST artifact cleanup / retention policy (dry-run by default)
-- Scope: 嘉禾志愿 2.0 production D1 (jhzy-v2-prod). 嘉禾志愿 1.0 绝对不触碰。
--
-- GUARDRAILS (硬性边界):
--   * 仅可处理带 T1_TEST_DO_NOT_USE_REAL / T2_TEST_DO_NOT_USE_REAL 标记，
--     或显式 TEST public_id / 哨兵 id 空间 (990001-990009 / 991001-991020) 的数据。
--   * 绝不处理真实业务数据。
--   * 绝不回收 id_pools（分配给 TEST 的 cert_srv 编号保留为已分配态，审计留存）。
--   * 绝不硬删 certificates（仅可 revoke；证书行保留为审计 artifact）。
--   * 绝不删除 teams / users / activities（FK RESTRICT）；保留为 TEST artifact。
--   * 绝不触碰 1.0 任何库 / 接口 / 文件。
--   * 本文件默认只读（PART A）。PART B 为禁用 / 注释态，仅当显式授权清理写入时
--     才可按前置条件谨慎启用。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- PART A — READ-ONLY INVENTORY（安全，仅 SELECT，可随时运行）
-- ----------------------------------------------------------------------------

-- A1. TEST 证书（按显式 public_id，覆盖 T1 + T2）
SELECT id, public_id, status, source_type, issue_source, source_id, user_id, revoke_reason
FROM certificates
WHERE public_id IN ('CYDSBABK8ABXXEYAAR4A7EQWWP','01M43GMNP3Z9K0D31MK741AVQX');

-- A2. TEST 证书审计日志
SELECT action, certificate_id, operator_id, result, failure_code
FROM certificate_logs
WHERE certificate_id IN (
  SELECT id FROM certificates
  WHERE public_id IN ('CYDSBABK8ABXXEYAAR4A7EQWWP','01M43GMNP3Z9K0D31MK741AVQX')
);

-- A3. TEST 活动（按标记定位）
SELECT id, public_id, title, team_id, status
FROM activities
WHERE title LIKE '%T1_TEST_DO_NOT_USE_REAL%'
   OR title LIKE '%T2_TEST_DO_NOT_USE_REAL%';

-- A4. TEST 会话（按哨兵 user id：990001=T1 用户, 991002=T2 admin, 991003=T2 recipient）
SELECT id, user_id, status, expires_at
FROM sessions
WHERE user_id IN (990001, 991002, 991003);

-- A5. 已消耗的 cert_srv id_pools（保留，不回收；code 列省略，raw 号池码不落盘）
SELECT id, pool_type, provenance, status, assigned_to
FROM id_pools
WHERE id IN (25775, 25776);


-- ----------------------------------------------------------------------------
-- PART B — WRITE SECTION（DISABLED / 注释态）
-- 仅当明确授权的清理写入（例如发现某 TEST 证书仍 status=1 或 TEST 会话仍 status=1）
-- 时才谨慎启用。启用前必须满足：
--   * Repo gate + health gate 已通过。
--   * 目标已确证为 TEST artifact（marker / 哨兵 id / public_id）。
--   * 绝不回收 id_pools；绝不删除 certificates；绝不触碰 1.0。
-- ❌ 禁止：DELETE FROM certificates / UPDATE id_pools SET status=0（回收）/ DELETE teams-users-activities
-- ----------------------------------------------------------------------------
--
-- -- B1. 仅当 TEST 证书仍 status=1 时撤销（幂等：status=1 守卫）
-- UPDATE certificates
-- SET status = 2,
--     revoked_at = unixepoch(),
--     revoked_by = <TEST_OPERATOR_ID>,
--     revoke_reason = 'T<x>_TEST_CLEANUP'
-- WHERE public_id = '<TEST_PUBLIC_ID>'
--   AND status = 1
--   AND user_id IN (990001, 991002, 991003);   -- 哨兵守卫：仅 TEST 用户
--
-- -- B2. 追加 revoke 审计日志
-- INSERT INTO certificate_logs (certificate_id, action, operator_id, result, failure_code, created_at)
-- SELECT id, 'revoke', <TEST_OPERATOR_ID>, 'success', NULL, unixepoch()
-- FROM certificates
-- WHERE public_id = '<TEST_PUBLIC_ID>' AND status = 2;
--
-- -- B3. 仅当 TEST 会话仍 status=1 时失效
-- UPDATE sessions
-- SET status = 2
-- WHERE user_id IN (990001, 991002, 991003)
--   AND status = 1;
--
-- -- ❌ NEVER: DELETE FROM certificates WHERE ...
-- -- ❌ NEVER: UPDATE id_pools SET status = 0 WHERE ...   (号池回收，禁止)
-- -- ❌ NEVER: DELETE FROM teams / users / activities WHERE ...
