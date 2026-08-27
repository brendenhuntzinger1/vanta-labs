# Final Integration & Production Certification — 2026-08-27

**Scope:** reconcile ~48h of work from a dozen-plus parallel sessions into one
coherent production system, prove it fits together, and certify the exact build.
This pass deliberately did NOT hunt for new features or new audit surface.

---

## A. EXACT PRODUCTION SHA

```
ee4471cdac51457432d8f5473feec3a317e07d06
```

- Vercel `dpl_3oPbBhYXfHg9nGRDGGSWGDqesayP`, `target=production`, state `READY`.
- `origin/main` == this SHA. Main and production agree.
- Certified integration branch: `claude/vanta-labs-final-integration-iqdnw9`
  @ `db8e630532ad1cbb61296a82d0caff99124905dc` (2 commits ahead of main,
  0 behind; Vercel preview `dpl_GEryUwAkYWbqLMyN9WszYKV3m41G` READY).

**Main moved twice during this pass.** It was `5d39bc9` at the start; another
session merged PR #112 and the performance lane mid-audit and deployed
`ee4471c`. That is itself the integration risk this pass exists to catch, so the
tree was re-merged and the full gate re-run from cold against the combined
result. Every claim below is against `ee4471c` / `db8e630`.

**The only code difference between production and the certified branch is
behaviour-neutral** — three stale comments, one regex rewritten from raw control
bytes to escapes (proven identical over every code point 0..0x10F), one test
fixture, and one new `.sql` documentation file the app never executes. The
substantive fix in that commit is a *database* change, and it is already applied
to production.

---

## B. PARALLEL-LANE RECONCILIATION

182 commits landed on `main` in 72 hours. Hottest files:
`payment-webhook.ts` (17 commits), `admin-profit.ts` (14), `cart-context.tsx` (9),
`quote-order.ts` (7).

### Disconnected histories — the biggest forensic risk, and it was clean
Eight `block-*` / `audit-*` branches share **no merge base** with `main` (root
`acf3cc4` vs main's `19117e7`/`f57a3e5`) — a separate audit environment. Their
commit subjects claim real fixes (C-06, I-09, J-04, K-07, K-17, K-25, F-series),
so "were these lost?" had to be answered by content, not ancestry.

Verified present on `main` by content:

| Finding | Evidence on main |
|---|---|
| K-25 shipping protection pre-ticked | `cart-context.tsx` `useState(false)`; confirmed **not pre-ticked in a live browser** |
| K-17 cancel returns stock exactly once | `order-cancellation-inventory.ts`, idempotent behind `inventory_restocked_at` |
| K-07 one membership skip per paid period | `membership-billing.ts:1099` |
| C-06 claim stage before minting | `cart-recovery.ts:259,395,430` |
| G-02/G-04/I-12/K-17 schema | `sql/inventory-return-path.sql` |

Set-differencing every block branch's `website/src` tree against main leaves only
four files, all accounted for:
- `load-evo-catalog.sql`, `load-evo-catalog-grouped.sql`, `product-costs-evo.sql`
  — **deliberately deleted** by `e33c28d` ("Remove the EvoLabs fulfilment enum
  values and catalogue seed scripts").
- `supabase-page.test.ts` — **superseded**. It tested `readAllRows`; main keeps
  only `readAllRowsBounded` (`admin-profit.ts:226`: "readAllRowsBounded is the one
  kept") with `supabase-page-bounded.test.ts`. `supabase-page.ts` exports exactly
  one function and there are zero unbounded callers left.

**No fix was lost.**

### Duplicate implementations — searched, and what was found
- `roundMoney` is defined in **three** modules (`bundle-pricing`, `shipping`,
  `member-pricing`). All three are byte-identical (`Math.round(v*100)/100`), so
  there is no arithmetic divergence. Consolidation is POST-LAUNCH, not a defect.
- `normalizeReferralCode` ×2, `applyTrackingUpdate` ×2 — same pattern.
- `protectProfit`/`DEFAULT_PROFIT_SETTINGS` (`profit-engine.ts`) have **zero
  non-test callers**. The duplicate `processingFeePercent: 8` there is therefore
  not a live second source of truth; `getProfitSettings()` is the live path.
- **Cron: one keyed registry**, 16 jobs, explicitly non-positional. No duplicate
  registration, no duplicate sweep.
- **Alert storm found and already fixed by a lane:** 44 identical
  `express_reconcile_backlog` warnings fired every 30 min for the same 2 orders.
  Renamed to `payment_reconcile_backlog` with a **persisted** 6-hour throttle,
  correctly noting a module-level timestamp throttles nothing in serverless.
  Zero further firings since 2026-08-26 19:31. Fix survived integration.

### Conflicting comments/documentation (fixed here)
Three comments still named a **14-day** commission hold. Production holds **30**,
and the code reads it from settings. The UI literals were removed by an earlier
lane; these comments were missed (`cron/sweep/route.ts`, `partner-portal.ts` ×2).

### A fix applied to one site, class not swept (fixed here)
Main's then-HEAD commit fixed a file git stored as a **binary blob** because a key
was joined on literal NUL bytes. Two more files carried the same class and were
missed: `email/cta-path.ts` (production code on the email-link path, whose
control-character regex used raw `\x00-\x1f\x7f` bytes) and
`attribution.test.ts`. A file git cannot diff cannot be reviewed. Both escaped;
equivalence proven exhaustively; 37 covering tests still pass.

---

## C. DATABASE / MIGRATION STATE

130 `.sql` files in the repo. Named items resolved:

| Item | State |
|---|---|
| `admin-dashboard-rollups.sql` | **APPLIED.** All 6 functions exist. `admin_revenue_summary` in production is byte-identical to the repo, including `round(amount_paid − refund_amount, 2)` with **no zero floor** — production RPC and the application's signed `netOrderRevenue` agree. |
| `products-hide-cost-columns-from-public.sql` (PR #112) | Was **NOT APPLIED**. Reviewed and **applied this pass**, then verified. |
| `product-doses-hide-cost-columns-from-public.sql` | **NEW this pass** — the half PR #112 missed. Applied and verified. |
| `migrations-applied/20260826014217_revoke_anon_create_partner_invite.sql` | Applied (directory is the lane's own record). |
| `PROPOSED-*.sql`, `ROLLBACK-*.sql`, `staging-seed.sql`, `harness-*.sql` | Not production migrations. Correctly unapplied. |
| `load-evo-catalog*.sql`, `product-costs-evo.sql` | **OBSOLETE** — removed from main by `e33c28d`. |
| `PROPOSED-pending-emails-order-link.sql` | **SUPERSEDED** by `pending-emails-order-link.sql`. |

### The COGS exposure was real, and was only half-fixed
Proven with the storefront's own publishable key against production:

- **Before:** `products?select=*` → 200, **36/36** rows carrying `product_cost_cents`.
- After applying PR #112's migration, `product_doses` **still** answered
  `select=*` → 200, **49/49** rows with the true per-variant landed cost:

| variant | retail | cost | margin |
|---|---|---|---|
| 5mg | $49.99 | $4.38 | 91.2% |
| 10mg | $69.99 | $6.13 | 91.2% |
| 20mg | $119.99 | $9.63 | 92.0% |
| 30mg | $144.99 | $12.80 | 91.2% |

The dose is the sellable unit, so this was the *more* sensitive half — the parent
rows advertised a flat $35.00; the dose rows give the real margin on every SKU.

Both tables are now: table-level `SELECT` revoked from `anon`/`authenticated`,
presentation columns re-granted by name (43 of 50 on `products`, 24 of 29 on
`product_doses`), and `INSERT/UPDATE/DELETE/REFERENCES` revoked (every write
policy already required `current_auth_role() = 'admin'`, so RLS was the only line
behind them). RLS row filters untouched — Postgres RLS cannot express column
scope, which is why GRANTs are the right mechanism.

**Verified after applying, not inferred:** cost read and `select=*` both return
`42501`; `label/price/stock` still return rows; anon `INSERT`/`UPDATE` return
`42501`; home/catalogue/PDP are **byte-identical** before and after
(138452b / 62791b / 111251b); `/api/catalog/products` still returns 36 products,
36 with doses, no cost field in any projection; and a real Chromium against the
deployed PDP finds no cost identifier in the HTML.

Two other cost-bearing tables (`product_cost_changes`,
`order_shipping_cost_audit`) and `orders`/`order_items` hold over-broad grants but
are **RLS-blocked** — all return `[]` to the public key. Defence-in-depth gap,
POST-LAUNCH.

---

## D. PRODUCTION CONFIG (non-secret launch snapshot)

Read from `admin_control_current` (a DISTINCT ON view over `admin_control_upsert`
audit rows; `target_table` / `target_id` / `metadata->>'value'`).

| Key | Value | Note |
|---|---|---|
| `referral.enabled` | `true` | |
| `referral.default_commission_percent` | **`15`** | changed 2026-08-27 14:03:59 by actor `launch-audit-2026-08-27`, note: *"Owner decision: 15% is the advertised base commission… Previous value: 10."* |
| `referral.personal_discount_percent` | `20` | ambassador's own orders |
| `referral.commissions_paused` | `false` | |
| `referral.customer_discount_percent` | *(unset)* | falls back to coded default (10) |
| `referral.commission_hold_days` | *(unset)* | falls back to coded default (**30**) |
| `inventory.tracking_enabled` | **`true`** | so stock findings are real, not the known false positive |
| `profit.processing_fee_percent` | **`""` (unset)** | **relies on the fallback** `PROCESSING_FEE_DEFAULT_PERCENT = 8`. Effective rate 8%, by fallback, *not* explicitly stored. |
| `profit.processing_fee_includes_tax` | `true` | |
| `profit.count_sales_tax_as_profit` | **`true`** | contradicts the code default (see P) |
| `profit.min_profit_dollars` / `min_profit_percent` | `""` | floor = break-even |
| `profit.shipping_cost_estimate` | `""` | falls back to $6 |
| `shipping.flat_rate` / `free_shipping_threshold` | `15` / `200` | |
| `shipping.north_america_flat_rate` / threshold | `25` / `400` | |
| `payment_processor.enabled` | `false` | **gates nothing** — dead flag; the real gate is `CHECKOUT_ENABLED` |
| `security.require_2fa` | `false` | |
| `security.backup_schedule` | `daily` | a stored string, not a verified job |

---

## E. FINANCIAL CERTIFICATION

**Independent reconciliation of every paid order**, computed in Python from the
component columns with nothing imported from the application:

```
order           expected  amount_paid    delta
VL-E8F4D52F        76.04        76.04     0.00
VL-49CA32C1         1.00         1.00     0.00
VL-8847B157        73.84        73.84     0.00
VL-EA5529EF        45.47        45.47     0.00
VL-8D132452        18.95        18.95     0.00
VL-37C1E4B0        17.08        17.08     0.00
VL-C98B8AB1       103.38       103.38     0.00
TOTALS            335.76       335.76     0.00      7/7 exact
```

Every purchased shipping-protection fee equals exactly 4% of merchandise subtotal
(2.20/54.99, 0.15/3.80, 0.08/2.00, 3.40/84.98). Card processing fee is $0.00 on
every order (customer surcharge disabled). Refunds $0.00 across the estate.

**Live cart arithmetic re-derived in a real browser on production** (1×BPC-157):
`$200.00` threshold − `$39.99` = **`$160.01` away** ✓; protection **`$1.60`** =
4% of `$39.99` ✓; flat shipping `$15.00` ✓; total **`$54.99`** ✓ — and
**identical at 1440×900 and 390×844**.

**Mutation controls** (each applied, suite run, file restored byte-for-byte):

| Mutation | Result |
|---|---|
| `commission_percent_locked ?? true` → `?? false` (unlocks every hand-set rate) | **CAUGHT** — 4 of 5 tests fail |
| `netOrderRevenue` re-floored at zero (`Math.max(0, paid−refunded)`) | **CAUGHT** — 10 tests across 7 files fail |
| Drop `.eq("payment_status","approved_for_payout")` from the payout claim (allows double payout) | **CAUGHT** — 3 tests across 2 files fail |

---

## F. INVENTORY CERTIFICATION

`inventory.tracking_enabled = true`, so the known false positive does not apply.
Stock lives on doses (71 dose rows, 49 with stock, 1135 units); only 5 of 36
parents carry stock, which is *expected* — `mapProductRow` resolves a dosed
product from the **default dose's** availability, and the parent column is
explicitly "a stale shadow of it".

Queried directly rather than eyeballed:
- Published products with **no buyable stock anywhere** (parent ≤0 AND every dose ≤0): **0**.
- Products whose **default dose is empty while a sibling has stock** (the named
  "parent 0 / stocked variant" case): **0**.
- `inventory_reservations` in an active/held state: **0** — nothing stuck.
- Paid orders missing `paid_side_effects_at`: **0**.

Reading `stock_status = "In Stock"` beside `inventory_quantity = 0` on a parent row
is **not** a defect here, and was not reported as one.

Two products (`dsip`, `ss-31`) carry a parent `stock_status = 'Out of Stock'` with
19 available dose units each; both are `track_inventory = false`, so the dose
governs and they sell. Data, not code — and inventory values are out of scope to
change.

---

## G. COMMISSION / REFERRAL CERTIFICATION

Production `ambassadors` — this is the direct answer to the manual-override question:

| Ambassador | Rate | Locked |
|---|---|---|
| Ashley Schloss, angel sicard, Jaeley Reynolds, Flavia, Eloa wolf, Xavier Martinez | `15.00` | `true` |
| **zain** | **`20.00`** | **`true`** ✓ |
| Paul huntzinger | `10.00` | `true` (legacy, grandfathered) |
| Elijah Lagrama | `10.00` | `false` — status `info_requested`, not approved |

- Default commission is authoritatively **15** in `admin_control`.
- **A manually-set 20% ambassador stays 20%** — `zain` is locked, and the
  `?? true` default that produces that lock is mutation-proven.
- Because **every approved ambassador is locked**, the tier ladder is currently
  inert for all of them; the default change to 15 affects only *future*
  un-overridden approvals.
- `/ambassador` renders **15% / 10%**, `/partner` renders 15% / 20% / 10% on live
  production, matching config. Before PR #112 these pages agreed with payout only
  by coincidence (hard-coded 15 + config changed to 15); PR #112 makes them
  read `getPublicProgramTerms()`, so they can no longer drift.

**Never exercised in production:** `commissions` = 0, `referral_orders` = 0,
`payouts` = 0. The pipeline is proven by tests and DB-backed concurrency suites,
never by a real referred order. See O.

---

## H. PAYMENT CERTIFICATION

- 7 paid orders reconcile exactly (E). `paid_side_effects_at` set on all of them.
- `payment_reconcile` sweep registered and idempotent; `reconcileVeyraPendingPayments`
  is the only thing between a charged card and an order reading unpaid forever.
- Exactly-once payout claim mutation-proven (E).
- Duplicate/late/out-of-order webhook handling is covered by the suite
  (`payment-webhook-dedupe.test.ts` and the DB-gated concurrency suites).
- **No card was charged.** See O.

---

## I. FULFILLMENT CERTIFICATION

- `shipping_cost_repair` and `shipment_repair` sweeps registered; both
  absence-based and idempotent.
- The repair sweep behaved correctly on the two un-recoverable labels: it found
  them, could not read postage back from Shippo, and raised
  `shipping_cost_manual_entry_required` rather than retrying forever or writing a
  fabricated zero. A lane has since shipped the admin form the alert points at
  (`admin-order-shipping-cost-form.tsx`, merged to main in this window).
- Unresolved and needing a human: 1 unattributed Shippo label
  (`d647fd12…`, tracking `1Z242F2B0313293233`); 2 orders needing manual postage;
  1 `fulfillment_failed` from 2026-08-03 (a $1.00 test order) that **nothing
  retries** — every other money path has a repair sweep, transmit does not.

---

## J. SECURITY CERTIFICATION

Probed against deployed production:

- `/api/mcp/contexts|events|ws` → **404**. The `copilot/add-mcp-server-with-devtools-integration`
  branch (which adds exactly these routes, forbidden by `CLAUDE.md`) is **unmerged
  and not deployed**. Correct — do not merge it.
- `/api/debug`, `/api/_debug`, `/api/devtools`, `/api/admin/debug` → **404**.
- `/api/admin/products|settings|control` → **401**. `/api/cron/sweep` → **401**.
- RLS with the live publishable key: `orders`, `order_items`, `ambassadors`,
  `commissions`, `payouts`, `admin_credentials`, `admin_sessions`,
  `admin_audit_logs`, `store_credit_ledger`, `points_ledger`,
  `customer_addresses`, `coupons`, `partner_clicks`, `referral_orders`,
  `email_send_log`, `inventory_items`, `partners`, `product_cost_changes`,
  `order_shipping_cost_audit` → **all `[]`**.
- **COGS exposure closed on both `products` and `product_doses`** and verified
  from the browser (C).
- Age gate certified on live production (L).

Carried forward, not fixed here: plaintext live secrets in `admin_audit_logs`
(RLS-protected, admin view redacts — rotate the SMTP credential); unauthenticated
`ambassadors` INSERT constrained to `status='pending' AND commission_percent=10.00`
— note that constant now disagrees with the 15% default; `validate_referral_code`
enumerable and unrate-limited.

---

## K. PERFORMANCE

No launch regression found, and **no further optimisation was done** — correctly,
since none of the observed numbers is a regression.

The performance lane (`57bfd86`, consent bar out of normal flow, age-gate and hero
entrance, `1543d02` font + checkout warm) was merged to main and deployed to
production by another session **mid-audit**. Because it touches the age gate, cart
context and cookie consent, it was re-verified in a browser against the new
deployment rather than trusted: age gate intact on both viewports, cart
arithmetic unchanged and identical desktop/mobile, no horizontal scroll on
`/products`, `/cart`, `/checkout` at 390×844 or 1440×900.

Live page timings through the intercepting proxy (pessimistic): home 5.0s first
hit, then 2.2–2.9s per route. Console noise is one repeated `401 /api/account/me`
(the anonymous session probe) and Sentry envelope aborts — both expected.

---

## L. PLAYWRIGHT — journeys actually exercised on the deployed site

The Playwright **MCP server** could not be used: it was launched at session start,
before `.playwright-mcp.json` existed in the tree, so it never picked up
`--ssl-version-max=tls1.2` and every navigation died on `ERR_CONNECTION_RESET`.
Chromium was driven directly with the same flags instead
(`/opt/pw-browsers/chromium`, `playwright-core`).

Against `https://www.vantalabsresearch.com`:

1. Cold visitor → `/` — age gate present, blocking, z-index 100, desktop **and** 390×844.
2. **Age gate PATH A** — 4 consent boxes; "Continue as guest" **disabled** before,
   **enabled** after all four; click clears the gate; **stays cleared** across
   navigation to `/products`.
3. **Age gate PATH B** — only 1 of 4 boxes ticked → entry **stays disabled**, gate up.
4. **Age gate PATH C** — deep link straight to `/products/bpc-157` with no consent
   → gate up.
5. `/products` — 200, 72 product links, no "out of stock", no horizontal scroll.
6. `/products/bpc-157` — 200, 6 add-to-cart controls, price `$39.99`,
   **no COGS identifier anywhere in the HTML**.
7. PDP → Add to Cart → `/cart` — cart contains BPC-157; money reconciles to the
   cent (E); **shipping protection offered but NOT pre-ticked**.
8. `/checkout`, `/ambassador`, `/partner` — 200, correct `h1`, programme
   percentages render 15/10 and 15/20/10.
9. All of 5–8 repeated at 390×844 with identical money and no horizontal scroll.

---

## M. REAL ORDER

**Not performed.** No authorisation to charge a production card was given, and the
brief requires explicit authorisation. No production order was created, no card
charged, no payment state mutated. This remains the single largest unproven area.

---

## N. ALERTS / MONITORING — what to watch at launch

Currently unresolved in `system_alerts`:

| Type | Sev | Count | Meaning |
|---|---|---|---|
| `express_reconcile_backlog` | warning | 44 | **historical noise** — pre-throttle duplicates of one condition; the storm is fixed, these rows are just untidy |
| `inventory_rpc_failed` | critical | 2 | `expire_stale_reservations` failed 09:01 & 12:00 with `JWT issued at future` (clock skew). **Self-healed** — none since, and 0 held reservations |
| `shippo_label_unattributed` | critical | 1 | needs a human in Shippo |
| `shipping_cost_manual_entry_required` | warning | 1 | 2 orders need postage typed in |
| `fulfillment_failed` | critical | 1 | 2026-08-03, nothing retries transmits |
| `payment_webhook_error` | warning | 3 | 2026-07-31 |

Watch during launch, in priority order: `payment_reconcile` failures (a charged
card reading unpaid), `commission_accrual_repair` (first real referred order),
`inventory_rpc_failed` recurrence, `fulfillment_failed` (no retry exists), and
`payment_reconcile_backlog` (the renamed, throttled one — a *new* firing is real).

---

## O. UNPROVEN — not verified, do not read as passed

- **No real payment.** VeyraGate hosted form, 3-D Secure, decline, timeout,
  refresh-during-payment, double-submit, and the live payment webhook were not
  exercised. Express/Apple Pay not exercised.
- **The commission pipeline has never run in production** — `commissions`,
  `referral_orders`, `payouts` are all empty. Accrual → hold → approval → payout
  → profit deduction is proven by tests and DB-backed concurrency suites only.
- **Refunds and replacements never executed in production** — `refund_amount` is
  0.00 on every order; 0 replacement orders exist.
- **Admin surfaces not exercised in a browser** — no credentials. Control Center,
  fulfillment workstation, profit dashboard, the new shipping-cost form and the
  new system-alert row are covered by tests only.
- **Signed-in customer flows not exercised** — account, orders, membership
  purchase, password reset, points/credit redemption.
- **Unauthenticated POST/PATCH to `/api/admin/orders` was not probed** — the
  sandbox classifier blocked the write attempt and I did not work around it. GET
  returns 405 and the sibling admin routes return 401; the write guard is
  asserted by code and tests, not by a live probe.
- **Cron convergence not run as repeated live ticks.** Idempotency is asserted by
  the suite and by the absence-based design; "next tick = zero writes" was not
  demonstrated by running the sweep twice against a seeded environment.
- **Inventory edge cases not reached live** — out-of-stock, last-unit race and
  disabled-tracking paths would require mutating production stock.
- **Shippo lifecycle** PRE_TRANSIT → TRANSIT → DELIVERED and duplicate/late/
  out-of-order webhooks not exercised end to end.
- **Email deliverability** — one `sent` row observed; inbox placement, SPF/DKIM
  and the shipping/delivery/membership templates not observed.
- **Backups/PITR not verified**; `security.backup_schedule = "daily"` is a stored
  string. No restore rehearsed.

---

## P. REMAINING ITEMS

### LAUNCH BLOCKER
None from an engineering standpoint on `ee4471c`. See the verdict for the
condition attached.

### BUSINESS / LEGAL DECISION (not mine to make)
1. **`profit.count_sales_tax_as_profit = true` contradicts the code's own recorded
   owner decision.** `DEFAULT_PROFIT_CONFIG.countSalesTaxAsProfit = false` is
   commented *"FALSE BY OWNER'S DECISION… the stored value must be changed too"*,
   while `docs/FINANCIAL-DATA-RECONCILIATION.md` FIN-10 records it as a toggle the
   owner deliberately set to `true`. Two lanes, opposite conclusions, and
   production sits on `true`. $22.72 of collected tax across 6 orders is inside
   reported profit while the tax report treats the same dollars as a liability.
   **One of those two records is wrong — the owner must say which.** Not changed.
2. **The "Over 70% of customers add BAC Water" claim** measures 57.1% of paid
   orders (4/7) and 50.0% overall (9/18). At n=7 no percentage claim is
   defensible. Owner's call to remove, soften, or substantiate.
3. **Legacy ambassador `BRUTUS` is locked at 10%** while the advertised base is
   now 15%. Deliberate grandfathering or an oversight — owner's call.
4. **Anonymous `ambassadors` INSERT policy pins `commission_percent = 10.00`**,
   which no longer matches the 15% default. Harmless today (applications land
   `pending` and rates are set on approval) but the constant is now stale.
5. **FDA / RUO exposure.** Out of engineering scope; qualified counsel required.
   Passing this audit says nothing about legal compliance.

### POST-LAUNCH
1. Retry + escalation for failed 3PL transmits (`fulfillment_failed`, no retry exists).
2. Processor reconciliation — nothing compares VeyraGate settlements to `orders.amount_paid`.
3. Chargeback/dispute workflow; fraud velocity controls.
4. Revoke the over-broad (RLS-blocked) grants on `orders`, `order_items`,
   `product_cost_changes`, `order_shipping_cost_audit`.
5. Rotate the SMTP credential; move live secrets out of `admin_audit_logs`.
6. Rate-limit / de-enumerate `validate_referral_code`; rate-limit ambassador applications.
7. Consolidate the three identical `roundMoney` definitions.
8. Wire up or delete `payment_processor.enabled` (a dead flag that tells an owner
   the opposite of the truth) and `providerSettlesRefunds()` (documents itself as
   the source of truth for "did money move"; returns `false`, has no callers).
9. Realtime subscriptions on `products`/`product_doses`/`admin_audit_logs` are
   **inert** — the `supabase_realtime` publication contains no tables, so admin
   "live" refresh never fires.
10. Sub-24px tap targets on mobile checkout; generic `<title>` on transactional
    pages (partially addressed by PR #112).
11. Restore-test backups; confirm PITR.
12. 2FA on admin.

---

## GATE EVIDENCE

Cold gate on the exact merged tree (`db8e630`), throwaway Postgres, `.next`
deleted first:

```
Test Files  325 passed (325)
Tests       4967 passed (4967)      0 failures, 0 skips
tsc --noEmit                        exit 0
eslint .                            exit 0   (46 warnings, all unused-vars in tests)
next build                          exit 0
```

Zero DB-gated skips is a real result, not an artifact: the same suite run
*without* `VANTA_TEST_DATABASE_URL` skips 82 tests across 10 files, and the gated
run's log carries live `pg` client warnings.
