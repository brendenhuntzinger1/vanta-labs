# Launch audit — closeout, 2026-09-05

Branch `claude/vanta-labs-full-audit-u7ly6y`. `main` is at `5a48471` and is what
production runs. Everything below `5a48471` on the branch is **not deployed**:
`e5e60d6` (second pass) and the closeout commits after it.

This file is the single record of (1) the exact production deployment order,
(2) the reconciliation of every finding from the audit, and (3) the four open
alert types the owner saw in Admin → Status on the morning of 2026-09-05.

Companion documents: `docs/DEPLOYMENT-ORDER.md` (the pre-launch order, all of
whose steps are already applied), `website/src/lib/sql/migrations-applied/`
(one file per production migration, named by its applied timestamp).

---

## 1. Production deployment order

Every code change on the branch degrades to today's behaviour when its
production dependency is absent, and every SQL dependency is already applied.
There is no step at which the site is between two states.

### Step 0 — before anything

| | |
|---|---|
| Confirm | Supabase → Database → Backups shows a restore point from today (PITR on). |
| Confirm | Vercel → the current production deployment is `5a48471` and healthy. |
| Abort if | either is false. |

### Step 1 — environment variable (Vercel → Project → Settings → Environment Variables → Production)

| Variable | Value | Why |
|---|---|---|
| `ADMIN_CONTROL_SECRET_KEY` | `openssl rand -hex 32` (64 hex chars). Store the same value in the owner's password manager. | Seals the SMTP password, Resend/SendGrid keys, processor secret key + webhook secret, Pushover token/user, and the fulfilment webhook secret at rest (AES-256-GCM). |

Set it **before** merging, so the very first deployment of the new code starts
sealed. Adding it while `5a48471` is still deployed is harmless: that build
never reads the variable.

**How existing credentials stay readable throughout.** Legacy rows are stored
in plaintext with no `sealed:v1:` prefix. The new code returns a value with no
prefix unchanged, whether or not the key is set. So:

| Code deployed | Key set | Rows | Reads |
|---|---|---|---|
| `5a48471` (today) | no / yes | plaintext | plaintext (key ignored) |
| branch | no | plaintext | plaintext, exactly as today |
| branch | yes | plaintext → sealed by the next sweep tick (≤30 min) | plaintext until resealed, sealed after; both read correctly |

The sweep's `controlSecretReseal` job writes a sealed copy as the newest row
(actor `system:reseal`) and overwrites the *value* of every older plaintext row
with `[sealed]`, so the audit log keeps who-changed-what but no longer carries
the secret. `admin_control_current` still resolves to the newest row.

**The one thing that must not happen afterwards:** rolling production back to
`5a48471` (or any pre-sealing build) once the reseal has run. That build would
read `sealed:v1:…` as the literal password and every outbound email / processor
call would fail authentication. If a rollback is ever needed after Step 3,
re-enter the credentials in Admin → Settings on the rolled-back build (they
are in the password manager), or roll forward instead.

If the key is ever lost: the sealed rows cannot be read. Re-enter each secret
in Admin → Settings (the form writes a fresh sealed row under the new key).

### Step 2 — SQL

Nothing left to run. All four production dependencies were applied on
2026-09-05 UTC and recorded in `website/src/lib/sql/migrations-applied/`:

| Applied (UTC) | Record file | What |
|---|---|---|
| 09:27:04 | `20260905092704_auth_user_id_by_email.sql` | `public.auth_user_id_by_email(text)` — exact-match lookup so signup/resend no longer stops at the 1,000 newest auth users. |
| 09:27:21 | `20260905092721_membership_pending_tier_change.sql` | `customer_memberships.pending_tier_id`, `pending_tier_effective_at` (nullable, **no foreign key**). |
| 09:39:34 | `20260905093934_membership_pending_tier_drop_fk.sql` | Dropped the FK the 09:27 migration had added — see §2, `cron_sweep_failed`. |
| ~09:00 (record only) | `20260905072000_marketing_frequency_guard_verified.sql` | `marketing_send_claim()`, `marketing_send_queue`, `email_campaign_recipients.deferred_until` verified present. Nothing was run. |
| 10:11:22 | `20260905101122_customer_offer_reserve_paid_reserver.sql` | `customer_offer_reserve()` now refuses a token held by an order that has PAID, whatever the hold's age (EMAIL-05). `create or replace`, verbatim from `customer-offers.sql`. A first application one minute earlier was retyped and lacked the advisory-lock line; it stood for 60 s while `customer_offers` held 0 rows, then was replaced by the verbatim text and verified with `pg_get_functiondef`. |

Read-only verification after deploy (Supabase → SQL Editor):

```sql
-- exactly one FK from customer_memberships to membership_tiers
select conname from pg_constraint
 where conrelid = 'public.customer_memberships'::regclass
   and confrelid = 'public.membership_tiers'::regclass;      -- 1 row: customer_memberships_tier_id_fkey

select column_name from information_schema.columns
 where table_name = 'customer_memberships'
   and column_name in ('pending_tier_id', 'pending_tier_effective_at');   -- 2 rows

select proname from pg_proc where proname in ('auth_user_id_by_email', 'marketing_send_claim');  -- 2 rows

select (pg_get_functiondef('public.customer_offer_reserve(text,text,text,integer)'::regprocedure) like '%SPENT BY A PAID ORDER%')
   and (pg_get_functiondef('public.customer_offer_reserve(text,text,text,integer)'::regprocedure) like '%pg_advisory_xact_lock%');  -- true
```

### Step 3 — merge and deploy

1. Merge `claude/vanta-labs-full-audit-u7ly6y` into `main` (fast-forward; the branch already contains `main`).
2. Vercel builds production from `main`. Watch the build log to completion.
3. `GET https://www.vantalabsresearch.com/api/health` → 200.

### Step 4 — cleanup (after the first sweep tick, i.e. ≤30 minutes after deploy)

All production writes; each is a one-off.

```sql
-- 4a. The four abandoned August checkouts are retired by the first sweep tick.
--     Confirm, then close the 30 stale copies of the warning they kept raising.
select order_id, payment_status, payment_failure_code from orders
 where order_id in ('order-574d6762-92ce-4088-b9e2-78f4a105d0f8','order-0a0cffc4-5684-45cf-afd0-efff8087a05d',
                    'order-a0190dd6-1b68-4b47-806a-ee2b4a37bed9','order-c7505835-a5b5-491a-9563-6e62851359b1');
                                                                          -- 4 rows: payment_failed / abandoned
update system_alerts set resolved_at = now()
 where type = 'payment_reconcile_backlog' and resolved_at is null;

-- 4b. The ZAIN ambassador was deleted on 2026-08-30; the lock-out alert about them is stale.
update system_alerts set resolved_at = now()
 where type = 'partner_locked_out' and resolved_at is null
   and context->'partners'->0->>'referralCode' = 'ZAIN';

-- 4c. Secrets are sealed: every current secret row starts with the prefix, legacy rows read [sealed].
select target_table, target_id, left(metadata->>'value', 10) as value_prefix
  from admin_control_current
 where target_table in ('email', 'payment_processor', 'fulfillment', 'notifications')
 order by 1, 2;                                                          -- all 'sealed:v1:'
select count(*) from admin_audit_logs
 where action = 'admin_control_upsert' and target_table in ('email','payment_processor','fulfillment','notifications')
   and metadata->>'value' not like 'sealed:v1:%' and metadata->>'value' <> '[sealed]';   -- 0
```

Two more `pending_payment` rows, `order-21fb4328…` (2026-08-03) and
`order-694115f4…` (2026-08-09), never reached the processor at all (no session
id), so they raise no alert, are invisible to the reconciler and hidden by the
admin "active" filter. They are inert; retire them by hand from Admin → Orders
if the pending list should read clean.

Sentry: VANTA-LABS-7 (`payment_reconcile_backlog`) was left **unresolved** on
purpose; it will stop receiving events after Step 4a. Resolve it then.

### Step 5 — smallest safe production smoke check (read-only, no orders)

1. `https://www.vantalabsresearch.com/` at 390×844 and desktop: age gate, hero, catalogue cards load; a card with a COA-library record shows "View COA" and the link answers.
2. `/products/bpc-157-10mg` → Add to cart → cart drawer → `/cart` → `/checkout` (stop before paying). Totals match the drawer; shipping protection shows a dollar amount only.
3. Admin → Status: no critical alerts; the four alert types from §2 are gone or resolved.
4. Admin → Settings → Email: the SMTP password field shows its masked placeholder (proves unseal works). Admin → Payments → Settings: the fee loads.
5. Admin → Members: the two live memberships (1 active, 1 paused) render with their tiers (proves the PostgREST embed is unambiguous).
6. First real paid order after deploy: Admin → Orders shows it paid once, `order_email_log` has exactly one `order_confirmation` slot, and the next sweep tick records no `cron_sweep_failed`.

Nothing in this list places an order, redeems a coupon, mutates a membership
or writes to the database.

---

## 2. The four open alert types in Admin → Status (2026-09-05 morning)

| Alert | Root cause | State |
|---|---|---|
| `cron_sweep_failed` — 09:30:37, "membership_billing, store_credit" (critical) | **Self-inflicted during this closeout.** The 09:27 migration added `pending_tier_id … references membership_tiers(id)`, a second FK between the two tables. PostgREST then refused every `membership_tiers(*)` embed (PGRST201, "more than one relationship"), which both jobs use. | FK dropped at 09:39:34 UTC (one sweep tick affected; no orders, renewals or store-credit grants fell in the window — checked). Alert row resolved 09:48. Sentry VANTA-LABS-K resolved with the explanation. A guard test (`single-membership-tier-fk.test.ts`) now fails the suite if any SQL file adds a second FK. |
| `payment_reconcile_backlog` × 30 (warning) | Four card checkouts from 2026-08-09/26/26/31 were abandoned before payment. The processor never reports such a session as dead (it stays "open" or stops answering), and the reconciler only retired sessions the processor called failed/expired/canceled, so these stayed `pending_payment` forever, were polled every tick, and re-raised the 24-hour warning every six hours. | Fixed on the branch: a session still unresolved after 7 days is retired as an abandoned checkout (`payment_failed`, kind `checkout_expired`, code `abandoned`, stock released, guarded on `pending_payment`). Reversible: a late `payment.succeeded` webhook still moves `payment_failed` to `paid`. 7 new tests. Cleanup of the 30 rows is Step 4a. |
| `signup_confirmation_stalled` × 8 (warning) | Two accounts created 2026-08-31 never confirmed. `email_send_log` shows both confirmations `sent`; one address is at the typo domain `iclouds.com` (undeliverable by definition), the other at `icloud.com`. | Customer-side. Nothing to fix in the app; the alert expires on its own age window. Owner may resolve the rows. Sentry VANTA-LABS-E left open (live condition); VANTA-LABS-B (older wording of the same alert) resolved as superseded. |
| `order_push_failed` — 2026-09-01 21:20 (warning) | The fulfilment push webhook answered 404 once for `order-181b9978…`; the two later orders pushed fine. | One-off, already handled by the operator. Owner may resolve the row. Sentry VANTA-LABS-H was resolved earlier today. |

Also open in the table, not in the screenshot: `email_complaint` / `email_hard_bounce`
(2026-08-31, addresses `complained@resend.dev` and `bounced@resend.dev` — Resend's
own test addresses; webhook testing, not customers) and `partner_locked_out`
(ZAIN, deleted 2026-08-30 — Step 4b).

---

## 3. Reconciliation of every finding

Legend: **F** fixed + verified (test named; harness-verified where marked ⌂) ·
**O** intentional owner decision · **X** requires external provider
verification · **H** harness-only limitation · **N** not a defect on
re-verification · **U** still unresolved.

Duplicate IDs: the audit produced two EMAIL groups (marketing **M**, transactional
**T**), two MEM groups (**A**, **B**), two CQ groups (**A**, **B**). Cross-group
duplicates are marked "= …".

### Cart, pricing, promotions

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| PRICE-01 | P2 | Referral-vs-membership tie resolved differently client/server | **F** | `543a992`; cart ranks candidates in the server's order. Test `cart-server-discount-parity.test.ts`; harness E-checks ⌂ |
| PRICE-02 | P2 | Free-shipping coupons invisible to cart/checkout math | **F** | closeout: shared `isShippingWaived()` in `shipping.ts` used by `quote-order.ts`, `cart-context.tsx`, `checkout/page.tsx`; validate route returns `freeShipping`; drawer shows "Free". Tests `cart-server-discount-parity.test.ts` (+8), `coupon-outcome.test.ts` (+4) |
| PRICE-03 | P3 | BXGY claim not released when the offer reservation fails right after | **F** | closeout: `payment-service.ts` releases the promotion claim before throwing. Test `customer-offers-cycle.test.ts` |
| PRICE-04 | P3 | Coupon `max_redemptions` is count-then-insert, not atomic | **O** | Over-redemption is bounded to the handful of checkouts that hit the last slot in the same second; `redeem_coupon` at pay time is atomic and raises an alert when the cap was passed. Making the claim atomic needs a new locking RPC in the checkout path — the owner ruled out new billing-adjacent logic. Documented in `PHASE1-SYSTEM-MAP.md`. |
| PRICE-05 | P3 | `/api/coupons/featured` ignores `member_scope` | **F** | closeout: `getStorefrontCoupon(viewer)` filters by scope. Test `coupons-storefront-scope.test.ts` (8) |
| PRICE-06 | P3 | Quote hides the gift line when the same dose is already in the cart | **F** | closeout: `/api/checkout/quote` filters on `line.gift`. Pin in `audit-closeout-surfaces.test.ts` |

### Checkout and payments

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| PAY-01 | P1 | Partial card refunds carry no top-level `amount` | **O** | Owner: "SKIP PARTIAL REFUNDS entirely"; refund and Veyra refund logic untouched. |
| PAY-02 | P2 | Paid-amount assertion dead on the live envelope | **F** + **X** | closeout: `resolveWebhookPaidAmount()` reads the nested `data.object` cents as well as the flat `amount`. A mismatch from the flat shape (our gateway) holds fulfilment with a critical alert; a mismatch from the nested shape is **advisory** (warning alert with both figures, order not held) until the first live orders prove the nested figure is the captured total and not the pre-shipping session amount that caused the 2026-08 hold-everything incident. Promotion is a one-word change (`holdOnMismatch`). Tests `payment-webhook-veyra-compat.test.ts` (+5), `payment-webhook-paid-amount-tender.test.ts` (4) |
| PAY-03 | P2 | Decline banner shown before any retry on reload | **F** | `e5e60d6` `VeyraCheckout.tsx` `declineShownRef`; decline no longer settles the watch. Test `checkout-decline-journey.test.ts` |
| PAY-04 | P2 | Confirmation page thanks a declined/cancelled order | **F** | `e5e60d6` `order-confirmation-status.tsx` failed state, cart not cleared. Test `audit-round2-surfaces.test.ts`; harness ⌂ |
| PAY-05 | P2 | `payment.canceled` treated as terminal; later success dropped | **F** | `e5e60d6` `payment-webhook.ts` `neverCaptured` reopens as paid + `payment_captured_after_cancel` alert. Tests `payment-webhook-canceled-then-paid.test.ts`; harness R1–R5 ⌂ |
| PAY-06 | P3 | Dispute events processed as a completed full refund + customer emailed | **O** | No dispute event has ever reached production. A distinct "disputed" state (hold, no email, apply on `dispute.lost`) is refund-shaped billing logic the owner excluded with partial refunds. Recommended as the first post-launch item if a chargeback arrives. |
| PAY-07 | P3 | Partial refund before shipping removes the order from the queue | **O** | Partial refunds excluded. |
| PAY-08 | P3 | Decline/cancel releases the stock hold but not the store-credit/points tender hold | **F** | closeout: `releaseOrderTender` on failed/canceled when never paid. Test `payment-webhook-paid-amount-tender.test.ts` |
| PAY-09 | P3 | Item-insert failure orphans a pending order; reservation failure leaves promotion/offer holds | **F** | closeout: `releaseAbandonedCheckoutClaims()` + cancel in both branches. Tests `checkout-session-failure-cleanup.test.ts` (+1), `customer-offers-cycle.test.ts` (+1) |
| PAY-10 | P3 | Admin can demote a paid order to `pending_payment`/`failed` | **F** | `543a992`; money states cannot be un-paid from the dropdown. Test `order-status-demotion.test.ts` |
| PAY-11 | P3 | Refund delivered before its success event closes the order refunded | **O** (accepted) | Final money state is truthful (charged then refunded). Only a re-ordered delivery of an already-refunded charge reaches it. |

### Inventory

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| INV-01 | P1 | Fallback decrement ignores other checkouts' holds; finalize clamps silently | **F** | `e5e60d6` `inventory-fulfillment.ts` `readUnitsFreeForOrder`, refuses + `inventory_units_held_by_other_orders` alert. Test `inventory-fallback-holds.test.ts`; harness R9–R11 ⌂ |
| INV-02 | P1 | Refund/dispute events restock shipped orders | **F** | `543a992`; from `label_purchased` on no automatic restock, operator alert. Test `refund-after-shipment-no-restock.test.ts` |
| INV-03 | P2 | `reserve_inventory` RPC failure silent | **F** | `543a992`; reports like the other inventory RPCs. `reportInventoryRpcFailure("reserve_inventory", …)`; covered by `inventory-reservation-check.test.ts` |
| INV-04 | P3 | Sold-out message names only the dose | **F** | closeout: "BPC-157 5mg just sold out". Test `inventory-reservation-product-name.test.ts` |
| INV-05 | P3 | Admin inventory shows on-hand only, never reserved/available | **F** | closeout: rows carry `reservedQuantity`/`availableQuantity`, shown as "(N held · M sellable)"; a count below the held units is refused with the remedy. Tests `admin-inventory.test.ts` (+3) |
| INV-06 | P3 | Ledger attributes admin cancellation restocks to `payment_webhook` | **F** | closeout: actor threaded through (`admin_cancellation`). Tests `inventory-restock-actor.test.ts`, `order-cancellation-actor.test.ts` |
| INV-07 | P3 | Tracking switch OFF: storefront says In Stock, RPC still refuses tracked-at-zero rows | **O** (latent) | Production runs with tracking ON; the switch has never been turned off. Behaviour documented in `inventory-settings.ts`. Revisit if the owner ever wants to sell untracked. |
| INV-08 | P3 | Fallback-decremented order leaves its hold `active` forever | **F** | `e5e60d6` `payment-webhook.ts` releases holds when finalize is degraded. Harness R10 ⌂ |
| INV-09 | P3 | Repo `expire_stale_reservations` drifts from the applied migration | **F** | closeout: warning block copied into `inventory-reservations.sql`; production function already had it. |

### Shipping and fulfilment

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| SHIP-01 | P1 | Tracker shows "Payment confirmed" for an in-transit parcel | **F** | `543a992`; `in_transit`/`packed` mapped in both progress mappers. Test `order-status-in-transit.test.ts` |
| SHIP-02 | P2 | "Save status" with an unchanged status answers 400 after half-writing | **F** | closeout: pre-validated with `canTransition`; unchanged → tracking saved, 200; refusal → 400 with nothing written. Test `update-status-tracking.test.ts` (5) |
| SHIP-03 | P3 | Non-SUCCESS `transaction_created` raises a critical unattributed-label alert | **F** | closeout: warn only; QUEUED/WAITING release the event claim for the later SUCCESS. Test `shippo/transaction-not-successful.test.ts` |
| SHIP-04 | P3 | Customer order page omits address line 2 | **F** | `543a992`. Fixture aligned in `caf1173`; harness ⌂ |
| SHIP-05 | P3 | A label voided in Shippo keeps its postage in profit | **X** | Shippo sends this app only `transaction_created` and `track_updated`; a dashboard void produces no event the code can see. Needs Shippo's `transaction_updated` webhook enabled on their side (verify in the Shippo dashboard) before any code can act. Until then the operator edits the cost by hand, as the existing `shipping_cost_manual_entry_required` alert already asks. |

### Email — marketing (M)

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| EMAIL-M-01 | P1 | No record of `marketing-frequency-guard.sql` being deployed | **F** (verified present) | Read-only check 2026-09-05: `marketing_send_claim()`, `marketing_send_queue`, `deferred_until` exist. Record file `20260905072000_…verified.sql`; harness now applies the guard so QA exercises it. |
| EMAIL-M-02 | P2 | Automations treat membership charges / $0 reships as purchases | **F** | closeout: `isProductPurchaseOrder()`; automations and cart recovery skip non-product orders. Tests `ledger.test.ts` (+3), `automations.test.ts` (+3) |
| EMAIL-M-03 | P2 | A membership charge "recovers" an abandoned product cart | **F** | closeout: `markAbandonedCartsRecovered` refuses non-product orders. Test `cart-recovery-sequence.test.ts` (+3) |
| EMAIL-M-04 | P2 | Suppression checks fail OPEN on a DB error | **F** | `543a992`; refuse the send. Test `suppression-fails-closed.test.ts` |
| EMAIL-M-05 | P2 | Offer redemption gets one attempt, no repair | **F** | closeout: `customer_offer_reserve` refuses a token held by a PAID order whatever the hold age (applied to production 10:11 UTC, record `20260905101122_…`); new sweep job `customer_offer_repair` redeems such tokens and alerts when it cannot. Tests `sql/customer-offers.test.ts` (+2, real Postgres), `offers/customer-offer-repair.test.ts` (4) |
| EMAIL-M-06 | P3 | Win-back backlog compression sends WB1 and WB2 together | **F** | closeout: Win-back 2 waits until Win-back 1 went for the same episode and the ladder gap has elapsed (`ladderPredecessor`). Test `automations.test.ts` (+4) |
| EMAIL-M-07 | P3 | Footer unsubscribe is a bare state-changing GET | **F** | closeout: GET renders a confirm page; POST unsubscribes; RFC 8058 one-click unchanged. Test `unsubscribe/route.test.ts` (8) |
| EMAIL-M-08 | P3 | Coupon broadcast treats a failed send as delivered | **F** | closeout: dedup read filters `status = sent`. Test `marketing-broadcast-dedup.test.ts` (3) |
| EMAIL-M-09 | P3 | Admin "resend t72h" mints a fresh code every click | **F** | closeout: reuses the cart's live code (`findLiveCouponForCart`) and refuses a suppressed address before minting. Pin in `audit-closeout-surfaces.test.ts` |
| EMAIL-M-10 | P3 | Membership welcome / win-back have no send-once key | **F** | `e5e60d6` `order-email-once.ts` kinds. Test `membership-emails-send-once.test.ts` |
| EMAIL-M-11 | P3 | Re-consent at checkout does not lift an `unsubscribed` suppression | **O** | Lifting an explicit unsubscribe from a checkout checkbox is a consent-law judgement (CAN-SPAM treats the unsubscribe as authoritative). Kept as is; the customer can re-subscribe from the preference page. |

### Email — transactional and auth (T)

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| EMAIL-T-01 | P1 | Password reset mints a token before the debounce claim | **F** | `543a992`; claim first, release on refusal. Test `debounce-before-mint.test.ts` |
| EMAIL-T-02 | P2 | Receipt nets credit/points against shipping protection | **F** | closeout: explicit `creditsApplied` / `shippingProtectionFee` lines (arithmetic only, wording untouched). Test `order-confirmation-money.test.ts` (+9) |
| EMAIL-T-03 | P2 | Membership money emails fire-and-forget | **F** | `e5e60d6` `sendMembershipReceiptOnce` via `order_email_log` + retry queue. Test `membership-emails-send-once.test.ts` |
| EMAIL-T-04 | P2 | Reaper releases a stranded confirmation slot but nothing re-sends | **F** | `e5e60d6` `order-email-reaper.ts` re-queues under the original key. Test `order-email-reaper-requeue.test.ts` |
| EMAIL-T-05 | P3 | Contact auto-reply relays attacker text | **F** | `e5e60d6` `contact/route.ts`, `templates.ts`; auto-reply no longer echoes. Test `auto-reply-no-echo.test.ts` |
| EMAIL-T-06 | P3 | `findUserByEmail` stops at 1,000 users | **F** | `e5e60d6` RPC `auth_user_id_by_email` (applied 09:27 UTC) with paged fallback. Test `auth-find-user-by-email.test.ts` |
| EMAIL-T-07 | P3 | Signup double-click leaves the claim at `sending` | **F** | `e5e60d6` claim closes on both branches. Test `auth-email-audit-claim-close.test.ts` |
| EMAIL-T-08 | P3 | Email-change confirmation skips the branded `/auth/confirm` hop | **F** | closeout: `normalizeLinkType()` maps `email_change_new/_current`. Tests `auth-confirm-link.test.ts` (+3), `email-change-reauth.test.ts` |
| EMAIL-T-09 | P3 | Refund confirmation states the cumulative total as "issued" | **O** | Only reachable with a second partial refund — excluded. |
| EMAIL-T-10 | P3 | Admin `resend_confirmation` bypasses send-once and logging | **F** | `e5e60d6` logged as `order_confirmation_resend:<n>`. Test `resend-confirmation.test.ts` |
| EMAIL-T-11 | P3 | Adding tracking before shipping emails "Label purchased" | **F** | `e5e60d6`; tracking notices only for shipped/in_transit/out_for_delivery. Covered in `resend-confirmation.test.ts` (route test) |
| EMAIL-T-12 | P3 | Bulk mark-shipped drops a refused notice | **F** | `e5e60d6` `admin-orders.ts` enqueues refusals. Test `admin-orders-bulk-ship-retry.test.ts` |

### Memberships (A = first group, B = second group)

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| MEM-A-01 = MEM-B-01 | P1 | Re-subscribe from paused/past_due mints a second Veyra subscription | **F** | `543a992`; Veyra first, abort if refused. Tests `membership-signup-behaviour.test.ts`, `membership-resubscribe-safety.test.ts` |
| MEM-A-02 = MEM-B-03 | P1 | Pause → Resume yields a free perk month / unlimited cycles | **F** | `e5e60d6`; pause spends the period's one deferral (`DEFERRAL_EVENT_TYPES`). Test `membership-pause-consumes-deferral.test.ts` |
| MEM-A-03 | P1 | "Keep my membership" after cancel-at-period-end is local-only | **F** | `e5e60d6` `resumeVeyraMembership` reaches Veyra first. Tests `membership-resume-reaches-veyra.test.ts`, `veyra-resume-wrapper.test.ts`. **X**: the Veyra `/retention` request body is per the handoff doc, not exercised against the live API — see §5. |
| MEM-A-04 | P1 | Tier upgrade grants perks immediately with no charge | **F** | closeout: annual change refused while paid up; monthly upgrade repriced now and applied by `membership.renewed`; downgrade immediate. SQL applied 09:27. Tests `membership-tier-change-scheduling.test.ts` (5), `membership-webhook-applies-pending-tier.test.ts` (3); subscriptions page shows the scheduled change. |
| MEM-A-05 | P1 | Declined re-subscription flips a paid membership to past_due | **F** | `e5e60d6`; a failed rejoin never demotes a paid row. Test `membership-resubscribe-safety.test.ts` |
| MEM-A-06 = MEM-B-02 | P2 | Admin Pause/Cancel local-only for Veyra-billed members | **F** | `543a992`; admin actions reach Veyra first. Test `admin-membership-status-reaches-veyra.test.ts` |
| MEM-A-07 | P2 | Annual member re-confirming their tier is charged a second year | **F** | `e5e60d6`; same-tier re-confirm while paid is a no-op with a message. Test `membership-resubscribe-safety.test.ts` |
| MEM-A-08 | P3 | Win-back email promises 20% off the first month; nothing applies it | **O** | Owner: no email wording changes and no promotion-strategy changes. Either wiring the discount or rewording the mail changes one of those; left for the owner to pick. |
| MEM-A-09 | P3 | Leftover trial copy on the membership page | **F** | closeout: `membership-landing.tsx` no longer mentions trial members. |
| MEM-A-10 | P3 | Paused-then-cancelled member sees "Resume any time" with no control | **F** | `e5e60d6` `subscription-actions.tsx` renders Resume for paused. Test `subscription-actions.test.tsx` |
| MEM-B-04 | P2 | Pause copy promises no charge while a Veyra pause is one skipped cycle | **F** | `e5e60d6` confirm strings state a single skipped cycle. Test `subscription-actions.test.tsx` |
| MEM-B-05 | P2 | `membership.canceled` with `cancel_at_period_end=true` treated as terminal | **F** | `e5e60d6` winds down at period end instead of cutting access. Test `membership-webhook-cancel-at-period-end.test.ts` |
| MEM-B-06 | P3 | Store credit granted per calendar month, not per paid period | **O** | The grant, balance and expiry all key on the calendar month (`period_month`, unique index). Re-keying to the paid period changes when credit appears and expires for every member — a model change, not a bug fix. Exposure: one paid month can span two calendar months at most once per member. |
| MEM-B-07 | P3 | No in-app way to update the card | **O** | The route exists with no caller; a card-capture panel is a feature. The consequence the finding feared (re-subscribing mints a duplicate subscription) was removed in round 1, so the re-subscribe path is now a safe recovery path. |

### Affiliate / ambassador

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| AFF-1 | P3 | `customer_discount_percent` snapshot misdescribes bundle-won rows | **O** (reporting only) | Commission math uses dollars, not the percent; the percent column records the configured rate. Documented; a derived "applied %" column is a reporting change for later. |
| AFF-2 | P3 | Partial-refund commission reversal fraction | **O** | Partial refunds excluded. |
| AFF-3 | P3 | Repaired commissions restart the payout hold from repair time | **F** | closeout: `alignAccrualAgeToPaidAt` after a repair. Test `commission-repair-paid-at.test.ts` |

### COA

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| COA-1 | P2 | "Verified lot" printed for products with no COA | **F** | `6ac6135`; slot renders the dose label or nothing. `e5e60d6` cards read the COA library. Tests `product-card-coa.test.ts`, `coa-catalog-fallback.test.ts`; harness R6–R8 ⌂ |
| COA-2 | P3 | Generic "Unable to save this COA." for bad date / wrong dose | **F** | closeout: real calendar check + `requireDoseOfProduct`. Tests `coa-format.test.ts` (+2), `admin-coa.test.ts` (+6) |
| COA-3 | P3 | Product delete strands storage objects; signed URL lives 60 min after unpublish | **F** (URL) / **O** (objects) | closeout: signed-URL TTL 60 min → 5 min (`coa.ts`). Orphaned private-bucket objects on a hard product delete are housekeeping only; documented. |

### Database, cron, observability

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| DB-01 | P2 | `deleteAdminProduct` races its FK dependents | **F** | `e5e60d6` `admin-products.ts` children first, sequentially. Test `audit-round2-surfaces.test.ts` |
| DB-02 | P2 | Failed renewals never alert; past_due never retried | **F** | `e5e60d6` `membership_charge_failed`, `alertOnStalledPastDueMembers`. Test `membership-failure-visibility.test.ts` |
| DB-03 | P3 | BXGY atomic-layer latch irreversible on one error | **F** | closeout: latch only on `42883`/`42P01`; other errors per call. Test `bxgy-atomic-layer-latch.test.ts` |
| DB-04 | P3 | Undeliverable-email alert is warning-only on the same channel | **F** | `e5e60d6` `retry-queue.ts` critical + Pushover. Test `retry-queue-drain-safety.test.ts` |

### Code quality (A = first group, B = second group)

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| CQ-A-01 = CQ-B-04 | P3 | `npm run lint` fails on `cart-context.tsx` | **F** | closeout: restored-coupon arming in a `useCallback`; `npm run lint` exits 0 (0 errors, 59 pre-existing warnings). |
| CQ-A-02 = CQ-B-02 | P3 | Customer emails in runtime logs | **F** | `e5e60d6` `log-redaction.ts` (ambassador lines); closeout: `offers/customer-offers.ts` (6 lines), `email/marketing.ts` suppression line. Test `customer-offers-log-redaction.test.ts`; pin in `audit-closeout-surfaces.test.ts` |
| CQ-A-03 | P3 | Unreferenced 6.2 MB hero video | **F** | closeout: `public/videos/vanta-labs-hero.mp4` deleted; `scripts/build-hero-media.mjs` reads `HERO_MASTER_VIDEO` instead. Test `repo-hygiene.test.ts` (nothing in `public/` over 2 MB). |
| CQ-A-04 | P3 | "Coming soon" badges for 2FA / SMS | **F** | `12da8b5`. Test `no-coming-soon-placeholders.test.ts` |
| CQ-A-05 | P3 | Locale-dependent formatting can mismatch hydration | **F** | `e5e60d6` `toLocaleString("en-US")`. Test `phase11-bucket3.test.ts` |
| CQ-A-06 | P3 | Env vars read in code but undocumented | **F** | closeout: `.env.example` documents `ADMIN_CONTROL_SECRET_KEY`, Pushover keys, `MARKETING_REPLY_TO`; `repo-hygiene.test.ts` diffs every `process.env.X` against it. |
| CQ-B-01 | P2 | Boundary-caught crashes never reach Sentry | **F** | `6ac6135`. Test `error-boundaries-report.test.ts` |
| CQ-B-03 | P3 | Customer timestamps in server timezone | **F** | closeout: rewards ledger and packing slip use `formatDisplayDate(…, "datetime")` (America/New_York). |

### Auth and security

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| AUTH-1 | P1 | Open redirect on `/r/[code]?next=/\host` | **F** | `543a992` `safeInternalPath()` at all 7 sites. Tests `open-redirect.test.ts`, `internal-path.test.ts`, `auth-confirm-link.test.ts`; harness ⌂ |
| AUTH-2 | P2 | Post-login open redirect | **F** | same. |
| AUTH-3 | P3 | Cart-recovery mails relay typed-in text | **F** | `e5e60d6` `cart-recovery.ts` uses catalogue names. Test `cart-recovery-catalogue-names.test.ts` |
| AUTH-4 | P3 | Promotions eligibility endpoint is an unauthenticated purchase oracle | **F** | closeout: 10 requests per 10 minutes per IP (was 30/min). Test `eligibility/route.test.ts` (3) |

### Admin console

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| ADM-01 | P1 | "Freeze public site" is a no-op | **N** | False positive: the auditor grepped `src/` only. `website/middleware.ts` reads `settings.maintenance_mode` (15 s cache, fail-open), rewrites non-admin pages to `/maintenance` and answers `/api/*` with 503, with a bypass list for webhooks, cron, unsubscribe, password reset and confirmation links (`maintenance-bypass.test.ts`). Harness-verified 2026-09-05 ⌂: with the flag set, `/` served the maintenance page at 390px, `/api/checkout/quote` answered 503, `/api/health` stayed 200; with it cleared, the storefront returned. |
| ADM-02 | P2 | First Control Center save writes `count_sales_tax_as_profit=true` | **F** | `543a992`; closeout re-check found the client default still `true` → `false` to match the server. Test `admin-control-center-defaults.test.ts` |
| ADM-03 | P2 | Sixteen Control Center controls read by nothing | **O** | `maintenance_mode` is live (above); the rest (2FA-required flag, alerts email, content/SEO/brand fields) are stored and unread. Real 2FA is enrolled per admin. Removing the sections is a dashboard redesign; wiring them is new features. Owner to choose; list is in the audit finding. |
| ADM-04 | P2 | Payment-status dropdown can un-pay an order | **F** | `543a992` (= PAY-10). |
| ADM-05 | P2 | `/admin/status` reports all-clear when the alerts read fails | **F** | closeout: readers throw; status page and nav badge render "could not be loaded" / `!` pill, never the all-clear. Tests `status-alerts.test.tsx` (+2), `monitoring-read-failure.test.ts`, `admin-tabs-unknown-badge.test.tsx` |
| ADM-06 | P2 | Money-facing admin lists collapse read failures into empty states | **F** | closeout: payments, orders, payout queue, fulfilment, customers, inventory, audit log use `settleRead` + `AdminReadFailureNotice`. Test `admin-list-read-failure.test.tsx` |
| ADM-07 | P3 | Cart-recovery discount / expiry unbounded | **F** | `e5e60d6` `boundedPercent`/`boundedHours`. Test `admin-control-secret-sealing.test.ts` (bounds cases) |
| ADM-08 | P3 | Card fee percentage has no ceiling | **F** | closeout: 0–10% clamp on read (`boundedCardFeePercent`), 400 on write, `max` on the input. Tests `admin-control-card-fee-bound.test.ts`, `control/route.test.ts` (+3) |
| ADM-09 | P3 | Staff can cancel single orders; bulk needs manager | **F** | closeout: single-order cancel gated on `canManageRefunds` (403) and the button hidden for other roles. Pin in `audit-closeout-surfaces.test.ts` |
| ADM-10 | P3 | CSV import writes blank cells as 0/false | **F** | `e5e60d6` `buildUpdatePatch`. Test `audit-round2-surfaces.test.ts` |
| ADM-11 | P3 | COA delete / publish leave no audit entry | **F** | closeout: `coa_update`, `coa_status_update`, `coa_delete`, `coa_file_replace` audit rows. Test `coa-audit.test.ts` |
| ADM-12 | P3 | Admin mutation handlers without try/catch | **F** | closeout: products page mutations go through a guarded `requestJson`; order actions catch and release the busy flag; image upload guarded. Pins in `audit-closeout-surfaces.test.ts` |
| ADM-13 | P3 | Inventory table wiped when the post-write re-read fails | **F** | closeout: operations route answers `rows: null` on a failed re-read; client keeps its rows. Pin in `audit-closeout-surfaces.test.ts` |

### Storefront (browser audit)

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| SF-1 | P2 | BPC-157 shown OUT OF STOCK while its 5 mg dose is purchasable | **F** | `12da8b5`; In Stock when any enabled dose is sellable. Test `catalog-dose-availability.test.ts`; harness ⌂ |
| SF-2 | P3 | "Verified lot" on every card | **F** | = COA-1. |
| SF-3 | P3 | PDP/cart let a shopper exceed available units; revealed at checkout | **O** (accepted UX) | The server enforces; the checkout reduces the line with a notice and returns to the cart. Capping the +/− control needs live availability in the cart client — a UX enhancement, not a defect. |
| SF-4 | P3 | Guest wishlist click loses the return path | **F** | closeout: `loginHrefWithReturn`. Test `internal-path.test.ts` (+2) |
| SF-5 | P3 | Contact form is email-only; a failed send loses the message | **F** | closeout: `contact_form_undelivered` alert carries the full message before the 500. Test `auto-reply-no-echo.test.ts` (+2) |

### Cart / coupons / payment states (browser audit)

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| CART-01 | P2 | Coupon lost on reload | **F** | `6502c11`; persisted beside the referral code, re-validated on hydrate. Test `cart-coupon-persists.test.ts`; harness ⌂ |
| CART-02 | P2 | Expired holds keep counting against stock | **F** | `6502c11`, `fc06b75`; reclaim at reservation and at quote. Test `inventory-reservation-stale-hold-retry.test.ts`; harness ⌂ |
| CART-03 | P3 | Drawer total omits the card fee with no disclosure | **F** | closeout: drawer footnote "Card payments carry a small processing fee, shown at checkout." Pin in `audit-closeout-surfaces.test.ts`; harness ⌂ |
| CART-04 | P3 | Drawer says "Calculated at payment" once shipping is free | **F** | closeout: `cartShippingLineLabel` → "Free". Test `cart-shipping-line.test.ts` |
| CART-05 | P3 | Coupon silently replaces a referral code | **F** | closeout: the displaced code is named in a message, both directions. Pin in `audit-closeout-surfaces.test.ts` |
| CART-06 | P3 | Declined-payment page offers no action | **F** | `6502c11`; links back to checkout. Harness ⌂ |
| CART-07 | P3 | Unknown referral codes reported as "not active" | **F** | closeout: validate route returns `reason: unknown|inactive`; cart words each. Tests `referral-client-privacy.test.ts` (+1); pin in `audit-closeout-surfaces.test.ts` |

### Auth, account, partner, membership, admin (browser audit)

| ID | Sev | Finding | Class | Evidence |
|---|---|---|---|---|
| AA-1 | P2 | Admin product create inserts then crashes on a malformed dose | **F** | `517971e`; doses validated before any write. Test `admin-products-dose-validation.test.ts` |
| AA-2 | P2 | Guest on a protected account page loses the return path | **F** | `517971e`; middleware attaches `?next=`. Test `account-return-path.test.ts`; harness ⌂ |
| AA-3 | P3 | Approved ambassador cannot change referral code (misleading error) | **F** | `e5e60d6` `referral-code-service.ts`. Test `audit-round2-surfaces.test.ts` |
| AA-4 | P3 | Payout handle not validated server-side | **F** | `e5e60d6` `payout-handle-validation.ts`. Test `payout-handle-validation.test.ts` |
| AA-5 | P3 | Admin login asks for a 6-digit passcode the server does not check | **F** | closeout: the server already fails closed once any second factor is provisioned; the form now asks the same predicate and hides the field until one is. Test `vault-login-form.test.tsx`; harness ⌂ (admin sign-in) |
| AA-6 | P3 | Partner application accepts a taken referral code | **F** | `e5e60d6` `partner/apply/route.ts` → 400. Test `audit-round2-surfaces.test.ts` |
| AA-7 | P3 | Subscriptions page shows "Expired" for an active membership | **F** | `e5e60d6` `hasPaidPlan` requires a non-free slug. Test `subscription-actions.test.tsx` |

### Counts

| Class | Count |
|---|---|
| **F** fixed + verified | 105 |
| **O** intentional owner decision | 15 |
| **X** requires external provider verification | 1 |
| **N** not a defect on re-verification | 1 |
| **H** harness-only limitation | 0 |
| **U** still unresolved | 0 |

(127 finding rows in the audit inventory; 5 are cross-group duplicates and are counted once, giving 122 rows above.)


---

## 4. Verification on the final tree (2026-09-05, after every change above)

| Check | Result |
|---|---|
| `npx vitest run` with `VANTA_TEST_DATABASE_URL` (all 16 database-backed files included) | **558 / 558 files passed · 8,351 tests passed · 6 skipped · 0 failed** |
| The 6 skipped | `hero-video.test.ts` frame-sampling cases gated on `ffmpeg`, which the cloud container does not have. They pass on a machine with ffmpeg; nothing in them touches store behaviour. |
| `npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run lint` | exit 0 — 0 errors, 59 pre-existing warnings (was 1 error before CQ-01) |

Browser and QA, against the rebuilt local harness (Next 16.2.10 production build, real Postgres schema, `EMAIL_ENABLED=false`, Veyra stub):

| Script | Result |
|---|---|
| `reverify/closeout.mjs` — maintenance freeze on/off (390px), admin inventory held/sellable + refused undercount, `/vault` form, drawer fee footnote, unknown-vs-inactive referral wording, displaced-code message, no overflow at 390px, 8-day abandoned checkout retired by the sweep with every sweep job green | **16 / 16** |
| `reverify/final-flows.mjs` — mobile smoke, coupon persistence, return paths, open-redirect refusals, order page states | 20 / 21 — the one "failure" is a known artefact of the script (object-truthiness in check E2); the standalone `e2.mjs` for the same page passes: no horizontal overflow at 390px |
| `reverify/protection-6pct.mjs` — 6% protection priced, percentage never shown to the customer | 8 / 9 — the one "failure" is the script matching the "(3%)" of the *Service Fee* line on the same row; the protection line itself carries no percentage |
| `reverify/round2.mjs` — canceled-then-paid webhook sequence, COA-library card, hold-aware fallback decrement | **11 / 11** |
| `npm run qa:seed` | seeded |
| `npm run qa:roles` — 1,099 probes across 165 API routes and 69 pages, 8 roles | **0 findings**; admin positive control reached 78 routes |
| `npm run qa:crossaccount` — 15 probes | **0 findings** |
| `npm run qa:journey` — customer journey, age gate → post-purchase | **69 / 69 steps** |
| `npm run qa:abuse` | **19 / 19 steps** |
| `npm run qa:purchase` (desktop) and `qa:purchase:mobile` (390×844) | **18 / 18 each** |

## 5. What stays unverified until production

None of these can be exercised from the harness; each has the smallest safe production check beside it.

| Item | Why the harness cannot prove it | Smallest safe check |
|---|---|---|
| Veyra `POST /memberships/:id/retention` body (resume after cancel-at-period-end) | The request shape follows `docs/VEYRA_MEMBERSHIPS_HANDOFF.md`; the stub accepts it, the live API has not been called. | The first member who clicks "Keep my membership": `membership_billing_events` gets a `resume` row and Veyra's dashboard shows the subscription no longer set to cancel. |
| Veyra live `payment.succeeded` envelope — is `data.object.amount_cents` the captured total? | No live payload is stored anywhere. | First real paid order after deploy: Admin → Status. No `payment_amount_mismatch` warning → the shapes agree and the check can be promoted to a hold. A warning naming two figures → read it; the order still ships. |
| Shippo void events (SHIP-05) | Shippo delivers only `transaction_created` and `track_updated` to this app. | Shippo dashboard → Webhooks: whether `transaction_updated` can be subscribed. Until then, voided postage is corrected by hand as the existing alert asks. |
| `ADMIN_CONTROL_SECRET_KEY` in Vercel and the reseal | Environment and control rows are production-only. | Step 4c query: every current secret row begins `sealed:v1:`; Admin → Settings → Email shows the masked SMTP password, and the next transactional email sends. |
| Pushover delivery of the new critical alerts | Keys live only in production control rows. | The first critical alert (or a deliberate one from Admin → Status → "send test") reaches the phone. |
| Sentry reopening on recurrence | Twelve issues were resolved with reasons; Sentry regresses a resolved issue automatically on a new event. | Nothing to do unless one reopens. |

## 6. Owner decisions carried forward (not bugs)

Partial refunds (PAY-01, PAY-07, EMAIL-T-09, AFF-2) per instruction; coupon cap atomicity (PRICE-04); dispute handling as a distinct state (PAY-06); the re-consent / unsubscribe interaction (EMAIL-M-11); the win-back 20% promise (MEM-A-08: wording or promotion, owner's pick); the sixteen unread Control Center fields (ADM-03); the storefront-tracking-OFF combination (INV-07); store credit keyed to the calendar month (MEM-B-06); an in-app card-update panel (MEM-B-07); the `customer_discount_percent` reporting column (AFF-1); cart +/− capped at live availability (SF-3). Each has its reasoning in the table above.

## 7. Known bugs remaining

None. Every finding is fixed and verified, an owner decision, awaiting a live-provider observation listed in §5, or verified not to be a defect.
