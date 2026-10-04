#!/usr/bin/env python3
"""
POST-R5-T1 — TEST data value generator + Step-5 D1 insert SQL builder.

Discipline:
- This script produces ONLY 2.0 TEST artifacts (sentinel id space 990001+ and
  Crockford ULIDs). It carries NO real PII, NO tokens, NO real cert numbers.
- It does NOT execute anything against D1. It only writes the SQL file for the
  operator to run via `wrangler d1 execute jhzy-v2-prod --remote --profile jhzy`.
- The generated cert_no / pool code is selected at runtime (Step 7) by a live
  query, NOT hardcoded here.
"""
import json
import os
import secrets
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_SQL = os.path.join(HERE, "54-t1-step5-data.sql")
OUT_JSON = os.path.join(HERE, "54-t1-values.json")

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # 32 chars (no I L O U)


def ulid() -> str:
    return "".join(CROCKFORD[secrets.randbelow(32)] for _ in range(26))


# ---- TEST sentinel id space (far above production maxima: users 1676, teams 1,
#      activities 226, occurrences 72, signups 370, participations 372,
#      attendance 240, templates 3, certificates 413) ----
U = 990001   # test user
T = 990002   # test team
A = 990003   # test activity
O = 990004   # test occurrence
S = 990005   # test signup
P = 990006   # test participation (also attendance.participation_id)
ATT = 990007 # test attendance session
TPL = 990008 # test certificate template
CERT = 990009  # test certificate (assigned at insert time)

now = int(time.time())
checkin_at = now - 7200
checkout_at = now - 3600

user_pub = ulid()
team_pub = ulid()
activity_pub = ulid()
occ_pub = ulid()
part_pub = ulid()

MARKER = "T1_TEST_DO_NOT_USE_REAL"

sql = f"""-- POST-R5-T1 Step 5: create 2.0 TEST data (sentinel id space 990001+).
-- Discipline: TEST ONLY. All ids 990001..990009 are non-production sentinels.
-- Marker present on text columns: users.nickname, teams.name, activities.title,
-- certificate_templates.name. FK-linked rows (signup/participation/attendance)
-- inherit the TEST scope via the sentinel activity/team/user.
-- Read the values JSON (54-t1-values.json) for the generated ULIDs.

INSERT INTO users (id, public_id, nickname, cert_level, status, created_at)
  VALUES ({U}, '{user_pub}', '{MARKER}', 1, 1, {now});

INSERT INTO teams (id, public_id, name, owner_user_id, status, is_system, created_at)
  VALUES ({T}, '{team_pub}', '{MARKER}_team', {U}, 1, 0, {now});

INSERT INTO activities (id, public_id, team_id, title, start_time, end_time, created_by, status, created_at)
  VALUES ({A}, '{activity_pub}', {T}, '{MARKER} activity', {checkin_at}, {checkout_at}, {U}, 1, {now});

INSERT INTO activity_occurrences (id, public_id, activity_id, start_time, end_time, status, created_at)
  VALUES ({O}, '{occ_pub}', {A}, {checkin_at}, {checkout_at}, 1, {now});

INSERT INTO activity_signups (id, activity_id, user_id, status, created_at)
  VALUES ({S}, {A}, {U}, 1, {now});

INSERT INTO activity_participations (id, public_id, signup_id, occurrence_id, status, created_at)
  VALUES ({P}, '{part_pub}', {S}, {O}, 1, {now});

INSERT INTO attendance_sessions (id, signup_id, activity_id, user_id, team_id, participation_id, status, checkin_at, checkout_at, created_at)
  VALUES ({ATT}, {S}, {A}, {U}, {T}, {P}, 2, {checkin_at}, {checkout_at}, {now});

INSERT INTO certificate_templates (id, name, cert_type, layout, status, created_at)
  VALUES ({TPL}, '{MARKER}_template', 'activity', '{{}}', 1, {now});
"""

with open(OUT_SQL, "w") as f:
    f.write(sql)

values = {
    "marker": MARKER,
    "sentinel_ids": {
        "user": U, "team": T, "activity": A, "occurrence": O, "signup": S,
        "participation": P, "attendance": ATT, "template": TPL, "certificate": CERT,
    },
    "ulids": {
        "user_public_id": user_pub, "team_public_id": team_pub,
        "activity_public_id": activity_pub, "occurrence_public_id": occ_pub,
        "participation_public_id": part_pub,
    },
    "timestamps": {"now": now, "checkin_at": checkin_at, "checkout_at": checkout_at},
}

with open(OUT_JSON, "w") as f:
    json.dump(values, f, indent=2)

print("WROTE:", OUT_SQL)
print("WROTE:", OUT_JSON)
print(json.dumps(values, indent=2))
