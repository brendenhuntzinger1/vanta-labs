# Master prompt — full checkout audit

Paste the block under **THE PROMPT** into a fresh Claude Code session. Everything
after it is the audit itself: ~200 numbered cases across every function in the
checkout path, each exercised more than one way.

Written 2026-08-26, after three consecutive failed checkout attempts by one
customer (`VL-B10D3E7A`, `VL-DA402437`, `VL-AD39DBEF`) produced **zero** server
errors, **zero** alerts and **zero** payment events. The store could not tell a
declined card from a shopper walking away. That is the hole this exists to close.

**How to read the matrices.** Every case has an ID, an action, and the assertion
that decides it. Where a row says "and then" it is one case with a sequence, not
two cases. Cases marked **P0** are the ones that touch money or stock; if the
audit is cut short, cut from the bottom.

---

## THE PROMPT

> Audit the entire Vanta Labs checkout system end to end using the Playwright MCP
> server, then close the gaps you find.
>
> **Read first, in this order:** `website/docs/CHECKOUT-VERIFICATION-PROMPT.md`
> (this file — the full case matrix), `website/docs/BROWSER-TESTING-RUNBOOK.md`
> (harness setup), `website/docs/findings/BLOCK-GH.md` (what was already proven and
> what was explicitly left `NOT VERIFIED`). Do not re-prove anything BLOCK-GH graded
> `BROWSER-PROVEN` unless the code beneath it has changed since.
>
> **Environment — no exceptions.** Local harness only. Bring it up with
> `website/scripts/setup-local-harness.sh`, serve with `npm run harness:build &&
> npm run harness:start`. Not `next dev` (HMR resets React state mid-test), not
> `next start` (forces `NODE_ENV=production`, which hard-blocks the mock gateway by
> design — do not weaken that control). Drive `http://127.0.0.1:3000`. **Never**
> point a browser at production for any step. No test orders, no payment attempts,
> no account creation, no coupon redemption against the live store, ever.
>
> **Work the matrix section by section, in order.** Sections 1-3 build the state
> sections 4-8 depend on. Record a verdict and an evidence grade per case using
> BLOCK-GH's vocabulary: `BROWSER-PROVEN` (driven through the real UI *and* the
> resulting database rows checked), `DB-PROVEN`, `NOT VERIFIED`. A green screen with
> no row check is not proven.
>
> **Test each function more than one way.** Every route gets at minimum: a valid
> call, an invalid-input call, a boundary call, and a tampered call. A function that
> only ever sees good input has not been tested.
>
> **The failure cases matter more than the happy path.** The happy path was proven in
> BLOCK-GH; the decline path never has been. For each failure case the question is
> not "does it error" but "what does the shopper see, and what does the store
> record". A decline that leaves the shopper on a spinner and writes nothing anywhere
> is the exact defect that caused this document to exist.
>
> **Be honest about what you cannot prove.** Read "What a browser cannot prove"
> before claiming Apple Pay or the live card form works. Grade those `NOT VERIFIED`
> and say what would close them.
>
> **Then fix what you find.** Failing test first — this is payment code, so
> `superpowers:test-driven-development` applies — then root cause, then re-run the
> same browser flow. Commit each fix separately. `npm test`, `npx tsc --noEmit` and
> `npm run lint` must all be clean before you push.
>
> **Deliver** a findings document at
> `website/docs/findings/CHECKOUT-AUDIT-<date>.md` in BLOCK-GH's format: a table per
> section, numbered defect IDs, and an explicit list of everything still
> `NOT VERIFIED` with what it would take to close each one.

---

## Section 1 — Pre-checkout: catalogue and cart

| ID | Case | Assertion |
|---|---|---|
| 1.1 | Age gate, first visit | Blocked before catalogue is reachable |
| 1.2 | Age gate, decline | Cannot proceed; state persists across reload |
| 1.3 | Age gate, accept, then reload | Not re-prompted |
| 1.4 | Age gate in a fresh incognito context | Prompted again |
| 1.5 **P0** | `/api/catalog/products` | Prices match `products` rows exactly |
| 1.6 | Product page, in stock | Add-to-cart enabled, stock figure matches DB |
| 1.7 **P0** | Product page, zero stock | Add-to-cart disabled; back-in-stock offered |
| 1.8 | `/api/catalog/back-in-stock` valid email | Row written |
| 1.9 | `/api/catalog/back-in-stock` malformed email | Rejected, no row |
| 1.10 | `/api/catalog/bac-water` | Companion product resolves |
| 1.11 | `/api/catalog/payment-methods` | Returns only `enabled` methods |
| 1.12 | `/api/catalog/promotions` | Matches admin toggles; defaults OFF when unset |
| 1.13 | `/api/catalog/bulk-savings-config` | Tier thresholds match admin |
| 1.14 | `/api/catalog/subscribe-save` | Config matches admin |
| 1.15 | `/api/catalog/welcome-offer` | Only for a first-time email |
| 1.16 | Add 1 item | Cart badge 1, line total correct |
| 1.17 | Add same item twice | One line, qty 2 — not two lines |
| 1.18 | Add 3 distinct items | Three lines, subtotal is the sum |
| 1.19 | Quantity via input, up and down | Totals track both directions |
| 1.20 **P0** | Quantity above available stock | Clamped at stock, not silently accepted |
| 1.21 | Quantity set to 0 | Line removed or clamped to 1 — state which |
| 1.22 | Quantity set to a negative number | Rejected |
| 1.23 | Quantity set to a non-integer (`1.5`, `abc`) | Rejected, no NaN in totals |
| 1.24 | Remove one line of several | Others survive, subtotal recalculates |
| 1.25 | Empty the cart | Empty state renders; checkout unreachable |
| 1.26 | Reload with items | Cart persists |
| 1.27 | Cart in a second tab | Both tabs agree after refresh |
| 1.28 | `/api/cart/validate` with a stale price | Reports the drift |
| 1.29 **P0** | `/api/cart/validate` with a now-deleted product | Reports it; does not 500 |
| 1.30 **P0** | `/api/cart/validate` with qty above stock | Reports it |
| 1.31 | `/api/cart/restore` valid token | Cart rehydrates |
| 1.32 | `/api/cart/restore` forged token | Rejected |
| 1.33 | `/api/cart/track` | Row written for the recovery sweep |
| 1.34 | Bulk tier boundary, one below | No tier applied |
| 1.35 **P0** | Bulk tier boundary, exactly at | Tier applied |
| 1.36 | Bulk tier boundary, one above | Same tier, correct amount |

## Section 2 — Validation functions, exercised directly

Unit-level. These are pure or near-pure and cheap to hammer; drive them through
their routes as well as directly.

| ID | Function | Cases |
|---|---|---|
| 2.1 | `sanitizeText` (`quote-order.ts:185`) | empty; whitespace only; 10k chars; HTML tags; emoji; null bytes; RTL override chars |
| 2.2 **P0** | `validateDestination` (`:197`) | US + valid state; US + invalid state; US + no state; a non-shipped country; empty country; lowercase country |
| 2.3 **P0** | `validateCustomer` (`:212`) | all valid; missing email; malformed email; missing name; missing address; missing postal code; postal code of wrong shape for the state; 500-char name |
| 2.4 | `normalizeCouponCode` (`coupons.ts:11`) | lowercase; mixed case; surrounding whitespace; internal whitespace; empty; unicode lookalikes |
| 2.5 **P0** | `calculateCouponDiscount` (`:19`) | percent normal; percent 100; percent >100; fixed below subtotal; fixed above subtotal; fixed equal to subtotal; zero; negative; non-numeric |
| 2.6 **P0** | `generateOrderNumber` (`payment-service.ts:65`) | 10k calls, zero collisions; format matches `VL-XXXXXXXX` |
| 2.7 | `sanitizeCustomerInput` (`:424`) | strips what it claims to; leaves valid input untouched |
| 2.8 **P0** | `buildOrderRow` (`quote-order.ts:946`) | every modifier off; every modifier on at once; each modifier alone |

## Section 3 — Quote and order creation

| ID | Case | Assertion |
|---|---|---|
| 3.1 **P0** | `quoteOrder` baseline, 1 item | subtotal, shipping, tax, fee, total all match a hand calculation |
| 3.2 **P0** | `quoteOrder` with every modifier stacked | Coupon + ambassador + points + credit + bulk + protection. Total ≥ 0, no double-discount |
| 3.3 **P0** | Discounts exceeding subtotal | Total floors at 0 or at shipping — state which, and that it is never negative |
| 3.4 | Quote is idempotent | Same input twice, identical output |
| 3.5 **P0** | Quote vs order row | Every figure the shopper saw appears unchanged in `orders` |
| 3.6 **P0** | `insertOrderRow` | Row created, `payment_status=pending_payment`, `payment_id` null at this instant |
| 3.7 **P0** | `insertOrderItems` | One row per line, qty and unit price correct |
| 3.8 **P0** | Inventory hold created | `inventory_reservations` `active`, qty matches, `expires_at` = now + 15 min |
| 3.9 **P0** | `idempotency_key` present and unique | Set on every order |
| 3.10 **P0** | Same `idempotency_key` submitted twice | Exactly one order row |
| 3.11 | `/api/admin/checkout-preflight` | Reports the same readiness the checkout enforces |
| 3.12 **P0** | `createCheckoutSession` success | `payment_id` written back to the order (`payment-service.ts:398`) |
| 3.13 **P0** | `createCheckoutSession` throws | Order cancelled, not left dangling (`:370`) |
| 3.14 | `createCheckoutSession` slow | No duplicate order from an impatient second click |
| 3.15 | Order number uniqueness under load | 50 concurrent creations, 50 distinct numbers |

## Section 4 — Payment lanes

Only `card` ships enabled (`DEFAULT_PAYMENT_METHODS`, `payment-methods.ts:131`),
labelled "Debit, Credit & Apple Pay". Manual lanes exist in schema and admin config
but are off by default — test 4.20+ only if the live store has one enabled.

| ID | Case | Assertion |
|---|---|---|
| 4.1 **P0** | Standard card, `/checkout` → `/checkout/pay/{orderId}` | Iframe mounts, `status: "ready"` |
| 4.2 | Pay page for someone else's order id | Refused, no order data leaked |
| 4.3 | Pay page for a non-existent order id | Clean 404, not a crash |
| 4.4 | Pay page for an already-paid order | Redirects to confirmation, no second charge path |
| 4.5 | Pay page for a cancelled order | Refused |
| 4.6 | `/api/checkout/order-status/{id}` while pending | `pending_payment` |
| 4.7 **P0** | `/api/checkout/order-status/{id}` after paid | Flips to paid, and the page redirects |
| 4.8 | `/api/checkout/order-status/` on a foreign order | No PII leaked |
| 4.9 | `/api/checkout/express/config` | Reports availability honestly |
| 4.10 | `/api/checkout/express/session` | Intent created |
| 4.11 | `/api/checkout/express/shipping-rates` valid address | Rates returned |
| 4.12 | `/api/checkout/express/shipping-rates` unsupported country | Refused cleanly |
| 4.13 **P0** | `/api/checkout/express/authorize` happy path | Order created and paid |
| 4.14 **P0** | `/api/checkout/express/authorize` failure | `payment_failed`, stock released (`authorize/route.ts:359`) |
| 4.15 | Express button when the wallet is unavailable | Hidden; standard lane still works |
| 4.16 | `expireStaleExpressIntents` | Armed-but-unused intents retire |
| 4.17 | Membership checkout | `order_type`, `membership_tier_id`, `membership_cycle` written |
| 4.18 | Membership renewal vs first purchase | Distinguished correctly |
| 4.19 | Subscribe-and-save | Recurrence recorded |
| 4.20 | Manual lane, if enabled | `payment_proof_url`, `payment_submitted_at` |
| 4.21 | Manual lane admin approval | `verified_at`, `verified_by`, order flips paid |
| 4.22 | Manual lane admin rejection | `payment_rejected_at`, `rejection_reason`, stock released |

## Section 5 — Payment outcomes

Mock mode drives the **real** webhook pipeline (`payment-mock.ts:18` maps each
outcome to the genuine event type; `/api/checkout/mock-pay` runs it through
`processPaymentWebhook`), so a mock decline exercises the same code a live one would.

| ID | Case | Assertion |
|---|---|---|
| 5.1 **P0** | Approve | `paid`, `paid_at`, `payment_events` 1 row, stock decremented, reservation `finalized`, confirmation email queued, `fulfillment_status=awaiting_fulfillment` |
| 5.2 **P0** | Decline — generic `4000000000000002` | **Shopper sees a decline, not a spinner.** Order not paid. State whether stock is held or released |
| 5.3 **P0** | Decline — insufficient funds `4000000000009995` | As 5.2, and the reason is distinguishable |
| 5.4 **P0** | Decline — incorrect CVC `4000000000000127` | As 5.2 |
| 5.5 **P0** | Decline, then immediate retry, same card | Second attempt behaves identically; no orphan order |
| 5.6 **P0** | Decline, then retry with a good card | Succeeds; exactly one paid order |
| 5.7 **P0** | Three declines in a row, same shopper | **Anything at all recorded server-side?** This is the incident, reproduced |
| 5.8 **P0** | Cancel | `canceled`, stock released |
| 5.9 **P0** | Full refund | `refunded`, commission reversed, points and credit returned, stock restocked |
| 5.10 **P0** | Partial refund | `partially_refunded`, only the refunded fraction reversed |
| 5.11 **P0** | Second partial refund | Cumulative, does not overwrite the first |
| 5.12 **P0** | Chargeback | Always full reversal, even with a partial amount |
| 5.13 **P0** | Refund after a partial refund | Completes to full |
| 5.14 **P0** | Duplicate webhook, same `event_id` | Second is a no-op; side effects run once |
| 5.15 **P0** | Two distinct events, same order | `paid_side_effects_at` claim spends once |
| 5.16 **P0** | `payment.failed` arriving on a paid order | Does **not** demote (`payment-webhook.ts:1419`) |
| 5.17 **P0** | Unrecognised event type | Does not write `pending_payment` over a paid order (`isRecognisedMoneyEvent`) |
| 5.18 | Webhook with a bad signature | Rejected |
| 5.19 | Webhook with no signature | Rejected |
| 5.20 | Webhook with a replayed old timestamp | Rejected if the handler checks it — state which |
| 5.21 **P0** | Webhook for an unknown order id | Handled, no crash, alert raised |

**5.2, 5.3, 5.4 and 5.7 are the point of this whole exercise.** Record what the
customer sees on screen, how long it takes to appear, and whether *anything* is
written server-side. If the answer is "nothing", that is the defect.

## Section 6 — Post-payment side effects

| ID | Case | Assertion |
|---|---|---|
| 6.1 **P0** | Stock decrement | Exactly the ordered quantity, once |
| 6.2 **P0** | Decrement is not double-run on a redelivered webhook | Count unchanged on the second delivery |
| 6.3 **P0** | Reservation `finalized` | Not left `active` |
| 6.4 | Confirmation email queued | `order_email_log` + `pending_emails` |
| 6.5 | Email retry on failure | `retryPendingEmails` picks it up |
| 6.6 **P0** | Ambassador commission accrued | `referral_orders` + `commissions` (BLOCK-GH defect G-01 — confirm fixed) |
| 6.7 **P0** | Commission not accrued twice | One row after a redelivery |
| 6.8 | `repairMissingCommissionAccruals` | Backfills a deliberately failed accrual |
| 6.9 | Points earned | `points_earned` matches the rule |
| 6.10 | Points redeemed are spent | Balance decremented once |
| 6.11 | Store credit spent once | Balance decremented once |
| 6.12 | Coupon redemption counted | `redemptions_count` +1 |
| 6.13 **P0** | Coupon at `max_redemptions` | Refused for the next shopper |
| 6.14 | Fulfilment queue entry | Matches the queue's own predicate |
| 6.15 | Shippo sync | `sweepUnsyncedOrders` pushes it |
| 6.16 | Order push notification | Fires once, inside the claim |
| 6.17 | Ad purchase event | `/api/ads/purchase-event/{orderId}` once |
| 6.18 | Order confirmation page | Totals match the order row |
| 6.19 | Order appears in `/account` | Correct status and figures |
| 6.20 | Admin order detail | Every figure matches the DB |

## Section 7 — Pricing modifiers

Combine with 5.1 rather than testing in isolation — interactions are where pricing
bugs live. Each row: alone, then stacked with the row above it.

| ID | Modifier | Watch for |
|---|---|---|
| 7.1 | Guest checkout | No `customer_user_id` |
| 7.2 | Logged-in checkout | Account linkage, saved address |
| 7.3 **P0** | Public coupon | `coupon_code`, `discount_amount` |
| 7.4 **P0** | Private coupon, anonymous shopper | **Refused** |
| 7.5 **P0** | Member-scoped coupon, non-member | **Refused** |
| 7.6 **P0** | Member-scoped coupon, member | Honoured |
| 7.7 **P0** | Expired coupon | Refused |
| 7.8 **P0** | Not-yet-started coupon | Refused |
| 7.9 **P0** | Coupon below its minimum spend | Refused |
| 7.10 **P0** | Coupon assigned to another email | Refused |
| 7.11 | Coupon code with odd casing/whitespace | Accepted after normalisation |
| 7.12 | Non-existent coupon | Clean rejection message |
| 7.13 **P0** | Ambassador code | `referral_code`, `ambassador_id` |
| 7.14 **P0** | Ambassador's own code on their own order | Refused if self-referral is barred — state which |
| 7.15 **P0** | Coupon + ambassador code together | Correct combined discount, no double-dip |
| 7.16 | Loyalty points redemption | `points_redeemed` |
| 7.17 **P0** | Points redemption above balance | Refused |
| 7.18 | Store credit | `store_credit_redeemed_cents` |
| 7.19 **P0** | Store credit above balance | Refused |
| 7.20 | Ambassador credit | `ambassador_credit_redeemed_cents` |
| 7.21 | Bulk tier | `bulk_discount_tier`, `bulk_discount_amount` |
| 7.22 | Shipping protection on | `shipping_protection_fee` |
| 7.23 | Shipping protection off | Fee absent, total drops by exactly that |
| 7.24 | Card processing fee | `card_processing_fee`, `card_processing_fee_percent` |
| 7.25 **P0** | Tax by state, three different states | `tax_amount`, `tax_rate_percent`, `tax_state` |
| 7.26 | Free-shipping threshold, one cent below | Shipping charged |
| 7.27 **P0** | Free-shipping threshold, exactly at | Shipping free |
| 7.28 **P0** | Discount drops the order below the threshold | State whether shipping is re-charged — and that it is deliberate |

## Section 8 — Failure, race and adversarial

The section nobody runs. This incident lived here.

| ID | Case | Question |
|---|---|---|
| 8.1 **P0** | Abandon on the pay page | Reservation expires at 15 min; order row stays `pending_payment` forever unless the retire plan ships |
| 8.2 **P0** | Webhook lost after a real charge | `reconcileVeyraPendingPayments` settles it within one sweep |
| 8.3 **P0** | Reconcile runs twice on the same order | Deterministic event id makes it a no-op |
| 8.4 **P0** | Double-click submit | `idempotency_key` prevents a second order |
| 8.5 **P0** | Two tabs, submit both | One order |
| 8.6 **P0** | Pay at minute 16, after the hold expired | Oversell must be impossible |
| 8.7 **P0** | Last unit, two shoppers, simultaneous checkout | One wins, one is refused cleanly |
| 8.8 **P0** | Item goes out of stock between cart and pay | Refused before charging |
| 8.9 | Back button after payment | No duplicate order, confirmation still reachable |
| 8.10 | Forward button after payment | Same |
| 8.11 | Refresh the pay page mid-payment | Poll resumes, no duplicate |
| 8.12 **P0** | Iframe fails to load | `status: "error"` shown (`VeyraCheckout.tsx:180-186`); does it reach Sentry? (gap 3) |
| 8.13 | Network drops during the poll | No false failure shown (`POLL_MS` 2500) |
| 8.14 | Slow settlement past 60s | Reassurance copy appears (`REASSURE_AFTER_MS`) |
| 8.15 | Very slow settlement, 5 min | Page still coherent |
| 8.16 **P0** | Tamper the total in the client payload | Server recomputes; tampered value ignored |
| 8.17 **P0** | Tamper the price of a line item | Server recomputes |
| 8.18 **P0** | Tamper the quantity past stock | Refused |
| 8.19 **P0** | Tamper `order_id` to another shopper's | Refused |
| 8.20 **P0** | Replay a `payment.succeeded` for a cheap order onto an expensive one | Refused |
| 8.21 | Submit checkout with an empty cart | Refused |
| 8.22 | Submit with a deleted product in the cart | Refused cleanly |
| 8.23 | Submit with a 10k-char address | Handled or refused, never a 500 |
| 8.24 | SQL-ish and XSS-ish strings in every text field | Stored inert, rendered escaped |
| 8.25 | Unicode / RTL / emoji in the name | Renders on the confirmation and the packing slip |
| 8.26 | Rapid repeated checkout attempts | Rate limiting behaves; state what it does |
| 8.27 **P0** | Three failed attempts, one email, one hour | Does anything alert? (gap 4) |

## Section 9 — Cross-cutting

| ID | Case | Assertion |
|---|---|---|
| 9.1 | Every screen above at 390x844 | Layout intact, tap targets ≥ 44px, no horizontal scroll |
| 9.2 | Pay page iframe at 390x844 | Sized correctly, fully visible |
| 9.3 | 768x1024 tablet | Intact |
| 9.4 | Keyboard-only checkout | Completable |
| 9.5 | Screen-reader labels on the checkout form | Present |
| 9.6 | Colour contrast on error states | Meets AA |
| 9.7 | Hydration warnings in console | None |
| 9.8 | Console errors across the whole flow | None |
| 9.9 | In-app browser (Instagram/TikTok UA) | Checkout completes |
| 9.10 | Safari-family UA string | No lane hidden incorrectly |
| 9.11 | Slow 3G throttling | Usable; no premature timeout |
| 9.12 | Browser back into an expired session | Recovers or explains |

---

## What a browser cannot prove

Say this plainly in the findings rather than quietly claiming coverage.

**Apple Pay is not testable in Chromium, at all.** A real wallet sheet requires
Safari on a provisioned Apple device; Playwright cannot produce one and no flag
changes that. Testable: config gating, session creation, shipping rates, the
`authorize` route's failure handling, whether the button hides when the wallet is
unavailable, and that the standard lane still works when it does. The sheet itself
stays `NOT VERIFIED` until someone taps it on a real iPhone. Two express orders have
completed in production, both paid — that is evidence the lane works, not
verification.

**The live Veyra card form is third-party and cross-origin.** `VeyraCheckout.tsx:6-7`
mounts an iframe served by veyragate.com; card data never touches your domain and the
iframe's only outbound signals are `onReady` and success. In mock mode that iframe is
replaced entirely, so locally you verify *your side of the handoff*, never Veyra's
form. On a Vercel preview you could load the real iframe but could not submit a card
without moving real money. **This is precisely the blind spot the incident fell
into**, which is why the four fixes below matter more than any test in this document.

**The local harness has no RLS and no GoTrue** (BLOCK-GH). Anything behind a login
cannot be graded above `DB-PROVEN` on it.

---

## Never let it happen again

Tests describe the system; these change it. Verification alone would not have caught
this incident, because nothing was broken in a way a test could see — the store was
simply blind.

**Gap 1 — declines are invisible.** No `payment.failed` event has ever been recorded
in `payment_events`. The handler already understands the type
(`payment-webhook.ts:84-86`); nothing is sending it. Either Veyra is not configured
to deliver failure events or it does not send them. Resolving it needs processor-side
access, so it is a question to put to Veyra, not a code change. Until it is answered,
every declined payment is indistinguishable from an abandoned cart.

**Gap 2 — abandoned orders never terminate.** Task 1 of
`docs/superpowers/plans/2026-08-26-retire-abandoned-pending-orders.md`, still
unshipped. Without it, `pending_payment` rows accumulate forever and the backlog
warning returns.

**Gap 3 — client-side checkout errors may not reach Sentry.** `VeyraCheckout.tsx:186`
reports a failed iframe load via `console.error`. The Sentry client SDK is
initialised (`instrumentation-client.ts:19`), but a caught error logged to the
console is only captured with the `CaptureConsole` integration enabled. Verify
whether it is. If not, a shopper whose card form never loaded produces no signal
anywhere — consistent with what was observed, and not ruled out.

**Gap 4 — no alerting on repeated failures by one shopper.** Three attempts in
sixteen minutes by one email generated nothing. A rule as simple as *same email, 3+
unpaid orders within an hour* would have surfaced this while the customer was still
on the site. Case 8.27 tests for it.

Gaps 2, 3 and 4 are yours to fix. Gap 1 is a question for the processor.
