# Vanta Labs — Launch QA Runbook

What's proven by automated tests vs. what must be validated live (with credentials),
plus a step-by-step manual QA pass by role. Nothing here is "assumed working" —
each row says how it is proven.

---

## 0. Pre-flight configuration (owner actions — cannot be done from code)

| # | Item | Where | Done? |
|---|------|-------|-------|
| 1 | Run migration `src/lib/sql/admin-dashboard-rollups.sql` (incl. REVOKEs) | Supabase → SQL Editor | ☐ |
| 2 | Run migration `src/lib/sql/marketing-subscribers.sql` | Supabase → SQL Editor | ☐ |
| 3 | Verify RPC lockdown: `select has_function_privilege('anon','public.admin_customer_rollup(text,int,int)','execute');` → **false** | Supabase | ☐ |
| 4 | Connect payment processor; set env; confirm `PAYMENT_PROVIDER=live` | Vercel env | ☐ |
| 5 | Connect billing provider (monthly memberships); `BILLING_PROVIDER` set, **never `mock` in prod** | Vercel env | ☐ |
| 6 | Enable Email + provider + verified `from` in `/admin/settings`; confirm `ready:true` **before first order** | Admin | ☐ |
| 7 | Configure Supabase Auth SMTP (password reset / verification are Supabase-native, separate from #6) | Supabase → Auth | ☐ |
| 8 | Enable 3PL fulfillment + provider config in `/admin/settings` | Admin | ☐ |
| 9 | Set `track_inventory = true` on every product/dose with real stock (else reservation is dormant → oversell) | Supabase / admin | ☐ |
| 10 | Confirm `vercel.json` crons scheduled + `CRON_SECRET` set (renewals, cart recovery, reservation expiry, email retry) | Vercel | ☐ |

---

## 1. Automated proof (run these — no credentials needed)

```bash
cd website
npx tsc --noEmit          # types
npx vitest run            # 294 tests: money math, discounts, tax, shipping,
                          # Buy-3-Get-1, refund reversal, commission accrual,
                          # membership reprice, reconciliation, webhook helpers
npm run build             # production build
```

Concurrency / integrity against **real Postgres** (needs `DATABASE_URL` to a test DB):

```bash
cd website
DATABASE_URL=... bash scripts/verify-db-locally.sh
```
Covers: coupon over-redemption (100 concurrent), **inventory oversell (100 concurrent → exactly 1 succeeds)**, ambassador payout double-claim, one-membership-per-customer (30 concurrent upserts), **duplicate/replayed webhook deliveries → side-effects run exactly once**, paid-flip once.

> ⚠️ The oversell proof validates the RPCs. They only engage at checkout when
> `track_inventory = true` (pre-flight #9). Until then the reservation layer is
> dormant and concurrent last-unit checkouts can oversell. Enable #9 before launch.

---

## 2. Manual QA — by role (validate live, post-config)

Legend: 🟢 automated-proven · 🔵 live-only (do manually)

### Guest customer
- 🔵 Browse products, product detail, COA download, add/remove cart, cart drawer totals
- 🟢 Coupon / Buy-3-Get-1 / bundle math · shipping (US/Canada) · 8% tax
- 🔵 Guest checkout → payment success → order-confirmation + **confirmation email received**
- 🔵 Payment failure path (use processor test card) → order not marked paid, no email
- 🔵 Refresh mid-checkout / double-click "Place order" → exactly one order (latch)

### Registered customer
- 🔵 Sign up → **verification email** · login/logout · **password reset email** (Supabase SMTP)
- 🔵 Account dashboard: orders, addresses, reorder, wishlist
- 🟢 Points earn/redeem caps · store credit caps
- 🔵 Order tracking page after 3PL "shipped" webhook → **shipping/tracking email**

### Member
- 🔵 $1 trial signup → perks active immediately · trial confirmation email
- 🔵 Trial → first-month remainder charge (sweep) → **repriced correctly after upgrade/downgrade** (🟢 math proven)
- 🔵 Renewal (sweep) · upgrade/downgrade mid-cycle · cancel (perks to period end) · failed payment → dunning email + retry
- 🔵 Expired card → charge fails → past_due → recovery

### Ambassador
- 🟢 Referral discount (config-driven %) · self-referral blocked · commission accrual/reversal
- 🔵 Apply → approve → payout "mark paid" (**send money first, then mark paid** — no real rail) → payout email
- 🟢 Duplicate payout claim refused · fraud-flagged commissions held

### Administrator
- 🔵 **Mark paid order Shipped + tracking → saves + shipping email fires** (was the P0, now fixed 🟢-adjacent)
- 🔵 Refund (full/partial) → reversals + store credit · cancel order
- 🔵 Reconciliation dashboard shows only true mismatches (🟢 formula proven)
- 🔵 CSV exports open safely in Excel (🟢 formula-injection neutralized) · dashboards fast at scale (🟢 RPCs)

---

## 3. Known non-code launch items (decisions)
- **Age gate blocks SEO** — content is server-hidden; decide overlay-vs-block (fix ready).
- **Refund confirmation email** — none exists; add or handle manually.
- **Ambassador fraud threshold = 2** — tune to avoid stranding legit repeat customers.
- **Admin-assigned memberships** never expire/bill — decide comp vs paid semantics.
- **`bundleReferralPercent`** admin field is documented but not implemented — implement or remove.
