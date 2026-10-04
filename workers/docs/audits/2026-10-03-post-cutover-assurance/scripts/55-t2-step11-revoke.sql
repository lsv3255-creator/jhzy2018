-- POST-R5-T2 cleanup (T2_TEST_DO_NOT_USE_REAL).
-- Safe revoke of the 1 TEST certificate issued via real HTTP route.
-- No HTTP revoke route exists; this mirrors the route's certificate_logs contract.
-- References public_id + integer ids only; no token / no pool code / no PII.

-- 1) revoke the TEST certificate (status 1 -> 2)
UPDATE certificates
   SET status = 2,
       revoked_at = (unixepoch()),
       revoked_by = 991002,
       revoke_reason = 'T2_TEST_CLEANUP'
 WHERE public_id = '01M43GMNP3Z9K0D31MK741AVQX' AND status = 1;

-- 2) audit row (action='revoke', result='success')
INSERT INTO certificate_logs (team_id, certificate_id, action, reason, operator_id, result, created_at)
VALUES (991001, 990010, 'revoke', 'T2_TEST_CLEANUP', 991002, 'success', (unixepoch()));

-- 3) invalidate the TEST session (auth context cleanup)
UPDATE sessions SET status = 2, updated_at = (unixepoch()) WHERE id = 991010 AND status = 1;
