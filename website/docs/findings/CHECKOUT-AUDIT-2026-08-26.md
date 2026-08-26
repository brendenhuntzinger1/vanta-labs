# CHECKOUT AUDIT — 2026-08-26

**Scope:** the full checkout path, per `docs/CHECKOUT-VERIFICATION-PROMPT.md`.

**Trigger:** one shopper made three checkout attempts in sixteen minutes
(`VL-B10D3E7A`, `VL-DA402437`, `VL-AD39DBEF`, ~$100 each) and completed none.
Zero server errors, zero alerts, zero payment events.

**Environment:** local Postgres 16 + `pgrst-shim.mjs`, synthetic seed, mock
payment gateway. Nothing in this audit touched production except read-only SQL.
No test order, payment attempt or account was created against the live store.

**Evidence grades** (BLOCK-GH's vocabulary)
- `BROWSER-PROVEN` — driven through the real UI *and* the resulting database rows checked
- `DB-PROVEN` — driven through the real server routes, database checked
- `NOT VERIFIED` — not exercised, with the reason stated

---

## HEADLINE: the defect that caused the incident

**D-01 — the payment page never told a shopper their card was declined.**
Confirmed. Fixed in `93b460c`.

`VeyraCheckout.tsx` polled `/api/checkout/order-status/[orderId]` every 2.5s and
read exactly one field:

```js
const data = (await response.json()) as { paid?: boolean };
if (data?.paid) goToConfirmation();
```

`order-status` already reported terminal failure. It computes
`pending: !isPaid && !failed`, added with a comment reading *"A terminal failure
is not 'keep waiting' — the payment page needs to stop polling and let the
shopper act."* The server half of the contract was built. The client half was
never wired.

So a declined card was indistinguishable from "not finished yet". The page span
forever on the card form. `onError` fires only for a failed iframe **load**,
never for a decline.

Proven end to end on the harness:

| Step | Result |
|---|---|
| Order created, hold taken | `pending_payment`, 1 reservation `active` |
| `mock-pay decline` → real webhook pipeline | `payment.failed` processed |
| Order row after | `payment_status = payment_failed`, reservation `released` |
| `order-status` after | `{"paid": false, "pending": false, "status": "payment_failed"}` |
| What the old poll did with that | **nothing — kept polling** |

This matches the incident exactly: ~82s, ~150s and ~35s on the page, then a
fresh attempt each time. The server knew on every one of those attempts. The
page never asked.

**Fix:** the decision moved to `decideFromOrderStatus` (`src/lib/checkout-poll-decision.ts`)
with 10 unit cases, and the page now shows a decline message and stops polling.
Deliberately conservative — only an explicit `pending === false` is terminal, so
a dropped request on mobile data still just polls again rather than telling
someone their good card was refused.

**D-02 — a failed card-form load reached no dashboard.** Confirmed. Fixed in
`93b460c`. `VeyraCheckout.tsx:186` reported it via `console.error`, but
`instrumentation-client.ts` registers only `breadcrumbsIntegration` and
`globalHandlersIntegration` — no console capture — so a *caught* error logged to
the console went nowhere. Now reported with an explicit `Sentry.captureException`
at the catch site, rather than by enabling `CaptureConsole` globally (which would
ship every `console.error` on the site, including ones carrying shopper input, to
a third party).

---

## Why this was never caught: the harness could not run a checkout

Four defects, each of which alone blocks a browser-driven checkout. Together they
explain BLOCK-GH's "checkout had never been exercised in any environment".

**H-01 — `.env.local` is never read by the harness.** `harness:build` and
`harness:start` both set `NODE_ENV=test`, and Next does not load `.env.local` in
test (`node_modules/next/dist/docs/01-app/02-guides/environment-variables.md:250`:
*".env.local won't be loaded, as you expect tests to produce the same results for
everyone"*). The runbook instructs you to put every harness variable in exactly
the one file the harness cannot read. Symptom: `Missing NEXT_PUBLIC_SUPABASE_URL`,
every product page 500. **Workaround used:** `.env.test.local`. **Not yet fixed
in the runbook.**

**H-02 — the setup script never applied `admin-control-current-view.sql`.**
Without the view, `getControlSnapshot` fails, `getInventorySettings` fails open to
"not tracking", and `/api/catalog/products` 400s. Fixed in `93b460c`.

**H-03 — the setup script never seeded.** Runbook section 3 describes the
required shapes; nothing applied them. A fresh harness came up with an empty
catalogue. Fixed in `93b460c` (applies `harness-seed.sql`).

**H-04 — the mock-payment lockout is constant-folded, so `harness-server.mjs`
cannot work.** This is the important one. The control is:

```js
if (process.env.NODE_ENV === "production") throw new Error("PAYMENT_PROVIDER=mock/test is forbidden…")
```

In the built bundle it becomes:

```js
if ("mock" === t || "test" === t) throw Error("PAYMENT_PROVIDER=mock/test is forbidden in production…")
```

The guard is **eliminated at build time** — the throw is unconditional on any
production build. `harness-server.mjs` exists specifically to defeat this by
setting `process.env.NODE_ENV = "test"` at runtime, and it cannot: the check no
longer exists in the compiled output to re-evaluate.

**Production is correct and must not change** — mock payments are meant to be
impossible there. What is broken is the ability to test payments on a production
build. The consequence is a vice:

- **Production build** → age gate works, mock payments impossible (H-04)
- **Dev mode** → mock payments work, age gate cannot be passed even with all four
  boxes genuinely checked (the exact false bug `BROWSER-TESTING-RUNBOOK.md`
  warns about: *"it made a working age gate look like an un-passable P0"*)

Neither mode can drive a checkout end to end in a browser. **This is the single
highest-value thing to fix**, and it is unresolved.

---

## Results

### Validation and order creation — `DB-PROVEN`, driven through the real routes

| ID | Case | Verdict |
|---|---|---|
| 3.6 | Valid payload creates an order | PASS |
| 3.7 | One `order_items` row, correct qty and price | PASS |
| 3.8 | `inventory_reservations` row `active` | PASS |
| 3.12 | `payment_id` written back to the order | PASS |
| 3.10 / 8.4 | Same `idempotencyKey` twice → one order | PASS |
| 2.3a | Missing email refused | PASS — "Invalid email address" |
| 2.3b | Malformed email refused | PASS |
| 2.2 | Invalid state refused | PASS — names the field |
| 8.21 | Empty cart refused | PASS |
| 1.22 | Negative quantity refused | PASS |
| 8.18 | Quantity beyond stock refused | PASS |
| 8.16 | Tampered `expectedTotal` refused | PASS — specific message, not the generic one |
| 8.22 | Unknown product id refused | PASS |
| ACK | Unticked acknowledgement refused **server-side** | PASS |

No failed attempt left an orphan order row.

### Payment outcomes — `DB-PROVEN` through the genuine webhook pipeline

| ID | Case | Verdict |
|---|---|---|
| 5.1 | Approve | PASS — `paid`, `paid_at`, `paid_side_effects_at`, reservation `finalized`, `fulfillment_status=awaiting_fulfillment` |
| 6.1 | Stock decrement | PASS — dose 25 → 24, exactly once |
| 5.2 | Decline | PASS server-side — `payment_failed`, reservation `released`, 1 `payment_events` row |
| 5.14 / 6.2 | Duplicate payment on a paid order | PASS — refused, still 1 event, stock unchanged at 24 |

### Catalogue and gate — `BROWSER-PROVEN`

| ID | Case | Verdict |
|---|---|---|
| 1.1 | Age gate blocks the catalogue | PASS |
| 1.2 | Both buttons disabled until all four boxes ticked | PASS |
| 1.5 | Catalogue prices match `products` rows | PASS |
| 1.6 | In-stock product purchasable | PASS |
| 1.7 | All-doses-zero product reads Out of Stock, avail 0 | PASS (with tracking on) |
| 9.8 | Console errors | Only synthetic-seed image 404s and a guest `401` on `/api/account/me` — both expected |

**Production check, read-only:** `admin_control_current` has
`inventory.tracking_enabled = true` (set 2026-08-25). Stock genuinely gates sales
on the live store. The harness defaulted to off and was aligned to match.

---

## NOT VERIFIED, and what would close each

| Area | Why | To close |
|---|---|---|
| The decline message as rendered | `VeyraCheckout` only mounts with a live processor session; in mock mode the page short-circuits to "Payment session missing". The decision function has 10 unit cases and typechecks, but the rendered message was not seen in a browser | Fix H-04, or mount the component against a stubbed session |
| Apple Pay wallet sheet | Requires Safari on a provisioned Apple device. Chromium cannot produce one at any price | A human taps it on a real iPhone |
| The live Veyra iframe | Cross-origin, third-party; submitting a real card moves real money | Nothing safe closes this locally |
| Sections 7 and 9 (pricing modifiers, cross-cutting) | Not reached — the audit stopped at the H-01→H-04 chain and the D-01 fix | Fix H-04, then run them |
| Cases 8.5-8.9 (races, oversell, last-unit contention) | Need two concurrent browser sessions, blocked by the same vice | Fix H-04 |
| Anything behind a login | Shim has no RLS and no GoTrue | Out of scope for this harness by design |
| 8.26 rate limiting | Harness logs `[rate-limit] FAILING OPEN — throttle not applied` (`rate-limits.sql` unapplied locally). **Not checked against production** | Apply the migration locally; verify the live table separately |

---

## Still open

**Gap 1 — declines are invisible to the store.** `payment_events` has never
recorded a `payment.failed` from the live processor. The handler understands the
type (`payment-webhook.ts:84-86`); nothing sends it. D-01 fixes what the *shopper*
sees; it does not give *you* a record. **This needs a question to Veyra**, not a
code change.

**Gap 2 — abandoned orders never terminate.** Task 1 of
`docs/superpowers/plans/2026-08-26-retire-abandoned-pending-orders.md`. Unshipped.

**Gap 4 — no alert on repeated failures by one shopper.** Three attempts in
sixteen minutes by one email produced nothing. Unshipped.

**H-01 and H-04** — the harness defects above. H-04 is the blocker for everything
in the NOT VERIFIED table.
