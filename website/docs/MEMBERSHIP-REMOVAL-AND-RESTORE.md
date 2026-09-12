# Membership — removal record and restore procedure

Written 2026-09-12, immediately **before** the paid membership feature was
removed. Its purpose is to make the removal cheap to undo: everything here
describes the feature exactly as it behaved and looked on commit `a0d1694`.

Screenshots of every surface live beside this file in `membership-snapshot/`.

---

## TL;DR — how to bring it back

The removal is deliberately **one commit**. Restoring is:

```bash
git revert <removal-sha>
```

That returns every file byte-for-byte. Nothing else is required, because:

- **The database was never touched.** `membership_tiers`,
  `customer_memberships` and `membership_billing_events` still exist with all
  their rows, including your production tier configuration. A revert lands code
  that matches the data already there.
- **No migration was written**, so there is none to roll back.
- Rewards/points, store credit and Subscribe & Save were deliberately left
  alive, so a revert does not have to reconcile them.

The one thing a revert does **not** undo automatically: the points bonus
settings panel was moved out of `/admin/membership` into `/admin/settings`
(see "The one thing that moved" below). After reverting, decide which home you
want it in — do not let both exist, or two UIs will write the same control keys.

---

## Why it was removed

The owner asked for it, on 2026-09-12. Worth recording alongside that: **paid
membership had never actually charged anybody.** `billing-provider.ts` only
ever implemented `noop` (fails honestly) and `mock` (fake success), and
production hard-blocks `mock`:

> `BILLING_PROVIDER=mock/test is forbidden in production — it would activate
> memberships without charging.`

So the entire state machine was real and working, but there was no live
recurring revenue to unwind. `docs/VEYRA_MEMBERSHIPS_HANDOFF.md` — **kept in
place** — records the unfinished card-capture port that would have made it
transact. Read that first if you are reinstating with real billing.

---

## What the feature was

### Tier lineup

Read from the local harness database on 2026-09-12. **Production tier
configuration is separate, lives in production Supabase, and was not read or
modified** — treat the shape below as the schema, not as your live prices.

| slug | name | monthly | annual | member discount | points/$ | free ship | active |
|---|---|---|---|---|---|---|---|
| `free` | Research Member | $0 | $0 | 0% | 1× | no | yes |
| `core` | Core Member | $29.00 | $290.00 | 10% | 1× | no | yes |
| `essential` | Vanta Essential | $9.99 | — | 5% | 1× | no | **no** |
| `pro` | Vanta Pro | $24.99 | — | 8% | 1× | no | yes |
| `elite` | Vanta Elite | $39.99 | — | 10% | 1× | no | yes |
| `black` | Vanta Black | $89.99 | — | 12% | 1× | no | yes |

All tiers carried an intro offer of $1.00 for 7 days (`intro_offer_enabled`).

**The `free` tier is load-bearing and was NOT removed.** The points system
reads its `points_per_dollar` as the baseline rate for every customer, and
`membership-tiers-seed.sql` says so explicitly: *"The free 'Research Member'
tier is left untouched (the app requires it for the points system)."*

### Perks, and the rule that governed them

`getMembershipPerks()` in `src/lib/membership.ts` was the single source of
truth. Its contract:

- Discount, free shipping and store credit applied **only** while the
  membership was an active paying (or trialing) **paid** tier. The moment a
  member stopped paying, every perk switched off automatically.
- Points rate came from the member's tier while active or trialing; a
  cancelled or past-due member dropped back to the free-tier rate — never their
  old paid rate.
- `isEligibleForBulkSavings()` was scoped to `elite` and `black` only, and
  required a genuinely active subscription (trialing did **not** qualify).
- `isPriorityMember()` set `orders.priority`, a real operational signal
  fulfillment staff filtered on — not marketing copy.

### Discount precedence

Membership was one competitor in a single-winner contest. From
`quote-order.ts`: exactly **one** customer discount applies per order, the best
of `referral / membership / bulk / coupon`. Shipping was never in that race.
The PDP FAQ stated this to customers:

> "No — exactly one discount applies per order. Membership pricing, promo
> codes, ambassador codes, bundle pricing, and promotions never combine."

Removing membership removes one competitor from that contest. It does not
change the rule, and the remaining competitors still resolve the same way.

### Billing state machine

Statuses: `active | paused | cancelled | trialing | past_due`.

Operations, all in `src/lib/membership-billing.ts` (2,363 lines):
`startMembershipSignup`, `activateMonthlyMembership`,
`activateAnnualMembership`, `activatePaidMembership`, `pauseMembership`,
`resumeMembership`, `skipNextBilling`, `cancelMembership`,
`updatePaymentMethod`, `revokeMembershipForRefund`,
`grantMonthlyStoreCreditSweep`, `runMembershipBillingSweep`.

Annual plans carried `cancel_at_period_end` **by design** — a one-time
non-refundable year that does not auto-renew. The account UI special-cased
this so an annual plan was not mislabelled "cancelled".

---

## How it looked

See `membership-snapshot/`. In summary:

| Surface | Treatment |
|---|---|
| `/membership` | Dark hero, "The inner circle of research.", Monthly/Annual toggle with "2 months free" badge, four tier cards with MOST POPULAR / BEST VALUE ribbons, each showing price, member-pricing %, a savings estimate at $200/mo, "best for" bullets, points rate, and a JOIN button |
| `/membership/[tier]/subscribe` | "Confirm your membership", Annual/Monthly toggle, billing-terms panel, non-refundable notice for annual, payment-method note, an acknowledgement checkbox, confirm button |
| `/account/subscriptions` | Sidebar entry "Subscriptions"; free members saw "You're on the free membership" with a VIEW MEMBERSHIP PLANS button, plus a Billing history panel |
| Product cards | Gold member price, a `−12%` badge, "With Vanta Black · save $8.28", and a "Become a member & save $8.28 today →" footer link |
| PDP | A full gold-bordered **MEMBER PRICING** panel: "TODAY'S PRICE $60.72", regular price struck through, savings, and a JOIN MEMBERSHIP button |
| Cart drawer | A "Save $X today with <tier>" upsell, shown only when `todayValue > 0` — i.e. only when the tier's benefit on *this* cart beat its monthly cost |
| Header nav | "MEMBERSHIP" link, second in the primary nav |
| `/admin/membership` | Tiers editor, member list, billing events, bulk-savings config, CSV export, and the points bonus settings |

**Visual consequence of removal, recorded honestly:** product cards drop from
four price elements to one (`$69.00`), and the PDP loses the gold panel between
the price and the quantity selector. Nothing was invented to fill those gaps —
the brief was "like membership never existed", not "replace it with something".

---

## Files removed

### Pages and routes
```
src/app/membership/page.tsx
src/app/membership/[tierSlug]/subscribe/page.tsx
src/app/account/(dashboard)/subscriptions/page.tsx
src/app/admin/membership/page.tsx
src/app/api/membership/{subscribe,cancel,pause,resume,skip,update-payment-method,card-config}/route.ts
src/app/api/admin/membership/{customers,customers/[userId],events,events/[eventId],tiers,tiers/[tierId],export,bulk-savings}/route.ts
```

### Components
```
src/components/membership-landing.tsx          (694 lines)
src/components/membership-subscribe-client.tsx (236)
src/components/membership-card-form.tsx        (258)
src/components/membership-billing-panel.tsx    (198)
src/components/admin-membership-client.tsx     (746)
src/components/member-remove-button.tsx        (119)
src/components/subscription-actions.tsx        (148)
```

### Libraries
```
src/lib/membership-billing.ts       (2363)
src/lib/membership-billing-math.ts  (190)
src/lib/membership-orders.ts        (261)
src/lib/membership-status.ts        (114)
src/lib/membership-webhook.ts       (396)
src/lib/veyra-membership.ts         (415)
src/lib/admin-membership.ts         (797)
src/lib/member-pricing.ts           (122)
```

`src/lib/membership.ts` (875 lines) was **split**, not deleted — see below.

---

## The split that matters most

`src/lib/membership.ts` held **two features**. Only one was removed.

| Stayed (moved to `src/lib/rewards.ts`) | Removed |
|---|---|
| `getPointsBalance`, `getPointsHistory`, `recordPointsLedgerEntry` | `getMembershipPerks` |
| `redeemPoints`, `reverseOrderPoints`, `restoreRedeemedPoints` | `getTierBySlug`, `getActiveMembershipTiers` |
| `awardSignupBonusIfNeeded`, `awardReferralSignupBonus` | `getCustomerMembership` |
| `runBirthdayBonusSweep`, `checkAndAwardBirthdayBonus` | `isEligibleForBulkSavings`, `isPriorityMember` |
| `getMembershipBonusSettings` (points bonuses) | `MembershipTier`, `CustomerMembership` types |
| `getActivePointsMultiplier`, `getProgressToNextReward` | |
| `getFreeTier` — kept, still reads `membership_tiers` | |

When restoring, the reverse split is the fiddly part: the revert will
reintroduce `membership.ts` in full. Check that `rewards.ts` does not survive
alongside it defining the same functions.

---

## Deliberately left alive

- **Rewards / points** — earning, redemption, balance, history,
  `/account/rewards`, and the signup / referral / birthday bonuses.
- **Store credit** — the ledger, checkout redemption and refund handling.
  Only the *membership monthly grant* stopped. Balances customers already held
  remain spendable, and refunds on historical orders still reconcile.
- **Subscribe & Save** — a completely separate feature (product-level opt-in,
  `product_subscriptions` table, `/api/catalog/subscribe-save`). Untouched.
  Do not confuse it with membership because of the shared word.
- **All three database tables** and every row in them.
- **`docs/VEYRA_MEMBERSHIPS_HANDOFF.md`** — the record of the unfinished
  Basis Theory / Veyra card-capture port.

---

## The one thing that moved

`/admin/membership` was the only UI for the **points bonus settings** — the
signup, referral and birthday bonus toggles and their point values. Those are
rewards controls, not membership controls, so they were rehomed rather than
deleted:

| Before | After |
|---|---|
| Panel inside `admin-membership-client.tsx` | Panel in the admin settings page |
| `PATCH /api/admin/membership/settings` | `PATCH /api/admin/rewards/settings` |

The underlying control keys are unchanged (`signup_bonus_enabled`,
`referral_bonus_enabled`, `birthday_bonus_enabled`, `signup_bonus_points`,
`referral_bonus_points`, `birthday_bonus_points`), so no data migrated.

---

## Verification standard applied

The removal was held to the pre-existing baseline, not to "it compiles":

| Check | Before removal |
|---|---|
| vitest (with scratch Postgres) | 688 files passed, 1 skipped; 10,618 tests passed |
| `tsc --noEmit` | clean |
| `eslint` | 0 errors, 62 warnings |
| `next build` | clean, 244 routes (19 membership) |

The same four were required to match afterwards, minus the membership routes
and their dedicated tests.
