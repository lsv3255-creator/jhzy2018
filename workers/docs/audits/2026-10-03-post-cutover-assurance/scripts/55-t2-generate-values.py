#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
POST-R5-T2 helper: generate TEST data values + SQL (no raw token).

Discipline:
- All ids are sentinel range 991001..991020 (verified unused on prod D1).
- TEST marker T2_TEST_DO_NOT_USE_REAL embedded in activity title + comments.
- Raw opaque token is written ONLY to /tmp (never committed).
- Masked token (s_****<last4>) is written to the committed values JSON.
- No PII: no real name / phone / openid / idcard.
"""

import secrets
import hashlib
import base64
import json
import time
import os

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
SQL_PATH = os.path.join(OUT_DIR, "55-t2-step5-data.sql")
VAL_PATH = os.path.join(OUT_DIR, "55-t2-values.json")
TOKEN_PATH = "/tmp/55-t2-token.txt"
CURL_PATH = "/tmp/55-t2-curl.sh"

ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

def gen_ulid():
    return "".join(secrets.choice(ULID_ALPHABET) for _ in range(26))

def gen_token():
    raw = secrets.token_bytes(32)
    b64 = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return "s_" + b64

now = int(time.time())
exp = now + 30 * 86400  # 30-day session

# ---- sentinel ids ----
TEAM_ID = 991001
ADMIN_ID = 991002
RECIPIENT_ID = 991003
ACTIVITY_ID = 991004
OCC_ID = 991005
SIGNUP_ID = 991006
PART_ID = 991007
ATT_ID = 991008
TPL_ID = 991009
SESSION_ID = 991010

# ---- generated public ids (ULIDs) ----
ULID_TEAM = gen_ulid()
ULID_ADMIN = gen_ulid()
ULID_RECIPIENT = gen_ulid()
ULID_ACTIVITY = gen_ulid()
ULID_OCC = gen_ulid()
ULID_PART = gen_ulid()
ULID_TPL = gen_ulid()
ULID_SESSION = gen_ulid()

# ---- session token (TEST only) ----
TOKEN = gen_token()
TOKEN_HASH = hashlib.sha256(TOKEN.encode("utf-8")).hexdigest()
MASKED_TOKEN = "s_****" + TOKEN[-4:]

# ---- build SQL (ordered for FK safety) ----
lines = []
lines.append("-- POST-R5-T2 TEST data (T2_TEST_DO_NOT_USE_REAL). Sentinel ids 991001..991020.")
lines.append("-- Auth context: sessions row + user_roles(team_admin @ TEST team).")
lines.append("-- Raw opaque token is NOT in this file; only its SHA-256 hash.")
lines.append("")
lines.append(f"-- 1) users (admin + recipient)")
lines.append(
    f"INSERT INTO users (id, public_id, nickname, cert_level, status, created_at) "
    f"VALUES ({ADMIN_ID}, '{ULID_ADMIN}', 'T2_TEST_ADMIN', 1, 1, {now});"
)
lines.append(
    f"INSERT INTO users (id, public_id, nickname, cert_level, status, created_at) "
    f"VALUES ({RECIPIENT_ID}, '{ULID_RECIPIENT}', 'T2_TEST_RECIPIENT', 1, 1, {now});"
)
lines.append("")
lines.append(f"-- 2) teams (owner = admin)")
lines.append(
    f"INSERT INTO teams (id, public_id, name, owner_user_id, cert_status, is_system, status, created_at) "
    f"VALUES ({TEAM_ID}, '{ULID_TEAM}', 'T2_TEST_DO_NOT_USE_REAL', {ADMIN_ID}, 0, 0, 1, {now});"
)
lines.append("")
lines.append(f"-- 3) activities (title carries TEST marker)")
lines.append(
    f"INSERT INTO activities (id, public_id, team_id, title, start_time, end_time, status, created_by, created_at) "
    f"VALUES ({ACTIVITY_ID}, '{ULID_ACTIVITY}', {TEAM_ID}, 'T2_TEST_DO_NOT_USE_REAL activity', {now}, {now + 3600}, 1, {ADMIN_ID}, {now});"
)
lines.append("")
lines.append(f"-- 4) activity_occurrences")
lines.append(
    f"INSERT INTO activity_occurrences (id, public_id, activity_id, start_time, end_time, status, created_at) "
    f"VALUES ({OCC_ID}, '{ULID_OCC}', {ACTIVITY_ID}, {now}, {now + 3600}, 1, {now});"
)
lines.append("")
lines.append(f"-- 5) activity_signups (recipient signs up)")
lines.append(
    f"INSERT INTO activity_signups (id, activity_id, user_id, status, created_at) "
    f"VALUES ({SIGNUP_ID}, {ACTIVITY_ID}, {RECIPIENT_ID}, 1, {now});"
)
lines.append("")
lines.append(f"-- 6) activity_participations (status=1 assigned)")
lines.append(
    f"INSERT INTO activity_participations (id, public_id, signup_id, occurrence_id, status, created_at) "
    f"VALUES ({PART_ID}, '{ULID_PART}', {SIGNUP_ID}, {OCC_ID}, 1, {now});"
)
lines.append("")
lines.append(f"-- 7) attendance_sessions (participation_id populated, status=2 checked-out, no anomaly)")
lines.append(
    f"INSERT INTO attendance_sessions (id, signup_id, activity_id, user_id, team_id, status, participation_id, created_at) "
    f"VALUES ({ATT_ID}, {SIGNUP_ID}, {ACTIVITY_ID}, {RECIPIENT_ID}, {TEAM_ID}, 2, {PART_ID}, {now});"
)
lines.append("")
lines.append(f"-- 8) certificate_templates (layout NOT NULL)")
lines.append(
    f"INSERT INTO certificate_templates (id, name, cert_type, layout, status, created_by, created_at, public_id) "
    f"VALUES ({TPL_ID}, 'T2_TEST_DO_NOT_USE_REAL template', 'activity', '{{}}', 1, {ADMIN_ID}, {now}, '{ULID_TPL}');"
)
lines.append("")
lines.append(f"-- 9) user_roles (admin -> team_admin @ TEST team)")
lines.append(
    f"INSERT INTO user_roles (user_id, role_id, scope_team_id, granted_at) "
    f"VALUES ({ADMIN_ID}, (SELECT id FROM roles WHERE code='team_admin'), {TEAM_ID}, {now});"
)
lines.append("")
lines.append(f"-- 10) sessions (TEST admin auth context; token_hash only)")
lines.append(
    f"INSERT INTO sessions (id, public_id, user_id, token_hash, expires_at, status, created_at) "
    f"VALUES ({SESSION_ID}, '{ULID_SESSION}', {ADMIN_ID}, '{TOKEN_HASH}', {exp}, 1, {now});"
)
lines.append("")

sql = "\n".join(lines)
with open(SQL_PATH, "w", encoding="utf-8") as f:
    f.write(sql)

# ---- committed values json (no raw token) ----
values = {
    "marker": "T2_TEST_DO_NOT_USE_REAL",
    "note": "All ids sentinel range 991001..991020; TEST only; no PII.",
    "team_id": TEAM_ID,
    "team_public_id": ULID_TEAM,
    "admin_user_id": ADMIN_ID,
    "admin_public_id": ULID_ADMIN,
    "recipient_user_id": RECIPIENT_ID,
    "recipient_public_id": ULID_RECIPIENT,
    "activity_id": ACTIVITY_ID,
    "activity_public_id": ULID_ACTIVITY,
    "occurrence_id": OCC_ID,
    "occurrence_public_id": ULID_OCC,
    "signup_id": SIGNUP_ID,
    "participation_id": PART_ID,
    "participation_public_id": ULID_PART,
    "attendance_id": ATT_ID,
    "template_id": TPL_ID,
    "template_public_id": ULID_TPL,
    "session_id": SESSION_ID,
    "session_public_id": ULID_SESSION,
    "token_masked": MASKED_TOKEN,
    "token_expires_at": exp,
    "created_at": now,
}
with open(VAL_PATH, "w", encoding="utf-8") as f:
    json.dump(values, f, indent=2, ensure_ascii=False)

# ---- raw token (NOT committed) ----
with open(TOKEN_PATH, "w", encoding="utf-8") as f:
    f.write(TOKEN)

# ---- curl script (NOT committed): preview + issue via real HTTP route ----
curl = "#!/bin/bash\n"
curl += "# POST-R5-T2 HTTP route test (T2_TEST_DO_NOT_USE_REAL). Raw token, NOT committed.\n"
curl += f'TOKEN="{TOKEN}"\n'
curl += f'TEAM_ID="{TEAM_ID}"\n'
curl += f'HOST="https://v2-smoke.signivra.com"\n'
curl += f'ACT="{ULID_ACTIVITY}"\n'
curl += f'PART="{ULID_PART}"\n'
curl += f'TPL="{TPL_ID}"\n'
curl += f'RECIP="{RECIPIENT_ID}"\n'
curl += "\n"
curl += "# --- preview ---\n"
curl += 'echo "=== PREVIEW ==="\n'
curl += (
    'curl -sS -i -X POST "$HOST/api/v2/activities/$ACT/certificates/preview" \\\n'
    '  -H "Authorization: Bearer $TOKEN" \\\n'
    '  -H "X-Team-Id: $TEAM_ID" \\\n'
    '  -H "Content-Type: application/json" \\\n'
    f'  --data \'{{"templateId":{TPL_ID},"recipientUserIds":[{RECIPIENT_ID}]}}\'\n'
)
curl += "\n"
curl += "# --- single issue ---\n"
curl += 'echo "=== ISSUE ==="\n'
curl += (
    'curl -sS -i -X POST "$HOST/api/v2/activities/$ACT/participants/$PART/certificate/issue" \\\n'
    '  -H "Authorization: Bearer $TOKEN" \\\n'
    '  -H "X-Team-Id: $TEAM_ID" \\\n'
    '  -H "Content-Type: application/json" \\\n'
    f'  --data \'{{"templateId":{TPL_ID}}}\'\n'
)
with open(CURL_PATH, "w", encoding="utf-8") as f:
    f.write(curl)
os.chmod(CURL_PATH, 0o700)

print("WROTE:")
print("  SQL      :", SQL_PATH)
print("  VALUES   :", VAL_PATH, "(masked token:", MASKED_TOKEN, ")")
print("  TOKEN    :", TOKEN_PATH, "(raw, NOT committed)")
print("  CURL     :", CURL_PATH, "(raw token, NOT committed)")
print("  TEAM_ID  :", TEAM_ID)
print("  ACTIVITY :", ULID_ACTIVITY)
print("  PART     :", ULID_PART)
print("  TEMPLATE :", TPL_ID)
print("  RECIPIENT:", RECIPIENT_ID)
