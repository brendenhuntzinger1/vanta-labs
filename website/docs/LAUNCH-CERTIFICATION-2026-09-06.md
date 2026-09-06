# Final launch certification — 2026-09-06

Branch `claude/vanta-labs-launch-cert-ow93y9`, cut from `00658a1`, which was
both `origin/main` and the deployment Vercel was serving in production when this
audit began (`dpl_2tXJ6fzH4ypBxTng6GYFrZt4cxWf`, READY, target production).

This file is the reconciliation. Every finding raised during the audit appears
below with a disposition; the counts at the bottom are the arithmetic of that
list, not a summary of it.

---

## 1. What was wrong, and what was done about it

### P1 — `/api/ads/funnel-event` still answered with its timing

**Confirmed. Fixed.**

A previous audit closed the response-BODY oracle on this endpoint: a real slug
used to return `{sent:true,…,totalOverridden}` and an unknown one
`{sent:false,reason:"no line matched a catalogue product"}`, so the catalogue —
which lives behind the login wall — was enumerable, and its prices recoverable,
by an anonymous caller. Every path now returns the same opaque `{received:true}`.

That closed half of it. The handler still did this:

```ts
await sendServerEvents([...]);          // only reached when a line MATCHED
return NextResponse.json(ACK, …);
```

`sendServerEvents` posts to TikTok's Events API. It only runs when
`decideRelay` matched at least one slug against the catalogue, so a real slug
answered a network round trip later than an unknown one. The bodies were
identical and the clock was not: the same enumeration, with a stopwatch.

Both gates that make the call real are open in production —
`credentialStatus().configured` (the token is set) and
`serverAdsReportingAllowed()` (deny-by-default outside a production
deployment) — so production is exactly where it was reachable. The harness
denies at the second gate and therefore **cannot reproduce it**; this one is
reasoned from the code and closed regardless, which is the honest description of
the evidence.

**Fix.** Everything that touches the catalogue — the `products` lookup,
`decideRelay`, and the delivery — now runs inside `after()` from `next/server`.
The reply is sent first; response time depends on the rate limiter and the
request body alone, neither of which knows what is in the catalogue. `after()`
rather than a floating promise because Vercel keeps the function alive for it.
It is also simply faster for the product page that fired the relay, which used
to wait on TikTok for nothing.

**Regression coverage.** `funnel-event-no-oracle.test.ts` gained four tests
bounded at BOTH ends: the catalogue work must appear after `after(` opens and
before its matching close, found by counting parentheses rather than guessing at
`});`. Mutation-checked — hoisting the catalogue read back onto the response path
fails three of them with `".from(\"products\")" escaped the after() callback`,
and restoring the fix passes all seven.

### P2 — two customer-facing typos in the live day-30 retention email

**Confirmed. Fixed in production (`email_automations`); no code change.**

| | Was | Now |
|---|---|---|
| subject | `Ready to restock? 10% 0ff + FREE Shipping…` | `…10% off…` |
| body, first word | `t’s been about a month since your last order` | `It’s been about a month…` |

A digit standing in for a letter inside a discount claim is the classic shape of
spam-filter evasion and is scored as such by inbox providers; this is the
most-sent retention subject line in the ladder. The body's first word was
missing its first letter. Neither is a tone change — the copy is otherwise
untouched, and the offers themselves were verified correct (see §2).

### P3 — five QA harnesses had stopped testing the store that exists

**Confirmed. Fixed.** The store closed its default earlier in this audit series
(`lib/access-policy.ts`); these suites were still driving the open storefront
that preceded it. Each one reported green, or reported a failure whose stated
cause was wrong, over something it was no longer measuring.

| Suite | What it was really doing | Before → after |
|---|---|---|
| `qa:purchase` | Could not reach checkout at all: `/products` answers 307, so there was no product link to click and `create-session` answered 401. **Ten of eighteen steps reported SKIP** — including the receipt test, "exactly one confirmation", and webhook-retry idempotency — and the run still printed a tidy summary. Now signs in through the real portal first. | 3 passed / 5 failed / 10 skipped → **18 passed, 0 skipped** |
| `qa:journey` | `signIn()` treated "no email field on screen" as "already signed in". The portal shows no email field to ANYONE until "Sign in with email" is pressed, so that became every signed-out caller: nothing filled, nothing submitted, eleven steps failing on a missing cookie. Section 1 tested an age gate that no longer exists. | 20 passed / 15 failed / 1 skipped → **70 passed, 0 skipped** |
| `qa:abuse` | The signup flood posted a body the route rejects with 400 before the limiter is consulted, so ten 400s "proved" no throttling. The CSRF probes ran unauthenticated, so the wall answered 401 and the Origin check was never reached. | 15 passed / 4 failed → **19 passed, 0 skipped** |
| `qa:crossaccount` | `/api/cart/restore` is no longer reachable signed out, which made "discloses the basket but not who it belongs to" vacuous — a 401 body contains neither the victim's name nor the basket — and turned the wall's 401 into a reported defect. | 15 probes / 1 finding → **16 probes, 0 findings** |
| `qa:roles` | `/account/auth/callback` was missing from the unauthenticated entry points, so every run carried one permanently-false finding. The next real one would have arrived as "2 findings" and read as the same noise. | 1099 probes / 1 finding → **1099 probes, 0 findings** |

`cross-engine-check.mjs` cleared an age gate that no longer exists and then
measured the login portal five times while calling it the storefront. Signing in
is opt-in through `QA_SIGNIN_EMAIL` so the script stays production-safe; without
it the run now says the routes are walled rather than passing silently.

`qa:discounts` looked for a button reading exactly "Sign in"; the portal's door
is "Sign in with email", so the form never opened and `page.fill` timed out
thirty seconds later complaining about a selector.

### P4 — a leak test that could not tell "closed" from "broken"

**Confirmed. Fixed.**

`wholesale-anon-image-leak.test.ts` asserted only that nothing is emitted.
`selectStackImages = () => []` would have kept every assertion green while the
signed-in composition — the thing the owner asked to keep — was silently gone.
One of its two tests was vacuous besides: it looped over a result that is always
empty in that case, so the assertion inside never ran.

Four tests now pin what a signed-in render gets (real photography returned,
cover image preferred, limit honoured, duplicates collapsed, placeholders
dropped from a mixed catalogue), and the empty case is asserted on the result.
Mutation-checked: a dead `selectStackImages` fails four of them.

### P5 — no interacted cross-engine coverage of the customer journey

**Confirmed. Fixed** (new `scripts/qa-cross-engine-journey.mjs`).

`login-portal-cross-engine.mjs` measures the portal's geometry and never signs
in; `cross-engine-check.mjs` looks for overflow. Neither INTERACTS, and neither
had a session, so nothing behind the wall had been driven in WebKit or Firefox
at all. Every iOS in-app browser — TikTok, Instagram, Facebook, Snapchat — is
WKWebView, and that is where paid traffic lands.

The new script signs in through the portal and walks catalogue → product page →
add to cart → cart → checkout in all three engines at desktop, 390 and 375,
comparing what the cart and the checkout say about the money.

---

## 2. Verified, unchanged

Everything here was checked against the running system rather than read.

**The anonymous wall.** 166 probes across GET/HEAD/OPTIONS, RSC (`RSC: 1`,
`Next-Router-Prefetch`, `?_rsc=`), trailing slashes, encoded and normalised
paths. Every non-refusal is an intentionally public route. A real slug
(`/products/bpc-157`) and an invented one produce byte-identical answers, so the
wall cannot be used to enumerate the catalogue.

**Crawler parity.** Googlebot, Bingbot, `facebookexternalhit`, Bytespider,
Slackbot, curl, a scanner UA and an ordinary browser receive identical status,
identical `Location` and identical bodies — including the TikTok in-app browser,
whose separate in-app routing runs strictly BEHIND the wall. The only difference
found anywhere was Next.js's own bot-mode rendering envelope (no out-of-order
Suspense placeholders in the flight payload); the content is byte-identical
after normalising those markers.

**Ad attribution across the wall.** `/products/x?utm_source=TikTok&…&ttclid=…`
redirects to `/account/login?next=<the whole original URL, encoded>` **and**
lifts `utm_source=tiktok`, `utm_campaign=hook_a`, `ttclid=XYZ` to the top level —
lowercased for the tags, verbatim for the click id. A referral link
`/r/QAAMB?utm_source=…` sets `vl_referral_code` for 30 days and redirects with
the tags intact.

**Sitemap and robots.** `sitemap.xml` derives from `isPublicPath()` and lists
exactly ten public URLs — no products, no catalogue, no protected route.
Production `robots.ts` allows `/` and disallows the gated prefixes under a
single `*` group; the blanket `Disallow: /` seen locally is the
non-production branch.

**Cache posture.** `/products`, a PDP, `/cart`, `/account`, `/account/orders`,
`/coa-library`, `/api/catalog/products` and `/api/account/me` all answer
`Cache-Control: private, no-store` to an authenticated request.

**CSRF.** Verified directly against the running server: a POST to
`/api/account/preferences` carrying a valid session and
`Origin: https://evil.example` answers **403 "Invalid request origin"**, while
the same request same-origin reaches the handler. All five cookie-authenticated
prefixes answer 403. The wall's 401 arrives first for an unauthenticated caller,
which is the correct order and is why the old probes proved nothing.

**Admin.** All 27 admin pages render 200 with substantive content under an admin
session. `qa:roles` ran 1099 probes across eight roles with a positive control
(the admin session reached 78 admin routes) and found nothing.

**The money path.** `quoteOrder` is the single authority: `finalTotal` becomes
both the order's `amountPaid` and the processor's `amount` (in minor units).
The client's `expectedTotal` is a tripwire ("Altered total detected"), never the
amount. A complete purchase was driven end to end — order row, signed webhook,
paid, exactly one confirmation, a retried webhook producing no second email, an
internally consistent total, and a failed payment producing no confirmation.

**Cart ↔ checkout.** Subtotal and shipping agree exactly on both screens in all
three engines at all three viewports. The total differs on the harness by the
3% card service fee, which the cart discloses in words ("Estimated total", "A 3%
Service Fee applies to card payments.") — the disclosure design in
`lib/cart-total-disclosure.ts`. Production has that fee **disabled at 0%**, so
the two totals are equal there.

**Free shipping sitewide.** Production `shipping.free_shipping_sitewide` is
**on**. The suite proves $0 merchandise shipping in every zone regardless of
subtotal, shipping protection still charged, and — the part that matters for a
transient failure — a config read that fails keeps the last proven value rather
than inverting the policy, and follows it back down when the read recovers.

**The retention ladder**, read from production rather than from code:

| Automation | delay_days | offer_key | Reward | Copy says |
|---|---|---|---|---|
| `welcome_no_purchase` | 3 | `winback_60_percent_15` | 15% | "15% off" ✓ |
| `replenishment` | 30 | `winback_60_free_shipping_10` | free shipping + 10% | "10% OFF + FREE shipping" ✓ |
| `winback_30` | 40 | `winback_60_bac_water_15` | free BAC Water + 15% | "15% off — plus a free BAC Water" ✓ |
| `winback_60` | 50 | `winback_60_free_ghkcu` | free GHK-Cu | "a GHK-Cu at no charge" ✓ |

Both gift products resolve and are shippable: `bac-water` (the canonical slug
after the rename; the two legacy spellings correctly do not exist) has 93 units
on its 10 mL dose, and `ghk-cu` has 45 on its 50 mg dose. Both carry parent
`inventory_quantity = 0` — the dose-stocked shape that is most of this catalogue
— and `quoteOrder` resolves a gift to the default dose and refuses to add one it
cannot ship.

**Concurrency.** Store credit and points: exactly one of two simultaneous claims
wins, ten racing checkouts never overspend, and the claim is idempotent per
order — proven against real Postgres from genuinely parallel clients.
Inventory: N units against 500 simultaneous buyers yields exactly N winners,
stock ends at zero and never goes negative.

**Ads measurement.** 35 DB-executed tests over the ROAS views: one row per
(platform, day, creative) — the fan-out guard — at three grains, refunds netted,
an over-refund left negative rather than clamped, every spelling of a platform
collapsed onto one key before the join, ROAS unknown rather than divide-by-zero
on a zero-spend day, and known arithmetic ($400 against $100 is 4×).

**Repository hygiene.** No TODO/FIXME/HACK in application code (the four `XXX`
hits are the `VL-XXXXXXXX` order-number placeholder in doc comments), no
`debugger`, and the two `console.log` calls are deliberate operational logging.

---

## 3. Accepted residuals

**The product-images bucket is public.** Someone who already holds an exact
storage URL can fetch that image. This is the owner's architecture decision and
was not redesigned here. What is enforced is that the application never HANDS
OUT those URLs before authentication: `/wholesale` — the one public page that
composed real photography — now reads the catalogue only for a signed-in
requester, and `force-dynamic` keeps the signed-out render uncacheable. Measured:
zero product-image URLs in the anonymous HTML, RSC payload and metadata.

**`/api/cart/restore` treats its id as a capability.** A signed-in customer
holding another customer's `abandoned_carts.id` can read that basket's items.
The id is a `gen_random_uuid()` and is not enumerable, the response names
nobody, and the wall now stands in front of it as well. This is the existing
design of the recovery link, unchanged.

**The cart's total is an estimate while a card fee is configured.** Disclosed in
words on the cart. Production has the fee at 0%, so there is nothing to disclose
there today.

---

## 4. External actions the owner still holds

**Supabase leaked-password protection is disabled** (`auth_leaked_password_protection`,
WARN). It is an Auth setting in the Supabase dashboard and is not reachable
through any tool available to this session. It affects password strength only;
it blocks nothing in checkout or the store. Owner action: Supabase → Authentication
→ Policies → enable "Leaked password protection".

**`RESEND_WEBHOOK_SIGNING_SECRET` cannot be verified from outside.**
`/api/webhooks/email` checks the URL secret FIRST and answers 401 to anyone
without it, so an external probe cannot distinguish "signing secret set" from
"not set" — which is correct behaviour and also means this cannot be certified
remotely. What IS externally verifiable is whether the endpoint is configured at
all: 503 means `EMAIL_WEBHOOK_SECRET` is unset, 401 means it is set and
rejecting. Owner action: confirm the signing secret in Vercel → Production.

Every `rls_enabled_no_policy` advisory is INFO and is the intended posture: RLS on with no policies is deny-all for `anon` and `authenticated`, and
the app reaches those tables through the service role only.

---

## 5. Reconciliation

| | Count |
|---|---|
| Findings raised | 9 |
| Duplicates | 0 |
| Rejected as non-defects | 4 |
| Confirmed defects | 5 |
| Fixed | 5 |
| Externally blocked | 2 (neither a defect; see §4) |
| Accepted residuals | 3 |
| **Unresolved launch blockers** | **0** |

The four rejected were: the `/wholesale` byte-length difference across
user-agents (Next.js bot-mode streaming, identical content); `payment_processor.enabled = false`
(a dormant placeholder module with no consumer outside the admin settings page —
the live card lane is `payment_methods.card` plus the Veyra provider); the
`bpc-157-10mg` and `starter-kit` slug literals (a test fixture and a doc comment
respectively, not production constants — every slug that production code does
resolve was checked against the live catalogue); and the harness's inability to
sign in an unconfirmed account (`gotrue-shim.mjs` does not implement email
confirmation and says so; the app-side control, that an unconfirmed address
cannot claim another buyer's orders, is proven).

`5 confirmed − 5 fixed − 0 accepted-as-non-defect = 0 unresolved.`
