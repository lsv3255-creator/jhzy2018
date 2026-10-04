# 33 — CERT-R5B Production Legacy Pool Import Closeout

Audit package: `workers/docs/audits/2026-10-03-post-cutover-assurance/`
Series: CERT-R5 → CERT-R5A (wiring) → CERT-R5B (production import + deploy)
Authoritative execution HEAD: `16a80cea5af143197c106101c0d1e25261d29d16` (R5B-RUNBOOK-FREEZE)
Closeout author: WorkBuddy (Agent mode, local, read-only docs only)

> This document records the **production execution result** reported by the human operator
> after they ran the frozen §13 checklist in the authorized maintenance window. No production
> action was taken by this closeout commit — it is documentation only.

---

## 1. Authorization & Maintenance-Window Override

- **Authorizing operator**: human administrator (product/design lead for JHZY 2.0).
- **Explicit authorization phrase** received: `执行 CERT-R5B 生产 legacy id_pools 续迁移`
  (maintenance window `2026-10-05 02:00–04:00 CST`).
- **Scope override** (per authorization): only the 450,000 legacy `id_pools` import,
  reconciliation, hash/selector checks, production Worker deploy + acceptance on `jhzy-v2-prod`;
  **do NOT re-apply 0045/0046**, do NOT touch JHZY 1.0 live, do NOT perform unrelated fixes.
- **Execution path**: operator ran the §13 template **in their own TTY** (OAuth reused for
  read-only probe; `CLOUDFLARE_API_TOKEN` exported for the real `execute` write via D1 REST adapter).
- This closeout doc was written **after** the window, with the operator-supplied results; it
  performs no production mutation of its own.

---

## 2. Pre-Import Production State (baseline, as frozen in §13.1)

| Metric | Value |
|---|---|
| migrations applied | `46` |
| migration `0045` count | `1` |
| migration `0046` count | `1` |
| `id_pools` total | `500` |
| `legacy_migrated` count | `0` |
| `v2_synthetic_compat` count | `500` |
| `certificates` count | `413` |

R5B deliberately did **NOT** re-apply `0045`/`0046` (idempotency guard in runner would
reject, and the operator was instructed not to). The `provenance` column already existed
from `0046`.

---

## 3. Environment Proof & API Token Handling

- **ENVIRONMENT_PROOF** = `PASS` (final readiness probe, see §6).
- The D1 read-only readiness probe (`cert-r5b-prod-readiness-probe.mjs`) was run with
  `--profile jhzy` — TTY OAuth, zero write.
- The real `execute` write used `createRemoteD1Adapter`, which **requires** `CLOUDFLARE_API_TOKEN`
  (OAuth cannot satisfy non-interactive REST auth). Token was supplied **only via environment
  variable**:

  ```bash
  export CLOUDFLARE_API_TOKEN=<D1 edit token scoped to jhzy-v2-prod>
  export CLOUDFLARE_ACCOUNT_ID=8770e4917f904aed5df91c883cf058af
  ```

- **Token value is NEVER recorded in any document, log, or commit.** Only the env-var name and
  the scope description appear in this package.
- **Post-closeout action**: the operator MUST revoke / delete the `CLOUDFLARE_API_TOKEN` used for
  this window once acceptance is confirmed (it is a short-lived migration credential, not a
  standing secret).

---

## 4. Execute Command Class (token redacted)

The command class executed (per §13.3), shown without any token value:

```bash
cd /Users/Shared/projects/jhzy-v2/workers

# read-only proof (OAuth, TTY)
node scripts/cert-r5b-prod-readiness-probe.mjs --profile jhzy

# 450k import (D1 REST adapter; needs CLOUDFLARE_API_TOKEN in env, not shown)
node scripts/cert-r5-protected-legacy-pool-import-runner.mjs --mode execute \
  --db-mode remote \
  --confirm-production-d1 d372229f-c0ae-4dcc-b968-4ec7c2832842 \
  --confirm-account 8770e4917f904aed5df91c883cf058af \
  --confirm-source-sha d51563b0e3149535eb66ff64a3d447a5ad9dfa1cdf26f00b680b4824c4d688bf \
  --confirm-maintenance-window CERTIFICATE_ISSUANCE_CLOSED \
  --confirm-i-understand-production-write

# post-import proof (OAuth, TTY)
node scripts/cert-r5b-prod-readiness-probe.mjs --profile jhzy

# worker deploy
npm run deploy:production
```

The runner's four-fold guard (target UUID / source SHA / precondition / explicit `--confirm-*`
flags) was satisfied; no re-application of `0045`/`0046` occurred.

---

## 5. Import Result

```
EXECUTE_OK
inserted       = 450000
alreadyPresent = 0
conflicts      = 0
batches        = 90
```

- `inserted = 450000` matches the offline archive source row count exactly.
- `alreadyPresent = 0` / `conflicts = 0` confirms no duplicate or colliding `code` rows.
- `batches = 90` is the runner's chunked commit size (450000 / 90 = 5000 per batch).

---

## 6. Post-Import Production Readiness Probe (ENVIRONMENT_PROOF = PASS)

| Probe field | Value |
|---|---|
| `PROD_STATE_OK` | `true` |
| `MIGRATION_0045` | `1` |
| `MIGRATION_0046` | `1` |
| `HAS_PROVENANCE_COLUMN` | `true` |
| `ID_POOLS_SYNTHETIC_COMPAT` | `500` |
| `ID_POOLS_LEGACY_MIGRATED` | `450000` |
| `ID_POOLS_NULL_PROVENANCE` | `0` |
| `DUPLICATE_CODE_GROUPS` | `0` |
| `ENVIRONMENT_PROOF` | `PASS` |

---

## 7. Detailed D1 Reconciliation

| Metric | Value |
|---|---|
| `id_pools` total | `450500` |
| `legacy_migrated` | `450000` |
| `synthetic_compat` | `500` |
| `null_provenance` | `0` |
| `duplicate_code_groups` | `0` |

**Pool-type totals** (`legacy_migrated` + `synthetic_compat`):

| pool_type | total |
|---|---|
| `cert_hon` | `10000` |
| `cert_skl` | `10000` |
| `cert_srv` | `150000` |
| `cert_trn` | `180500` |
| `volunteer` | `100000` |

(Expected source: `cert_trn=180000` legacy + `500` synthetic, `cert_srv=150000`,
`cert_hon=10000`, `cert_skl=10000`, `volunteer=100000`; the `cert_trn=180500` reflects the
`500` synthetic-compat rows landing in the training pool, consistent with `synthetic_compat=500`.)

**Status totals**:

| status | count | meaning |
|---|---|---|
| `0` | `448812` | available (free for issuance) |
| `1` | `1661` | assigned |
| `2` | `27` | reserved |

- `certificates` count remains `413` (pre-existing production certs; issuance was closed during
  the window and not reopened — no new certs were minted by this migration).

---

## 8. Worker Deploy Output Summary

| Field | Value |
|---|---|
| Worker | `jhzy-v2-worker-production` |
| Version ID | `bfff110b-4787-40cb-b982-6c692e699429` |
| Active Percent | `100%` |
| D1 Binding | `jhzy-v2-prod` |
| R2 Binding | `jhzy20-files` |

The production Worker was successfully deployed and is serving 100% of traffic with the
migrated `id_pools` data bound.

---

## 9. Finding — HTTP_HEALTH (non-blocking)

```
HTTP_HEALTH = BLOCKED_BY_LOCAL_NETWORK_OR_PROXY
```

- A `curl` to the `*.workers.dev` `/health` endpoint failed **from the local operator network**
  (proxy / firewall intercepts non-Cloudflare hosts).
- This is **NOT a blocker for R5B**: Cloudflare's deployment list independently confirms the
  active version is `bfff110b-…` at `100%`, and the D1 readiness probe (`ENVIRONMENT_PROOF=PASS`)
  confirms data + binding integrity from the authoritative source.
- **Documented here so it is not mistaken for a deploy failure.** Acceptance is based on the
  Cloudflare deployment record + D1 probe, not the local `curl`.

---

## 10. Interpretation — PRECONDITION=NOT_READY_FOR_IMPORT After Import

After the successful import, re-running the runner's `validatePreconditions` returns
`NOT_READY_FOR_IMPORT`. **This is expected and healthy**, not a regression:

- The guard `LEGACY_MIGRATED_NOT_ZERO_BEFORE_IMPORT` trips because `legacy_migrated = 450000`
  (> 0). Its sole purpose is to **prevent a duplicate / accidental re-import**.
- Therefore the post-import state is the correct terminal state. Do **NOT** re-run the import
  to "clear" this precondition — doing so would attempt to insert 450,000 rows that are already
  present (and the guard now correctly blocks it).

---

## 11. Prohibitions — Post-Execution Attestation

| Prohibited action | Occurred during R5B / this closeout? |
|---|---|
| rerun import | **NO** (guard prevents; operator instructed not to) |
| touch production D1 (beyond the authorized import) | import was authorized; no other D1 write |
| deploy Worker again | **NO** (single deploy, `bfff110b…`, 100%) |
| apply migrations (0045/0046) | **NO** |
| touch JHZY 1.0 live (`/www/wwwroot/api.jhzyfw.com`) | **NO** |
| push | **NO** |
| write / expose Cloudflare API Token | **NO** (env-only, value never recorded) |
| unrelated fixes | **NO** |

### Mutation ledger (this closeout commit scope)

| Resource | State in this closeout |
|---|---|
| production D1 `id_pools` | **MUTATED = YES** — but only by the authorized window import (450k rows), not by this doc |
| production Worker | **DEPLOYED = YES** — by the authorized window deploy (`bfff110b…`) |
| production Secret | **MUTATED = NO** (no secret put/delete/change) |
| production certificate issued | **NO** (issuance stayed closed; `certificates=413` unchanged) |
| JHZY 1.0 live | **TOUCHED = NO** |
| git push | **PERFORMED = NO** |

---

## 12. Next Action

```
CERT_R5B_CLOSEOUT_STATUS = PASS_WITH_FINDINGS
NEXT_ACTION = post-R5 monitoring + certificate issuance validation (NOT migration rerun)
```

- Future work is **post-R5 monitoring** (pool exhaustion, duplicate-code watch, selector
  behaviour under load) and **certificate issuance validation** (verify legacy `id_pools`
  allocate correctly when issuance reopens).
- The legacy pool migration itself is **complete and closed**; re-running it is prohibited.
- Revoke/delete the migration `CLOUDFLARE_API_TOKEN` now that acceptance is recorded.

```
SECRET_PII_SCAN = PASS
```
