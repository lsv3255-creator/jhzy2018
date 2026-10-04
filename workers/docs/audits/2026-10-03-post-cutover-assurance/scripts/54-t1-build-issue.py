#!/usr/bin/env python3
"""
POST-R5-T1 Step 7 — build the issuance SQL (D1_FALLBACK) that mirrors EXACTLY the
real CertificateIssuanceService.issueBatch atomic batch:
  1) certificates INSERT
  2) id_pools conditional consume (guarded by EXISTS(certificates.public_id, status=1))
  3) certificate_logs INSERT derived from the cert row

The script writes:
  * /tmp/54-t1-step7-issue.sql      (REAL, executed, NOT committed)
  * <scriptdir>/54-t1-step7-issue.template.sql  (MASKED, committed as doc evidence)
  * <scriptdir>/54-t1-step7-values.json          (TEST public_id / internal ids / masked cert_no)

It carries NO real tokens / PII. The only "real" value embedded is the TEST cert_no
(the selected legacy pool code), which is written ONLY into /tmp (not committed) and
is masked everywhere else.
"""
import json
import os
import secrets
import sys

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def ulid() -> str:
    return "".join(CROCKFORD[secrets.randbelow(32)] for _ in range(26))


HERE = os.path.dirname(os.path.abspath(__file__))
pool_code = sys.argv[1]
pool_id = sys.argv[2]

# TEST sentinel ids (must match 54-t1-values.json)
U, T, A, TPL, CERT = 990001, 990002, 990003, 990008, 990009
now = int(__import__("time").time())

cert_pub = ulid()
verify_code = ulid()

real_sql = f"""-- POST-R5-T1 Step 7 D1_FALLBACK issuance (mirrors CertificateIssuanceService.issueBatch).
-- TEST ONLY. cert_no = selected legacy cert_srv pool code (consumed, not reclaimed).
-- Run as ONE batch so the id_pools EXISTS(certificates.public_id) guard sees the cert.

INSERT INTO certificates
  (id, public_id, cert_no, verify_code, template_id, user_id, team_id, cert_type,
   source_type, issue_source, source_id, cert_kind, issue_reason, issued_by,
   holder_name, issuer_name, snapshot, status, issued_at, created_at)
 VALUES
  ({CERT}, '{cert_pub}', '{pool_code}', '{verify_code}', {TPL}, {U}, {T}, 'activity',
   'activity', 'activity', {A}, 'participant', 'normal', {U},
   NULL, NULL, NULL, 1, {now}, {now});

UPDATE id_pools
   SET status = 1, assigned_to = {U}, assigned_at = {now}
 WHERE pool_type = 'cert_srv' AND code = '{pool_code}' AND status = 0
   AND provenance IN ('legacy_migrated','v2_native')
   AND EXISTS (SELECT 1 FROM certificates c WHERE c.public_id = '{cert_pub}' AND c.status = 1);

INSERT INTO certificate_logs
  (team_id, certificate_id, action, reason, operator_id, result, failure_code, batch_id, created_at)
 SELECT c.team_id, c.id, 'issue', 'normal', {U}, 'success', NULL, NULL, {now}
   FROM certificates c
  WHERE c.public_id = '{cert_pub}' AND c.status = 1;
"""

masked_code = pool_code[:4] + "****" + pool_code[-4:]

template_sql = real_sql.replace(pool_code, "<TEST_CERT_NO_PLACEHOLDER>")

with open("/tmp/54-t1-step7-issue.sql", "w") as f:
    f.write(real_sql)
with open(os.path.join(HERE, "54-t1-step7-issue.template.sql"), "w") as f:
    f.write(template_sql)

values = {
    "marker": "T1_TEST_DO_NOT_USE_REAL",
    "certificate_id": CERT,
    "certificate_public_id": cert_pub,
    "verify_code": verify_code,
    "cert_no_masked": masked_code,
    "pool_id": int(pool_id),
    "recipient_user_id": U,
    "team_id": T,
    "source_activity_id": A,
    "template_id": TPL,
    "issued_at": now,
    "issue_path": "D1_FALLBACK",
}
with open(os.path.join(HERE, "54-t1-step7-values.json"), "w") as f:
    json.dump(values, f, indent=2)

print("WROTE /tmp/54-t1-step7-issue.sql (REAL, not committed)")
print("WROTE 54-t1-step7-issue.template.sql (masked)")
print("WROTE 54-t1-step7-values.json")
print(json.dumps(values, indent=2))
