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
Auto-transmit to 3PL             fulfillment_orders (+ fulfillment_events log)
        │                        fulfillment_payouts (amount owed)
        ▼
3PL webhook /api/webhooks/fulfillment
        │                        status, tracking, inventory sync, cancel/refund/errors
        ▼
Order updated in real time       orders.fulfillment_status, orders.tracking_number,
        │                        order_shipments, products.inventory_quantity
        ▼
Customer notified                shipping-update email (email_send_log)
        ▼
Payouts & analytics              fulfillment_payouts (3PL owed / paid),
                                 commissions/partner_payouts (ambassadors),
                                 website_analytics_events (traffic/sales)
```

---

## Section 1 — Products

| Table | Purpose |
|---|---|
| `products` | Master catalog. Slug, name, category, base `price`, `stock_status`, `inventory_quantity`, `low_stock_threshold`, `coa_url`, `image_url`, enable/archive flags. `category` is a column (there is no separate `categories` table). |
| `product_doses` | Dose/size **variants** of a product (e.g. 5mg/10mg): label, sku, price/sale price, per-variant `stock_status`, `inventory_quantity`, default flag. FK → `products`. |
| `product_images` | Gallery images for a product (url, alt, sort). FK → `products`. |
| `inventory_items` | Legacy/standalone inventory table — **not used by app code** today (real stock lives on `products`/`product_doses`). Candidate for removal (Appendix B). |

- **COAs** are not a separate table: each product carries `coa_url`; the COA
  Library reads them via `getCoaRecords()` (`src/lib/catalog.ts`).
- **Indexes:** slug (unique), category, enabled/archived filters.
- **RLS:** public read of enabled products via the catalog API (server); writes
  service-role only.

## Section 2 — Orders

| Table | Purpose |
|---|---|
| `orders` | The order record and its full money breakdown. Key columns below. |
| `order_items` | Line items: `product_id`, `product_name`, `unit_price`, `quantity`, `line_total`. FK → `orders(order_id)`. |
| `order_shipments` | Shipment/tracking per order: `carrier`, `tracking_number`, `shipping_status`, `estimated_delivery`. Unique on `order_id` (upsert target). |
| `payment_events` | Webhook idempotency ledger: `event_id` (PK), `order_id`, `status`, `processed_at`. Prevents double-processing of card webhooks. |

**`orders` key columns:** `order_id` (text UUID, PK-ish unique), `order_number`
(short human code, e.g. `VL-1A2B3C4D`), `payment_id`, `payment_method`,
`payment_status`, `fulfillment_status`, money (`subtotal`, `shipping_amount`,
`handling_fee`, `tax_amount`, `discount_amount`, `card_processing_fee`,
`amount_paid`, `refund_amount`), promo (`referral_code`, `ambassador_id`,
`coupon_code`, `bulk_discount_tier/amount`, `points_redeemed/earned`),
manual-payment proof (`payment_reference`, `payment_proof_url`,
`payment_submitted_at`, `verified_at`, `verified_by`, `rejection_reason`,
`payment_rejected_at`), customer (`customer_email/name`, address fields,
`customer_user_id` → `auth.users`), `tracking_number`, `paid_at`, timestamps.

- **`payment_status`:** `pending_payment` → (`awaiting_verification` for manual)
  → `paid` / `payment_rejected` / `payment_failed` / `refunded` /
  `partially_refunded` / `canceled`.
- **`fulfillment_status`:** `pending` → `awaiting_fulfillment` → `processing` →
  `shipped` → `delivered` / `cancelled`.
- **Order status history** is recorded in `admin_audit_logs`
  (`target_table='orders'`), not a dedicated `order_status_history` table.
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
| Payout records | Ambassador payouts: `payouts` / `partner_payouts`. 3PL payouts: `fulfillment_payouts` (Section 5). |

## Section 5 — 3PL / Fulfillment

| Table | Purpose |
|---|---|
| `fulfillment_orders` | One row per order handed to the 3PL: `provider`, `external_id`, `status`, `tracking_number/url`, `carrier`, `last_error`, `transmitted_at`, `last_synced_at`, `payload` (jsonb). Unique on `order_id`. |
| `fulfillment_events` | Append-only log of every outbound transmission and inbound webhook (status, tracking, inventory sync, cancel, refund, error) — doubles as the **API log**. `direction`, `event_type`, `status_code`, `ok`, `payload`. |
| `fulfillment_payouts` | What you owe the 3PL per order: `units`, `model` (`per_unit`/`percent`), `rate`, `amount_owed`, `status` (pending/paid/failed), `paid_at`. Unique on `order_id`. |

- **Config** (`admin_audit_logs` section `fulfillment`): `enabled`,
  `auto_transmit`, `mode` (`manual`/`generic_rest`), `api_base_url`, `api_key`,
  `webhook_secret`, `payout_model`, `payout_rate`
  (`src/lib/fulfillment/config.ts`).
- **Provider-agnostic:** `src/lib/fulfillment/provider.ts` — swap 3PLs by
  changing credentials. Inbound updates arrive at
  `/api/webhooks/fulfillment` (HMAC-verified) and update `orders`,
  `order_shipments`, `products` inventory, and these tables in real time
  (`src/lib/fulfillment/service.ts`).
- The requested `tracking_numbers`, `shipping_updates`, `inventory_sync`,
  `api_logs` are all covered by `order_shipments` + `fulfillment_orders` +
  `fulfillment_events` rather than separate tables.
- **RLS:** service-role only (operational tables).

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

- Shipping **rates/rules are computed in code** (`src/lib/shipping.ts`:
  domestic vs international thresholds, flat fees, free-shipping, 5% handling
  fee, configurable tax) plus the admin control snapshot section `shipping`
  (`tax_rate`). There are no `shipping_rates` / `shipping_rules` tables.
- Shipping **labels/tracking** live in `order_shipments` (and
  `fulfillment_orders`).

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
| `admin_audit_logs` | **Dual purpose:** (1) audit trail of admin actions; (2) config-as-data store (`admin_control_upsert`) for all settings snapshots (homepage, promotions, bulk_savings, cart_recovery, payment_methods, payment_processor, email, fulfillment, shipping). |
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
| `order_status_history` | `admin_audit_logs` (order rows) — add a dedicated table if you want customer-visible history |
| `carts` | browser `localStorage` + `abandoned_carts` |
| `customer_profiles` / `customer_accounts` | `auth.users` + `customer_preferences` |
| `memberships` | `customer_memberships` (+ `membership_tiers`, `membership_billing_events`) |
| `payment_settings` | `admin_audit_logs` sections `payment_methods` / `payment_processor` |
| `payment_transactions` | `orders` + `payment_events` |
| `refunds` | `orders.refund_amount` + `admin_audit_logs` |
| `payout_records` | `payouts` / `partner_payouts` (ambassadors); `fulfillment_payouts` (3PL) |
| `tracking_numbers` / `shipping_updates` | `order_shipments` + `fulfillment_orders`/`fulfillment_events` |
| `inventory_sync` / `api_logs` | `fulfillment_events` |
| `3PL_payouts` | `fulfillment_payouts` |
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
11. **`fulfillment-3pl.sql`** (new — 3PL orders/events/payouts)
12. Supabase advisor fixes (`supabase-*-advisor-*.sql`)
