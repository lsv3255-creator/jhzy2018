-- POST-R5-T2 TEST data (T2_TEST_DO_NOT_USE_REAL). Sentinel ids 991001..991020.
-- Auth context: sessions row + user_roles(team_admin @ TEST team).
-- Raw opaque token is NOT in this file; only its SHA-256 hash.

-- 1) users (admin + recipient)
INSERT INTO users (id, public_id, nickname, cert_level, status, created_at) VALUES (991002, 'B4XJ97PFTM80H651FRC55Z1XD8', 'T2_TEST_ADMIN', 1, 1, 1791119024);
INSERT INTO users (id, public_id, nickname, cert_level, status, created_at) VALUES (991003, '1ZKE91BE546MJC5G9PEBCW58NZ', 'T2_TEST_RECIPIENT', 1, 1, 1791119024);

-- 2) teams (owner = admin)
INSERT INTO teams (id, public_id, name, owner_user_id, cert_status, is_system, status, created_at) VALUES (991001, '9A4BGY1DMADESFM2Y2T9WJG03E', 'T2_TEST_DO_NOT_USE_REAL', 991002, 0, 0, 1, 1791119024);

-- 3) activities (title carries TEST marker)
INSERT INTO activities (id, public_id, team_id, title, start_time, end_time, status, created_by, created_at) VALUES (991004, 'VXT16HD0SJEJ2B9K58P3EVAWYT', 991001, 'T2_TEST_DO_NOT_USE_REAL activity', 1791119024, 1791122624, 1, 991002, 1791119024);

-- 4) activity_occurrences
INSERT INTO activity_occurrences (id, public_id, activity_id, start_time, end_time, status, created_at) VALUES (991005, 'E4PMSX5M26DF1J5Z1ANR6BC7SR', 991004, 1791119024, 1791122624, 1, 1791119024);

-- 5) activity_signups (recipient signs up)
INSERT INTO activity_signups (id, activity_id, user_id, status, created_at) VALUES (991006, 991004, 991003, 1, 1791119024);

-- 6) activity_participations (status=1 assigned)
INSERT INTO activity_participations (id, public_id, signup_id, occurrence_id, status, created_at) VALUES (991007, '8D1ZKXZEEN4VNMPZ2B7XEV68N2', 991006, 991005, 1, 1791119024);

-- 7) attendance_sessions (participation_id populated, status=2 checked-out, no anomaly)
INSERT INTO attendance_sessions (id, signup_id, activity_id, user_id, team_id, status, participation_id, created_at) VALUES (991008, 991006, 991004, 991003, 991001, 2, 991007, 1791119024);

-- 8) certificate_templates (layout NOT NULL)
INSERT INTO certificate_templates (id, name, cert_type, layout, status, created_by, created_at, public_id) VALUES (991009, 'T2_TEST_DO_NOT_USE_REAL template', 'activity', '{}', 1, 991002, 1791119024, 'G2NZ2WM2Q3MWFQF90ZRK363H0V');

-- 9) user_roles (admin -> team_admin @ TEST team)
INSERT INTO user_roles (user_id, role_id, scope_team_id, granted_at) VALUES (991002, (SELECT id FROM roles WHERE code='team_admin'), 991001, 1791119024);

-- 10) sessions (TEST admin auth context; token_hash only)
INSERT INTO sessions (id, public_id, user_id, token_hash, expires_at, status, created_at) VALUES (991010, 'YR2P3V7M62J5FDD5HMKDSXRS0Q', 991002, 'bb63302e3cf0810f1d45cee08144c31ebbc8d202309630b0dd0216e66e2c456a', 1793711024, 1, 1791119024);
