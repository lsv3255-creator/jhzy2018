# P11-WP5 Production Cutover Runbook

> **STATUS: PLAN FROZEN BY CG-1 — NOT EXECUTED**
> Frozen by STEP CG-1 (local source preparation + read-only remote verification).
> No production mutation, no secret mutation, no deploy, no push occurred in CG-1.
> `PRODUCTION_CUTOVER_AUTHORIZED = NO`

| Field | Value |
|---|---|
| Gate | CG-1 — Final Production Cutover Go/No-Go Freeze |
| Mode | LOCAL SOURCE PREPARATION + READ ONLY REMOTE VERIFICATION |
| Authoritative workspace | `/Users/Shared/projects/jhzy-v2` |
| Branch | `master` |
| Starting HEAD | `2b5188306017b0f2cb3cc46018ac1226bf5ad338` |
| Cutover HEAD (authorized deploy source) | the CG-1 commit `chore(cutover): freeze production cutover package` — hash recorded in the CG-1 report `/tmp/b4/cg1_final_go_nogo.json` and workspace memory |
| Frozen (UTC) | 2026-10-02T17:00Z |

---

## 1. Frozen inputs (verified in CG-1 §A)

| Input | Expected | Verified |
|---|---|---|
| B1–B6 | CLOSED | ✅ CLOSED |
| CG-0 | accepted | ✅ accepted |
| Production D1 | `jhzy-v2-prod` / `d372229f-c0ae-4dcc-b968-4ec7c2832842` | ✅ |
| Forbidden default DB | `jhzy-v2-db` / `ea603f43-d076-4df5-b118-3d8a0c245439` | ✅ excluded |
| Staging D1 | `jhzy-v2-staging` / `85853fb1-1384-486e-9be3-566f72f45c5d` | ✅ reference only |
| Migration version | staging 0044 / production 0044 | ✅ |
| B6 snapshot SHA256 | `47469eb56e9f801d6e7accf10e863664169ce84f7607a9ba0fe4cd480e40ee2b` | ✅ |
| B6 manifest SHA256 | `1fc2338c41dcd1cd6ccc0739bfd27902a89e0fd36316bbf00e4de6594348500b` | ✅ |
| Canonical fingerprint | `8539522165fd` | ✅ recomputed in-memory in CG-1 |

> Secret value: **never printed, never written to disk, never committed.**

---

## 2. Exact target resources

| Resource | Name | UUID / version |
|---|---|---|
| Production D1 (write target from P4) | `jhzy-v2-prod` | `d372229f-c0ae-4dcc-b968-4ec7c2832842` |
| Staging D1 (reference only) | `jhzy-v2-staging` | `85853fb1-1384-486e-9be3-566f72f45c5d` |
| Production Worker | `jhzy-v2-worker-production` | live pre-cutover version `45282c30-0e80-4234-818f-96c25585999a` @ `2026-09-29T17:19:14Z` |

---

## 3. ⚠️ FORBIDDEN DEFAULT DB — read before every command

`workers/wrangler.jsonc` declares a **top-level / default** `d1_databases` binding to:

```
jhzy-v2-db
ea603f43-d076-4df5-b118-3d8a0c245439     <-- FORBIDDEN
```

**Any `wrangler d1 …` command issued WITHOUT an explicit `--env` resolves to this default binding.**

1. Every production D1 command MUST carry `--env production` (or pass the explicit UUID).
2. Never rely on the default/top-level D1 binding.
3. Re-verify target by name **and** UUID before each write.

---

## 4. ⚠️ Worker name resolution trap (`--name` + `--env`)

CG-1 empirically discovered: wrangler appends the environment as a suffix to the Worker name.

| Invocation | Resolved Worker name | Result |
|---|---|---|
| `wrangler <cmd> --env production` | `jhzy-v2-worker-production` | ✅ correct |
| `wrangler <cmd> --env production --name jhzy-v2-worker-production` | `jhzy-v2-worker-production-production` | ❌ **not found** |

Evidence: `npx wrangler secret list --env production --name jhzy-v2-worker-production` →
`Worker "jhzy-v2-worker-production-production" (env: production) not found.`

**Rule: for all production Worker secret/deploy commands use `--env production` and NEVER combine it with `--name`.**

---

## 5. Canonical write set (frozen in CG-1 §D)

### 5.1 Source and hashes

| Phase | File | SHA256 |
|---|---|---|
| 01 | `01_add_legacy_id_maps.sql` | `503a3164508a31c955ff14710cf7aa69845a22c72763e570ec1673d27a9e5489` |
| 02 | `02_insert_users.sql` | `2001ce0fd07ae26776507ab51175d5fc7472d2258969d58e45a5dd41192d6a81` |
| 03 | `03_insert_user_identities.sql` | `a2332120d5fdcde32cf72914a86d7d85f84bf087655174f514b03c6ab4bb44cd` |
| 04 | `04_insert_volunteer_profiles.sql` | `f8c06906062852bcbd9b6b8705d6bad2dea752d68b3e9031c911419222a6b667` |
| 05 | `05_insert_user_profiles.sql` | `e42739bb31a3a345f2511e265cea8747767c803ecf159995d4cc93fdb4540fcb` |
| 06 | `06_insert_points_accounts.sql` | `8f32c177dd934bb3f4079228b8f27d1b970914c8e0d78cd14e3fed4ea34309bb` |
| 07 | `07_remap_fk.sql` | `2eacb1c0da842274b7a41ec2ddeed1947a74b7fd128cc1fce47650262e190529` |
| 09 | `09_merge_converged_b2_3c.sql` | `5c1579bdeb9de056081032b98d1088b8ff894cb528eb8a1f6b244fe3b26377df` |
| 08 | `08_delete_old_person.sql` | `094e290b1104ad75b7e753eaf06cea5f3c629ca3cd43012bbd54e7a51d765846` |

All nine hashes are byte-identical to the B2-3C frozen manifest — **no drift**.

### 5.2 Execution order (exact)

```
01_add_legacy_id_maps.sql
02_insert_users.sql
03_insert_user_identities.sql
04_insert_volunteer_profiles.sql
05_insert_user_profiles.sql
06_insert_points_accounts.sql
07_remap_fk.sql
09_merge_converged_b2_3c.sql       <-- BEFORE 08
08_delete_old_person.sql           <-- LAST
```

> `09` MUST precede `08`: the merge remaps child rows to canonical ids; `08` then removes old person rows. Inverting them orphans children.

**Forbidden (D1-incompatible):** `09_merge_converged.sql`, `09_merge_converged_b2_3a1.sql` — contain `CREATE TEMP TABLE`, rejected by Cloudflare D1 with `SQLITE_AUTH`.

### 5.3 Offline B6 re-simulation (CG-1 §D) — PASS

Executed against a **fresh local restore** of the B6 production snapshot (zero remote writes):

| Postcondition | Expected | Simulated |
|---|---|---|
| `users` | 631 | 631 ✅ |
| person users (excl. 1676) | 630 | 630 ✅ |
| system user `1676` | 1 | 1 ✅ |
| `user_identities` | 1300 | 1300 ✅ |
| `wechat_openid` / `phone` / `username` | 622 / 623 / 55 | 622 / 623 / 55 ✅ |
| `volunteer_profiles` | 622 | 622 ✅ |
| `user_profiles` | 622 | 622 ✅ |
| `points_accounts` | 622 | 622 ✅ |
| `legacy_id_maps` | 4561 | 4561 ✅ |
| `team_members` | 630 | 630 ✅ |
| `activity_signups` | 370 | 370 ✅ |
| `course_enrollments` | 518 | 518 ✅ |
| `certificates` | 413 | 413 ✅ |
| `attendance_sessions` | 240 | 240 ✅ |
| `learning_records` | 2030 | 2030 ✅ |
| old person users | 0 | 0 ✅ |
| old person references | 0 | 0 ✅ |
| FK violations | 0 | 0 ✅ |
| unique violations (`team_members` dup groups) | 0 | 0 ✅ |
| `d1_migrations` / `0044` count | 44 / 1 | 44 / 1 ✅ |

`OFFLINE_B6_SIMULATION = PASS`

### 5.4 Frozen merge semantics

- `team_members`: 47 `EXACT_BUSINESS_DUPLICATE` groups → collapse, survivor `MIN(id)`, 47 rows removed (677 → 630).
- `activity_signups` / `course_enrollments` / `certificates` / `attendance_sessions`: 0 collisions → `user_id` remap ONLY, **no deletion**.
- System user `1676`: **PRESERVE, DO NOT REMAP.**

---

## 6. Source gates (CG-1 §C) — all PASS

| Gate | Command | Result |
|---|---|---|
| TypeScript typecheck | `npx tsc --noEmit` | **PASS** (exit 0, 0 errors) |
| Test compile | `npx tsc -p tsconfig.test.json` | **PASS** (exit 0) |
| STEP 3.11 crypto contract | `node /tmp/jhzy_test_build/migration/etl/step3_11_crypto_contract.test.js` | **PASS** (`STEP 3.11 CRYPTO CONTRACT TEST PASSED`; AES-256-GCM round-trip, HMAC-SHA256 stability, PII masking, id_card HMAC all OK) |
| F8-2B id mapping | `node /tmp/jhzy_test_build/migration/id-mapping-engine.test.js` | **PASS** (`DEDICATED_PASS_COUNT=70 / FAIL=0`, `P11-F8-2B DEDICATED TEST GATE: PASS`) |
| F8-4 ETL | `node /tmp/jhzy_test_build/migration/etl/self-test.js` | **PASS** (`ETL SELF TEST PASSED`, 30/30 incl. rollback convergence) |
| Worker build | `npx wrangler deploy --env production --dry-run --outdir …` | **PASS** (875.71 KiB / gzip 201.62 KiB) |

Build output **after** the config change (§7) confirms the final production binding set:

```
env.DB (jhzy-v2-prod)                    D1 Database
env.FILES (jhzy20-files)                 R2 Bucket
env.ENVIRONMENT ("production")           Environment Variable
env.WECHAT_APPID ("wxfd0c72ef78144686")  Environment Variable
env.ADMIN_ALLOWED_ORIGINS (...)          Environment Variable
```

`IDENTITY_HMAC_KEY_PREVIOUS` **no longer appears**. Before the change it did appear — a direct before/after proof.

---

## 7. Frozen wrangler config change (CG-1 §B)

**Target state: `IDENTITY_HMAC_KEY_PREVIOUS` = ABSENT in the final production runtime config.**

Change applied (CG-1, local only, not deployed):

| Scope | Before | After |
|---|---|---|
| top-level `vars` | `ENVIRONMENT`, `IDENTITY_HMAC_KEY_PREVIOUS` | `ENVIRONMENT` |
| `env.production.vars` | `ENVIRONMENT`, `IDENTITY_HMAC_KEY_PREVIOUS`, `WECHAT_APPID`, `ADMIN_ALLOWED_ORIGINS` | `ENVIRONMENT`, `WECHAT_APPID`, `ADMIN_ALLOWED_ORIGINS` |

Both scopes were edited. Rationale: wrangler merges top-level `vars` with environment `vars`; removing the key only from `env.production` risks it being re-inherited from the top-level block. Removing both guarantees absence regardless of merge semantics.

**Explicitly NOT altered:** production D1 binding, staging D1 binding, Worker service identity, `DELIVERY_IDENTITY_ENC_KEY`, `WECHAT_APP_SECRET`, R2 binding, routes, compatibility settings, `WECHAT_APPID`, `ADMIN_ALLOWED_ORIGINS`, `ENVIRONMENT`.

Verified: JSONC parses; `env.production` D1 = `jhzy-v2-prod` / `d372229f…`; `env.staging` D1 = `jhzy-v2-staging` / `85853fb1…`; `IDENTITY_HMAC_KEY_PREVIOUS` absent from the parsed config; structural diff equals "backup minus those two lines" exactly.

### 7.1 PREVIOUS is NOT a Worker Secret

`npx wrangler secret list --env production` (names only) returns:

```
DELIVERY_IDENTITY_ENC_KEY
IDENTITY_HMAC_KEY
WECHAT_APP_SECRET
```

No `IDENTITY_HMAC_KEY_PREVIOUS`. Therefore **no `wrangler secret delete` is required** — the var removal + deploy is sufficient.

Runtime role (from source): `IDENTITY_HMAC_KEY_PREVIOUS` is consumed **only** as the secondary fallback in `getIdentityKeys()`; empty/absent ⇒ `secondary = null`. It is **not** used by `PiiCrypto`, so removal cannot orphan canonical data.

---

## 8. Cloudflare version semantics (CG-1 §F) — established

### 8.1 `wrangler deploy --env production`

Creates a new Worker version **from the local workspace source** and deploys it immediately. This is the only step that packages local code.

### 8.2 `wrangler secret put IDENTITY_HMAC_KEY --env production`

| Question | Answer | Evidence |
|---|---|---|
| Does it create a new Worker version? | **YES** — "creates a new version of the Worker and deploys it immediately" | Cloudflare docs (workers/runtime-apis/bindings/secrets, wrangler/commands/workers) |
| Does it retain code/config from the currently deployed version? | **YES** — it is a server-side secret write against the existing script; no code is re-uploaded | wrangler 4.143.0 source: handler does `PUT /accounts/{accountId}/workers/scripts/{scriptName}/secrets` with `{name, text, type:"secret_text"}` |
| Could it accidentally repackage the local workspace? | **NO** — `SECRET_PUT_REPACKAGES_LOCAL_SOURCE = NO`. The handler never builds or uploads a bundle; it reads the value from stdin (`readFromStdin()` / prompt) and applies `trimTrailingWhitespace` | wrangler 4.143.0 `wrangler-dist/cli.js` |
| Local workspace still required? | Yes — only to resolve the Worker name and env (or use `--name`, but see §4) | same |

**Consequence for ordering:** because the new version inherits the **currently deployed** bundle, the config change removing `PREVIOUS` **must be deployed before** the secret switch. If the secret were switched first, the server-generated version would still carry the old config containing `PREVIOUS`.

Alternative not used: `wrangler versions secret put` creates a version **without** promoting it (for gradual deployments). Not used here — the frozen plan promotes explicitly at P7.

### 8.3 How to prove the active runtime contains the intended code/config after secret put

1. **Before P7:** record active version id via `GET /accounts/{acc}/workers/scripts/jhzy-v2-worker-production/versions` — pre-cutover `45282c30-0e80-4234-818f-96c25585999a`.
2. **After P7:** newest version id changes to `V_deploy`; `created_on` updates. This version was built from the audited cutover source (§6 gates all PASS).
3. **After P8:** newest version id changes again to `V_secret`. Because §8.2 proves secret put does not upload code, `V_secret` inherits `V_deploy`'s bundle — same code, new secret.
4. `wrangler secret list --env production` → `IDENTITY_HMAC_KEY` present, `IDENTITY_HMAC_KEY_PREVIOUS` absent.
5. `wrangler deploy --env production --dry-run` → binding table shows no `IDENTITY_HMAC_KEY_PREVIOUS`, and `env.DB (jhzy-v2-prod)` unchanged (config-level proof).

---

## 9. Final cutover order (CG-1 §G)

```
P0  preflight / source & workspace freeze verification         read-only      BEFORE
P1  maintenance boundary ON (record window; sessions=0)        meta           BEFORE
P2  fresh production drift check vs B6 baseline                read-only      BEFORE
P3  conditional fresh snapshot — ONLY if P2 reports drift      backup         BEFORE
P4  PRODUCTION DATA IMPORT (write set §5.2, in order)          WRITE          BEFORE
P5  post-import data reconciliation                            read-only      BEFORE
P6  config edit: remove IDENTITY_HMAC_KEY_PREVIOUS             source edit    BEFORE  (done in CG-1)
P7  Worker deploy --env production                             DEPLOY         BEFORE
P8  SECRET SWITCH: IDENTITY_HMAC_KEY <- canonical anchor       SECRET         <<< IRREVERSIBLE BOUNDARY
P9  secret inventory verify by NAME ONLY                       read-only      AFTER
P10 runtime crypto verification                                read-only      AFTER
P11 full production reconciliation                             read-only      AFTER
P12 maintenance boundary OFF                                   meta           AFTER
```

**LAST_REVERSIBLE_POINT = P7 completion** (immediately before P8).

**IRREVERSIBLE_CRYPTO_BOUNDARY = P8** — the single `wrangler secret put IDENTITY_HMAC_KEY --env production` invocation.

Traffic never observes a mismatched state because P1 opens the maintenance window before any mutation and P12 closes it only after P11 passes. The two prohibited pairings:

| Prohibited pairing | Prevented by |
|---|---|
| OLD DATA + NEW KEY | P4 installs canonical data before P8; between P4 and P8 the runtime still holds the OLD key, but no traffic is served (P1) |
| NEW DATA + incompatible runtime | P7 deploys the audited runtime before P8; P10 verifies crypto interoperability before P12 |

### 9.1 Per-step failure handling

| Step | Failure handling |
|---|---|
| P0–P3 | STOP, re-baseline. No mutation. |
| P4 partial write | **B6 snapshot data rollback** — re-import data-only from `b6_prod_precutover_20261002T160949Z.sql` |
| P5 mismatch | B6 snapshot rollback |
| P6 config error | `git checkout -- workers/wrangler.jsonc` |
| P7 deploy failure | Redeploy from cutover HEAD, or roll back to `45282c30-…`. Data untouched, secret untouched. |
| **P8+** | **FORWARD RECOVERY ONLY** — see §10 |

---

## 10. Abort / recovery rules

```
OLD_PRIMARY_SECRET_ROLLBACK = IMPOSSIBLE
POST_BOUNDARY_RECOVERY = FORWARD_ONLY
```

**BEFORE_SECRET_SWITCH (P0–P7):** B6-snapshot data rollback + git source revert + redeploy of `45282c30-…`. All reversible.

**AFTER_SECRET_SWITCH (P8–P12):** the old production primary is not recoverable (B4-G bounded audit found no off-platform copy; Cloudflare secrets cannot be read back). Repairs proceed forward only:

| Failure | Forward repair |
|---|---|
| P9 shows PREVIOUS still bound | Re-deploy from cutover HEAD. **Never** revert the primary. |
| P10 identity lookup fails | Canonical dataset is anchor-keyed → re-import. **Never** revert the key. |
| P10 PiiCrypto fails | Canonical `*_enc` are anchor-derived → re-import. `PiiCrypto` has no previous-key fallback, so key reversion is not a remedy even if it were possible. |
| P11 reconciliation mismatch | Re-run the failing write-set phase forward. |
| P12 traffic issue | Keep maintenance ON; continue forward repair. |

**Required resting state after P8:** `IDENTITY_HMAC_KEY` = canonical anchor (`8539522165fd`); production data = canonical dataset derived from that anchor; `IDENTITY_HMAC_KEY_PREVIOUS` = ABSENT; runtime code = audited cutover source.

---

## 11. Secret handling rules

### 11.1 Absolute rules

Never print / echo / log / report a secret value. Never write one to disk. Never commit one. No secret value appears in this runbook or any CG artifact.

### 11.2 Injection mechanism (design — NOT executed)

Value path: **Keychain → stdout pipe → wrangler stdin → Cloudflare API over TLS.** Never touches disk.

```
set +o history

security find-generic-password -s jhzy-v2-identity-key -a IDENTITY_HMAC_KEY -w \
  | tr -d '\n' \
  | npx wrangler secret put IDENTITY_HMAC_KEY --env production

set -o history
```

Controls:

- No shell variable, no CLI argument containing plaintext, no temp file, no stdout/stderr/log/report capture.
- **No `--name` flag** — see §4 (would resolve to `…-production-production`).
- Non-TTY stdin ⇒ wrangler uses `readFromStdin()`; wrangler additionally applies `trimTrailingWhitespace`, so a trailing newline cannot corrupt the HMAC key (`tr -d '\n'` is belt-and-braces).
- `set +o history` keeps the invocation out of shell history (the command itself contains no value).

### 11.3 Fingerprint verification (before any real switch)

Recompute **in memory**, never displaying the value:

```
security find-generic-password -s jhzy-v2-identity-key -a IDENTITY_HMAC_KEY -w \
  | tr -d '\n' | shasum -a 256 | cut -c1-12
```

Must equal `8539522165fd`. **Verified in CG-1 §A — MATCH.**

### 11.4 Structural proof chain (no value, no PII)

1. Canonical `identity_hash` values were generated under the **staging** anchor.
2. That anchor is the same Keychain item (`jhzy-v2-identity-key` / `IDENTITY_HMAC_KEY`), fingerprint `8539522165fd` — the only JHZY entry that exists (B4-G).
3. The production secret is loaded from that identical item.
4. Therefore runtime `HMAC-SHA256(IDENTITY_HMAC_KEY, identifier)` reproduces the canonical hashes.
5. Empirically: post-import production `identity_hash` values are byte-identical to the B2 canonical dataset, so a successful lookup under the new key closes the chain.

No health/debug endpoint exists in `workers/src`; verification is by **name-only inventory + fingerprint + structural chain + functional dry-run**, never by reading the value back.

---

## 12. Expected logical postconditions

| # | Postcondition | Expected |
|---|---|---|
| 1 | `users` | 631 |
| 2 | canonical person users | 630 |
| 3 | system user `1676` | 1 (preserved, not remapped) |
| 4 | `user_identities` | 1300 |
| 5–7 | `wechat_openid` / `phone` / `username` | 622 / 623 / 55 |
| 8–10 | `volunteer_profiles` / `user_profiles` / `points_accounts` | 622 / 622 / 622 |
| 11 | `legacy_id_maps` | 4561 |
| 12 | `team_members` | 630 |
| 13–17 | `activity_signups` / `course_enrollments` / `certificates` / `attendance_sessions` / `learning_records` | 370 / 518 / 413 / 240 / 2030 |
| 18–19 | old person users / references | 0 / 0 |
| 20–21 | FK / unique violations | 0 / 0 |
| 22 | migration version | 0044, present exactly once |
| 23 | identity lookup under canonical anchor | PASS |
| 24 | PiiCrypto encrypt/decrypt interoperability | PASS |
| 25 | `IDENTITY_HMAC_KEY_PREVIOUS` in final runtime config | **ABSENT** |

---

## 13. Final remote drift check (CG-1 §J) — NO DRIFT

Read-only production check immediately before the Go/No-Go declaration:

| Check | Expected | Actual |
|---|---|---|
| `users` | 677 | 677 ✅ |
| `user_identities` | 1299 | 1299 ✅ |
| `volunteer_profiles` | 676 | 676 ✅ |
| identity distribution | 622 / 623 / 54 | 622 / 623 / 54 ✅ |
| runtime PiiCrypto envelope rows | 0 | 0 ✅ |
| `id_card_hash` non-null | 0 | 0 ✅ |
| `users.last_login_at` non-null | 0 | 0 ✅ |
| `sessions` | 0 | 0 ✅ |
| `d1_migrations` | 44 | 44 ✅ |
| `0044` count / applied_at | 1 / `2026-09-29 17:28:55` | 1 / `2026-09-29 17:28:55` ✅ |

`PRODUCTION_DRIFT_SINCE_B6 = NO`

---

## 14. Production verification checklist

```
[ ] Target verified by name AND uuid: jhzy-v2-prod / d372229f-c0ae-4dcc-b968-4ec7c2832842
[ ] No command issued without --env (default DB jhzy-v2-db / ea603f43 never touched)
[ ] No command combined --env production with --name
[ ] d1_migrations = 44 ; 0044 occurrences = 1 ; applied_at = 2026-09-29 17:28:55
[ ] users = 631 ; canonical persons = 630 ; users.id=1676 present = 1
[ ] user_identities = 1300 ; 622 / 623 / 55
[ ] volunteer_profiles 622 ; user_profiles 622 ; points_accounts 622
[ ] legacy_id_maps = 4561 ; team_members = 630
[ ] activity_signups 370 ; course_enrollments 518 ; certificates 413
[ ] attendance_sessions 240 ; learning_records 2030
[ ] old person users 0 ; old person references 0
[ ] foreign_key_check 0 ; unique violations 0
[ ] active Worker version recorded before P7 / after P7 / after P8
[ ] secret list (names only): IDENTITY_HMAC_KEY present
[ ] secret list (names only): IDENTITY_HMAC_KEY_PREVIOUS absent
[ ] binding table (dry-run) shows no IDENTITY_HMAC_KEY_PREVIOUS
[ ] identity lookup under canonical anchor = PASS
[ ] PiiCrypto encrypt/decrypt interoperability = PASS
[ ] sessions = 0 before window ; no orphaned login state created
```

---

## 15. Final Go / No-Go checklist (for controlled cutover execution)

```
[x] Workspace / branch / starting HEAD = 2b5188306017b0f2cb3cc46018ac1226bf5ad338
[x] 0044 SHA256 = cb0e5572cc30cb020bd89625054e9fd77beaf42b808abe1fa0529a4b7de0e80d
[x] Write set = B2-3C ; nine hashes byte-identical ; offline B6 re-simulation PASS
[x] B6 rollback artifact present, snapshot + manifest SHA256 verified
[x] typecheck / STEP 3.11 / F8-2B / F8-4 / build — all PASS
[x] Config change frozen (PREVIOUS removed from both scopes) ; build proves it
[x] PREVIOUS confirmed NOT a Worker Secret (secret list names only)
[x] Cloudflare version semantics established (§8)
[x] Production drift since B6 = NO
[ ] Maintenance window declared and recorded
[ ] Operator explicitly accepts that the primary secret switch is IRREVERSIBLE
[ ] Fingerprint re-verified immediately before P8 = 8539522165fd
[ ] Separate explicit authorization for: data import / deploy / secret switch
[ ] Rollback (data) path rehearsed and available
[ ] Forward-recovery path understood and accepted
```

> Unchecked items are execution-time gates. **No production mutation has been authorized.**

---

## 16. Mutation authorization boundaries

| Action | CG-1 | Cutover execution |
|---|---|---|
| Read production D1 | performed (read-only) | authorized |
| Write production D1 | **NOT performed** | requires explicit GO |
| Apply any migration | **NOT performed** | forbidden (0044 already converged) |
| Edit `workers/wrangler.jsonc` | **performed (local)** — PREVIOUS removal only | frozen; included in cutover commit |
| Deploy Worker | **NOT performed** (dry-run build only) | requires explicit GO (P7) |
| Mutate any secret | **NOT performed** | requires explicit GO (P8) |
| `git commit` | performed (cutover package only) | — |
| `git push` | **NOT performed** | forbidden |

---

*End of runbook. Contains no secret values and no PII.*
