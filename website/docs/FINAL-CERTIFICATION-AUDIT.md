# Vanta Labs — Final Production Certification Audit

**Status:** IN PROGRESS — Phase 0 complete, Phase 1 in progress
**Branch:** `claude/audit-superpowers-playwright-extension-c2oyhm`
**Baseline commit:** `9aea901` (merge of PR #109)
**Started:** 2026-08-25

This is the durable ledger for the final certification audit. It exists so a
fresh session can resume without repeating work or losing evidence. Update it as
each phase completes.

**Do not commit to this file:** screenshots, Playwright artefacts, secrets,
customer PII, or raw sensitive production data. Emails in this document are
masked; aggregate counts only.

---

## Evidence grades

Every claim below carries one of these. Do not upgrade a grade without new evidence.

| Grade | Means |
|---|---|
| `PRODUCTION-PROVEN` | Observed against live production |
| `PREVIEW-PROVEN` | Observed against a Vercel preview deployment |
| `BROWSER-PROVEN` | Reproduced in a real browser via Playwright |
| `DATABASE-PROVEN` | Confirmed by querying the live database |
| `BEHAVIORAL-TEST-PROVEN` | A test that exercises behaviour (and can fail) passes |
| `SOURCE-INSPECTED` | Read the code; no runtime evidence |
| `INFERRED` | Reasoned, not observed |
| `NOT VERIFIED` | Open |

---

## Phase 0 — Tooling & environment certification — COMPLETE

| System | Status | Evidence |
|---|---|---|
| Superpowers | READY | `Skill(superpowers:verification-before-completion)` invoked, full body returned. v6.3.0, 14 skills at `/root/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/` |
| Playwright MCP | READY | Full round trip: navigate → snapshot → evaluate → click → console → resize 390x844 → close. `HeadlessChrome/141.0.0.0`. `@playwright/mcp@0.0.79` |
| Claude in Chrome | **NOT AVAILABLE** | Two ToolSearch sweeps returned zero browser-extension tools; `ListConnectors` shows 11 connectors, none Chrome. Session runs in an isolated cloud container with no channel to a local extension. Audit proceeds on Playwright. |
| Repository | READY | `brendenhuntzinger1/vanta-labs`, branch as above, HEAD `9aea901`, PR #109 config verified by diff |
| Supabase | READY | `list_projects` → `mlpimwgkwuqpsvsrlpqv` ACTIVE_HEALTHY, PG 17.6.1; `list_tables` → 68 public tables, RLS enabled on all |
| Vercel | READY | Team `brendenhuntzinger1s-projects` (Pro); project `vanta-labs`; production deployment READY on `9aea901` |
| Sentry | READY | Org `vanta-innovation-llc`, project `vanta-labs`; 1 unresolved issue retrieved |
| GitHub | READY | `get_me` → `brendenhuntzinger1` |

### Baseline evidence (commit `9aea901`)

| Check | Result |
|---|---|
| `npm run test` (vitest) | **201 files / 3566 tests, all passing**, 27.8s, exit 0 |
| `npx tsc --noEmit` | exit 0, no errors |
| `npm run build` | exit 0, builds clean (Next.js 16.2.10, Turbopack) |
| `npm run dev` | Boots in ~0.5s, `GET / → 200` |
| Playwright → local dev | Reaches `http://127.0.0.1:3000`, title `Vanta Labs \| Premium Research Peptides`, age gate renders |
| Working tree | Clean |
| Vercel production | READY, serving `9aea901` — **production and audit baseline are the same commit** |

**Note on dev console errors:** local dev logs 6 `webpack-hmr` WebSocket
failures. These are a sandbox artefact of the container, **not an application
defect**. Do not report them as findings.

**A green suite is not certification.** 3566 passing tests coexisted with every
historical defect in the audit brief. Test *quality* is audited in Phase 15.

---

## Phase 1 — System map — COMPLETE

**Full map: [`PHASE1-SYSTEM-MAP.md`](./PHASE1-SYSTEM-MAP.md)** — ten subsystems,
their real data flows, sources of truth, state machines, and **159 recorded
risks (20 P0 · 53 P1 · 68 P2 · 18 P3)**.

Everything in that file is `SOURCE-INSPECTED` — hypotheses from reading code,
**none reproduced**. It is a prioritised work queue, not a defect register. Each
entry carries a `prove:` line naming the specific test that would confirm or
refute it. Findings only move into this ledger's register once reproduced.

Three leads there bear directly on the historical defects in the brief:

- **`createPartnerInvite` (partner-portal.ts:1370) is still the non-atomic
  two-insert pattern that produced BRUTUS.** F-009 fixed the *self-service*
  application path; the *admin invite* path was not covered by that repair and
  still writes `partners` then `ambassadors` as separate statements. This is the
  highest-priority thing to reproduce next.
- **`resolveReferralCode` (used by `/r/[code]`) resolves a wider set of codes
  than checkout honours** — it falls back to `partners` and to aliases, while
  checkout validates against `ambassadors` only. A partners-only code would set
  the cookie and record a click, then be silently dropped at checkout. That is
  the same *shape* as the historical "$100 minimum" defect: attribution and
  checkout disagreeing about what is valid.
- **`fetchAuthoritativeRates` returns an empty map on ANY error**, silently
  reverting every displayed rate to the `partners` copy — a silent fallback on a
  money-adjacent display.

**Good news on historical defect #2:** the mapper reports `minimum_qualifying_order`
**is** now enforced on both paths and at both layers — `quoteOrder` throws below
it, `ensureCommissionRecord` re-checks with the pre-discount subtotal, and the
cart suppresses the referral candidate client-side. Still to be behaviourally
confirmed, but the structural repair is present.



### Scale

| Surface | Count |
|---|---|
| API routes (`route.ts`) | 143 |
| Pages (`page.tsx`) | 68 |
| Lib modules (`src/lib/*.ts`) | 393 |
| Test files | 201 (3566 tests) |
| TS/TSX files | 742 |
| SQL files | 116 |

### Stack

- **Framework:** Next.js 16.2.10 (App Router, Turbopack), React 19.2.4
- **Database:** Supabase (Postgres 17.6.1), 68 public tables, RLS on all
- **Payments:** Basis Theory (tokenisation) + "Veyra" (processor)
- **Email:** nodemailer
- **Observability:** Sentry (`@sentry/nextjs`), Vercel Analytics
- **Domain:** `vantalabsresearch.com`
- **Cron:** exactly one — `/api/cron/sweep`, every 30 min (`*/30 * * * *`)

### Architectural observations (Phase 1, `SOURCE-INSPECTED` / `DATABASE-PROVEN`)

**A1 — No versioned migration system.** `DATABASE-PROVEN` + `SOURCE-INSPECTED`.
There is no `supabase/migrations/` directory. Instead 116 ad-hoc `.sql` files sit
in `website/src/lib/sql/` (plus loose scripts in `website/scratchpad/`, e.g.
`FIX-AMBASSADOR-STATUS.sql`). Nothing orders them, records which were applied, or
proves repo schema matches production schema. This is the "production schema as
undocumented configuration" risk in the audit brief. Phase 5 must diff repo SQL
against live schema.

**A2 — `partners` and `ambassadors` are schema-identical twins.** `DATABASE-PROVEN`.
Both tables carry the **same 24 columns**. `payouts` and `partner_payouts` are
likewise identical (differing only in `partner_id` vs `ambassador_id`). This is
the structural cause of the historical Brutus/Paul and Elijah defects. The data
is currently converged (see F-002), but the duplication remains.

**A3 — `orders.state` is the US state, not an order state.** Values are `FL`,
`ID`, null — a shipping-address field. The real order state machine is
`payment_status` + `fulfillment_status`. Anyone auditing this must not confuse
them.

---

## Phase 2 — Production data integrity — PARTIAL (read-only)

All queries below were read-only aggregates. No production state was mutated.

### F-001 — 31 of 36 storefront products have parent stock 0 while doses are stocked
**Grade:** `DATABASE-PROVEN` · **Severity:** P1 (pending browser proof) · **Status:** OPEN

46 products total; 38 published; **36 storefront-eligible** (`is_published AND
is_enabled AND NOT is_archived`). Of those 36:

- **31 have `products.inventory_quantity = 0` while their enabled doses hold stock.**
- 0 have stocked parent but zero doses.
- 0 have all doses at zero.

The historical "Selank parent 0 / dose 15" case is not an outlier — it is the
**normal shape of 86% of the catalog**. The entire storefront therefore depends on
stock being resolved at the dose (sellable-unit) level. Any code path that reads
the parent's `inventory_quantity` would show 31 of 36 products falsely out of
stock.

*Next:* Phase 5 must (a) find every stock-resolution path, (b) browser-prove a
parent-zero/dose-stocked product renders In Stock and is purchasable.

*Blocked:* (b) cannot be done in this session — see E-001. Note also that the
parent rows carry `stock_status = 'In Stock'` **as text** while
`inventory_quantity = 0`, so display may key off the text column rather than the
quantity. If so, F-001 may be a non-defect at display level while hiding the
inverse risk: a product showing In Stock when every dose is actually zero. Both
readings remain unproven.

### F-002 — Partner/ambassador tables currently converged
**Grade:** `DATABASE-PROVEN` · **Severity:** informational · **Status:** PASS (data)

7 partners, 7 ambassadors, joined on email: all 7 match 1:1, **same `id`**, same
`referral_code`, same `status`, same `commission_percent`, same
`customer_discount_percent`, both with `auth_user_id`. No orphans, no duplicate
identities.

- **Brutus/Paul:** "Paul huntzinger" holds code `BRUTUS`, present in both tables,
  same id, `approved`. Historical consolidation **held**.
- **Elijah:** `info_requested` in **both** tables. Historical drift
  (partners=`info_requested` / ambassadors=`approved`) is **resolved in data**.

*Caveat:* this proves the *data* is converged today. It does **not** prove the
*prevention* works. Phase 6 must behaviourally test the pre-added-ambassador →
signup → apply convergence path, and prove Elijah's `info_requested` code is
actually inert for referral and commission.

### F-003 — NULL `customer_discount_percent` is an intentional sentinel, not missing data
**Grade:** `SOURCE-INSPECTED` + `DATABASE-PROVEN` · **Severity:** none · **Status:** NOT A DEFECT

4 of 7 ambassadors (`ELOA`, `FLAVIAROSSETTI`, `BRUTUS`, `ZAIN`) have NULL
`customer_discount_percent`. This initially looked like the precondition of the
15%-shown-as-10% bug. It is not: NULL means **inherit the program default** by
design. `admin-partners-client.tsx:925` renders `?? programDefaultDiscountPercent`
with a literal "(default)" label, and `admin/partners/[partnerId]/page.tsx:108`
prints "(program default)" vs "(override)".

`MIZZY` and `SMOKE` carry explicit `15.00`; `ELIJAH` `10.00`.

Recorded so a later reviewer does not re-raise it as a defect.

### F-004 — Historical bug #1 repair is structurally present (not yet browser-proven)
**Grade:** `SOURCE-INSPECTED` · **Status:** RECERTIFICATION PENDING

`src/lib/ambassador-discount.ts:22` `resolveAmbassadorCustomerDiscount(override,
programDefault)` handles null, empty-string (explicitly, to avoid `Number("") === 0`),
non-finite, and out-of-range, each falling back to the program default.

The cart calls **that same function** at `cart-context.tsx:574` and `:1090`, with
a comment naming the original defect. So the frontend no longer hardcodes 10.

**Still unproven:** that `validate_referral_code` actually returns
`customer_discount_percent`, and that a real browser shows 15% for a 15%
ambassador. Requires `BROWSER-PROVEN` evidence in Phase 6.

### F-005 — RESOLVED: the alert was right, my first reading was wrong
**Grade:** `DATABASE-PROVEN` + `SOURCE-INSPECTED` · **Severity:** none · **Status:** NOT A DEFECT

Sentry `VANTA-LABS-2` (first seen 2026-08-25, ~41 min before observation):
> `express_reconcile_backlog: 1 express order(s) have been pending at the processor for over 24h — typically an abandoned 3DS challenge. They hold inventory and will never settle on their own`

Live data (15 orders total):

| payment_status | n |
|---|---|
| paid | 6 |
| canceled | 5 |
| pending_payment | 4 |

The 4 `pending_payment` orders are **20.5h, 25.4h, 384.4h (16 days), and 531.1h
(22 days)** old — i.e. **three** exceed 24h, not one. All four have
`checkout_channel = NULL`, yet the alert describes them as "express". Meanwhile
`express_checkout_intents` has exactly 1 `open` row, created ~50 min ago — under
24h.

I first compared the alert's count against **all** pending orders and concluded
it disagreed. It does not. `src/lib/express-reconcile.ts:95` selects candidates
as:

```
payment_status = 'pending_payment'  AND  payment_id IS NOT NULL  AND  created_at < cutoff
```

and `stale` counts those older than `RECONCILE_STALE_MS` (24h). Against the live
rows:

| order | pending | payment_id | age | in candidate set | stale |
|---|---|---|---|---|---|
| VL-9D8CA974 | yes | yes | 20.5h | yes | no (<24h) |
| VL-0716175A | yes | yes | 25.4h | yes | **yes** |
| VL-DCA0FAD5 | yes | **no** | 384h | no | no |
| VL-64F8EDE4 | yes | **no** | 531h | no | no |

`stale = 1`, exactly what the alert reported. Having a `payment_id` means a
processor session was actually created, which is the only population worth
chasing — an order that never reached the processor has nothing to reconcile.
The wording "express order(s)" is slightly loose (it means "orders with a live
processor session"), but the count is correct and the alert is doing its job.

Recorded in full because the wrong version of this finding was in the ledger
first, and a later reviewer should not resurrect it.

### F-006 — Zero COAs exist, but the storefront advertises COA documentation
**Grade:** `DATABASE-PROVEN` · **Severity:** P1 (provisional) · **Status:** OPEN

- `coa_records` table: **0 rows**.
- Of 36 storefront-eligible products: **36 have no `coa_url` on the parent AND no
  `coa_url` on any dose** — i.e. **no product has a COA anywhere**.

Yet the age gate advertises "COA Documented" (`BROWSER-PROVEN`, observed in the
Phase 0 snapshot), and the app ships a `/coa-library` page plus
`/api/coa/[coaId]/file` and `/api/admin/coa/**` routes.

Per the audit brief, a marketing claim is not certified merely because the text
exists. Either COAs live somewhere not yet found (a storage bucket not modelled
in these tables), or the claim is currently unsubstantiated.

*Next:* Phase 5 must find what `/coa-library` actually renders and where COA
files come from before this is graded.

### F-007 — Affiliate marketing figures are a deliberate pre-launch floor
**Grade:** `DATABASE-PROVEN` + `SOURCE-INSPECTED` · **Severity:** P3 — owner decision, not a defect · **Status:** FOR YOUR REVIEW

`partner_program_stats` holds display figures:

| key | value |
|---|---|
| `total_commissions_paid_base` | 22,638.00 |
| `average_partner_earnings_base` | 1,918.00 |
| `top_partner_payout_base` | 4,829.00 |
| `average_approval_time_hours_base` | 24.00 |

Meanwhile `commissions` = **0 rows**, `payouts` = **0 rows**,
`partner_payouts` = **0 rows**, `referral_orders` = **0 rows**.

`src/lib/partner-portal.ts:657` documents this explicitly: the baseline is
"set once, e.g. before launch, to avoid showing a discouraging '$0 everything'
to prospective partners" and is a **floor that real activity builds on**, not a
static override:

```
totalCommissionsPaid     = baseline + real total
averagePartnerEarnings   = baseline + real average
topPartnerPayout         = MAX(baseline, real top)
averageApprovalTimeHours = real average once ANY real approval exists
```

So it is intentional, documented, and does not hide real growth. **Not a code
defect.**

It is still a claims question only you can answer: with `commissions`,
`payouts`, `partner_payouts` and `referral_orders` all at **0 rows**, the
recruitment page currently tells prospective ambassadors the program has paid
out **$22,638** and that partners average **$1,918**, when the real figures are
zero. That is a business decision about seeded numbers, not a bug, and it is
flagged here rather than "fixed" because changing it is your call.

### F-012 — Orders that never reached the processor are never retired
**Grade:** `DATABASE-PROVEN` · **Severity:** P3 · **Status:** OPEN

The express reconciler only considers orders with a `payment_id` (F-005). Two
production orders — **384h (16 days)** and **531h (22 days)** old — sit in
`pending_payment` with **no** `payment_id`, so nothing will ever move them. They
are invisible to the reconciler and to the stale alert.

Impact is limited: `inventory_reservations` currently holds **0 active** rows,
so they are not holding stock. But they inflate any "pending orders" figure an
operator looks at, indefinitely. Worth a cleanup path that retires orders which
never reached the processor after some age.

### F-008 — Order-status drift on one canceled order
**Grade:** `DATABASE-PROVEN` · **Severity:** P3 · **Status:** OPEN

`VL-EB6E0751` is `payment_status = canceled` but `fulfillment_status = pending`,
while the other four canceled orders carry `fulfillment_status = cancelled`.
One order also has a **NULL `order_number`**, and the 5 oldest orders have no
`idempotency_key` (added later). Small dataset, but it shows the two status
columns can diverge.

### F-009 — Pre-added ambassador cannot ever apply: identity still matched by `auth_user_id` only
**Grade:** `DATABASE-PROVEN` (constraints + live RPC body) + `SOURCE-INSPECTED` (app layer); failure mode `INFERRED` pending reproduction
**Severity:** P1 (provisional) · **Status:** OPEN — highest-priority recertification target

This is the Brutus/Paul defect. The **atomicity half was fixed; the convergence
half was not.**

Live RPC body (`create_partner_application`, `DATABASE-PROVEN`):

```sql
select id, status, referral_code into existing
from public.partners
where auth_user_id = p_auth_user_id   -- <-- still auth_user_id ONLY
```

App layer (`src/lib/partner-portal.ts:442`, `SOURCE-INSPECTED`):

```ts
.from("partners").select("id, status, referral_code")
.eq("auth_user_id", input.authUserId)   // <-- also auth_user_id ONLY
```

**Neither layer matches on email.** And the constraints are asymmetric
(`DATABASE-PROVEN`):

| Table | Unique constraints |
|---|---|
| `ambassadors` | `id` (PK), **`email`**, `referral_code` |
| `partners` | `id` (PK), `auth_user_id`, `referral_code` — **no unique email** |

Predicted sequence for "admin pre-adds ambassador → same person signs up → applies":

1. App layer finds no `partners` row for the new `auth_user_id` → proceeds.
2. RPC finds no `partners` row for that `auth_user_id` → proceeds to insert.
3. `INSERT INTO partners` **succeeds** (no unique email constraint there).
4. `INSERT INTO ambassadors` **violates `ambassadors_email_key`**.
5. Both inserts are in one plpgsql body = one transaction → **whole thing rolls back**.
6. `assertNoSupabaseError` throws → `/api/partner/apply` returns 400.

**What the fix did achieve:** no more orphan `partners` row with a dead referral
code. The code comment names BRUTUS and this exact state. That half is real.

**What remains:** the applicant is *permanently blocked*. Every retry fails
identically (rate-limited to 3/hour). The admin sees no application. The person
is stuck behind an opaque error.

**Current exposure:** all 7 ambassadors have `auth_user_id` set, so this is
**not firing today**. It is latent, and fires the next time an admin pre-adds an
ambassador — a normal operation (`created_by`, `invited_at`, and the
`ambassadors_insert_admin` policy all exist to support it).

**Explicitly fails the brief's requirement:** "no unique-email failure".

*Next (Phase 6):* reproduce in an isolated harness — insert an ambassador with
email + NULL `auth_user_id`, then run the apply path — and confirm the rollback
+ 400. Then decide the smallest safe fix (converge on email when
`auth_user_id IS NULL`, adopting the existing row rather than minting a new
identity). **Do not repair before reproduction.**

### F-009 — REPRODUCED AND REPAIRED (repo); production apply pending approval

**Reproduction (`BEHAVIORAL-TEST-PROVEN`).** Built a throwaway PostgreSQL 16.13
locally and loaded a faithful replica: table DDL and constraints dumped from
production `information_schema`, and the `create_partner_application` body
dumped verbatim via `pg_get_functiondef()`. Constraints verified identical to
production before running anything. **Production was never touched.**

Result — exactly as predicted:

```
=== admin pre-adds an ambassador (email known, no auth account) ===
ambassadors | 1
partners    | 0

--- app layer: SELECT partners WHERE auth_user_id = <her new uid> ---
app_layer_match_rows | 0        <- no match, so it calls the RPC

--- RPC ---
ERROR:  duplicate key value violates unique constraint "ambassadors_email_key"
DETAIL: Key (email)=(paula@example.test) already exists.

=== STATE AFTER ===
ambassadors | 1
partners    | 0                 <- rolled back cleanly: atomicity works
partner_visible | NO - she has no partners row

=== RETRY ===
ERROR:  duplicate key value violates unique constraint "ambassadors_email_key"
```

The applicant is permanently blocked, and retrying never converges.

**Intended behaviour** (from the audit brief): recognise the identity, no
duplicate partner, no orphan, **no unique-email failure**, referral code works,
configured rates survive.

**Regression tests — RED before the fix.** `src/lib/partner-identity-convergence.test.ts`
runs the **real plpgsql** against a real Postgres. Before the repair:

```
Tests  5 failed | 2 passed (7)
error: duplicate key value violates unique constraint "ambassadors_email_key"   (x5)
```

The 2 that already passed are guard rails for behaviour the fix must not break
(a genuinely new applicant; an identity another account already claimed).

A fake RPC cannot prove this. The existing `affiliate-integrity.test.ts` models
the RPC in memory and does **not** model `UNIQUE(email)`, so it reports success
on the exact input that fails in production. That is how this survived 3566
green tests — recorded for the Phase 15 test-quality report.

**The repair** — `src/lib/sql/partner-identity-convergence.sql`. When no
`partners` row matches `auth_user_id`, look for an ambassador with the same
email (case-insensitive) that no account has claimed, and **adopt** it: claim
the row for this auth user and ensure its `partners` twin exists with the same
id. Nothing the admin configured is overwritten — not the referral code (which
may be in circulation), the commission rate, the customer discount, or the
status. If another account already claimed that email, it raises rather than
merging two people's identities.

A second, smaller repair in `src/lib/partner-portal.ts`: the RPC now returns
`adopted: true`, and adoption is treated as a **first** application, not a silent
re-submission. Without this the applicant would submit the form, see success,
and receive no confirmation, while the owner was never told the person they
pre-added had signed up. The function also now answers with the identity the
RPC settled on rather than the ids it generated locally — otherwise an adopted
applicant would be told their referral code is `PAULA2` when the live code is
`PAULA`.

**GREEN after the fix:** `Tests 7 passed (7)`.

**Negative controls (mutation tests) — each lands on exactly the right test:**

| Mutation | Result |
|---|---|
| A: neuter the already-claimed-by-another-account guard | only *"does NOT hand over an identity that another account already claimed"* fails |
| B: let adoption overwrite the admin's referral code | only *"preserves the rates and referral code the admin configured"* fails |
| C: treat adoption as a silent re-submission (pre-fix behaviour) | the 3 notification tests fail |
| D: answer with the locally generated identity | the 2 identity tests fail |
| restored | all green |

**Verification:** full suite **203 files / 3579 tests passing** with the database
present (was 201/3566). Without a database the 7 convergence tests skip *loudly*
via `console.warn` — 202 passed, 1 skipped — so CI cannot report a false pass.
`tsc --noEmit` exit 0. `eslint` 0 errors (one pre-existing unused-variable
warning at `partner-portal.ts:461`, present in `HEAD` before this change and
left alone as an unrelated edit).

**STATUS: APPLIED TO PRODUCTION AND VERIFIED THERE.** `PRODUCTION-PROVEN`.

Applied 2026-08-25 with the owner's explicit approval, as Supabase migration
`partner_application_adopts_pre_added_ambassador`, matching how the three
earlier affiliate repairs were applied.

Before / after:

| | value |
|---|---|
| `md5(prosrc)` before | `23d162500976785aa426c1fc10c0e04f` (1756 bytes) |
| `md5(prosrc)` after | `0c177eff4e03b6a7d2b57927846c0c47` |
| adoption path present | yes |
| `partners` / `ambassadors` row counts | 7 / 7 — unchanged |

**Behavioural verification in production, persisting nothing.** The probe ran
inside a `DO` block that ends in `RAISE EXCEPTION`, so every write rolled back.
It exercised the real tables, real constraints and real defaults — not the local
replica:

```
start p=7 a=7
A=PASS(already-claimed guard raised)
B: adopted=true id_match=t code=AUDITPROBEPRE comm=17.50 disc=12.50
   twin=t phone=555-0199 p=8 a=8
```

| Check | Result |
|---|---|
| A — an ambassador another account already claimed is NOT handed over (used a **real** existing ambassador's email with a different auth id) | raised, no hand-over |
| B — adoption fires for a pre-added ambassador | `adopted=true` |
| Returns the pre-added id, not a newly minted one | `id_match=t` |
| Admin's issued referral code survives (applicant asked for `AUDITPROBENEW`) | `AUDITPROBEPRE` |
| Admin's commission survives (`10` was passed in) | `17.50` |
| Customer discount survives | `12.50` |
| `partners` twin created, same id, auth claimed | `twin=t` |
| Applicant's own details filled in | `555-0199` |
| Case-insensitive identity match (email passed UPPERCASE) | matched |

**Rollback confirmed clean:** `partners=7, ambassadors=7`, **0** probe rows in
either table, **0** probe auth claims, 4 ambassadors still inheriting the
program default (unchanged), **7 converged pairs** — the same-id invariant
holds.

**No regression in production referral behaviour** after the change:
`MIZZY → 15`, `BRUTUS → null`, `ELIJAH-AB78AE → {valid:false}`,
`NONEXISTENT → {valid:false}` — identical to the pre-change readings.

Revert path is exact: re-apply `BASELINE-live-functions-2026-08-25.sql`.

*Still owed:* browser-level proof of the full pre-add → sign-up → apply journey
(Phase 6), which needs the fix applied to a preview or the local dev database.

### F-013 — The admin invite door reopens BRUTUS, and silently defeats the F-009 repair
**Grade:** `BEHAVIORAL-TEST-PROVEN` (real Postgres, real constraints, real TypeScript) · **Severity:** P0 · **Status:** REPAIRED, APPLIED TO PRODUCTION AND VERIFIED THERE

F-009 fixed the *self-service* apply path. `createPartnerInvite`
(`src/lib/partner-portal.ts:1370`) — the **admin invite** path — was never
routed through anything, and still wrote `partners` then `ambassadors` as two
independent PostgREST statements. Two statements over HTTP are two
transactions, so nothing rolls the first one back.

**Reproduced, SQL level.** Faithful replica on local PostgreSQL 16.13; DDL and
constraints taken from production `information_schema`. Production untouched.

```
--- SETUP: admin pre-adds the ambassador (a normal, supported operation) ---
ambassadors | 1      partners | 0

--- step 2: INSERT INTO partners  ---> INSERT 0 1   (commits)
--- step 3: INSERT INTO ambassadors -->
ERROR:  duplicate key value violates unique constraint "ambassadors_email_key"

=== STATE AFTER ===
ambassadors | 1      partners | 1     <- the first insert was NOT rolled back

--- orphan partners rows (partners row with no ambassadors twin) ---
 33333333-...  paula@example.test  PAULAP-A1B2C3  pending  10
```

That orphan **is** the BRUTUS row: a `partners` row holding a live,
unique-claimed referral code with no `ambassadors` twin.

**It is worse than a stale row — it defeats F-009.** The orphan carries
`auth_user_id`, and both the app layer (`partner-portal.ts:442`) and
`create_partner_application` match on `auth_user_id` first. Proven in the
replica, running the **shipped** F-009 repair:

```
=== Paula accepts the invite and applies. Does F-009 adoption fire? ===
{"status":"pending","created":false,"partner_id":"3333...","referral_code":"PAULAP-A1B2C3"}
                                    ^ no "adopted" key -- adoption never ran

=== Which code is she told she has, and is it valid at checkout? ===
 told_to_paula | honoured_at_checkout
 PAULAP-A1B2C3 | f

=== Her real approved identity: still stranded? ===
 PAULA | approved | 17.50 | 12.50 | unclaimed_by_any_account = t
```

So the invitee is handed a referral code that **checkout will never honour**
(`validate_referral_code` reads `ambassadors` and requires `status='approved'`),
while her real approved identity — with the rates the admin configured — stays
stranded in `ambassadors`, unclaimed, permanently. The admin saw only a 400.

**Regression tests — RED before the fix.** `src/lib/partner-invite-atomicity.test.ts`
runs the **real `createPartnerInvite`** against a real Postgres through a
`supabaseAdmin` shim backed by `pg`, so every insert meets the real constraints.

```
Tests  5 failed | 2 passed (7)
leaves no orphan partners row behind
  -> expected [ { referral_code: "PAULAT-4C800E", commission_percent: "10", ... } ] to deeply equal []
adopts the admin's ambassador instead of minting a second identity  -> expected 2 to be 1
reports back a referral code that checkout will actually honour     -> expected null not to be null
does not strand her real identity unclaimed                         -> expected null not to be null
refuses to hand over an ambassador another account already claimed  -> orphan left behind
```

The 2 that already passed are guard rails for behaviour the fix must not break
(a genuinely new invitee; the admin's configured rates surviving untouched).

**The repair** — `src/lib/sql/partner-invite-convergence.sql` defines
`create_partner_invite`, deliberately the same shape as F-009's repair because
it is the same defect through a different door: one plpgsql body is one
transaction, and identity is the person (their email), not the auth row.

1. Already invited/applied under this auth user → hand back what exists.
2. An ambassador already holds this email → claimed by another account, raise;
   unclaimed, **adopt** it and ensure the `partners` twin carries the same id.
3. Nobody by either → create both rows, or neither.

Nothing the admin configured is overwritten on adoption — not the referral code
(which may be in circulation), the commission, the customer discount, or the
status. In particular **the invite form's default commission does not overwrite
a rate an admin deliberately set**; silently downgrading someone's rate through
a form default is a money defect. `createPartnerInvite` now answers with the
identity the database settled on, and records `partner_invite_adopted` in the
audit log so an adoption is not indistinguishable from a fresh invite.

**GREEN after the fix:** `Tests 7 passed (7)`.

**Negative controls (mutation tests) — each lands on exactly the right test:**

| Mutation | Result |
|---|---|
| A: neuter the already-claimed-by-another-account guard | only *"refuses to hand over an ambassador another account already claimed"* fails |
| B: let adoption overwrite the admin's referral code and rate | *"preserves the referral code and rates the admin configured"* fails — and so does *"reports back a code checkout will honour"*, because the reported code and the stored code then disagree |
| C: atomic but NOT convergent (drop the email lookup) | the 3 convergence tests fail; *"leaves no orphan"* still passes — correctly isolating atomicity from convergence |
| D: answer with the locally generated identity | only *"reports back a referral code that checkout will actually honour"* fails |
| E: adopt the ambassador but never create the `partners` twin | only *"adopts the admin's ambassador instead of minting a second identity"* fails |
| restored | all 7 green |

**Verification:** full suite **204 files / 3586 tests passing** with the database
present (was 203/3579 after F-009). `tsc --noEmit` exit 0.

**STATUS: APPLIED TO PRODUCTION AND VERIFIED THERE.** `PRODUCTION-PROVEN`.

Applied 2026-08-26 with the owner's explicit instruction, as Supabase migration
`partner_invite_atomic_and_convergent` — the same mechanism as the four earlier
affiliate repairs. The SQL landed **before** the code that calls it, which was
the deployment hazard this entry previously flagged; that hazard is now closed.

| | value |
|---|---|
| `create_partner_invite` before | **did not exist** |
| `md5(prosrc)` after | `2d6dc067f3ac531a40a53bfd4767fb80` |
| `create_partner_application` md5 (F-009) | `0c177eff4e03b6a7d2b57927846c0c47` — **unchanged** |
| `partners` / `ambassadors` counts | 7 / 7 — unchanged |

**Behavioural verification in production, persisting nothing.** The probe ran
inside a `DO` block ending in `RAISE EXCEPTION`, so every write rolled back. It
exercised the real tables, real constraints and real defaults:

```
start p=7 a=7
A=PASS(already-claimed guard raised)
B: adopted=true id_match=t code=AUDITINVPRE comm=17.50 status=approved twin=t
C: created=true both_rows_same_id=1
before rollback p=9 a=9  -> ROLLED BACK
```

| Check | Result |
|---|---|
| A — an ambassador another account already claimed is NOT handed over (used a **real** existing ambassador's email with a different auth id) | raised, no hand-over |
| B — adoption fires for a pre-added ambassador | `adopted=true` |
| Returns the pre-added id, not a newly minted one | `id_match=t` |
| Admin's issued referral code survives (the invite asked for `AUDITINVNEW`) | `AUDITINVPRE` |
| Admin's commission survives (`10` was passed in) | `17.50` |
| Admin's status survives | `approved` |
| `partners` twin created, same id, auth claimed | `twin=t` |
| Case-insensitive identity match (email passed UPPERCASE) | matched |
| C — a genuinely new invitee still gets both rows with one id | `created=true`, `1` |

**Rollback confirmed clean:** `partners=7, ambassadors=7`, **0** probe rows in
either table, **7 converged pairs**, **0 orphan partners**, and F-009's function
untouched at its recorded md5.

Revert path is exact: `drop function public.create_partner_invite(uuid,uuid,text,text,text,numeric,uuid);`
and revert the `createPartnerInvite` change in `partner-portal.ts` together.

### F-014 — The database-backed proofs skip silently; the ledger's "loud skip" claim was false
**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P1 (test-suite honesty) · **Status:** REPAIRED IN REPO

This ledger claimed of F-009's suite: *"Without a database the 7 convergence
tests skip **loudly** via `console.warn` — so CI cannot report a false pass."*
**That claim was wrong.** Vitest 4 swallows `console.warn` emitted at module
scope when the suite is skipped. Measured, before the fix:

```
$ npx vitest run src/lib/partner-identity-convergence.test.ts
 Test Files  1 skipped (1)
      Tests  7 skipped (7)          <- and nothing else. No warning at all.
```

So the 14 tests that constitute the *entire* runtime proof of both BRUTUS
repairs (F-009's 7 and F-013's 7) skip invisibly whenever
`VANTA_TEST_DATABASE_URL` is unset, and the run still reports success.

**This matters more than it looks:** the repository has **no `.github/` and no
CI configuration at all**, so nothing sets that variable automatically. These
proofs run only when a person deliberately exports it. A green `npm run test` is
therefore not evidence that either BRUTUS repair still holds.

**Repair:** both suites now emit the notice through `process.stderr.write`,
which Vitest does not capture. Verified after:

```
[partner-identity-convergence] SKIPPED: set VANTA_TEST_DATABASE_URL ...
[partner-invite-atomicity] SKIPPED: set VANTA_TEST_DATABASE_URL ...
```

*Still owed (Phase 15):* a real gate. Making the run *fail* without a database
would be the honest default, but there is no CI to configure, so that is a
decision for the owner rather than a unilateral change. Recorded so the Phase 15
test-quality report does not repeat the original false claim.

### F-015 — Nothing runs the test suite automatically. There is no CI at all.
**Grade:** `SOURCE-INSPECTED` (repo) + `PRODUCTION-PROVEN` (Vercel project config) · **Severity:** P1 — process, not code · **Status:** OPEN — owner decision

Measured, not assumed:

| Check | Result |
|---|---|
| `.github/` directory | **does not exist** — no workflows, no actions |
| Any CI config in the repo (`*.yml`, `*.yaml`, `Jenkinsfile`, `.gitlab-ci*`) | the only match is `website/vercel.json`, which contains **just the cron schedule** |
| `package.json` scripts | `dev`, `build` (`next build`), `start`, `lint`, `test` — **`build` does not invoke `test`** |
| Vercel project `vanta-labs` | framework `nextjs`, default build; **no test step** |

So the 3,595 tests run **only when a person types the command.** No push, pull
request, or deployment runs them. A red suite cannot block a merge or a deploy,
because nothing is watching.

**Why this is a finding and not a footnote.** The audit brief asks how 3,566
passing tests coexisted with every historical defect. Part of the answer is test
*quality* (Phase 15). But part of it is simply that **a passing suite was never a
precondition for anything.** Every regression test this audit adds — F-009's 7,
F-013's 7, F-016's 9 — protects nothing on its own. They are proofs that the
defect *was* fixed, not guards that it stays fixed.

Compounded by **F-014**: the 23 database-backed tests among them need
`VANTA_TEST_DATABASE_URL`, which no automated process would set even if CI
existed.

*Recommended, but the owner's call:* a workflow on pull request and on push to
`main` running `npm ci`, `npx tsc --noEmit`, `npm run lint`, and `npm run test`
with a Postgres service container and `VANTA_TEST_DATABASE_URL` pointed at it.
Not added unilaterally — introducing a required check changes the owner's
merge workflow.

### F-016 — The commission sweep overwrites money that moved while it was deciding
**Grade:** `BEHAVIORAL-TEST-PROVEN` (real Postgres, genuinely concurrent connections) · **Severity:** P0 · **Status:** REPAIRED IN REPO — **no production change needed** (application code only)

`autoApproveEligibleCommissions` (`partner-portal.ts:284`, run by the only cron,
every 30 minutes) reads `referral_orders WHERE payment_status = 'pending'`, then
makes **three more round trips** (ambassadors, orders, settings) before writing.
Its write carried no status guard — just `.in("id", eligibleIds)`. Anything that
happened to those rows inside that window was silently overwritten.

`markCommissionsPaid` has always guarded its equivalent write with
`.eq("payment_status", "approved_for_payout")`. This path never did.

**Reproduced with genuinely overlapping calls**, not sequential ones: the real
function runs against a real Postgres through a **pooled** shim, and the
competing operation commits **on its own connection** mid-sequence.

```
a refund reverses a commission mid-sweep -> expected 'reversed',  got 'approved_for_payout'
an admin pays a commission out mid-sweep -> expected 'paid',      got 'approved_for_payout'
a reversal landing between the two ledger writes -> referral_orders 'reversed',
                                                    commissions 'approved_for_payout'
```

**The second one is the money defect.** A commission that was *already paid*
is dragged back to `approved_for_payout`, where it re-enters the payout queue
and is **paid a second time**. The first silently un-reverses a refunded
commission. The third leaves the two ledgers disagreeing about the same order.

This is not theoretical: the sweep runs every 30 minutes, unattended, and the
competing writes are ordinary operator actions (a refund, a payout release).

**Repair.** Guard the authoritative write with the status that was read, and
mirror only the rows actually claimed — the same discipline `markCommissionsPaid`
already applies, including the A8 "key the mirror off what was claimed" rule.
A second guard on the mirror covers the tighter window between the two writes.

**RED before / GREEN after:** `4 failed | 5 passed (9)` → `9 passed (9)`.

**Negative controls:**

| Mutation | Result |
|---|---|
| A: drop the status guard on the authoritative update | the 3 tests for reversed / already-paid / ledger agreement fail |
| B: drop the status guard on the `commissions` mirror | only *"does not overwrite a reversal that lands between the two ledger writes"* fails |
| restored | all 9 green |

**Certified in the same run — mechanisms that DO hold under real contention:**

| Behaviour | Evidence |
|---|---|
| `markCommissionsPaid` pays exactly once under two simultaneous releases | 2 concurrent calls → 1 winner, 1 payout row of $140, 0 duplicate |
| The two payout ledgers stay in step | `partner_payouts` and `payouts` each hold 1 row with the same id |
| No commission left half-paid | all rows `paid`, none stranded |
| The paid-side-effects exactly-once claim | 8 concurrent `update ... where paid_side_effects_at is null returning` → **exactly 1** wins |

The last one matters: it is the mechanism preventing double commissions and
double stock decrements on a replayed payment webhook, and it is sound.

**A harness defect found and fixed along the way.** The three database-backed
suites shared one database while Vitest ran them in parallel workers, so they
destroyed each other's fixtures and failed with unique-constraint errors
belonging to a *different* suite's seed data. Each suite now provisions its own
throwaway database (`src/lib/test-support/suite-database.ts`). Recorded because
that failure mode looks exactly like a real defect and would have wasted a
later reviewer's time.

**Map correction (`DATABASE-PROVEN`).** `PHASE1-SYSTEM-MAP.md` states
`partner_payouts.ambassador_id references ambassadors(id)`. Live
`information_schema` shows `partner_payouts` has **only a primary key — no
foreign key at all**. `payouts.partner_id` → `partners(id)` and
`commissions.partner_id` → `partners(id)` are the real FK constraints, and
`referral_orders.ambassador_id` → `ambassadors(id)`. The map's P0 rationale for
the `markCommissionsPaid` ordering risk is therefore half wrong: a one-sided
identity breaks the `payouts` mirror, not `partner_payouts`. The ordering risk
itself (status flipped to `paid` before the payout rows are inserted, with no
transaction) is **unchanged and still open** — see NOT VERIFIED below.

### F-017 — Historical defect #3: the approval email quotes a commission the ambassador does not earn
**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P0 · **Status:** REPAIRED IN REPO — **no production change needed** (application code only)

The referral-code-assigned email was repaired after MIZZY was emailed "0%" with
15.00 stored. Its header says, in capitals, that telling an ambassador they earn
0% is worse than not writing, and it resolves the rate through
`firstFinitePercent([rate set now, stored rate, program default])`.

The comment 30 lines above it claims the **approval** email "resolves it inside
`sendPartnerStatusEmail` … a caller that forgets cannot reintroduce a hole."
**It did not, and the caller did.** `updatePartnerStatus` passed:

```ts
commissionPercent: existingPartner.commission_percent != null
  ? Number(existingPartner.commission_percent) : undefined,
```

`existingPartner` is a snapshot of the **`partners`** row taken *before* the
update — the table this same function calls "the mirror" and "a display copy",
because `ambassadors` is what checkout and commission accrual read. So:

| Situation | What the ambassador was told | What they actually earn |
|---|---|---|
| Approve **and** set the rate in one action (the normal way) | the **previous** rate | the new rate |
| The two tables have drifted | the **display copy** | the `ambassadors` value |
| `partners` holds 0 while `ambassadors` holds a real rate | **"0%"** | their real rate |

The third row is historical defect #3 exactly, reachable through the other door.

**RED before / GREEN after:** `4 failed | 2 passed (6)` → `6 passed (6)`.

**The repair.** Read the rate back from `ambassadors` **after** the write and
quote that — the number the ambassador will actually be paid — falling back to
the program default, and leaving the value unset (so the template's own default
applies) when nothing is configured anywhere. An explicit 0 is still honoured;
`null`, `undefined` and `""` mean "look further", never "email them zero". The
rate typed into the request needs no separate slot: the authoritative row is
read after the write, so it already carries it — and quoting the database rather
than the request means a write that silently matched no rows cannot produce an
email promising a rate nobody holds.

**Negative controls:**

| Mutation | Result |
|---|---|
| A: read the pre-update `partners` copy again (the original defect) | the 4 tests for same-submission rate, authoritative rate, DB agreement and explicit 0 fail |
| B: read `ambassadors` *before* the write instead of after | 5 of 6 fail — the read's timing is load-bearing, not incidental |
| C: coerce a missing rate to 0 instead of the program default | only *"falls back to the program default"* fails |
| restored | all 6 green |

**Two false passes found and fixed along the way — both worth more than the fix.**

1. **My own first fake returned live row references.** PostgREST returns JSON
   over HTTP, so a row read earlier does not change when the table is updated
   later. Handing back the stored object made two tests **pass against the
   unfixed code** — the caller's `existingPartner` appeared to pick up the new
   rate by itself. Corrected to return snapshots, at which point the defect
   appeared. Recorded because it is precisely the failure mode this audit
   exists to find, and it happened *inside the audit*.

2. **`referral-code-email-wiring.test.ts` — the file whose header reads "THE
   TEST THAT WOULD HAVE CAUGHT IT" — could not have caught this half.** Its fake
   answered `null` for every `ambassadors` read and had no store behind the
   `ambassadors` update, so the scenario in its own header ("15.00 stored on
   **both** tables") was only ever half modelled. A fake that cannot represent
   the authoritative rate cannot catch an email quoting the wrong one. Now
   models the row and lets the write land. **This is a concrete, named instance
   of the Phase 15 "mock-shape drift" P0.**

### F-011 — Three safety-critical database functions exist only in production
**Grade:** `DATABASE-PROVEN` · **Severity:** P1 · **Status:** BASELINE CAPTURED

Reconciling live schema against the repository (as required before any DB
change) found that **no repository SQL file defines**:

| Function | What it protects |
|---|---|
| `create_partner_application` | atomic partner+ambassador creation — the BRUTUS orphan fix |
| `affiliate_balances` | server-side aggregation of amounts owed — the row-cap truncation fix |
| `rls_auto_enable` | event trigger enabling RLS on every new public table — why coverage is 68/68 |

All three are repairs for defects found in live data. Had the database been
rebuilt from this repository, **all three protections would have vanished
silently** and the defects they fix would have returned.

Captured verbatim into `src/lib/sql/BASELINE-live-functions-2026-08-25.sql`
(with `validate_referral_code`, which *was* already reproducible). `CREATE OR
REPLACE` makes re-applying a no-op when production already matches, so it is a
reviewable baseline rather than a migration to run blindly.

**Refinement after applying F-009's repair.** `supabase_migrations` is not
empty — it holds four migrations, all applied 2026-08-25:

| version | name |
|---|---|
| 20260825003037 | `rpc_execute_lockdown` |
| 20260825204855 | `referral_code_returns_customer_discount` |
| 20260825214916 | `partner_application_atomic_creation` |
| 20260825215051 | `affiliate_balances_server_side_aggregate` |

So the mechanism exists and was used; what failed is that **the SQL was never
committed to the repository**. The migration history lives only in the database.
That is a narrower and more fixable problem than "no migration system", and it
means Phase 5's reconciliation should diff `supabase_migrations` contents against
`src/lib/sql/` rather than trying to reconstruct intent from 116 loose files.

F-009's own repair was applied the same way
(`partner_application_adopts_pre_added_ambassador`) **and** committed to the
repo, so it does not extend the drift.

This is a concrete instance of A1. The wider reconciliation — every table,
column, index, constraint, policy and trigger — is still owed in Phase 5.

### F-010 — RLS posture: 68/68 enabled, but four issues worth noting
**Grade:** `DATABASE-PROVEN` · **Severity:** mixed (P2/P3) · **Status:** OPEN

68 public tables, **68 with RLS enabled** — the historical claim re-certifies.
80 policies across 34 tables; the other 34 tables have RLS on and **no policies**,
which is fail-closed (safe). An `rls_auto_enable` event trigger explains why
coverage is total.

Issues found:

1. **`referrals_insert_any`** — `INSERT ... WITH CHECK (true)` for `public`.
   Anyone can insert referral rows. Same shape for `partner_clicks_insert_any`
   and `website_analytics_events_insert_any`. Presumably for anonymous click
   tracking, but referral attribution is money-adjacent. *P2 — check whether the
   app writes these via service role (making the policy unnecessary) and whether
   fabricated rows can influence commission.*
2. **Anon can INSERT into `ambassadors`** — policy "Anyone can submit ambassador
   application" allows `{anon,authenticated}` INSERT with
   `WITH CHECK (status = 'pending' AND commission_percent = 10.00)`. This bypasses
   the atomic `create_partner_application` path entirely and would create an
   `ambassadors` row with no `partners` twin — **the exact orphan shape F-009's
   fix exists to prevent**. It also hardcodes `10.00` as a business constant *inside
   a database policy*. *P2 — determine whether any live code path uses it; if
   not, it is a dormant bypass.*
3. **A no-op policy that reads as protective.** `ambassadors` has
   `"No public ambassador viewing"` = `SELECT ... USING (false)` for
   `{anon,authenticated}`, alongside `ambassadors_select_owner` =
   `USING (owner OR admin)` for `public`. Postgres combines *permissive* policies
   with **OR**, so `USING (false)` blocks nothing. A reviewer could reasonably
   believe it does. *P3 — misleading, not exploitable.*
4. **Duplicate policies.** `ambassadors_select_owner` / `..._select_owner_or_admin`,
   `partner_clicks_select_owner` / `..._or_admin`, `partner_payouts_select_owner` /
   `..._or_admin` are pairwise identical. Also inconsistent helpers:
   `store_credit_ledger` and `ambassador_wallet_ledger` use `auth.uid()` directly
   while everything else uses `current_auth_uid()`. *P3 — housekeeping.*

### Historical-defect recertification — running scoreboard

| # | Historical defect | Status so far | Grade |
|---|---|---|---|
| 1 | 15% discount displayed as 10% | **Server side PASS.** `validate_referral_code('MIZZY')` returns `customer_discount_percent: 15`; NULL passes through un-coerced for inheritors. Cart calls the same `resolveAmbassadorCustomerDiscount` as the server. **Browser proof still owed.** | `DATABASE-PROVEN` + `SOURCE-INSPECTED` |
| 2 | Mystery $100 affiliate minimum | Not yet assessed. `DEFAULT_MINIMUM_QUALIFYING_ORDER` exists; `/api/catalog/promotions` swallows a settings failure with `.catch(() => ({ minimumQualifyingOrder: DEFAULT }))` — a silent fallback to watch. | `NOT VERIFIED` |
| 3 | 0% commission approval email | **FAIL → REPAIRED (repo).** The referral-code email was fixed; the APPROVAL email still passed the pre-update `partners` copy, so approving and rate-setting in one action emailed the old number, and a `partners`-0 / `ambassadors`-real drift emailed "0%". 6 tests red→green, 3 negative controls. Two false passes found and fixed, one of them in the test named "THE TEST THAT WOULD HAVE CAUGHT IT". | `BEHAVIORAL-TEST-PROVEN` |
| 4 | Brutus/Paul duplicate identity | **TWO DOORS. Self-service (F-009): REPAIRED & LIVE** — reproduced in a replica, 7 tests red→green, 4 negative controls, applied to production and proven there by a rolled-back probe. **Admin invite (F-013): REPRODUCED & REPAIRED IN REPO, not yet applied to production** — the same orphan, and it silently defeats the F-009 repair; 7 tests red→green, 5 negative controls. Browser proof still owed for both. | `PRODUCTION-PROVEN` (F-009) + `BEHAVIORAL-TEST-PROVEN` (F-013) |
| 5 | Elijah status drift | **PASS (behavioural).** `validate_referral_code('ELIJAH-AB78AE')` → `{valid:false}` because the RPC filters `status='approved'`. Both tables show `info_requested`. | `DATABASE-PROVEN` |
| 6 | Affiliate money chain | Not yet assessed. `commissions`, `payouts`, `partner_payouts`, `referral_orders` are all **0 rows** — no production money has ever flowed, so all proof must be behavioural. | `NOT VERIFIED` |
| 7 | Affiliate balance row-cap | `affiliate_balances()` RPC exists (server-side aggregation, SECURITY DEFINER) — the structural fix is present. Not yet proven above the row cap. | `SOURCE-INSPECTED` |

### Live database function inventory (`DATABASE-PROVEN`)

21 functions in `public`. Business-critical ones, all SECURITY DEFINER:
`validate_referral_code`, `create_partner_application`, `affiliate_balances`,
`redeem_coupon`, `reserve_inventory`, `finalize_inventory_for_order`,
`release_inventory_for_order`, `expire_stale_reservations`, plus admin rollups
(`admin_revenue_summary`, `admin_ops_summary`, `admin_partner_rollups`,
`admin_customer_rollup`, `admin_bulk_savings_stats`, `admin_revenue_by_method`,
`admin_points_outstanding`). Auth helpers `current_auth_role/uid/email` are
invoker. `rls_auto_enable` is an event trigger.

The presence of server-side aggregate RPCs for revenue and affiliate balances is
the structural answer to the historical 1000-row truncation defects. Phase 10
must confirm the admin actually *uses* them rather than raw selects.

### Production volume context

15 orders, 52 referrals, 52 partner_clicks, 46 products, 7 partners, 367 coupons,
903 admin audit logs, 7,152 analytics events. **Volume is low**, so the
row-cap/truncation risks in the brief (Supabase 1000-row cap on profit and
affiliate balance queries) **cannot be reproduced with production data** — Phase
10 and Phase 16 will need generated data in an isolated harness.

---

## Environment constraints discovered (Phase 3) — READ THIS FIRST

### E-001 — This session's network policy forbids the app from reaching ANY database
**Grade:** `PRODUCTION-PROVEN` (measured) · **Impact:** blocks Phases 3, 13, 18, 20 as originally scoped

The environment's egress proxy answers **403 to CONNECT** for every
non-allowlisted host. Measured:

| Host | Result |
|---|---|
| `www.vantalabsresearch.com` | 403 CONNECT denied |
| `vanta-labs-*.vercel.app` (preview) | 403 CONNECT denied |
| `mlpimwgkwuqpsvsrlpqv.supabase.co` (production DB) | 403 CONNECT denied |
| `snnezhxvssochqpqsjcm.supabase.co` (audit harness DB) | 403 CONNECT denied |
| `example.com` (control) | 403 CONNECT denied |
| `github.com` | reachable |

The Supabase **MCP tools** work because they tunnel through Anthropic's MCP
proxy, not direct egress. The Next.js app gets no such tunnel. So:

- **Production and Vercel previews cannot be browser-tested from this session.**
- **A locally running app cannot reach any Supabase project**, production or
  throwaway. `/api/catalog/products` returns `{"success":false}` and the
  storefront renders "We couldn't load the catalog".

What still works: everything database-side through Supabase MCP; everything
repo-side; behavioural tests against a **local** Postgres over a direct socket
(this is how F-009 was proven); and browser testing of anything that does not
need data.

**A dead end I walked into:** an isolated Supabase project
(`vanta-audit-harness`, `snnezhxvssochqpqsjcm`, free tier) was created and
seeded with the production schema shape before this constraint was measured.
It is correct and reusable, but unreachable from here, so it bought nothing.
Connectivity should have been tested first. The project is free and idle; delete
it or keep it for an environment that does have egress.

**RESOLUTION CHOSEN BY THE OWNER: allowlist the harness host (option 1).**

### Exactly what to change

At [claude.ai/code](https://claude.ai/code), in the row above the message box,
click the **cloud icon** showing the current environment's name (`vanta`). There
is no settings page or direct URL for this selector. Hover the `vanta`
environment and click the **settings gear** on the right. In the dialog:

1. Set **Network access** to **Custom**.
2. In **Allowed domains**, one per line, add:

```text
snnezhxvssochqpqsjcm.supabase.co
```

3. Tick **"Also include default list of common package managers"** — otherwise
   npm, GitHub and the rest stop working and the session cannot even install
   dependencies.
4. Save.

**Then start a NEW session.** Running sessions copy their environment once at
startup and never re-read it, so the session that requested this change cannot
benefit from it. That is why this ledger exists.

### Why only that one host

`snnezhxvssochqpqsjcm.supabase.co` is the **isolated audit harness**. Its REST,
Auth, Realtime and Storage endpoints are all on that single hostname, so one
line covers everything `supabase-js` needs.

**Deliberately NOT allowlisted, and it should stay that way:**

| Host | Why it stays blocked |
|---|---|
| `mlpimwgkwuqpsvsrlpqv.supabase.co` | the **production** database. Leaving it blocked means a locally running app physically cannot touch production data, no matter what a stray `.env` says. Production stays reachable read-only through the Supabase MCP tools, which is all the audit needs. |
| `api.resend.com`, `api.sendgrid.com` | email providers. Blocked means a test flow **cannot** send mail to a real customer. |
| `api.goshippo.com` | blocked means no test can buy a real shipping label. |
| `veyragate.com` | the payment processor. Blocked means no test can create a real charge. |
| `business-api.tiktok.com`, `ads-api.reddit.com`, `sc-static.net` | ad pixels; blocked keeps synthetic traffic out of real ad reporting. |

Do **not** add `*.supabase.co` — that wildcard would re-open production.

Optional, only if membership card-entry UI needs browser proof later:
`js.basistheory.com` (the PCI iframe for card fields). Everything else in the
storefront works without it.

### After the allowlist lands, in the new session

1. Verify: `curl -o /dev/null -w '%{http_code}' https://snnezhxvssochqpqsjcm.supabase.co/rest/v1/` — expect **401**, not `000`. A 401 means the host is reachable and the request merely lacks a key; `000` means still blocked.
2. **Recreate `website/.env.local` — it is gitignored, so a fresh container will NOT have it.** Get the harness anon key with the Supabase MCP tool `get_publishable_keys` for project `snnezhxvssochqpqsjcm`, then write:

   ```
   NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000
   NEXT_PUBLIC_SUPABASE_URL=https://snnezhxvssochqpqsjcm.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   SUPABASE_SERVICE_ROLE_KEY=<anon key>     # deliberate - see caveat below
   SUPABASE_URL=https://snnezhxvssochqpqsjcm.supabase.co
   SUPABASE_ANON_KEY=<anon key>
   EMAIL_ENABLED=false
   EMAIL_PROVIDER=none
   NEXT_PUBLIC_ENABLE_ANALYTICS=false
   CHECKOUT_ENABLED=true
   PAYMENT_PROVIDER=mock
   NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED=false
   ```

   `EMAIL_ENABLED=false` and `PAYMENT_PROVIDER=mock` are load-bearing: they keep
   a synthetic test from mailing a real person or touching a real processor.
3. `cd website && npm ci && npm run build && npm run start` — **not** `npm run dev`. Dev's HMR socket is blocked in this sandbox and Fast Refresh resets React state mid-test (see the age-gate note above).
4. Harness data already seeded: 4 products (including the parent-zero/dose-stocked shape F-001 turns on, and an all-doses-zero control), 4 ambassadors (`MIZZYPROBE` explicit 15%, `BRUTUSPROBE` inheriting NULL, `HOLDPROBE` info_requested, `PREADDPROBE` pre-added with no auth account for F-009), and one membership tier.
5. Resume from the phase table at the bottom of this file. Nothing needs redoing.

**The harness project must not be deleted** — the owner asked for it to be kept.

**One caveat to carry forward:** the harness runs the app with the **anon** key
because this session cannot mint a service-role key. Production runs
service-role, which bypasses RLS. So a page that works in production may fail on
the harness purely because a public SELECT policy is missing. Treat any such
failure as a **finding to investigate**, not a harness artefact — but confirm
which it is before reporting it.

**Alternatives, now moot:**

1. Allowlist `*.supabase.co` (and ideally the production domain) in the cloud
   environment's network policy. Cheapest by far, and re-enables the harness
   immediately.
2. Build a local PostgREST-compatible shim so `supabase-js` talks to the local
   Postgres over `127.0.0.1`. The repo's `.gitignore` carries an entry for
   `.pgrst-shim.mjs` — "local test-rig stub (Postgres shim used by the audit
   harness)" — so a previous session built exactly this, but it was never
   committed and is gone. It would have to be rebuilt.
3. Accept that stock display, referral discount in the cart, cart, and checkout
   stay `NOT VERIFIED` at browser level in the final report.

### Browser results that DID land

**Age gate — `BROWSER-PROVEN`, PASS.** Against a production build
(`npm run build && npm start`) at `127.0.0.1:3000`:

- Renders as a modal dialog over the catalog with four separate attestations
  (age 21+, organisation, research-use-only, terms).
- With 1 of 4 confirmed, both entry buttons stay `disabled`.
- With 4 of 4 confirmed, "Continue as guest" and "Create account / Sign in"
  both become enabled; clicking through dismisses the gate.
- "I am under 21 — exit" is always enabled.
- Policy links are outside the clickable row — a deliberate fix, commented in
  `age-gate.tsx`, for webviews where `target="_blank"` navigates in place.

**A dev-mode artefact, NOT a defect — recorded so nobody re-raises it.** Under
`npm run dev` the four boxes could read 4/4 checked while both buttons stayed
disabled, which looks exactly like a P0 un-passable gate. It is not. The
sandbox blocks the HMR WebSocket, Next dev retries continuously, and the
resulting Fast Refresh resets the component's `confirmed` state; a later read
showed all four boxes back to unchecked. The checkboxes are controlled
(`checked={Boolean(confirmed[id])}`), so DOM-checked-but-disabled is only ever a
transient mid-update state. On a production build the gate behaves correctly.
**Do not browser-test this app under `npm run dev` in this environment.**

**Trust claims rendered to customers** (`BROWSER-PROVEN`, catalog header):
"SAME-DAY FULFILLMENT · PUBLISHED COAS · ≥99% PURITY · FAST CUSTOMER SUPPORT ·
SECURE CHECKOUT", plus the age gate's "Third-Party Tested · COA Documented ·
Encrypted Checkout". **"PUBLISHED COAS" and "COA Documented" are asserted to
every visitor while `coa_records` is empty and no product carries a COA URL**
— see F-006. That pairing is now evidenced at both ends.

## Open questions carried forward

1. Where do COA files actually live, if `coa_records` is empty? (F-006) — still open
2. ~~What population does `express_reconcile_backlog` count?~~ **ANSWERED** — orders with a live processor session; the alert is correct (F-005)
3. ~~Does `validate_referral_code` return `customer_discount_percent`?~~ **ANSWERED** — yes, verified in production (F-004)
4. Is `minimum_qualifying_order` still 100, and enforced on both the manual-code
   and referral-link paths?
5. Does the repo SQL match live schema? (A1)
6. Are `partner_program_stats` figures presented to visitors as real payouts? (F-007)

---

## Safety constraints in force

- Branch-isolated; no merge to main without approval.
- No production mutations: no charges, refunds, payouts, label purchases, emails,
  account creation, coupon redemption, or destructive DB operations.
- Supabase production access is **read-only** unless explicitly authorised.
- Production browser access is read-only.
- Supabase migrations / production data repairs require explicit approval.

---

## Phase status

| Phase | Status |
|---|---|
| 0 — Tooling & environment | ✅ COMPLETE |
| 1 — System map | ✅ COMPLETE — see PHASE1-SYSTEM-MAP.md (159 risks catalogued, none reproduced) |
| 2 — Production data integrity | 🔄 PARTIAL (11 findings) |
| 5 — Migrations / schema reconciliation | 🔄 STARTED — 3 missing functions captured (F-011); full table/policy diff still owed |
| 6 — Affiliate / ambassador | 🔄 F-009 repaired and live; **F-013 (admin invite door) reproduced and repaired in repo, production migration pending approval**; browser proof of the end-to-end journey still owed |
| 3 — Customer journey | 🔄 BLOCKED for data-driven flows by E-001; age gate PASS, trust claims captured |
| 4, 7–21 | ⬜ NOT STARTED |

## Repairs made

| Finding | Repair | Tests | Production |
|---|---|---|---|
| F-009 | `src/lib/sql/partner-identity-convergence.sql` + adoption handling in `src/lib/partner-portal.ts` | 7 integration (real Postgres) + 6 app-layer; 4 negative controls | **APPLIED & VERIFIED** — migration `partner_application_adopts_pre_added_ambassador`; production probe passed on all 9 checks and rolled back clean |
| F-011 | `src/lib/sql/BASELINE-live-functions-2026-08-25.sql` (verbatim capture) | n/a — baseline | no change; documents current state |
| F-013 | `src/lib/sql/partner-invite-convergence.sql` (new `create_partner_invite` RPC) + `createPartnerInvite` rewired in `src/lib/partner-portal.ts` | 7 integration (real Postgres, real `createPartnerInvite`); 5 negative controls | **APPLIED & VERIFIED** — migration `partner_invite_atomic_and_convergent`; production probe passed all 9 checks and rolled back clean |
| F-014 | `process.stderr.write` instead of `console.warn` in both database-backed suites | verified: notice now prints on a skipped run | repo only; no production change |

## Running the database-backed tests

    /usr/lib/postgresql/16/bin/initdb -D /tmp/vantapg -A trust -U postgres
    /usr/lib/postgresql/16/bin/pg_ctl -D /tmp/vantapg -o '-p 55432 -k /tmp' start
    VANTA_TEST_DATABASE_URL=postgres://postgres@localhost:55432/postgres npm run test

Without `VANTA_TEST_DATABASE_URL` the convergence suite skips and says so on
stderr. It is not silently green.
