# Vanta Labs — Database Documentation

Production reference for the Supabase (PostgreSQL) schema behind the store:
every table, its purpose, relationships, row-level security (RLS), indexes,
and how data flows from checkout to payouts and analytics.

- **Engine:** Supabase / PostgreSQL. Schema lives as idempotent SQL in
  `src/lib/sql/*.sql` (hand-run in order; no ORM/migration runner).
- **Access:** all app writes/reads go through the service-role client
  (`src/lib/supabase-server.ts`, `server-only`). The browser only uses the
  anon key. Internal/operational tables have RLS enabled with no public
  policies (service-role only); customer-owned tables are scoped by
  `auth.users`.
- **Config-as-data:** several "settings" live as rows in `admin_audit_logs`
  (action `admin_control_upsert`) rather than dedicated tables — see
  `src/lib/admin-control.ts`. This is called out per section below.

> **Naming note.** This document also maps the current table names to a
> proposed canonical scheme (see **Appendix A**). The canonical rename was
> **not** applied automatically because renaming live tables requires a
> coordinated data migration + code update across ~40 tables and can only be
> verified against the live database; doing it blind would risk breaking the
> running store. Appendix A gives a safe, phased plan to adopt the canonical
> names when you're ready.

---

## End-to-end data flow

```
Customer browses                 products, product_doses, product_images, coupons
        │                        (COA links: products.coa_url → COA Library)
        ▼
Adds to cart (localStorage)      abandoned_carts (+ abandoned_cart_emails recovery)
        │
        ▼
Checkout — picks payment method  payment method + card-fee config (admin_audit_logs)
        │  server prices order   src/lib/payment-service.ts (authoritative totals)
        ▼
Order created (pending_payment)  orders + order_items
        │
        ├── Card ──► hosted processor (stub today) ──► webhook /api/webhooks/payment
        │                                              payment_events (idempotency)
        │
        └── Cash App / Zelle / PayPal
                customer submits proof  ──► orders.payment_status = awaiting_verification
                                            payment_reference, payment_proof_url (private bucket)
        ▼
Admin approves payment           finalizeManualPayment() → orders.payment_status = paid
        │                        commissions/referral_orders, points_ledger, coupons,
        │                        email_send_log, order confirmation email
        ▼
Owner packs the order            fulfillment_status ready_to_fulfill → packed
        │                        order_status_history (every transition + source)
        ▼
Buys the postage from Shippo     orders.label_purchase_claimed_at (exactly-once claim)
        │  parcel = preset dims  shipping_package_presets + products/product_doses
        │  + summed unit weights .shipping_weight_oz (src/lib/shippo/parcel.ts)
        │                        orders.shippo_shipment_id / _rate_id / _transaction_id,
        │                        label_url, postage_cost_cents (exact, integer cents)
        ▼
Profit finalized on the label    recordActualShippingCost() → actual_shipping_cost_cents,
        │                        profit_finalized, order_shipping_cost_audit
        ▼
Shippo tracking webhook          shippo_webhook_events (idempotency), then the
        │                        out-of-order-safe transition in order-pipeline.ts
        ▼
Order updated in real time       orders.fulfillment_status, orders.tracking_number,
        │                        shipped_at / delivered_at, order_shipments
        ▼
Customer notified                shipping-update email (email_send_log)
        ▼
Payouts & analytics              commissions/partner_payouts (ambassadors),
                                 website_analytics_events (traffic/sales)
```

---

## Section 1 — Products

| Table | Purpose |
|---|---|
| `products` | Master catalog. Slug, name, category, base `price`, `stock_status`, `inventory_quantity`, `low_stock_threshold`, `coa_url`, `image_url`, `shipping_weight_oz`, enable/archive flags. `category` is a column (there is no separate `categories` table). |
| `product_doses` | Dose/size **variants** of a product (e.g. 5mg/10mg): label, sku, price/sale price, per-variant `stock_status`, `inventory_quantity`, `shipping_weight_oz`, default flag. FK → `products`. |
| `product_images` | Gallery images for a product (url, alt, sort). FK → `products`. |
| `inventory_items` | Legacy/standalone inventory table — **not used by app code** today (real stock lives on `products`/`product_doses`). Candidate for removal (Appendix B). |

- **COAs** are not a separate table: each product carries `coa_url`; the COA
  Library reads them via `getCoaRecords()` (`src/lib/catalog.ts`).
- **`shipping_weight_oz`** is the packaged weight of ONE unit in ounces, used to
  build the Shippo parcel (Section 5). On `products` it defaults to `0.5`; on
  `product_doses` it is nullable and `NULL` means **inherit the parent
  product's** weight, since dose variants usually weigh the same.
- **Indexes:** slug (unique), category, enabled/archived filters.
- **RLS:** public read of enabled products via the catalog API (server); writes
  service-role only.

## Section 2 — Orders

| Table | Purpose |
|---|---|
| `orders` | The order record and its full money breakdown. Key columns below. |
| `order_items` | Line items: `product_id`, `product_name`, `unit_price`, `quantity`, `line_total`. FK → `orders(order_id)`. |
| `order_shipments` | Shipment/tracking per order: `carrier`, `tracking_number`, `shipping_status`, `estimated_delivery`. Unique on `order_id` (upsert target). |
| `order_status_history` | Append-only log of every `fulfillment_status` transition: `from_status`, `to_status`, `source` (`admin`/`shippo`/`system`), `actor`, `created_at`. Deliberately **no FK** to `orders` — an audit trail must never block a status write or be cascade-deleted with the order. |
| `payment_events` | Webhook idempotency ledger: `event_id` (PK), `order_id`, `status`, `processed_at` (completion marker; `claimed_at` records the claim). Prevents double-processing of card webhooks. |

**`orders` key columns:** `order_id` (text UUID, PK-ish unique), `order_number`
(short human code, e.g. `VL-1A2B3C4D`), `payment_id`, `payment_method`,
`payment_status`, `fulfillment_status`, money (`subtotal`, `shipping_amount`,
`handling_fee`, `tax_amount`, `discount_amount`, `card_processing_fee`,
`amount_paid`, `refund_amount`), promo (`referral_code`, `ambassador_id`,
`coupon_code`, `bulk_discount_tier/amount`, `points_redeemed/earned`),
manual-payment proof (`payment_reference`, `payment_proof_url`,
`payment_submitted_at`, `verified_at`, `verified_by`, `rejection_reason`,
`payment_rejected_at`), customer (`customer_email/name`, address fields,
`customer_user_id` → `auth.users`), `tracking_number`, `paid_at`, timestamps,
plus the shipping/label columns in Section 5.

- **`payment_status`:** `pending_payment` → (`awaiting_verification` for manual)
  → `paid` / `payment_rejected` / `payment_failed` / `refunded` /
  `partially_refunded` / `canceled`.
- **`fulfillment_status`:** `awaiting_payment` → `paid` → `ready_to_fulfill` →
  `packed` → `label_purchased` → `shipped` → `in_transit` →
  `out_for_delivery` → `delivered`, plus the terminals `cancelled` /
  `refunded` / `returned`. The transition rules live in
  `src/lib/order-pipeline.ts`.
  **Legacy values are still in the table** and are mapped forward on read
  (`awaiting_fulfillment`/`processing` → `ready_to_fulfill`, `pending` → `paid`,
  `fulfilled`/`partially_fulfilled` → `shipped`). There is intentionally **no
  CHECK constraint** on this column: adding one validates against existing rows
  and would either fail the migration or reject writes on historical orders.
- **Order status history** is now a dedicated `order_status_history` table
  (customer-visible timeline + out-of-order webhook forensics), in addition to
  the admin action trail in `admin_audit_logs` (`target_table='orders'`).
- **Carts:** no server-side cart table — the live cart is browser
  `localStorage`; `abandoned_carts` (Section 9-adjacent) persists snapshots for
  recovery.
- **Indexes:** `created_at desc`, `payment_status`, `payment_method`,
  `order_number` (unique), `customer_email`, `ambassador_id`, `referral_code`.
- **RLS:** enabled; service-role for admin, owner-scoped reads for a customer's
  own orders.

## Section 3 — Customers

| Table | Purpose |
|---|---|
| `auth.users` (Supabase) | The customer identity/account. Referenced by `orders.customer_user_id` and the tables below. |
| `customer_addresses` | Saved shipping/billing addresses. Scoped by `user_id`. |
| `customer_preferences` | Per-customer profile/preferences (marketing opt-ins, etc.). |
| `customer_memberships` | A customer's membership: tier, status, billing dates. FK → `auth.users`, `membership_tiers`. |
| `membership_tiers` | Membership plan definitions (name, price, points-per-dollar, perks). |
| `membership_billing_events` | Membership billing lifecycle log (trial, remainder, renewal, failure). |
| `wishlist_items` | Customer wishlist entries. Scoped by `user_id`. |

- There is no separate `customer_profiles`/`customer_accounts` table — identity
  is `auth.users` plus `customer_preferences`.
- **RLS:** owner-scoped (`user_id = auth.uid()`), verified in the security audit.

## Section 4 — Payments

| Concern | Where it lives |
|---|---|
| Payment method + card-fee **settings** | `admin_audit_logs` control snapshot, sections `payment_methods` / `payment_processor` (`src/lib/admin-control.ts`, `payment-methods.ts`, `payment-processor-config.ts`). Defaults are placeholders; admins edit them in **Admin → Payments → Settings** and **Settings**. |
| Payment **transactions** | `orders` (amount, method, status, proof) + `payment_events` (webhook idempotency). No separate `payment_transactions` table — the order is the transaction. |
| Manual-payment **proof** | `orders.payment_reference` (transaction id) + `orders.payment_proof_url` (path into the **private** `payment-proofs` storage bucket; admins view via short-lived signed URLs). |
| Refunds | `orders.refund_amount` / `refunded_at` + an `order_refund` row in `admin_audit_logs`. |
| Payout records | Ambassador payouts: `payouts` / `partner_payouts`. There are no fulfilment payouts — the store fulfils its own orders and pays Shippo per label (`orders.postage_cost_cents`, Section 5). |
| Express (Apple Pay) checkout | `express_checkout_intents` + `express_shipping_quotes` (`src/lib/sql/express-checkout.sql`). See below. |

### Express (Apple Pay) checkout tables

The mini-cart wallet lane has a problem the card lane does not: the payment
sheet must show an amount **before** any address exists, then charge that
amount plus shipping and tax resolved mid-sheet. These two tables are what make
that provable rather than hopeful.

| Table | Purpose |
|---|---|
| `express_checkout_intents` | The cart + price snapshot frozen when the sheet is armed, paired 1:1 with a processor session. `amount_cents` is the authoritative address-independent amount the sheet opens on; the charge is that plus locked shipping plus locked tax and nothing else. `consumed_at` is the atomic single-charge claim (NULL → now(), once, immediately before the charge). `compliance_ack` is the consent record for an express order — `orders` has no column for it. `outcome` is the terminal result, replayed to a duplicate authorize so a double-tap can never charge twice. |
| `express_shipping_quotes` | Every shipping + tax quote returned to the wallet callback, keyed by a fingerprint of the address that produced it. Authorization recomputes that fingerprint from the address actually being charged and refuses any method not in the matching row — which is what stops a stale wallet cache charging one address's sales tax against another's. Append-only; it is the audit trail. |

Both are service-role only (RLS on, no policies): an intent row carries the
authoritative charge amount, so a client that could write one could choose its
own price.

`orders.checkout_channel` distinguishes the lane (`express_apple_pay`), and
`orders.payment_id` carries the processor session id from the moment the order
is written — that is what lets the reconciliation sweep settle a charge whose
webhook was lost.

## Section 5 — Self-fulfillment (Shippo)

Vanta Labs packs and ships **every order itself** and buys postage directly from
Shippo. There is no outside fulfiller, no provider adapter, no outbound
transmission and no provider payout — so the database holds the facts a 3PL used
to hold: the parcel, the label, the exact postage, and the tracking timeline.
Schema: `src/lib/sql/self-fulfillment-shippo.sql`.

| Table | Purpose |
|---|---|
| `shipping_package_presets` | The boxes/mailers the owner ships in: `name`, `length_in`, `width_in`, `height_in`, `empty_weight_oz` (tare, added **once** per parcel), `is_default`, `is_active`. Seeded with `Standard Vanta Mailer` (9×6×3 in, 1.5 oz). A **partial unique index on `is_default`** guarantees at most one default, because parcel math resolves "order names no preset" to *the* default and two defaults would make that non-deterministic. |
| `shippo_webhook_events` | Tracking-webhook idempotency: `event_key` (PK, derived from the payload), `received_at` (claim), `processed_at` (completion). Shippo delivers at-least-once; the PK collision drops a duplicate before it can re-send a shipping email. |
| `order_status_history` | The fulfillment timeline (Section 2). Shippo events arrive **out of order**, so the ordered log is what explains a status. |

**`orders` shipping/label columns** (all nullable — an order exists long before a
label does, and legacy orders never get one):

| Column | Purpose |
|---|---|
| `shippo_shipment_id`, `shippo_rate_id` | The quote the owner picked, kept for re-attempts and for auditing the price shown against the price paid. |
| `shippo_transaction_id` | The purchased label. Also the **short-circuit**: set and not voided ⇒ return the existing label instead of buying another. |
| `shipping_carrier`, `shipping_service` | `USPS`/`UPS`/`FedEx` and the service level bought. |
| `label_url`, `label_purchased_at`, `label_voided_at` | The 4×6 PDF and its lifecycle. A void must also reverse the recorded cost so profit stops carrying a refunded charge. |
| `postage_cost_cents` | The **exact** amount Shippo charged, integer cents parsed from the rate string. Never `0` as a stand-in for unknown — unknown stays `NULL` and the UI shows "Pending". Fed to `recordActualShippingCost()` (Section 4 profit reconciliation). |
| `package_preset_id` | FK → `shipping_package_presets(id)`, `on delete set null` so retiring a box never touches an order. `NULL` ⇒ use the default preset. |
| `parcel_weight_oz_override` | **Replaces** (does not add to) the computed parcel weight for the odd order the math gets wrong. |
| `packed_at`, `shipped_at`, `delivered_at` | Pipeline timestamps. |
| `label_purchase_claimed_at` | **Exactly-once claim for buying a label** — see below. |

- **Exactly-once label purchase.** `update orders set label_purchase_claimed_at
  = now() where order_id = $1 and label_purchase_claimed_at is null returning
  id` — Postgres serializes concurrent updates on the row lock, so exactly one
  caller may call Shippo; losers return the **existing** label rather than an
  error. A failed Shippo call sets the column back to `NULL` so a genuine retry
  can proceed (hence a nullable timestamp, not a boolean). Same proven pattern
  as `orders.inventory_restocked_at` and `orders.paid_side_effects_at`.
- **Parcel math** (`src/lib/shippo/parcel.ts`, pure + unit tested):
  `preset.empty_weight_oz + Σ(unit weight × quantity)`, where a unit weight is
  `product_doses.shipping_weight_oz ?? products.shipping_weight_oz ?? 0.5`;
  `parcel_weight_oz_override` replaces the total; the final value is clamped to
  a minimum of 0.1 oz because Shippo rejects zero/negative weight.
- **Config:** the Shippo token lives in the **server environment**
  (`SHIPPO_API_TOKEN`, read only by `src/lib/shippo/config.ts`) — never in the
  database and never readable through an admin API. The only fulfilment setting
  stored as data is inventory tracking (`admin_audit_logs` section `inventory`,
  `src/lib/inventory-settings.ts`); `src/lib/fulfillment-settings.ts` joins the
  two for the admin screen.
- **Indexes:** `orders(shippo_transaction_id)` and `orders(tracking_number)`
  (partial, non-null) — a tracking webhook identifies the order by one of those,
  never by `order_id`; `orders(order_id) where label_purchase_claimed_at is
  null` for the "needs a label" queue; `order_status_history(order_id,
  created_at desc)` for the timeline.
- **RLS:** service-role only (operational tables, no policies). Presets are
  included: a client able to write one could shrink the box under a pending
  label purchase and change what the store is charged.

## Section 6 — Ambassadors / Affiliate Program

| Table | Purpose |
|---|---|
| `ambassadors` | Ambassador accounts: name, email, `referral_code`, `commission_percent`, `status`, `auth_user_id`. |
| `partners` | Partner mirror of ambassadors (same UUID) referenced by `commissions` FKs and payout/name lookups. |
| `referrals` | Referral relationships / attribution. |
| `referral_orders` | Per-order commission ledger: `commission_percent/amount`, `payment_status`, fraud flags, review flags. Unique on `order_id`. |
| `commissions` | Mirror of commission records keyed to `partners` for payout/reporting. |
| `commission_tier_rules` | Tiered commission rules (volume → percent). |
| `partner_clicks` | Referral link click tracking (the `referral_clicks` concept). |
| `partner_payouts` / `payouts` | Ambassador payout records (the `commission_payouts` concept). |
| `partner_program_stats` | Cached/aggregated partner program stats. |

- `ambassadors` ↔ `partners` are a **dual-write with a shared UUID**; keep them
  in sync (see Appendix B robustness note).
- **RLS:** ambassador-owned reads via the partner portal; admin via
  service-role.

## Section 7 — Shipping

- Shipping **rates/rules charged to the customer are computed in code**
  (`src/lib/shipping.ts`: domestic vs international thresholds, flat fees,
  free-shipping, 5% handling fee, configurable tax) plus the admin control
  snapshot section `shipping` (`tax_rate`). There are no `shipping_rates` /
  `shipping_rules` tables. This is what the buyer pays and is independent of
  what the label actually costs.
- Shipping **labels/postage/tracking** live on `orders` (the Shippo columns) +
  `order_shipments` + `order_status_history` — see **Section 5**. Postage the
  store pays is `orders.postage_cost_cents`; it is reconciled into profit via
  `recordActualShippingCost()`, so the customer-facing `shipping_amount` and the
  real postage stay separate numbers.
- **Parcel dimensions** come from `shipping_package_presets`; **parcel weight**
  from `products`/`product_doses.shipping_weight_oz` (+ the preset tare), or
  `orders.parcel_weight_oz_override` when the owner overrides the whole total.

## Section 8 — Discounts & Promotions

| Table / store | Purpose |
|---|---|
| `coupons` | Coupon codes: type (percent/fixed), value, expiry, `max_redemptions`, `redemptions_count`, `assigned_email`, `source`. |
| `points_ledger` | Loyalty **reward points** ledger (earn/redeem/reverse). |
| `promotional_point_events` | Point multipliers / promotional point campaigns. |
| Promotions config | `admin_audit_logs` section `promotions` (Buy-3-Get-1, etc.). |
| Bulk discounts config | `admin_audit_logs` section `bulk_savings` (elite bulk tiers). |

- The "one discount per order, greatest wins" rule is shared client/server
  (`src/lib/discount-resolution.ts`).

## Section 9 — Analytics

| Table / source | Purpose |
|---|---|
| `website_analytics_events` | Raw event stream: page views, sessions, purchases, refunds, UTM, device. The single source for traffic + sales analytics. |
| Sales analytics | Computed from `orders` (`src/lib/admin-revenue.ts`, `admin-analytics.ts`). |
| Customer / inventory metrics | Computed on demand from `orders`, `products`. |
| `abandoned_carts` / `abandoned_cart_emails` | Cart-recovery funnel + send tracking. |

- There are no separate `sales_analytics` / `traffic_analytics` /
  `customer_metrics` / `inventory_metrics` tables — these are **derived views**
  computed from `website_analytics_events` + `orders` + `products`.

## Section 10 — Admin & System

| Table | Purpose |
|---|---|
| `admin_credentials` | Admin logins: username, scrypt salt/hash, `role` (`staff`/`manager`/`super_admin`), active flag. |
| `admin_sessions` | Active admin sessions (sha256 token hash, expiry, last seen, ip/ua). |
| `admin_login_attempts` | Login attempt log for rate-limiting/lockout. |
| `admin_audit_logs` | **Dual purpose:** (1) audit trail of admin actions; (2) config-as-data store (`admin_control_upsert`) for all settings snapshots (homepage, promotions, bulk_savings, cart_recovery, payment_methods, payment_processor, email, inventory, shipping). The former `fulfillment` section (3PL credentials, auto-transmit, payout model) is gone; the Shippo token lives in the server environment, never in the database. |
| `notification_queue` | Internal notification queue (the `notifications` concept). Guarded for absence. |
| `email_send_log` | Log of transactional emails sent. |
| `email_suppressions` | Unsubscribe / suppression list. |

- **Feature flags** are stored in the `admin_audit_logs` control snapshot, not a
  separate `feature_flags` table.
- **RLS:** all admin/system tables are service-role only.

---

## Appendix A — Canonical naming map & safe rename plan

The current names are internally consistent and battle-tested by the app. If
you want the canonical scheme, adopt it in a **phased, reversible** way rather
than a big-bang rename:

**Phase 1 — compatibility views (zero downtime).** For each rename, create a
view under the new name selecting from the old table (or vice-versa) so both
names resolve. Ship it, verify nothing breaks.

**Phase 2 — code cutover.** Update `src/lib/*.ts` reads/writes to the new
names, table by table, with tests green after each.

**Phase 3 — drop the old names.** Once no code references the old name and the
live DB is confirmed, drop the compatibility view/rename the base table.

| Canonical (requested) | Current implementation |
|---|---|
| `product_variants` | `product_doses` |
| `categories` | `products.category` column (introduce a table only if you need category metadata) |
| `inventory` | columns on `products`/`product_doses` (drop unused `inventory_items`) |
| `certificates_of_analysis` | `products.coa_url` (promote to a table if you need multiple COAs per product) |
| `order_status_history` | `order_status_history` (now a real table — Sections 2 & 5) |
| `carts` | browser `localStorage` + `abandoned_carts` |
| `customer_profiles` / `customer_accounts` | `auth.users` + `customer_preferences` |
| `memberships` | `customer_memberships` (+ `membership_tiers`, `membership_billing_events`) |
| `payment_settings` | `admin_audit_logs` sections `payment_methods` / `payment_processor` |
| `payment_transactions` | `orders` + `payment_events` |
| `refunds` | `orders.refund_amount` + `admin_audit_logs` |
| `payout_records` | `payouts` / `partner_payouts` (ambassadors) |
| `tracking_numbers` / `shipping_updates` | `orders` (Shippo columns) + `order_shipments` + `order_status_history` |
| `inventory_sync` / `api_logs` | inventory lives on `products`/`product_doses` (no external sync); Shippo webhook receipts are in `shippo_webhook_events` |
| `3PL_payouts` | n/a — self-fulfilled; postage is `orders.postage_cost_cents` |
| `shipping_boxes` / `packages` | `shipping_package_presets` |
| `referral_codes` | `ambassadors.referral_code` (+ `referrals`) |
| `commission_payouts` | `partner_payouts` / `payouts` |
| `referral_clicks` | `partner_clicks` |
| `shipping_rates` / `shipping_rules` | code (`src/lib/shipping.ts`) + `admin_audit_logs` section `shipping` |
| `promotions` / `bulk_discounts` | `admin_audit_logs` sections `promotions` / `bulk_savings` |
| `reward_points` | `points_ledger` (+ `promotional_point_events`) |
| `sales/traffic/customer/inventory` analytics | derived from `website_analytics_events` + `orders` + `products` |
| `admin_settings` / `feature_flags` | `admin_audit_logs` control snapshot |
| `notifications` | `notification_queue` |
| `audit_logs` / `activity_logs` | `admin_audit_logs` / `admin_login_attempts` + `admin_sessions` |

## Appendix B — Cleanup recommendations (verify against live DB first)

- **`inventory_items`** — defined but unused by app code; safe to drop after
  confirming no external consumer.
- **`ambassadors` ↔ `partners`** — enforce the dual-write (ideally in a single
  transaction / trigger) so a `partners` mirror always exists; a missing mirror
  would break commission FK inserts.
- **`DB_COMPATIBILITY_REPORT.md`** flagged a few tables as "missing" — that was
  a stale probe of an under-migrated database, not a code bug. Before launch,
  **apply every `src/lib/sql/*.sql` file in order** to the live database and
  re-run the probe; that resolves it.
- Standardize money columns as `numeric(12,2)` (already the norm) and timestamp
  columns as `timestamptz` (already the norm) as you touch tables.

## Appendix C — Migration run order

Apply these SQL files in order (each is idempotent):

1. `orders-schema.sql`, `orders-rls.sql`
2. `customer-accounts.sql`
3. `partner-portal-schema.sql`, `partner-portal-rls.sql`, `affiliate-program-schema.sql`, `affiliate-program-rls.sql`
4. `membership-rewards.sql`, `membership-billing.sql`
5. `coupon-checkout-columns.sql`, `shipping-country-handling-fee-columns.sql`
6. `inventory-thresholds.sql`, `order-shipment-management.sql`
7. `ambassador-commission-rules.sql`, `referral-code-rpc.sql`, `partner-system-repair.sql`
8. `admin-rbac-refunds.sql`
9. `abandoned-cart-recovery.sql`
10. **`manual-payments.sql`** (new — manual payments, order number, tax, proofs)
11. Supabase advisor fixes (`supabase-*-advisor-*.sql`)
12. `orders-state-phone.sql` (shipping state + phone captured at checkout)
13. `inventory-enforce-positive-stock.sql` (reservations on any positive stock)
14. **`dynamic-sales-tax.sql`** (new — per-order tax rate + destination state
    for the address-based sales-tax system; tax is collected only for
    admin-configured nexus states at destination-state rates)
15. **`coupon-private-flag.sql`** (new — private/unlisted coupons: valid at
    checkout, never advertised on the storefront)
16. **`replacement-orders.sql`** (new — links a $0 replacement shipment to the
    original order + records the damaged/lost/stolen reason)
17. **`express-checkout.sql`** (new — Apple Pay express lane: intents +
    shipping quotes, `orders.checkout_channel`, and a re-assertion of the
    settlement backstops it depends on). Must be run **before** deploying the
    code that reads it, and it ends with a verification query that must return
    all `t`.
18. **`self-fulfillment-shippo.sql`** (new — self-fulfillment via Shippo: unit
    shipping weights, `shipping_package_presets` (+ seeded default mailer), the
    `orders` label/postage columns including the exactly-once
    `label_purchase_claimed_at` claim, `shippo_webhook_events`, and
    `order_status_history`). Must be run **before** deploying the code that
    reads it — deployed first, the label purchase would run without its claim
    column, which is exactly the case that buys two labels. Ends with a
    verification query that must return all `t`.

The former `fulfillment-3pl.sql` (3PL orders/events/payouts) is **retired** and
is no longer in `src/lib/sql/`. Its tables (`fulfillment_orders`,
`fulfillment_events`, `fulfillment_payouts`) may still exist in a database
migrated before the switch to self-fulfillment; nothing reads or writes them.
They are left in place deliberately — dropping them would destroy the historical
record of orders that were shipped under the old arrangement. Drop them only
after exporting that history.
