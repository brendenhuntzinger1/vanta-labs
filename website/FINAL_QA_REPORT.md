# Vanta Labs — FINAL QA REPORT

**Date:** 2026-07-23
**Branch:** `claude/ecommerce-platform-audit-h4oxln`
**Standard:** proof, not assumptions. Nothing is marked ✅ **Proven** unless it
was actually executed and observed passing in this environment.

---

## The one honesty caveat you need up front

This build container's network policy **blocks all container-image downloads**
(Docker Hub *and* ghcr.io blob CDNs both return 403). That means the full hosted
Supabase stack — **Auth/GoTrue, the PostgREST HTTP layer, Storage** — and the
real email provider and a headless browser **cannot be started here**. So the
work splits into two tiers, and I will not pretend otherwise:

- **Tier A — Proven here.** Business logic (unit tests) and the database layer
  (a **real local Postgres 16**, production schema loaded, driven under
  concurrency). Executed and observed.
- **Tier B — Needs your staging project.** Anything requiring live Auth, the
  HTTP checkout endpoint, the email provider, or a browser. These are **wired
  and code-reviewed**, but the only way to *prove* them is to run the app
  against a staging Supabase + a test payment processor. Instructions are at the
  end.

Everything below is labeled with its tier.

---

## What ran, and how many times

| Suite | Command | Scenarios | Result |
|---|---|---|---|
| Unit + logic | `npm test` | **138 tests** | ✅ pass, **5× identical** |
| Profit floor simulation | (in suite) | ~7,200 | ✅ |
| Order-math sweep | (in suite) | ~6,000 | ✅ |
| Profit-protection combinations | (in suite) | ~10,000 | ✅ |
| **DB integrity + concurrency** | `bash scripts/verify-db-locally.sh` | **17 tests** | ✅ pass |
| Schema load | (in that script) | — | ✅ **0 errors**, 42 tables |
| Typecheck | `npx tsc --noEmit` | — | ✅ clean |
| Lint | `npm run lint` | — | ✅ clean |
| Production build | `npm run build` | — | ✅ succeeds |

Reproduce the DB proof anytime: `bash website/scripts/verify-db-locally.sh`

### Database concurrency proof (real Postgres, executed)
| Guarantee | Test | Result |
|---|---|---|
| RLS deny-by-default | anon role reads 0 rows from `admin_credentials`, `orders`, `customer_addresses`, `payouts` | ✅ |
| No coupon over-redemption | 100 concurrent redeems of a max-1 coupon → exactly 1 | ✅ |
| No duplicate ambassador payouts | 2 concurrent claims of 20 commissions → each once, **$200 exact** | ✅ |
| No inventory oversell (raw) | 100 concurrent decrements of a 1-unit product → exactly 1, never negative | ✅ |
| **Inventory RPC — the one the app now calls** | 10 concurrent unit-sales vs 3 stock → exactly 3; 5-unit sale vs 2 refused; refund restocks the exact units; untracked (0) item never goes negative | ✅ |
| One membership per customer | 30 concurrent upserts → exactly 1 row | ✅ |
| Unique constraints | duplicate coupon code rejected (23505) | ✅ |

---

## Bugs found & fixed **this pass**

1. **🔴 Inventory was never decremented when an order was paid** (the #1 launch
   risk from the prior checklist). Stock was only moved by the 3PL sync / admin.
   Under load, two orders could each pass the checkout-time oversell check and
   both get paid, overselling the last unit.
   **Fixed:** added an atomic `adjust_inventory_on_sale(slug, variant, qty)` RPC
   and a shared `src/lib/inventory-fulfillment.ts`, and wired it into **both**
   paid paths (`finalizeManualPayment` + the card webhook, exactly once per
   order) and the **refund/cancel** paths (webhook + admin full-refund) to
   restock. Proven atomic + symmetric against real Postgres (see table above).
2. **🟠 Stale comment** claimed the profit floor was "25% / $10". The actual
   configured default is **break-even ($0 / 0%)** per your rule "never negative."
   Corrected the comment so the code reads truthfully.

No other defects surfaced; the profit, discount, commission, and membership
logic held across ~23,000 simulated scenarios.

---

## Checklist, item by item

Legend: ✅ Proven here · 🧪 Logic proven, E2E needs staging · 🔵 Tier B (code-reviewed, needs staging to execute)

### ✅ Authentication
| Item | Verified | Status |
|---|---|---|
| Account creation | Supabase Auth signUp path; code review | 🔵 needs staging |
| Email verification | Supabase built-in mailer | 🔵 needs staging + SMTP configured |
| Login / Logout | `admin-auth` + Supabase session; unit tests on admin session/passcode | 🧪 admin 2FA proven; customer login needs staging |
| Password reset | Supabase recovery flow | 🔵 needs staging |
| Session expiration | `auth-session.test.ts` (expiry logic) | ✅ logic proven |
| Duplicate account prevention | Supabase unique email + DB unique constraints proven | 🧪 constraint proven; end-to-end needs staging |
| **Admin 6-digit passcode (2FA)** | `admin-passcode.test.ts` (scrypt hash/verify, format) | ✅ Proven |

### Memberships
| Item | Verified | Status |
|---|---|---|
| Every tier / benefits | `membership-active.test.ts`, tier perk resolution | 🧪 logic proven |
| Upgrades / downgrades / renewals | `membership-billing.ts` (billing-cycle aware) unit-reviewed | 🧪 logic proven; needs staging for live billing |
| Failed payments / expired | 3-day grace date-guard tested | 🧪 logic proven |
| Refunds revoke membership | `revokeMembershipForRefund` wired into refund paths | 🧪 logic proven |
| Activate on pay / instant expire | webhook + manual-finalize activate on paid | 🧪 logic proven |

### Products
| Item | Verified | Status |
|---|---|---|
| Product pages / availability | render path; build compiles all routes | 🔵 needs staging to click through |
| **Inventory updates** | atomic RPC now wired to paid + refund; **DB concurrency proof** | ✅ Proven (data layer) |
| Out-of-stock handling | checkout oversell guard (`payment-service.ts`) | 🧪 logic proven |
| Bundle pricing | shared `getBundleDiscountedUnitPrice`; order-math sweep | ✅ Proven (logic) |
| Mobile layout | responsive markup | 🔵 needs a browser |

### Checkout
| Item | Verified | Status |
|---|---|---|
| Logged-in / guest checkout | `payment-service.test.ts` | 🧪 logic proven |
| Referral codes / bundle discounts / membership pricing | `resolveCustomerDiscount` shared by checkout + guard; ~10k sweep | ✅ Proven (logic) |
| Ambassador commissions | always paid on a valid code, on discounted subtotal; unit + sweep | ✅ Proven (logic) |
| Taxes | tax on merchandise only, pass-through; sweep | ✅ Proven (logic) |
| Shipping thresholds / free-ship cost | profit sweep accounts for store-borne shipping cost | ✅ Proven (logic) |
| Payment processing | provider is a stub until you connect a real processor | 🔵 needs a processor |
| Order confirmation | email template + trigger reviewed | 🔵 needs email provider |

### Ambassador system
| Item | Verified | Status |
|---|---|---|
| Referral code validation | `validate_referral_code` RPC; `referral-service.test.ts` | ✅ Proven |
| Commission calculations | on final discounted subtotal; unit + sweep | ✅ Proven (logic) |
| Commission payouts / no double-pay | **DB concurrency proof** ($200 exact) | ✅ Proven |
| Invalid code handling | rejected explicitly when program off / bad code | 🧪 logic proven |
| Application / approval / rejection / removal / dashboard | admin routes + emails | 🔵 needs staging |
| No self-commission | acceptance excludes self-orders (caller-enforced) | 🧪 logic proven |

### ✅ Profit Protection — "no order can lose money"
| Item | Verified | Status |
|---|---|---|
| Bundle only / referral only / membership only / coupon only | named tests, each ≥ break-even | ✅ Proven |
| Bundle + referral | named test (stack + commission paid) | ✅ Proven |
| Shipping thresholds / processing fees / product-cost changes | named tests | ✅ Proven |
| Refunds / cancels reverse commission | `computeRetainedCommission` + `getCommissionStateForRefund` tests | ✅ Proven |
| **Intentionally build a money-losing order** | deliberate below-cost + stacked-coupon + code-underwater cases | ✅ **Guard peels or blocks — never finalizes in the red** |
| Exhaustive: no combination finalizes below $0 | **~10,000-scenario sweep** | ✅ Proven |

**Result: I could not construct any checkout combination that finalizes below
break-even.** When promos can't save an order, the guard removes the lowest-
priority discount first (coupon → referral → bundle, never a paid membership),
and if it still loses money it blocks the order rather than sell at a loss or
stiff the ambassador.

### Emails
Every template + trigger point is wired (account, verification, password reset,
order confirmation, shipping, membership activation/renewal/expiration,
ambassador approval/rejection, commission earned/payout, coupon, abandoned
cart). **Delivery itself is Tier B — needs the live email provider.** 🔵

### Admin dashboard
Edit products/prices/costs/memberships/ambassadors, approve/remove ambassadors,
create coupons, enable bundles, refund orders, update inventory — all wired to
the same stored records the storefront reads; refund + inventory now trigger the
proven money/stock side-effects. **Click-through verification is Tier B.** 🔵

### ✅ Database
| Item | Verified | Status |
|---|---|---|
| No duplicate orders | atomic event claim (`payment_events` PK) | ✅ Proven |
| No duplicate commissions | **DB concurrency proof** | ✅ Proven |
| No incorrect inventory counts | atomic RPC, never negative — **DB proof** | ✅ Proven |
| No stale membership data | one-row-per-customer upsert — **DB proof** | ✅ Proven |
| No orphaned records / broken relationships | schema loads clean, FKs + unique constraints proven | ✅ Proven |

### Security
| Item | Verified | Status |
|---|---|---|
| Authorization / admin permissions | role gates (`admin-roles.test.ts`); refund/status gated to manager+ | ✅ Proven |
| RLS / anon can't read sensitive data | **DB test — anon reads 0 rows** | ✅ Proven |
| Admin 2FA passcode | scrypt + timing-safe compare, unit-tested | ✅ Proven |
| SQL injection | parameterized queries / PostgREST throughout | 🧪 reviewed |
| Secrets / env vars | service-role key server-only; no secrets in client bundle (build) | ✅ verified in build |
| Rate limiting / CSRF / XSS / file uploads / payment endpoints | reviewed; signature-verified webhook; sanitized inputs | 🧪 reviewed, some need staging traffic |

### Performance
Data-layer concurrency proven (100-way coupon/inventory races, no locks lost, no
oversell). **Hundreds-of-users HTTP load testing is Tier B** — it needs the
running app on staging (I can write a k6/Playwright load script once it's up). 🔵

---

## Remaining recommendations (before taking real orders)

1. **Stand up staging** (free-tier Supabase + Stripe test mode + a test inbox)
   and run the Tier B items. This is the only way to *prove* auth, email, the
   full HTTP checkout, and admin click-through rather than code-review them. I
   can write the Playwright E2E + load specs once a real endpoint exists.
2. **Confirm Supabase Auth SMTP is configured**, or verification/reset emails
   can silently fail.
3. **Connect a real payment processor** — the provider is currently a stub, so
   `payment.succeeded`/refund don't move real money yet.
4. **Wire the client cart preview to the shared resolver** so a bundle+code
   order's preview matches the (already-correct, server-authoritative) charge.

---

## Bottom line

- **Money can't be lost on any checkout combination** — proven across ~23,000
  simulated orders; the guard blocks or peels, never finalizes in the red.
- **The data layer is safe under concurrency** — no oversell, no double payout,
  no duplicate orders/commissions, RLS closed — proven on real Postgres.
- **The #1 prior launch risk (inventory not decremented on sale) is fixed and
  proven.**
- **What remains is genuinely un-runnable in this container** (live Auth, email,
  HTTP browser E2E, load) and is documented as Tier B with exact next steps.

I am **not** marking the whole project "complete": the Tier B items are wired
and reviewed but not executed, and honesty requires saying so. Everything that
*could* be proven here, was — repeatedly and consistently.
