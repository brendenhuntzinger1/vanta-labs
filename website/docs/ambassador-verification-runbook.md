# Ambassador System — End-to-End Verification Runbook

Read this section first. Three things below will make a working system look
broken if you don't know about them.

---

## Before you start: three traps

**1. The minimum qualifying order defaults to $100.**
`referral-config.ts:9` sets `DEFAULT_MINIMUM_QUALIFYING_ORDER = 100`. If your
test cart's **pre-discount** subtotal is under the configured minimum, the
commission records as `$0.00` with `ineligible_reason` explaining why. That is
correct behavior, not a bug. Check the Program tab before ordering and either
set your test cart above the minimum or lower the minimum.

**2. Commission tiers silently override an unlocked rate.**
`getEffectiveCommissionPercent` (`ambassador-commission.ts:130`) ignores the
ambassador's own `commission_percent` and uses the matching **tier** rate
whenever `commission_percent_locked` is false and any active tier exists. Save
the commission through the Rates card — that sets `locked = true` — or your 15%
may record as something else entirely.

**3. A real end-to-end test costs real money.**
Mock payment mode is blocked in production by design: `PAYMENT_PROVIDER=mock`
throws when `NODE_ENV=production` (`payment-provider.ts:305`), specifically so
an unauthenticated caller can never mark orders paid via `/api/checkout/mock-pay`.
You told me not to change the payment processor config, so the honest path is a
**real card charge through Veyra on the live site**, using your cheapest SKU.
Budget for two real orders.

Related: **the admin's refund button does not move money.**
`LivePaymentProvider.refundPayment()` is a no-op (`payment-provider.ts:243`).
The admin action tests commission-reversal logic only. To actually return money
you must refund inside Veyra. The store's own refund email is already gated on
real settlement, so no customer gets told money is coming when it isn't.

---

## The test ambassador

| Field | Value |
|---|---|
| Name | `Test Ambassador` |
| Referral code | `VLTEST` |
| Status | `approved` |
| Customer discount | **10%** |
| Commission | **15%** (locked/manual) |

Round numbers on purpose: at a $120 subtotal the discount is $12.00 and the
commission is $16.20, both of which you can check in your head. Avoid rates
that divide badly — a rounding question mid-test wastes an order.

**Use a real email you control** for the ambassador. Application and status
emails are live.

---

## Phase 1 — Set up and confirm before ordering

### Step 1.1 — Create the ambassador
Admin → `/admin/partners` → **Ambassadors** tab → *Invite Partner*.
Name `Test Ambassador`, your email, commission `15`.

Then approve them (roster → Approve) so `status = approved`. An unapproved
ambassador earns nothing — that is Phase 5's test, not this one.

### Step 1.2 — Set the referral code
On the roster, set the code to `VLTEST`.

### Step 1.3 — Set both rates independently
Open `/admin/partners/<their-id>` → **Rates** card.

- Customer Discount → `10` → **Save Discount**
- Commission → `15` → **Save Commission**

Save them **separately**, and after each save confirm the *other* number did
not move. That is the first real test of independence — do not skip it by
setting both and saving once.

### Step 1.4 — Check the program settings
**Program** tab. Note the *Minimum qualifying order* and *Commission hold
period*. Your test cart's pre-discount subtotal must be **at or above** the
minimum.

### Step 1.5 — What you should see in the admin BEFORE ordering

- **Overview tab** — Total ambassadors includes the new one. Approved count +1.
  Lifetime Sales, Balance Owed unchanged.
- **Ambassadors tab** — a row for Test Ambassador reading
  `Customer 10%` and `Earns 15%`. No "(default)" tag next to the 10% — that tag
  appears only for an ambassador inheriting.
- **Profile page** — header reads
  `Customer save 10% (override) · Test Ambassador earns 15% (manual)`.
  Orders 0, Gross Sales $0.00, Balance Owed $0.00.

### Step 1.6 — Run SQL Block 0 and Block 1
`src/lib/sql/ambassador-e2e-verify.sql`.

**Block 1 must show:** `customer_discount_pct = 10`, `discount_source = OVERRIDE`,
`ambassador_earns_pct = 15`, **`commission_is_manual = true`**, `status = approved`.

If `commission_is_manual` is false, go back to Step 1.3 and press Save
Commission. Do not order until it is true.

---

## Phase 2 — Order #1 (records 10% / 15% forever)

### Step 2.1 — Place the order
Use a **different browser profile or incognito window**, and **do not log in**
as the ambassador — an approved ambassador gets a personal discount on their
own orders, which is a different discount and will contaminate the math.

1. Add your cheapest SKU, quantity enough to clear the minimum qualifying order.
2. **Avoid quantity 3–4 of one item** — Buy 3 Get 1 Free is a bundle discount and
   the code picks the single best discount, so a bundle can displace the referral.
3. Do **not** apply a coupon. Do **not** use a membership account.
4. At checkout, enter `VLTEST` in the **Referral code** field and press **Apply**.

### Step 2.2 — What you should see at checkout

- Green confirmation line under the field.
- `Test Ambassador · 10% off` (`checkout/page.tsx:1017` renders exactly this).
- The order summary gains a discount line equal to **10% of the merchandise
  subtotal**.
- The coupon field is replaced with *"A referral code is applied. Remove it to
  use a coupon instead."* — the two never stack.
- Tax, if your state collects it, is computed on `subtotal − discount`, not on
  the full subtotal.

**Write down the subtotal, the discount, and the total before you pay.**

### Step 2.3 — Pay
Complete the real payment through Veyra.

### Step 2.4 — What should happen after payment succeeds

- Order confirmation page, then a confirmation email.
- Order appears in `/admin/orders` with payment status **paid**.
- The order pushes to Shippo (the fulfillment card on the order page reports it).
- Commission accrues in the background, on the deferred path, after the
  response is flushed — so give it a few seconds before checking.

### Step 2.5 — What should appear under the ambassador

Profile page `/admin/partners/<id>`:

| Metric | Expected |
|---|---|
| Orders | 1 |
| Gross Sales | the order's `amount_paid` |
| Avg Order Value | same as Gross Sales |
| Net Commission Earned | 15% of (subtotal − discount) |
| Balance Owed | the same figure |
| — of which *ready* | $0.00 |
| — of which *holding* | the full amount |
| Commission Paid | $0.00 |
| Reversed | $0.00 |

Commission sits in **pending** because it is inside the hold period (default 30
days). "Balance Owed" counts pending + approved, so it is non-zero immediately;
"ready" stays $0.00 until the hold clears. Both are correct at once.

**Ambassador portal** (`/partner/dashboard`, logged in as them): the hero reads
*"Your code gives customers 10% off · you earn 15% commission"*, total earnings
and the order both appear.

### Step 2.6 — Run SQL Blocks 2, 3, 4, 5

**Block 2 proves the discount and attribution:**
- `attribution_recorded = true`
- `discount_correct = true`
- `paid_side_effects_at` is set (not null)

**Block 3 proves the snapshot — this is the one that matters:**
- `snapshot_commission_pct = 15`
- `snapshot_discount_pct = 10`
- `commission_math_correct = true`
- `payment_status = pending`
- The `commissions` mirror shows the same two percentages.

**Block 4 proves duplicate protection:**
- `referral_rows = 1` and `commission_rows = 1`.

Veyra may deliver the paid webhook more than once; the `paid_side_effects_at`
claim flips NULL → timestamp exactly once and every later delivery loses the
race. If you ever see 2 here, the claim is broken and commissions are being
double-counted.

**Block 5 proves the admin's numbers** match the database. Compare
`paid_orders`, `revenue`, `pending_commission`, `balance_owed` against what
Step 2.5 showed on screen. Any disagreement is a UI bug, not a data bug.

---

## Phase 3 — Change the rates, then Order #2

This is the cleanest proof in the whole plan.

### Step 3.1 — Change both rates
Profile → Rates card:
- Customer Discount → `15` → Save Discount
- Commission → `20` → Save Commission

### Step 3.2 — Confirm history did NOT move
Before ordering again, re-run **Block 3**.

Order #1 must **still** read `snapshot_commission_pct = 15` and
`snapshot_discount_pct = 10`. If those numbers followed the rate change, the
system is recomputing history from the live rate and the snapshot has failed.
Stop and tell me if so.

### Step 3.3 — Place order #2
Same procedure as Phase 2. At checkout the field must now read
`Test Ambassador · 15% off`, and the discount line must be **15%** of subtotal.

### Step 3.4 — Run SQL Block 6 — the verdict

Two rows, oldest first:

| | order #1 | order #2 |
|---|---|---|
| `snapshot_discount_pct` | **10** | **15** |
| `snapshot_commission_pct` | **15** | **20** |
| `ambassadors_discount_today` | 15 | 15 |
| `ambassadors_commission_today` | 20 | 20 |

The last two columns being 15/20 on **both** rows while the snapshot columns
differ is the entire point: the live rate moved, the history did not.

The final query in Block 6 collapses this to one boolean. **`snapshot_held`
must be `true`.**

Also confirm `discount_pct_actually_charged` matches `snapshot_discount_pct` on
each row — that proves the stored discount still explains the money actually
charged, which is the reason the snapshot exists at all.

---

## Phase 4 — Refund behavior

Remember: the admin refund records in Vanta only. Refund in Veyra separately if
you want the money returned.

### Step 4.1 — Partial refund (use order #2)
Refund roughly half the order in the admin.

Expected, via **Block 7**:
- `commission_amount` drops proportionally — recomputed from the **stored** base
  and percent, so successive partials don't compound off an already-reduced
  number.
- `commission_status` stays `pending` (it had not been paid out).
- `review_required = false`.

Recompute by hand: `original_commission × (1 − refunded_fraction)`.

### Step 4.2 — Full refund (use order #1)
Refund the remainder.

Expected, via **Block 7**:
- `commission_status = reversed`
- `reversed_at` set
- `commission_amount` unchanged — the figure is preserved as a record of what
  was earned; the **status** is what voids it.

Then the profile page should show that amount under **Reversed**, and Balance
Owed should drop by it.

> If the commission had already been paid out, a full refund lands in
> `manual_review` with a reason rather than silently reversing — money already
> sent cannot be clawed back by a status change.

---

## Phase 5 — Negative cases

### Step 5.1 — Failed / abandoned payment
Start a checkout with `VLTEST`, reach the payment step, then **abandon it**.

**Block 9** expected: order exists with `payment_status` not `paid`,
`paid_side_effects_at IS NULL`, and **`commission_rows = 0`**. A commission must
never exist for an unpaid order.

### Step 5.2 — Disabled ambassador
Disable Test Ambassador in the roster, then place a small order with `VLTEST`.

**Block 8** expected:
- `attribution_still_recorded = true` — the order still knows where it came from
- `commission_percent = 0`
- `commission_amount = 0.00`
- `ineligible_reason` names the ambassador as inactive

Eligibility is re-checked at webhook time, not just at checkout, so disabling
mid-flight still stops the commission.

Re-approve them afterward.

### Step 5.3 — Program default inheritance
On the Rates card, **clear** the Customer Discount field (leave it empty) and
Save Discount.

Expected:
- Card reads *"Inheriting the program default (10%)"*
- Roster shows `Customer 10% (default)`
- **Block 10**: `customer_discount_percent IS NULL`, `discount_mode = inherits
  program default` — **NULL, not 0**

Then change the program default in the Program tab and confirm this ambassador
follows it while any ambassador carrying an override does not.

### Step 5.4 — Deliberate 0%
Set the Customer Discount to `0` and save. `discount_mode` must read
`deliberate 0% (no discount)` and the value must be `0`, not NULL. A code that
tracks attribution without discounting is legitimate and must survive.

### Step 5.5 — Rejected input
Try to save a customer discount of `100`. Expected: *"Customer discount must be
0 or more and less than 100."* and no change in the database. A 100% discount is
a free order.

---

## Coverage map

| Requirement | Proven by |
|---|---|
| Customer discount calculation | Block 2 `discount_correct`, checkout line |
| Commission calculation | Block 3 `commission_math_correct` |
| Referral attribution | Block 2 `attribution_recorded` |
| Historical rate snapshot | **Block 6 `snapshot_held`** |
| Order count | Block 5 `paid_orders` vs profile |
| Revenue | Block 5 `revenue` vs Gross Sales |
| Pending commission | Block 5 `pending_commission` |
| Payout balance | Block 5 `balance_owed` |
| Duplicate webhook protection | Block 4 `referral_rows = 1` |
| Failed payment | Block 9 `commission_rows = 0` |
| Full refund | Block 7 status `reversed` |
| Partial refund | Block 7 proportional amount |
| Disabled ambassador | Block 8 percent 0, reason set |
| Program-default inheritance | Block 10 NULL |
| Individual overrides | Block 1 + Block 10 |

---

## Visual QA checklist — the six tabs

Send screenshots and I'll work through anything that looks wrong. What I'd
check on each:

### All tabs
- Tab bar wraps cleanly at 375px with no horizontal page scroll.
- The active tab is legible (dark text on light chip), inactive tabs readable.
- Switching tabs does not clear a search you typed.
- Only one tab's content is visible — if a section shows on **every** tab it
  landed outside its group.

### Overview
- Five ambassador counts, six sales/commission cards, no editors.
- Cards use two columns at 375px without clipping numbers.
- Balance Owed sub-line reads `$X ready · $Y holding`.

### Ambassadors
- Roster with the **Rates** column showing both percentages.
- `(default)` tag only on ambassadors with no override.
- Table scrolls horizontally **inside its own container** — the page must not.
- Invite Partner form below the roster.

### Applications
- Selecting it moves the status filter to `pending` — the dropdown should
  visibly read Pending, since it is describing what's on screen.
- Amber count badge on the tab matches the number of rows.
- With zero applications: empty-state message, badge hidden.

### Payouts
- Payout History with date/search filters, and the
  `Showing N of M · $X total` line agreeing with the rows.
- Empty state before any payout is recorded.

### Program
- Commission Tiers, Program Settings, Marketing Resources — all three.
- Number inputs accept decimals and don't reformat mid-typing.

### Analytics
- Top Performers, Needs Attention, Fraud & Review.
- Needs Attention is hidden entirely when no approved ambassador has orders.
- Fraud rows render with no flags present.

---

## Status

**The ambassador system is not production-ready until Block 6 returns
`snapshot_held = true` on two real paid orders**, and Blocks 2–5 agree with the
admin screens. Everything to this point is verified by 1176 passing tests, a
clean build, and structural checks — none of which proves that a real Veyra
payment produces a correct commission row. Only the order does that.
