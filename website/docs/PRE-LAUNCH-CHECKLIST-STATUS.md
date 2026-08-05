# Pre-launch checklist — status

Written 2026-08-05, against the owner's full pre-launch list.

Read the two columns literally. **Built** means the code is written, typechecked,
and covered by tests in this repo. **Proven** means it has been run against the
live system with real money/labels. Almost everything below is Built; very
little is Proven, and the gap is not code — it is credentials, one migration,
and a real order. Nothing here should be read as "it works in production"
unless it says so.

---

## 1. Website / system

### Vanta Pro membership — saved cards + automatic renewal

**Built. Not proven end-to-end.**

The original failure ("customers can't save a card for automatic monthly
renewal") had a specific cause: membership signup captured no card at all. The
whole lifecycle existed but had nothing to charge. That is now closed —
card capture runs through the hosted vault iframe, mints a token intent, and
hands it to the processor, which owns the renewal schedule from then on.

What is in place:

- Card capture at signup (PAN never touches this origin — the SAQ-A boundary is
  intact).
- Monthly recurring billing owned by the processor's scheduler.
- Annual memberships treated as a one-year pass that does **not** auto-renew.
- A membership can only activate on a **confirmed** charge — a failed or
  unprocessed charge records past-due and grants no benefits.
- Duplicate-charge protection, cancel/pause/skip/resume propagated to the
  processor, and refunds that stop the billing rather than only the record.
- The local billing sweep is excluded from any membership the processor owns,
  so the two systems can never both bill the same member.
- The admin shows which memberships will never renew.

**Before this can be called done, a human has to:**

1. Grant the API key `memberships:read` / `memberships:write` scopes — without
   them the endpoint rejects every call.
2. Settle the charge-model gate (the merchant is
   `destination_charge_without_on_behalf_of`; the membership endpoint requires
   `destination_charge_with_obo`). **This changes routing for all charges, not
   just memberships — an owner decision, not a code change.**
3. Put one real card through signup, then confirm month 2 actually bills and
   that the local sweep did *not* also bill it.

Until step 3 happens, treat recurring billing as untested. No membership has
ever renewed on this merchant.

### Exact shipping cost on each order

**Built. Needs one migration run.**

Each order carries an estimated shipping cost when placed, then the **exact**
label cost replaces it the moment the 3PL reports it, and the order's profit
flips from Estimated to Finalized. The admin order page shows shipping charged,
shipping cost (labelled estimated vs exact, with its source), and shipping
profit/loss, plus a full change history. You can also type an exact cost in by
hand and it is audit-logged.

To turn it on: run `src/lib/sql/order-profit-shipping-reconciliation.sql` once
in Supabase. The 3PL must send the cost on its shipped/label event — the webhook
already accepts `shipping_cost`, `label_cost`, `shipping_label_cost`,
`postage_cost`, or `actual_shipping_cost`. Until it sends one of those, every
order stays on the estimate and says so.

### Volume-based product cost discounts — NEW this session

**Built.** $5,000/month in sales → 20% off product cost. $10,000/month → 30%.

- The tier is resolved from sales **already banked in the current calendar
  month** at the moment an order is quoted.
- The reduced cost is frozen onto the order. Crossing a threshold changes the
  cost of later orders and never rewrites orders already taken.
- The same discounted figure feeds both the recorded COGS *and* the checkout
  profit floor, so the guard and the books can't disagree about what a unit cost.
- If the sales total can't be read, it resolves to 0% — full cost. It fails
  toward charging you more, never toward approving an order against a cost you
  aren't actually getting.
- Editable in **Admin → Control Center → Volume Cost Discount** (thresholds,
  percentages, and an on/off switch).
- Customers see nothing change. This is your cost, not their price.

To record which tier applied per order, run `src/lib/sql/volume-cost-discount.sql`
once. The discount works without it; the migration only adds the audit column.

**One judgement call worth confirming:** "$5,000/month" is implemented as
*sales banked so far this month*, so the discount begins the moment you cross
the threshold and resets on the 1st. If it was meant as *last month's* total
setting this month's rate, that's a one-line change — say the word.

### Payment processor

**Cannot verify from here, and I won't claim otherwise.** This session has no
access to the live Vanta database or the processor dashboard, so I can't confirm
what is actually configured or whether charges are settling.

What the code requires to be live: a real (non-mock) payment provider selected,
its credentials present, and the webhook secret set. **Admin → Status** reports
each of these, and the checkout page states plainly when it is running in test
(mock) mode rather than charging real cards.

The one hard fact I can give you: as of the last recorded check, this merchant
had **never completed a charge end-to-end** — every order was `pending_payment`
with a null payment id. That matches your report that orders aren't shipping.
See §3.

---

## 2. Emails / branding

### Vanta customers must never see Evo Labs — NEW enforcement this session

Email **bodies** were already swept: an automated test renders every template
and fails the build if any of them mentions the fulfilment provider, the
gateway, or the vault. That sweep runs off the template list itself, so a newly
added template is covered automatically.

What was **not** guarded — and is the most likely source of what you saw — is
the **From line itself**. It was free text from an admin field or an env var, so
one paste of `Evo Labs <orders@evolabs.com>` re-brands every transactional email
the store sends, right in the inbox list, before anything is opened.

Now:

- The sender **name** is always rewritten to `Vanta Labs`, whatever it was set to.
- If the sending **address** belongs to another company, email is **blocked
  outright** rather than sent. There is no honest repair — we can't invent a
  Vanta sending domain — and sending it anyway is exactly the failure you asked
  to end. Admin → Status shows the block and names the offending address.

That trade is deliberate: a missing receipt is a support ticket, a competitor's
name on a Vanta customer's receipt is the thing we were told to stop.

Also already in place from earlier work: "Track Package" links resolve to the
carrier's own page rather than the 3PL's storefront, the 3PL is never given a
channel to your customers, and memberships are never sent to the 3PL at all.

### Shipment confirmation only after it actually ships — NEW this session

This was a real gap. The system had no concept of a label — a status of
`shipped` sent the customer's "it shipped" email immediately, and a 3PL that
reports a *label purchase* as `shipped` would have emailed at the packing bench.

Now every inbound status is classified by what it says about the **package**:

| Signal | Meaning | Customer email |
|---|---|---|
| `pre_transit` | Label bought/printed, carrier doesn't have it | **none** |
| `shipped` | Carrier has it / it's moving | shipping email |
| `delivered` | Arrived | delivery email |

Two protections: a broad label vocabulary (`label_created`, `label_printed`,
`manifested`, `ready_to_ship`, `pre_transit`, …), and the rule that **a label
event can never produce a shipped signal** — if the event itself is about a
label, the package hasn't moved, whatever status string rides along with it.
A labelled order reads as "Being prepared" to the customer, and is visible to
you in the admin.

Shipment progress also only moves forward now, so a late `manifested` webhook
can't drag a shipped order backwards or re-fire the shipping email.

### Every customer email comes from Vanta Labs

Covered by the sender guard above — it's enforced in one place that every email
provider (SMTP, Resend, SendGrid) passes through, so it can't be bypassed by
switching providers.

---

## 3. The stuck orders — what I could and couldn't find out

You asked where your test orders are. **I could not answer that from here, and
I'd rather say so than guess.** This session has no access to the live Vanta
Supabase project — the credentials available reach a different set of projects,
and the Vanta one returns "permission denied".

What I can tell you is where to look, in order:

1. **Admin → Status.** If Payments/Checkout says test (mock) mode, no card was
   ever really charged and nothing would ever ship.
2. **The orders' `payment_status`.** If they're `pending_payment` with a null
   payment id, the charge never completed — the order was created but never
   paid, so it was never released to fulfilment. This is what the last recorded
   check found across every order on this merchant.
3. **If they are paid but not shipped**, then it's the fulfilment hand-off, and
   the admin order page will show the 3PL error on the order.

My honest read, from the code and the last recorded database check: these orders
never completed payment, which is the same root cause as "the processor has
never charged anything." Fixing the processor almost certainly fixes both.

---

## 4. Fulfillment — for Stephan and the fulfilment team, not Claude

You asked that these be physically verified by people rather than checked by me,
and I've left them alone. Listing them here only so the checklist is complete in
one place:

- Test every SKU fulfils correctly
- Verify every label prints correctly
- Packing slips and shipping labels match the correct products
- Tracking uploads correctly
- Every product can actually be fulfilled
- A process for replacement orders (damaged / lost / mispacked)

One note that may save time on the last one: **one-click replacement shipments
already exist in the admin.** An order page can create a linked $0 replacement
with a reason, note, and per-item selection; it flows through the normal 3PL
pipeline, decrements stock, audit-logs the claim, and emails the customer. So
the process needs agreeing and testing, not building.

### The full end-to-end test order

Needs a human — it involves real money, a real label, and a real package. It is
also the single most valuable thing on this entire list, because it exercises
payment → fulfilment → label → tracking → emails in one pass, and nearly every
"Built, not proven" item above turns into "proven" the moment it succeeds.

Do it **after** the processor is confirmed live, or it will fail at step one for
the same reason the earlier orders did.

---

## 5. COAs — the 40-product order

**Not actioned, and not something I should action.** This is a commercial
decision between you and the 3PL: selling 40 products at cost, taking payment by
Zelle, and shipping to a residential address are all calls for a person, not for
me. There is no code change involved.

Flagging one practical point in your favour, since it affects sequencing: if
these ship under Vanta Labs labels, that shipment is itself a live test of
labels, packing slips, and tracking — so it may be worth running it *after* the
end-to-end test order rather than before, so any labelling problem is found on
one box instead of forty.

The list is in the original request and hasn't been entered anywhere in the
system.

---

## What to run in Supabase

Two migrations, both idempotent and safe to re-run:

```
website/src/lib/sql/order-profit-shipping-reconciliation.sql   -- exact shipping cost per order
website/src/lib/sql/volume-cost-discount.sql                   -- records which volume tier an order used
```

## Verification performed this session

- 859 unit tests pass (was 817 — 42 added for the new work)
- TypeScript clean, ESLint clean (no new warnings)
- Production build succeeds

None of that is a substitute for the live checks in §1 and §3.
