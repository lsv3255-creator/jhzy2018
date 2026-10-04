-- POST-R5-T1 Step 7 D1_FALLBACK issuance (mirrors CertificateIssuanceService.issueBatch).
-- TEST ONLY. cert_no = selected legacy cert_srv pool code (consumed, not reclaimed).
-- Run as ONE batch so the id_pools EXISTS(certificates.public_id) guard sees the cert.

INSERT INTO certificates
  (id, public_id, cert_no, verify_code, template_id, user_id, team_id, cert_type,
   source_type, issue_source, source_id, cert_kind, issue_reason, issued_by,
   holder_name, issuer_name, snapshot, status, issued_at, created_at)
 VALUES
  (990009, 'CYDSBABK8ABXXEYAAR4A7EQWWP', '<TEST_CERT_NO_PLACEHOLDER>', '8TRCZ0YCYHMMM1YNXJXP192ATN', 990008, 990001, 990002, 'activity',
   'activity', 'activity', 990003, 'participant', 'normal', 990001,
   NULL, NULL, NULL, 1, 1791116463, 1791116463);

UPDATE id_pools
   SET status = 1, assigned_to = 990001, assigned_at = 1791116463
 WHERE pool_type = 'cert_srv' AND code = '<TEST_CERT_NO_PLACEHOLDER>' AND status = 0
   AND provenance IN ('legacy_migrated','v2_native')
   AND EXISTS (SELECT 1 FROM certificates c WHERE c.public_id = 'CYDSBABK8ABXXEYAAR4A7EQWWP' AND c.status = 1);

INSERT INTO certificate_logs
  (team_id, certificate_id, action, reason, operator_id, result, failure_code, batch_id, created_at)
 SELECT c.team_id, c.id, 'issue', 'normal', 990001, 'success', NULL, NULL, 1791116463
   FROM certificates c
  WHERE c.public_id = 'CYDSBABK8ABXXEYAAR4A7EQWWP' AND c.status = 1;
