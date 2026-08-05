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

**Built, to the terms printed on the EVO wholesale sheet** (dated June 16, 2026).

The sheet's exact wording is: *"Tier set each month from the prior month's total
product purchases. Discount applies to all per-vial pricing above."* That is what
is implemented — and it differs in two ways from a plain reading of "$5,000/month
in sales":

| | Sheet's rule (implemented) | "Sales" reading |
|---|---|---|
| **When** | Set by the **prior** month; fixed all month | Moves mid-month as sales land |
| **What** | **Product purchases** — per-vial spend with EVO | Retail sales revenue |

The second difference is the big one. At roughly $30/vial wholesale, $5,000 of
*purchases* is about 167 vials, which retail for far more than $5,000. Measuring
on retail revenue would have handed out tiers that were never earned under the
sheet.

- $5,000+ of prior-month product purchases → 20% off per-vial cost.
- $10,000+ → 30%.
- Shipping is excluded from the measure, matching the sheet ("everything except
  shipment cost").
- The reduced cost is frozen onto each order as placed, so a later tier change
  never rewrites the margin on orders already taken.
- The same discounted figure feeds both the recorded COGS *and* the checkout
  profit floor, so the guard and the books can't disagree about what a unit cost.
- If the total can't be read, it resolves to 0% — full cost. It fails toward
  charging you more, never toward approving an order against a cost you aren't
  actually getting.
- Editable in **Admin → Control Center → Volume Cost Discount**.
- Customers see nothing change. This is your cost, not their price.

**In the first month there is no prior month, so the rate is 0% — full cost.**
That's the sheet's terms, not a bug, but it's worth knowing before launch: the
first month is bought at full per-vial price no matter how well it goes.

To record which tier applied per order, run `src/lib/sql/volume-cost-discount.sql`
once. The discount works without it; the migration only adds the audit column.

**Two things to confirm with EVO**, because the sheet doesn't say and the
difference is real money:

1. **Is "total product purchases" measured before or after the discount?** This
   is implemented as actual spend (post-discount), which is the natural reading
   of "purchases". Under that reading a 30% month can drop you back under
   $10,000 and cost you the tier — worth pinning down in writing.
2. **The sheet says "Valid 30 days from date above" (June 16, 2026), so it has
   lapsed.** Confirm the pricing and tiers still stand before relying on them.

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

### Vial labels — "print vial label" missing on dosed products

Reported from the warehouse (order 127902, a Vanta Labs reship): the MOTS-C
line offered **print vial label**, the GLP-1 5mg line did not.

**Root cause confirmed — it's ours, and it's a straight contract violation.**
The integration spec we sent the partner
(`docs/3PL-INTEGRATION-REQUIREMENTS.md` §5) says, verbatim:

> Our `sku` is the product slug (e.g. `glp-1`) and `variant` is the dose
> (e.g. `5mg`). Inventory callbacks must match on the **same** pair.

The code was sending this store's internal `product_doses.id` as `variant`:

| Line | `sku` | `variant` sent | `variant` promised |
|---|---|---|---|
| MOTS-C (single dose) | `mots-c` | *(none)* | *(none)* |
| GLP-1 5mg (dosed) | `glp-1` | `6d1f0a8e-…` (UUID) | `5mg` |

A vial label is per-*strength* — a 5mg label is not a 10mg label — so the
partner needs the dose to pick a label template. They were handed a UUID that
matches nothing in their catalogue. MOTS-C has no dose at all, so its plain slug
identified the vial and its label printed. That is exactly the reported
asymmetry, and it affects **every dosed product**, not just this reship.

### The same bug was silently breaking inventory

This is the more expensive half. A partner following our written spec sends:

```json
{ "type": "inventory", "inventory": [{ "sku": "glp-1", "variant": "5mg", "quantity": 42 }] }
```

The handler matched that against a UUID column (`.eq("id", "5mg")`). That is a
Postgres type error, and the result was discarded unchecked — so **dose-level
stock updates never applied for any dosed product, silently.** Since the 3PL is
the source of truth for stock, that means sold-out doses could keep selling.
This is the very failure an earlier fix claimed to have closed.

**Fixed, both directions:**

- **Outbound:** `variant` is now the dose (`"5mg"`) as documented. The internal
  id still travels as `variant_id` for round-tripping, and the line also carries
  `variant_sku` (the dose's real SKU) and `batch_number` for the label itself.
  If a dose can't be resolved we fall back to the raw suffix rather than `null`
  — `null` would tell the partner the product has no strengths, which is how a
  wrong vial gets picked.
- **Inbound:** the dose is matched on label or slug suffix (`"5mg"`, `"5 MG"`,
  `"5-mg"` all compare equal), with the UUID still accepted so a partner already
  sending ids keeps working. Matching happens in JS, not in the query, because
  comparing a label to a uuid column is exactly what failed silently before. An
  unresolvable dose is now **logged and skipped** rather than written
  product-wide.

**Two things to confirm — neither is code:**

1. **Ask Steph to re-check "print vial label" on a dosed order** once this
   deploys, and to confirm which field their template reads. It should now find
   `variant` / `dose` = `"5mg"`, plus `variant_sku` and `batch_number`.
2. **Check the per-dose SKUs are populated** in Admin → Products. If
   `product_doses.sku` is blank we'll send `variant_sku: null`; the dose itself
   still goes through, but the label may want the SKU.

It remains possible their label template is also missing for that SKU — but the
contract violation above is real regardless, and had to be fixed either way.

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

### What the 40 vials actually cost

All 40 requested items map cleanly to the June 16 wholesale sheet. Priced at
sheet wholesale, one vial of each:

| | |
|---|---|
| Vials | 40 |
| **Total at sheet wholesale** | **$1,194.95** |
| Average per vial | $29.87 |
| Plus | shipping (the sheet includes packaging, envelope and fulfilment — *not* shipment cost) |

For reference only, since neither applies here: at a 20% tier this basket would
be $955.96, at 30% $836.47.

Two things that bear on what to ask for:

- **This order earns no volume tier.** It's $1,194.95 against a $5,000
  threshold, and the tier is set by the *prior* month regardless. Full sheet
  price is the correct basis.
- **He asked for "the same price you guys pay for them" — that is below the
  wholesale sheet, not equal to it.** The sheet is EVO's price *to* Vanta; his
  wording asks for EVO's own cost. Those are different numbers and it's worth
  settling which one is meant before quoting. The $1,194.95 above is sheet
  wholesale.

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
