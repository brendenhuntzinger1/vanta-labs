# Retention / Revenue Audit — Checkpoint

**Last updated:** 2026-09-09
**Branch:** `claude/email-marketing-platforms-8smgxp`
**Head:** `b5fa704`
**Working tree:** clean, pushed

---

## Objective

Build on the existing abandoned-cart and lifecycle email system to produce more
*profitable incremental sales*. Not a rewrite. Priorities in order: don't break
production; fix real revenue leaks; increase cart recovery; convert subscribers;
increase repeat purchase; better targeting; protect margin; prevent colliding
automations; trustworthy attribution; a foundation that improves with data.

---

## Business scale (production, 2026-09-09)

These numbers decide what is worth building. Re-check them when resuming.

| | |
|---|---|
| Marketing list | ~119 (58 account holders + 64 guests − 3 suppressed) |
| Paid orders, all time | 12 product + 1 membership |
| Revenue, all time | **$1,085.21** |
| AOV | $83.48 |
| Paying customers | 8 |
| Abandoned carts | 37 (16 still active) |
| Cart recovery emails sent | 85 → **2 clicks** |
| Email delivery | 100% delivered, 0 bounces, 0 complaints, ~36% open |

**Volume is the binding constraint on experimentation.** A/B tests need ~300
per arm to conclude; nothing here reaches that. Say so rather than running
underpowered tests.

---

## Architecture discovered (do not rebuild — these work)

- **Consent**: two stores — `customer_preferences.marketing_emails` (accounts,
  by user id) and `marketing_subscribers` (guests, by email). Union minus
  `email_suppressions`. Consent is the floor and is applied in one place
  (`audience.ts`).
- **Reputation separation**: marketing sends from a different From than
  receipts; enforced by source-level tests (`reputation-separation.test.ts`).
- **Send-once**: `order_email_log` with `UNIQUE (order_id, kind) WHERE status IN
  ('sending','sent')` — database-level duplicate prevention for transactional
  order mail. Verified present in production.
- **Frequency**: 24h quiet period per address across all marketing families;
  30-day send-once lookback (`frequency.ts`).
- **Cart recovery**: 4 stages (`t30m`/`t12h`/`t24h`/`t72h`), per-stage slot
  reserved in `abandoned_cart_emails` behind a unique index before sending.
- **Attribution**: HMAC-signed click links → `/api/email/click` → attribution
  cookie → `attributed_campaign_id` written once. Primary vs assisted orders
  are distinguished; revenue is net of refunds.
- **Offers/gifts**: minted per recipient, bound to the address, consumed by the
  first paid order; `closeCustomerOfferCycle` revokes the rest on purchase.
- **Retry**: `enqueueFailedEmail` + sweep, keyed on `(orderId, kind)` so the
  sweep can close the send-once slot rather than leaving it `failed`.

---

## Confirmed findings

### P0 — Recovery attribution double-counted (FIXED, `d255f88`)

`markAbandonedCartsRecovered` updated **every** active cart for an address and
stamped them all with the same `recovered_order_id`. One statement wrote two
different facts: "stop mailing this cart" (true of all) and "this order
recovered this cart" (true of at most one).

Evidence: one $76.04 order credited to 4 carts claiming $582.90; a second
$73.84 order to 2 more. **9 carts read as recovered where 5 orders existed.**

Fixed: close stays broad (reminders must stop), credit narrows to one —
preferring a cart with `restored_at` (evidence they came back through the link),
else most recently updated. Others close as `superseded` with no order id.

### P1 — Payment declines were never followed up (FIXED, `5064f04` + `b5fa704`)

**The largest leak in the system.**

| | |
|---|---|
| Orders reaching `payment_failed` | **$2,444.00** |
| Revenue ever earned | $1,085.21 |
| Never returned | **$1,813.24** (8 orders, 5 customers) |
| Of which real declines (`processor_declined`) | **$1,494.76** |
| Recovery emails ever sent for a failed payment | **0** |
| Failures in the last 14 days | 6 of 15 |

Money lost at the payment step is **1.67× all revenue ever earned**. Meanwhile
85 abandoned-cart emails went to people who only added to a cart. The system
chased its lowest-intent audience and ignored its highest.

`payment_failed` covers two unrelated events and only one is recoverable:
- `processor_declined` — bank asked, said no. $1,494.76. **Mailed.**
- `checkout_expired` — no charge attempted. Telling these people "your payment
  was declined" is false. **Not mailed.**

### P2 — Not built, evidence recorded

- **Cart recovery converts poorly**: 45 delivered, 16 opened (~36%), **2
  clicks**, and **0 of the 9 "recovered" carts had a click**. Delivery and
  opens are healthy; the offer/CTA is the problem, not deliverability. The
  existing subject-line experiment is recording (7 in arm A, 10 in arm B) but
  cannot conclude at this volume.
- **`checkout_expired` follow-up** ($318.48 never returned) — different message
  from a decline ("your order is still waiting"), not yet built.
- **59 auth emails have no `provider_message_id`** (51 signup confirmations, 6
  password resets, 2 resends) so their delivery is unknowable. Being fixed on
  branch `claude/open-alerts-review-og8fnj` — do not duplicate that work.

---

## Changes made

| Commit | What |
|---|---|
| `d255f88` | One order recovers one cart, not every cart the address had open |
| `5064f04` | Payment decline recovery: rule, template, sender, webhook wiring |
| `b5fa704` | Adversarial pass: amount guard + durable retry queue |

### Files added
```
website/src/lib/email/payment-decline-recovery.ts        (eligibility rule, pure)
website/src/lib/email/payment-decline-send.ts            (sender, never throws)
website/src/lib/email/payment-decline-recovery.test.ts   (15 tests)
website/src/lib/email/payment-decline-send.test.ts       (17 tests)
website/src/lib/email/payment-declined-template.test.ts  (13 tests)
website/src/lib/email/payment-decline-wiring.test.ts     (3 tests)
website/src/lib/cart-recovery-credit-one.test.ts         (8 tests)
```

### Files modified
```
website/src/lib/cart-recovery.ts                 markAbandonedCartsRecovered
website/src/lib/payment-webhook.ts               one call site, guarded, non-throwing
website/src/lib/email/templates.ts               + paymentDeclinedTemplate
website/src/lib/email/order-email-once.ts        + "payment_declined" kind
website/src/lib/email/template-standards-inputs.ts  registered the new template
website/src/lib/sql/abandoned-cart-recovery.sql  documented `superseded` status
```

### Migrations
**None required.** `payment_declined` inherits send-once from the existing
`(order_id, kind)` unique index; `superseded` is a new value in an existing free
-text `status` column, and every reader tests positively (`=== "recovered"`,
`=== "active"`), so no reader mishandles it.

---

## Tests / verification performed

- `npx vitest run` — **9,992 passed**, 245 skipped, 0 failed
- `npx tsc --noEmit` — clean
- `npx eslint` on all changed files — clean
- `npm run harness:build` — compiled successfully
- Production index verified by query: `order_email_log_one_live` exists

---

## Outstanding — exact next tasks

1. **Historical data repair (needs the owner's go-ahead — a production write).**
   Dry-run confirmed: 9 rows → **5 recovered**, recovered value **$1,198.76 →
   $625.87**. SQL:
   ```sql
   with ranked as (
     select id, row_number() over (
       partition by recovered_order_id
       order by (restored_at is not null) desc, last_updated_at desc) as rn
     from public.abandoned_carts where recovered_order_id is not null)
   update public.abandoned_carts c
     set status='superseded', recovered_order_id=null
   from ranked r where c.id=r.id and r.rn>1;
   ```
2. **Watch the first real decline email.** Nothing has sent yet in production.
   Check `order_email_log where kind='payment_declined'` after the next decline.
3. **Not started:** `checkout_expired` follow-up; profit/contribution reporting
   (COGS is not in the database — see below); cart-recovery offer rework.

## Production invariants that must not regress

- Consent is the floor: a segment/rule filters the consented set, never expands it.
- Suppression wins over any rule or offer.
- Marketing and transactional sending identities stay separate.
- One order credits at most one cart as recovered.
- The decline email is transactional: **no incentive of any kind**, or it
  becomes marketing and loses its reach to unsubscribed customers.
- `checkout_expired` is never told a payment was declined.
- Nothing in the payment webhook may throw from an email path.

## Known gap for profit work

**COGS is not in the database.** Contribution profit per stage/tier/incentive —
requested in the brief — cannot be computed from real data yet. Do not invent
numbers. The prerequisite is a per-product cost field; until it exists, profit
reporting can only be revenue minus known discount/gift retail value.
