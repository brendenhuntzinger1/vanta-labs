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

## Phase 1 — System map — IN PROGRESS

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

### F-005 — Pending-payment orders older than 24h; Sentry alert count disagrees
**Grade:** `DATABASE-PROVEN` + `PRODUCTION-PROVEN` · **Severity:** P2 (provisional) · **Status:** OPEN

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

So the alert's count (1) matches neither the >24h pending orders (3) nor the open
express intents by age (0). Either the alert queries a different population than
its wording implies, or its threshold/joins are wrong. A misleading operational
alert is itself a defect.

*Next:* read the `express_reconcile_backlog` alert source in Phase 14; determine
the intended population; confirm whether the two 16-/22-day orders hold
inventory reservations.

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

### F-007 — Affiliate marketing figures vs empty commission ledger
**Grade:** `DATABASE-PROVEN` · **Severity:** P2 (provisional) · **Status:** OPEN

`partner_program_stats` holds display figures:

| key | value |
|---|---|
| `total_commissions_paid_base` | 22,638.00 |
| `average_partner_earnings_base` | 1,918.00 |
| `top_partner_payout_base` | 4,829.00 |
| `average_approval_time_hours_base` | 24.00 |

Meanwhile `commissions` = **0 rows**, `payouts` = **0 rows**,
`partner_payouts` = **0 rows**, `referral_orders` = **0 rows**.

The suffix `_base` suggests these are deliberate baseline/seed numbers for the
recruitment page. That may be intended marketing. It needs to be checked against
how the ambassador page presents them — a figure shown as money actually paid to
partners, when no commission has ever been recorded, is a misleading claim.

*Next:* Phase 6 — read the `/ambassador` page rendering of these keys.

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
| 3 | 0% commission approval email | Not yet assessed. | `NOT VERIFIED` |
| 4 | Brutus/Paul duplicate identity | **PARTIAL FAIL — see F-009.** Atomicity fixed; identity convergence not. | `DATABASE-PROVEN` + `SOURCE-INSPECTED` |
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

## Open questions carried forward

1. Where do COA files actually live, if `coa_records` is empty? (F-006)
2. What population does `express_reconcile_backlog` actually count? (F-005)
3. Does `validate_referral_code` return `customer_discount_percent`? (F-004)
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
| 1 — System map | 🔄 IN PROGRESS |
| 2 — Production data integrity | 🔄 PARTIAL (8 findings) |
| 3–21 | ⬜ NOT STARTED |
