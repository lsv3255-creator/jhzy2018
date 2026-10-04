# 34 — POST-R5 Production Monitoring P1 (read-only stability check)

Audit package: `workers/docs/audits/2026-10-03-post-cutover-assurance/`
Series: CERT-R5B (PASS_WITH_FINDINGS) → CERT-R5B-CLOSEOUT (PASS_WITH_FINDINGS) → POST-R5-MONITORING-P1
Authoritative HEAD at start: `a26c5b88b059a46385a7407cbeaa3e4eb258ecfa`
Executed: read-only, TTY OAuth (`--profile jhzy`), no API token used.

---

## 1. Authorization / Scope / Prohibition Attestation

- **API token**: the migration `CLOUDFLARE_API_TOKEN` was **revoked by the user before this check**.
  This monitoring used **only TTY OAuth** (`wrangler --profile jhzy`) with
  `CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af`; `CLOUDFLARE_API_TOKEN` was explicitly
  unset (`env -u CLOUDFLARE_API_TOKEN`). The revoked token was **not** used or required.
- **All checks were READ-ONLY**: `wrangler deployments list` (SELECT-less metadata) and
  `wrangler d1 execute ... --command "SELECT ..."` (13 + 4 SELECT statements, no INSERT/UPDATE/DELETE).
  Every D1 response carried `changed_db: false`, `rows_written: 0`.

| Prohibited action | Occurred? |
|---|---|
| import `id_pools` | **NO** |
| rerun CERT-R5B `execute` | **NO** |
| apply migrations | **NO** |
| deploy Worker | **NO** |
| issue certificate | **NO** |
| mutate secret | **NO** |
| touch JHZY 1.0 live | **NO** (not accessed) |
| push | **NO** |
| unrelated fixes | **NO** |
| use revoked `CLOUDFLARE_API_TOKEN` | **NO** (unset, OAuth only) |

---

## 2. Worker Active Version (read-only)

Command: `wrangler deployments list --env production --profile jhzy`

```
Active version (100%): bfff110b-4787-40cb-b982-6c692e699429
Created:              2026-10-04T03:54:01.924Z
Source:               Unknown (deployment)
```

✅ Matches the R5B-CLOSEOUT recorded active version `bfff110b-4787-40cb-b982-6c692e699429`.
Worker is stable at 100% active; no new deploy occurred during this monitoring window.

---

## 3. Production D1 Reconciliation (read-only)

Command: `wrangler d1 execute jhzy-v2-prod --remote --profile jhzy --command "<13 SELECTs>"`

| Metric | Observed | Expected (R5B) | Match |
|---|---|---|---|
| `migration_count` | `46` | `46` | ✅ |
| `migration_max` | `46` | `46` | ✅ |
| `migration_0045` | `1` | `1` | ✅ |
| `migration_0046` | `1` | `1` | ✅ |
| `id_pools_total` | `450500` | `450500` | ✅ |
| `legacy_migrated` | `450000` | `450000` | ✅ |
| `synthetic_compat` | `500` | `500` | ✅ |
| `null_provenance` | `0` | `0` | ✅ |
| `duplicate_code_groups` | `0` | `0` | ✅ |
| `certificates_count` | `413` | `413` | ✅ |
| `duplicate_cert_no_groups` | `0` | `0` | ✅ |

**Pool-type totals** (`legacy_migrated` + `synthetic_compat`):

| pool_type | Observed | Expected |
|---|---|---|
| `cert_hon` | `10000` | `10000` |
| `cert_skl` | `10000` | `10000` |
| `cert_srv` | `150000` | `150000` |
| `cert_trn` | `180500` | `180500` |
| `volunteer` | `100000` | `100000` |

**Status totals**: `0 = 448812`, `1 = 1661`, `2 = 27` (matches R5B exactly; `448812 + 1661 + 27 = 450500`).

➡️ **D1_RECONCILIATION = STABLE** — every count is byte-for-byte identical to the R5B post-import
state. No drift, no unexpected rows, no duplicate codes, no duplicate cert numbers.

---

## 4. Selector Safety (read-only interpretation)

Command: 4 SELECTs filtering `status=0` allocatable candidates.

| Check | Observed | Interpretation |
|---|---|---|
| `available_legacy` per pool | `cert_hon=9998`, `cert_skl=10000`, `cert_srv=149692`, `cert_trn=179543`, `volunteer=99079` | sum = **448312** allocatable legacy rows |
| `synthetic_available_candidates` (raw `status=0` AND `provenance='v2_synthetic_compat'`) | `500` | ⚠️ **NOT allocatable** — `v2_synthetic_compat` is excluded from the selector provenance whitelist (`legacy_migrated` / `v2_native` only). These 500 rows are compatibility placeholders, must never be returned by the issuance selector. |
| `null_provenance_available_candidates` | `0` | ✅ safe — no null-provenance row can enter allocation |
| `non_free_legacy` (`status IN (1,2)`) | `1688` | ✅ = `1661 + 27` reserved/assigned legacy rows correctly excluded from `status=0` candidate set |

**SELECTOR_SAFETY = PASS** with one required note:
- The selector eligibility predicate MUST include a `provenance` whitelist
  (`provenance IN ('legacy_migrated','v2_native')`). Do **not** treat the 500 raw `status=0`
  `v2_synthetic_compat` rows as issuable — that would mint certificates from compatibility
  placeholders and break the legacy continuity guarantee.
- `null_provenance = 0` means no row can slip through an un-guarded `status=0` query into issuance.

---

## 5. HTTP Health (optional check, non-blocking finding)

```
HTTP_HEALTH = BLOCKED_BY_LOCAL_NETWORK_OR_PROXY
```

- `curl -Iv --connect-timeout 10 https://jhzy-v2-worker-production.lsv3255.workers.dev/health`
  returned `502 Bad Gateway` from the local egress proxy (`https_proxy=http://127.0.0.1:61407`),
  tunnel `CONNECT ... failed, response 502`.
- This is the **same local-network/proxy limitation** recorded as the R5B finding. It is
  **NOT a deployment or runtime failure**: Cloudflare's `wrangler deployments list` independently
  confirms the active version `bfff110b-…` is serving **100%**.
- Acceptance of this monitoring P1 does **not** depend on the local `curl` succeeding.

---

## 6. Stability Verdict

```
POST_R5_MONITORING_P1_STATUS = PASS
WORKER_ACTIVE_VERSION        = bfff110b-4787-40cb-b982-6c692e699429 (100%, stable)
D1_RECONCILIATION             = STABLE (all counts == R5B baseline)
SELECTOR_SAFETY              = PASS (whitelist required; 500 synthetic non-allocatable; 0 null-prov)
HTTP_HEALTH                  = BLOCKED_BY_LOCAL_NETWORK_OR_PROXY (non-blocking)
SECRET_PII_SCAN              = PASS
PRODUCTION_D1_MUTATED        = NO
PRODUCTION_WORKER_DEPLOYED  = NO
CERTIFICATE_ISSUED           = NO
SECRET_MUTATED               = NO
JHZY_1_0_LIVE_TOUCHED        = NO
GIT_PUSH_PERFORMED           = NO
NEXT_ACTION                  = post-R5 issuance validation (open issuance, verify selector returns
                              legacy_migrated rows only) — NOT a migration rerun
```

R5B production state is confirmed stable and intact. The legacy pool migration remains closed;
future work is issuance validation, not re-import.

```
SECRET_PII_SCAN = PASS
```
