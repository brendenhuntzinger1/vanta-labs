# Launch readiness audit — 2026-08-30

**Commit audited:** `f1ecb14` — equal to `origin/main` and to the READY
production deployment at the time of audit.
**Scope:** a delta audit. A full evidence-graded audit ran on 2026-08-29
against `e2c8f90`; 53 commits landed after it, including a new Buy-X-Get-Y
promotion engine, coupon stacking, and changes to `quote-order.ts` and
`payment-webhook.ts`. This audit re-verifies the base and concentrates on
that delta plus live production state.

**Evidence tiers.** **EXECUTED** — run here, output observed. **PROD-DATA** —
read-only query against the production Supabase project. **CODE** — read from
the tree, not executed.

---

## Verdict

**No launch-blocking code defect was found.** The code is in good shape: the
suites are green, the type checker is clean, database authorisation genuinely
holds under an anonymous role, and the promotion migration the new engine needs
is already applied in production.

Everything blocking is **configuration and data**, not code. Three items should
be settled before volume arrives, and none of them require an engineer:

1. Sales tax is still not being collected.
2. 21 of 71 sellable doses have no oversell ceiling.
3. Live API keys sit in plaintext in the database.

---

## What was verified working

### Static checks — EXECUTED

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors** |
| `npm test` (on `e041f4d`) | **6,361 passed**, 106 skipped |
| `npm test` (on `f1ecb14`, live) | **6,376 passed / 406 files**, 106 skipped, 0 failed |

The 106 skipped are the DB-backed suites (double payout, exactly-once payout
claim, refund correctness, inventory return, invite atomicity). The prior audit
ran them against a real Postgres 16 and all passed; they were not re-run here.

### Database authorisation genuinely holds — PROD-DATA

This was tested rather than inferred. Assuming the `anon` role directly and
counting rows:

    set local role anon;
    admin_credentials 0 | admin_sessions 0 | ambassadors 0
    coupons 0 | customer_addresses 0 | payment_events 0

`orders` and `order_items` are not granted to `anon` at all — the read fails at
the grant, before RLS is consulted. Policies are admin-gated via
`current_auth_role() = 'admin'` or owner-scoped via `current_auth_uid()`.

`admin_control_current` — the view holding the store's configuration and its
secrets — is a `security_invoker`-unset view, so it *would* bypass the
underlying RLS. It is safe only because it grants nothing to `anon` or
`authenticated`. That is a single `GRANT` away from exposure; see finding 3.

Supabase's own advisor reports no `rls_disabled_in_public` error. The
`rls_enabled_no_policy` notices it does raise are all default-deny.

### The promotion engine's migration is applied — PROD-DATA

`orders.promotion_id` exists, with both `idx_orders_promotion_id` and
`idx_orders_promotion_customer`. This matters: the code degrades *silently*
without it — usage limits stop being enforced and only a `console.warn` says
so. It is applied, so limits will count.

All promotions are currently **off** (`buy_3_get_1_enabled` false,
`buy_2_get_1_half_enabled` false, no `bxgy_promotions` row). The new engine
ships dark and changes no price until an admin enables one.

### Inventory is not stuck — PROD-DATA

`reserved_quantity` totals **0** across all active products, so no abandoned
checkout is holding stock. The two critical alerts that could have caused that
(`inventory_rpc_failed` on `expire_stale_reservations`, and `cron_sweep_failed`)
both **resolved on 2026-08-28 13:48** and have not recurred; the same cron is
still firing today, which is what proves it is running.

### Order pipeline — PROD-DATA

20 orders lifetime: 8 paid, 5 canceled, 5 pending_payment, 2 payment_failed.
Deployment history shows every recent production build **READY**; no failed
builds.

---

## Findings

### 1. Sales tax is still not being collected — business decision

`nexus_states` is empty, so $0 tax is charged on every order, and has been
since 2026-08-23. This was reviewed by the owner on 2026-08-29 and deliberately
deferred, so it is restated rather than re-argued — but the reason to revisit it
is that the exposure is a function of volume, and volume is the thing about to
change. The business is registered in FL, which is where a home-state
obligation would land first. Uncollected tax cannot be retroactively charged to
a customer; it comes out of margin.

### 2. 21 of 71 sellable doses have no oversell ceiling — data

`reserve_inventory()` enforces stock only where `track_inventory = true`. This
is deliberate and documented ("TRACKED vs UNTRACKED is an EXPLICIT flag, NOT a
count of 0"), and untracked items are held to be unlimited.

Of 71 doses on active products: **50 tracked** (1,097 units), **21 untracked**.
An untracked dose will accept an unlimited quantity.

Most of that is currently masked, and it is worth being precise about why:
20 of the 21 belong to products whose `stock_status` is `Out of Stock`, and
`quoteOrder` rejects those **server-side** (`quote-order.ts:485`), not merely by
disabling a button. So they are genuinely unbuyable today.

The real exposure is the one untracked dose that is *not* out of stock —
**Bac Water (`bacteriostatic-water`)**, marked In Stock with 36 units recorded
and no ceiling. It will sell 500 units against 36 on hand without complaint.
The wider risk is that this is one admin toggle deep: flipping any of those 20
products back to In Stock re-arms the same gap.

**Suggested:** set `track_inventory = true` on Bac Water and on anything else
intended to be finite, before traffic arrives.

### 3. Live credentials in plaintext in the database — security hygiene

`admin_control_current` stores, in plaintext: a live fulfilment API key
(`api_key`, `sk_live_…`), the Resend API key, an SMTP password, and the
fulfilment `webhook_secret`.

**These are not currently reachable by an anonymous caller** — the view grants
nothing to `anon`/`authenticated`, and I verified anon reads return nothing.
So this is not an active breach. But: the values are readable by anything
holding the service-role key, they are in plaintext at rest, and the SMTP
password looks like a personal, human-chosen password rather than a generated
one — the kind that tends to be reused elsewhere.

**Suggested:** rotate all four, move them to environment variables alongside the
other secrets, and never grant this view to `anon`.

### 4. Three legacy duplicate products are live — data

`GLP-1`, `GLP-2` and `GLP-3` are `is_active = true` with machine-generated
slugs (`glp-1-legacy-b0bd1271-…`). They are Out of Stock so they cannot be
bought, but they are catalogue entries a customer can land on, and their URLs
are unpresentable. Deactivate them.

### 5. Open warning backlog — operational

Unresolved and still firing:

- `payment_reconcile_backlog` — 3 orders unresolved at the processor for over
  24h, re-firing roughly every 6h since 08-28 with nothing clearing it. The
  message says these are typically abandoned checkouts needing nothing; if so,
  clear them, because a warning that always fires is one nobody reads on the day
  it matters.
- `partner_locked_out` — approved ambassador `ZAIN` has never signed in. Their
  referral code is live and accruing commission they cannot see.
- `signup_confirmation_stalled` — accounts waiting >12h on a Supabase Auth
  confirmation email.

### 6. Confirm `ORDER_PUSH_WEBHOOK_URL` is set — operational

Commit `f1ecb14` exists because this was unset in production and **two paid
orders went unannounced**. The new code raises an alarm on `/admin/status`
instead of failing silently, but that alarm only helps if someone reads it.
Verify the variable is set in the Vercel production environment before launch —
this is the difference between knowing and not knowing that a sale happened.

### 7. Dead admin field — cosmetic

The `payment_provider` control value is written by the admin Control Centre and
read by nothing. The real provider comes from `process.env.PAYMENT_PROVIDER`
(empty resolves to `live`; `mock` is hard-blocked in production). It is
currently an empty string, which reads alarmingly and means nothing. Remove the
field or wire it up.

---

## What this audit did not cover

Stated plainly rather than implied:

- **No browser verification was run.** The purchase path, age gate and mobile
  layout were driven end-to-end in the 2026-08-29 audit against `e2c8f90`, not
  against `f1ecb14`. The delta since then touches pricing, so a single
  end-to-end purchase against the current build is the one check worth adding
  before launch.
- **The 106 DB-backed tests were not re-run** against a real Postgres here.
- **Load and concurrency were not tested.** Nothing here establishes behaviour
  under simultaneous checkouts competing for the same unit; the atomic-hold
  design is sound by inspection and was verified for replay safety, but not
  under contention.
