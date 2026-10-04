-- POST-R5-T1 Step 5: create 2.0 TEST data (sentinel id space 990001+).
-- Discipline: TEST ONLY. All ids 990001..990009 are non-production sentinels.
-- Marker present on text columns: users.nickname, teams.name, activities.title,
-- certificate_templates.name. FK-linked rows (signup/participation/attendance)
-- inherit the TEST scope via the sentinel activity/team/user.
-- Read the values JSON (54-t1-values.json) for the generated ULIDs.

INSERT INTO users (id, public_id, nickname, cert_level, status, created_at)
  VALUES (990001, 'ZZVDTWK1AXYKBF8RPHAGW2ZZA2', 'T1_TEST_DO_NOT_USE_REAL', 1, 1, 1791116136);

INSERT INTO teams (id, public_id, name, owner_user_id, status, is_system, created_at)
  VALUES (990002, 'HC37MNTA21CJTCH5FHHEPCNPZ7', 'T1_TEST_DO_NOT_USE_REAL_team', 990001, 1, 0, 1791116136);

INSERT INTO activities (id, public_id, team_id, title, start_time, end_time, created_by, status, created_at)
  VALUES (990003, 'G92NH9A4VX5WATWAFZABQBJ1VH', 990002, 'T1_TEST_DO_NOT_USE_REAL activity', 1791108936, 1791112536, 990001, 1, 1791116136);

INSERT INTO activity_occurrences (id, public_id, activity_id, start_time, end_time, status, created_at)
  VALUES (990004, 'AQ5NXG7YTGVW0JYYAAK683WS80', 990003, 1791108936, 1791112536, 1, 1791116136);

INSERT INTO activity_signups (id, activity_id, user_id, status, created_at)
  VALUES (990005, 990003, 990001, 1, 1791116136);

INSERT INTO activity_participations (id, public_id, signup_id, occurrence_id, status, created_at)
  VALUES (990006, 'VZ9X5S5JZ2CXXH6FS4PGM4KTP2', 990005, 990004, 1, 1791116136);

INSERT INTO attendance_sessions (id, signup_id, activity_id, user_id, team_id, participation_id, status, checkin_at, checkout_at, created_at)
  VALUES (990007, 990005, 990003, 990001, 990002, 990006, 2, 1791108936, 1791112536, 1791116136);

INSERT INTO certificate_templates (id, name, cert_type, layout, status, created_at)
  VALUES (990008, 'T1_TEST_DO_NOT_USE_REAL_template', 'activity', '{}', 1, 1791116136);
