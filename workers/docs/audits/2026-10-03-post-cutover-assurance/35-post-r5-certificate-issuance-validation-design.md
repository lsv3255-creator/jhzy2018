# 35 — POST-R5 Certificate Issuance Validation Design

Audit package: `workers/docs/audits/2026-10-03-post-cutover-assurance/`
Series: CERT-R5B (PASS_WITH_FINDINGS) → POST-R5-MONITORING-P1 (PASS) → POST-R5-P2 (this doc)
Authoritative HEAD at start: `1f0ceb3c441509190881764ed6f1bde0a6c16c91`
Scope: **design only** — source audit + read-only D1 check + validation plan. **No certificate issued.**

---

## 1. P2 Goal & Prohibitions

**Goal**: design how to validate that post-R5 certificate issuance (against the migrated legacy
`id_pools`) behaves correctly — selector returns only allocatable (`legacy_migrated` / `v2_native`)
rows, never `v2_synthetic_compat`, never NULL, never `status=1/2`.

**This task is read-only + design.** Hard prohibitions (all honored):

| Prohibited | Occurred? |
|---|---|
| call any production issuance endpoint | **NO** |
| INSERT `certificates` | **NO** |
| UPDATE `id_pools` | **NO** |
| modify `certificate_logs` | **NO** |
| batch issuance | **NO** |
| create test certificate | **NO** |
| touch JHZY 1.0 live | **NO** |
| deploy Worker | **NO** |
| mutate secret | **NO** |
| push | **NO** |
| use API token | **NO** (OAuth `--profile jhzy` only, `env -u CLOUDFLARE_API_TOKEN`) |
| unrelated fixes | **NO** |

All D1 queries in §3 carried `changed_db: false`, `rows_written: 0`.

---

## 2. Source Audit (authoritative repo `workers/src`, absolute paths)

### 2.1 Issuance implementation inventory

| File | Role | Mounted? | Writes `certificates`? |
|---|---|---|---|
| `services/certificate-issuance-service.ts` | CERT-R3B **shared issuance core** (`issue()` / `previewEligibility()`) | **NO** — defined, zero `new CertificateIssuanceService(` call sites in `workers/src` | via `issueBatch` (un-wired) |
| `repository/certificate-issuance.ts` | issuance D1 primitives (`peekPoolCode`, `buildPoolConsumeStatement`, `issueBatch`) | NO (repo of un-wired service) | YES (but un-called) |
| `services/certificate-number-allocator.ts` | `PoolCertificateNumberAllocator` (`allocate` / `buildConsumption`) | NO | NO (builds statements only) |
| `repository/exam.ts` | `submitAndMaybeIssueAtomically` — **exam→training auto-issue** | **YES** (via `routes/exams.ts`) | YES (live path) |
| `routes/certificates.ts` | `GET /mine`, `/verify`, `/admin/templates`, `/admin`, `/:id` | YES (read-side only) | NO POST issue |
| `routes/exams.ts` | `POST /sessions/:id/submit` | YES | triggers exam.ts issue |

### 2.2 Audit answers (the 8 required questions)

1. **Does a runtime issuance POST route exist?**
   - **Training: YES** — `POST /api/v2/exams/sessions/:sessionPublicId/submit`
     (`routes/exams.ts:61` → `exam-service.submit` → `exam.ts:237 submitAndMaybeIssueAtomically`)
     auto-issues a `cert_trn` certificate on exam pass.
   - **Generic / activity / service: NO** mounted POST issuance route. `CertificateIssuanceService`
     (the CERT-R3B core meant for activity/service) is **defined but never instantiated or routed**.

2. **Admin batch issuance route?** — **NO.** `/certificates/admin/*` only manages **templates**
   (`GET/POST/PUT /admin/templates`). No batch-issuance endpoint exists anywhere.

3. **training/activity/service auto-issuance entry?**
   - **training: YES** (exam submit, mounted & live).
   - **activity: NO** mounted auto-issuance (CertificateIssuanceService un-wired).
   - **service: NO** mounted auto-issuance.

4. **Defined-but-unmounted service?** — **YES.** `CertificateIssuanceService` + its allocator and
   `previewEligibility()` are implemented (fail-closed: requires injected `EligibilityPolicy` +
   `RecipientGuard`, else throws at construction) but have **no route or caller** in `workers/src`.

5. **Selector provenance whitelist explicit = `legacy_migrated` / `v2_native`?**
   - **YES.** `domain/certificate.ts:298-300`:
     `ALLOCATABLE_PROVENANCES = ['legacy_migrated', 'v2_native']` (frozen).
   - `allocatableProvenanceSql()` emits `provenance IN ('legacy_migrated','v2_native')`.
   - **Both** the mounted exam path (`exam.ts:631,676,700,726`) and the un-wired core
     (`certificate-issuance.ts:77,120`) use this **same** predicate → selection/consume consistency.

6. **`v2_synthetic_compat` explicitly excluded?** — **YES.** `SYNTHETIC_COMPAT_PROVENANCE`
   (`domain/certificate.ts:304`) is defined separately and is **not** in `ALLOCATABLE_PROVENANCES`
   → never a candidate. The 500 synthetic rows are deliberately non-allocatable.

7. **NULL provenance excluded?** — **YES.** `IN (...)` list predicate never matches NULL
   (fail-closed for unknown future literals too).

8. **`status=1/2` excluded?** — **YES.** Every select/consume uses `status = 0`
   (`exam.ts:630,675,699`; `certificate-issuance.ts:77,119`).

### 2.3 Key risk / gap

The **post-R5 concern is activity/service issuance against the migrated legacy pool**, but the
CERT-R3B `CertificateIssuanceService` that would serve it is **not mounted**. The only live
issuance path is the **training exam** path (consumes `cert_trn`). So:
- The migrated legacy `cert_trn` pool (180,000 legacy + 500 synthetic) is consumable *today* only
  through the exam path, which is selector-safe (whitelist).
- activity/service issuance cannot be validated in production until `CertificateIssuanceService`
  is **feature-wired** (route + injected `EligibilityPolicy` + `RecipientGuard`).

---

## 3. Read-only D1 Re-confirmation (production, no write)

Re-ran the P1 checks to confirm no drift since R5B import:

| Metric | Observed | R5B baseline | Stable? |
|---|---|---|---|
| `certificates_count` | `413` | `413` | ✅ |
| `id_pools` status 0 / 1 / 2 | `448812` / `1661` / `27` | same | ✅ |
| `available_legacy_total` (`status=0 AND provenance IN ('legacy_migrated','v2_native')`) | `448312` | `448312` | ✅ |
| `synthetic_raw_status0` (`v2_synthetic_compat`, raw `status=0`) | `500` | `500` | ✅ (non-allocatable) |
| `null_prov_status0` | `0` | `0` | ✅ |
| `non_free_legacy` (`status IN (1,2)`) | `1688` | `1688` | ✅ |

➡️ Production state is **unchanged** since R5B. The 500 synthetic `cert_trn` rows remain
`status=0` but are excluded by the selector whitelist, exactly as designed.

---

## 4. Issuance Validation Plan — Three Options (ranked)

### Option A — No-write validation (RECOMMENDED, do first)
- **What**: pure source audit (done above) + `allocatableProvenanceSql()` unit/SQL assertion +
  **local simulation** against a local `node:sqlite` seeded from the offline archive
  (450,000 rows, `parseSqlDateTime` Asia/Shanghai policy) feeding the same `peekPoolCode` SQL.
- **Proves**: selector returns `legacy_migrated`/`v2_native` only; never `v2_synthetic_compat`,
  never NULL, never `status=1/2`.
- **Cost**: zero production touch, zero risk. Reuses existing R3D/R3B/R4/R5A test suites.
- **Limitation**: does not exercise the *live* Worker HTTP path. Acceptable because the SQL
  predicate is the single source of truth for allocation and is already proven identical in both
  code paths.

### Option B — Staging issuance validation
- **What**: provision/use a **staging** D1 (`jhzy-v2` staging, not `jhzy-v2-prod`), seed a small
  fixture (few `legacy_migrated` + a few `v2_synthetic_compat` + a NULL-provenance row), mount the
  issuance route in staging, perform a real (staging) issuance, then assert the issued cert's
  `cert_no` came from a `legacy_migrated` row.
- **Proves**: the *end-to-end* allocate→consume→insert works and the whitelist holds under the
  real D1 engine, without polluting production.
- **Cost**: requires staging env + fixture; does not touch prod.
- **Limitation**: needs a staging Worker deployment (separate from prod), still a feature-wiring
  step for the activity/service service.

### Option C — Production controlled issuance (ONLY after explicit user authorization)
- **Prereq**: a real, compliant, already-existing business event — e.g. a real volunteer **passing
  a real training exam** (the mounted `POST /exams/.../submit` path). This is the only live
  issuance entry and it already consumes `cert_trn` from the migrated pool.
- **Must satisfy ALL**:
  - no fabricated training/service/activity records; no fabricated service hours; no fabricated points;
  - use a **real** issuable subject (real `user_id`, real passed exam, real `exam_paper_id`);
  - pre-record: certificate type, `source_type`, `issue_source`, `source_id`, `user_id`;
  - reconcile before/after (`certificates_count`, `id_pools` `cert_trn` `status=0` delta,
    `legacy_migrated` consumed count);
  - failure must be explainable; **no batch** (single issuance only).
- **Limitation**: only covers `cert_trn` (training). activity/service still require Option B wiring
  before any C-style validation.

**Recommendation**: execute **A now** (cheap, zero-risk, proves selector safety for the migrated
pool). Then **B** (staging) as the gating step before any production issuance feature is enabled.
**C** only on explicit authorization and only via the live exam path (or post-wiring for
activity/service).

---

## 5. Issuance Entry Status Summary

```
PRODUCTION_ISSUANCE_ROUTE =
  training : YES  (POST /api/v2/exams/sessions/:id/submit -> exam.ts, live, selector-safe)
  activity : NO   (CertificateIssuanceService un-wired)
  service  : NO   (CertificateIssuanceService un-wired)
  admin-batch : NO

SELECTOR_SAFETY = PASS
  whitelist = provenance IN ('legacy_migrated','v2_native') AND status = 0
  v2_synthetic_compat = EXCLUDED
  NULL provenance       = EXCLUDED (fail-closed)
  status 1/2            = EXCLUDED
  (identical predicate in exam.ts AND certificate-issuance.ts)

RECOMMENDED_VALIDATION_OPTION = A (no-write) then B (staging)

PRODUCTION_ISSUANCE_VALIDATION_EXECUTABLE =
  NO for the R5-target activity/service path
  (CertificateIssuanceService not mounted -> no callable prod activity/service issuance entry;
   must feature-wire first, not force-issue).
  NOTE: a live training issuance entry (exam) EXISTS and is selector-safe; it validates only
  cert_trn and is itself a viable controlled-production face for Option C.
```

---

## 6. Next Action (requires user authorization)

- **Now (no auth needed)**: Option A — local simulation + `allocatableProvenanceSql` assertion
  (already substantially covered by R3D/R3B/R4/R5A suites). This doc is the design record.
- **To validate activity/service issuance in production**: user must authorize **feature wiring**
  of `CertificateIssuanceService` (add a route + inject `EligibilityPolicy` + `RecipientGuard`),
  then run Option B (staging), then optionally Option C (controlled, real event only).
- **Do NOT** force-issue certificates to "test" the pool — the live exam path is the only
  legitimate production issuance surface, and it must be driven by a real exam pass.

```
SECRET_PII_SCAN = PASS
PRODUCTION_D1_MUTATED = NO
CERTIFICATE_ISSUED = NO
PRODUCTION_WORKER_DEPLOYED = NO
SECRET_MUTATED = NO
JHZY_1_0_LIVE_TOUCHED = NO
GIT_PUSH_PERFORMED = NO
```
