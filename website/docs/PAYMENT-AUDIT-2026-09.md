# The checkout audit — September 2026

Written for the owner of the store, not for an engineer. Every claim here was
checked against the code, the database or a browser; where something is inferred
rather than measured, it says so.

---

## 1. What was actually wrong

Until 9 September 2026 this store had never taken an order of $200 or more.
Seven customers tried. All seven failed. The largest payment that had ever
succeeded was **$194.98**.

The cause was **3-D Secure on Veyra's side**, and none of it was ours. Veyra
asked the card for a verification step, its embedded form printed *"Additional
verification is required for this payment"*, greyed out its own pay button, and
then offered the shopper nothing to do — no code box, no bank-app handoff, no
redirect. The charge was never submitted to the issuer at all, so there was no
decline code, no event from Veyra, and nothing the customer could act on. Two
shoppers lost five orders, about $620, on 8 September alone.

I verified the "not ours" half rather than assuming it. The only number in this
codebase anywhere near $200 is the free-shipping threshold, which is keyed on the
cart subtotal and decides the cost of postage. It never gates a charge. That is
now enforced by a test that fails if any file on the payment path so much as
compares an amount against 200.

**Then Veyra removed 3-D Secure, and the very next high-value attempt behaved
like ordinary card processing:**

| Order | Amount | Outcome | Gap |
| --- | --- | --- | --- |
| VL-4AFCDF39 | $269.35 | declined — `insufficient_funds` | — |
| VL-D56BA5B4 | $269.35 | **paid** | 112 seconds later |

One customer, two attempts three minutes apart. The first reached his **bank**
and came back with a real decline code. His bank texted him to approve the
purchase. He approved it, retried, and it went through. That is the first order
at or above $200 this store has ever settled.

The bank prompt he saw was **not** 3-D Secure coming back. 3-D Secure is a step
inside the checkout form, run by the processor. What he got was his own bank's
fraud hold, sent out of band, which no merchant and no processor controls. The
two look similar to a customer and are completely different mechanisms — the
first blocked the charge before it left Veyra, the second happened *because* the
charge finally reached the issuer.

### Andrew's orders

Two orders Andrew asked about, VL-7B72D71A and VL-9AB78A20, are both
`payment_failed`, both have no `paid_at`, and both have **zero** payment events
recorded. No webhook of any kind ever arrived for either. He was not charged, and
those orders cannot later become charges — the attempt never reached his bank.

---

## 2. The state of the checkout now

The working post-3DS path is intact and is now protected by a permanent
regression run, `npm run qa:highvalue`, which drives a real high-value order
through the real checkout, the real order and item rows, the real inventory hold,
a signed webhook and every side effect behind it. **20 of 20 steps pass on
desktop and at phone width**, and they were re-run after every single change
below.

A second run, `npm run qa:amounts`, places ten real carts from $44 to $826 —
four below $200 and six at or above — and asserts that the cents handed to Veyra
are exactly the cents written on the order, at every size.

---

## 3. What was found, and what was done about it

Grouped by what actually goes wrong for a customer, rather than by file.

### Money that could be lost or taken twice

- **A losing "payment failed" could un-capture a paid order.** Two events racing
  for one order left it reading `payment_failed` with the money taken and the
  side effects already run. Measured, not theorised: of twenty deliberately raced
  orders, **nineteen** ended in exactly that state. All order writes on the
  payment path are now compare-and-set — they change the row only if it is still
  where the check that approved the change found it.

- **Two ways to charge a shopper twice for one purchase.** Reloading a payment
  link after paying still rendered a live, chargeable card form; and replaying a
  checkout submission for an order that had already settled minted a fresh
  chargeable session. Both now stop and send the shopper to their receipt.

- **A second, different capture on an already-paid order was absorbed in
  silence.** The guard that stops a redelivery doing the work twice cannot tell a
  retry from a real second charge, and nothing said anything. A second capture
  under a different payment session now raises a critical alert naming both
  sessions, so it can be found and refunded.

- **A charged order could stay invisible.** A live webhook whose processing
  crashed part-way was answered with "already delivered", so the processor never
  sent it again — even though the code had a recovery path built for exactly that
  case which could therefore never run. Those are now answered as retryable.

- **A penny could hold a parcel.** The check comparing what Veyra charged against
  what the order says compared dollars as floating-point numbers, so a difference
  of exactly one cent was flagged at some amounts and not at others. It now
  compares whole cents.

- **Refunding an order that was never paid** wrote a refund confirmation to the
  customer for a charge that never happened and made the order permanently
  unpayable. It is now refused, with the correct action named instead.

### Orders telling the customer something untrue

- **A declined order was shown as a live one with a receipt** — a total paid, an
  invoice, a tracker. It now says the payment did not complete, offers no
  invoice, and explains what to do.

- **"Thank you for your order"** appeared for orders that might never be paid.

- **Every failure claimed the bank had declined it.** On this store most did not:
  of eighteen failed orders, **sixteen had no processor event at all**, which
  means nobody's bank was ever asked. The wording now distinguishes a real
  decline from "we do not know", and both versions carry the step that actually
  recovers the sale — approve the bank's prompt, then retry, which is exactly how
  David's decline became a paid order 71 seconds later.

- **A shopper's own unfinished payment was reported to them as a sold-out
  shelf.** Reproduced on the harness: three units in stock, the shopper's own
  earlier attempt holding two of them, and the store answering *"we can't ship
  that many — please adjust your cart"*. It now says the units are held by a
  checkout that has not finished, and points them back to the payment page they
  already have.

- **A long, correct message was silently replaced by a generic one.** The
  checkout route flattened errors to plain strings before sanitising them, which
  discarded the marker that says "this text was written for the person reading
  it". Anything over 200 characters became *"we couldn't start checkout just
  now"*. Found because the fix above was written, deployed, and still not shown.

### Records and reporting that did not match reality

- **Paid orders whose stock never moved** are now found and repaired by a job
  that keys on the absence of the movement rather than on a flag.

- **Phantom $0 orders** created from processor events that name no order, or name
  one we do not have, no longer appear in Needs Fulfillment.

- **The commission fraud check could never fire on a real card order.** It reads
  the customer's email and address, and the card path fed it a field that a live
  Veyra callback does not contain. It reads the order row now, like the manual
  path always did.

- **One sale could be reported to the ad platforms as two conversions.** The
  guard was a read followed by a write, and the confirmation page asks twice by
  design. It is now an atomic claim on both the server and the browser side.

- **Five production orders were mislabelled** as bank declines when no bank was
  ever asked. With your authorisation, those five rows were corrected to say the
  reason is not known. Two genuine declines were deliberately left alone. No
  money field and no payment status was touched.

### Things nobody could see

- **The two facts that took days to establish are now on the order page.** Which
  payment session an attempt used, and whether any webhook ever arrived for it.
  Both were already in the database and neither was readable from any screen,
  which is why the conversation with Veyra ran on screenshots. The new panel says
  in plain words which of three situations an order is in, and it never reports a
  failed database read as "no webhook was received".

---

## 4. What was deliberately not changed

Each of these was investigated, and each was left alone because the fix carried
more risk than the problem.

- **Releasing a stock hold left behind by a dead payment attempt.** The obvious
  fix, and not a safe one: an abandoned attempt can still settle minutes later,
  and handing its units to the retry can end with the shopper holding two paid
  orders for one purchase. The message was fixed instead.

- **Treating Veyra's nested charge amount as authoritative.** No live delivery
  has yet confirmed whether that figure is the captured total or the
  pre-shipping session amount. Asserting it would hold real orders out of
  fulfilment on a guess, so it warns and records the raw fields instead. One real
  mismatch will settle it.

- **Restructuring the reconcile sweep's ordering.** The change was larger than
  the starvation case it addressed.

- **Voiding the previous payment session when a shopper retries.** Our side does
  not void it; whether Veyra does is not something we can see from here. That is
  the gap the duplicate-capture alert now watches, and closing it properly needs
  an answer from Veyra rather than a guess from us.

---

## 5. What still needs Veyra, or you

1. **Confirm with Veyra that 3-D Secure is off for good**, not suppressed for a
   trial period. Everything above assumes the account setting they changed is
   permanent.

2. **Ask Veyra whether minting a new payment session voids the previous one.** If
   it does not, a shopper with two tabs open can be charged twice, and the only
   thing standing there today is the alert added in this branch.

3. **Ask Veyra what its charge object's amount field means** — the captured total
   or the session amount. That one answer turns an advisory warning into a real
   safeguard.

4. **Watch for the `duplicate_capture_suspected` alert.** If it ever fires, both
   session ids are in the message; refund the second one.

5. **Decide whether to enable the commission fraud hold in practice.** It now
   works. A genuinely loyal customer buying three times through one ambassador's
   code will hold that commission for your review.

---

## 6. How the working path is protected from here

- `npm run qa:highvalue` — the post-3DS high-value journey end to end, 20 steps,
  desktop and phone. Run it before and after any payment change.
- `npm run qa:amounts` — ten real carts either side of $200, 14 steps.
- The automated suite: **10,102 tests passing, none failing**, with about 2,500
  lines of new payment tests written for this audit across 23 files.
- Every fix in this branch was written as a failing test first, and the failure
  was confirmed against the old code before the fix was applied.

---

## 7. How to check any of this yourself

```
cd website
npm test                    # the whole suite
npm run qa:highvalue        # the high-value payment journey
npm run qa:amounts          # the amount sweep either side of $200
```

For a single order, open `/admin/orders/<id>` and read the **Processor trace**
panel. It answers, in one line, whether Veyra ever told us anything about that
order — which is the question that took days to answer by hand.
