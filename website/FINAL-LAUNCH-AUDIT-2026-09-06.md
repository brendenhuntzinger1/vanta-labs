# NOT READY FOR MAIN LAUNCH — one owner action away

**As `main` stands today (`f81bf5f`).** Every defect in this report is live on
`main` right now, and four of them lose money or lock a customer out on an
ordinary evening.

**The remediation is done, verified, and pushed.** Branch
`claude/vanta-labs-launch-audit-px3297` is 31 commits ahead of `main`, contains
all of it, and is green everywhere I can measure.

**What changed in the second pass (§18).** The first pass closed with "three
owner actions". Two of the three are now gone — one because you resolved it and
I verified the result live, one because it was never yours to do. The residue
is **one** action that genuinely cannot be performed with the tools available
here, plus one setting that is gated behind a paid plan and is a business
decision rather than a defect. Three further defects were found and fixed during
that pass, including one in the busiest endpoint in production.

Audit run 2026-09-06 against `main` at `f81bf5f`, the eleven PRs merged into it
this week (#153–#163), and the production database and site.

---

## 1. What was audited, and how

Sixteen areas, each read line by line and then **proved by execution** — a real
Postgres, the local harness with a production build, a real browser at desktop
and 390×844, the live production database, and read-only HTTP against the live
site. 45 independent agent reports fed it; 29 of their findings went through an
adversarial verification pass whose job was to *refute* them, and 17 were
refuted as stale or wrong and dropped.

Nothing in this report rests on reading code alone. Where a claim could be
executed, it was, and the measurement is quoted.

| Evidence | Result |
|---|---|
| Unit + integration suite (with Postgres) | **603 files, 9153 passed, 6 skipped** |
| Same suite with no database (CI's old state) | 8925 passed, **234 skipped** |
| `tsc --noEmit` | clean |
| `eslint` | **0 errors**, 59 pre-existing warnings |
| `next build` (production) | **exit 0**, compiled in 20.3s |
| Browser: desktop + 390×844 | **99/99 checks**, 0 console errors, 0 page errors |
| Production Supabase advisors | 0 ERROR, 1 WARN (§18), rest INFO |

---

## 2. Where `main` came from, and whether anything was lost

`main` is `f81bf5f`, 171 commits. The recent history is eleven merged PRs:

    #163  ROAS fan-out, Windsor field map, ads dashboard      f81bf5f
    #162  Email measurement: one table, every channel         ad23b76
    #161  Ad spend against revenue, four platforms            b24e69b
    #160  Free shipping sitewide: one switch, one formula     f5de66f
    #159  "Stay signed in" on the door people use             2fb2a45
    #158  One access system, and a wall that checks           48915b9
    #157  Remove the $100 minimum qualifying order            1811c45
    #156  Run the tests before anything reaches main          4160849
    #155  Profit floor tells the owner, never refuses         bc5a460
    #154  Age gate off the pages auth emails link to          2e851f9
    #153  Every discount competes; attribution survives       1dcc398

**Nothing was lost, reverted, duplicated or left on a branch.** Two merge
commits (`2135f88`, `2ebe12a`) reconcile parallel work and both keep the later
change; I diffed the cumulative range rather than the tips. The audit branch
contains all of `main` (`git merge-base --is-ancestor origin/main HEAD` passes),
so nothing here is built on a stale base.

**Working tree:** clean. One debug artefact was found *and removed* — a scratch
probe (`__verify_tmp.test.ts`) that rode into a commit on `git add -A`; the
ignore file now carries name patterns so it cannot repeat. No `.env` file is
tracked except `.env.example`. No generated file, no harness output, nothing
untracked.

**Migrations:** five applied to production this session, each recorded in
`src/lib/sql/migrations-applied/` (§16). The local harness now applies the
security SQL it never applied before (§10) and asserts the result.

---

## 3. Access gate and authentication — what an anonymous crawler can see

Measured against **production**, read-only, with no cookie:

    /                      307 -> /account/login?next=%2F
    /products              307 -> /account/login?next=%2Fproducts
    /membership /research  307
    /cart /checkout        307
    /account               307
    /admin                 307 -> /vault
    /vault /wholesale /contact /ambassador /partner   200   (public by design)
    /api/catalog/promotions  401
    /api/account/me          401

The wall holds. It holds for GET, HEAD, OPTIONS, RSC (`?_rsc=`) and every path
normalisation variant.

**Four holes were found and closed:**

- **The login page promoted a stale localStorage session.** A visitor arriving
  with `#refresh_token=…` — or simply on a shared browser where supabase-js had
  kept one — was signed in as whoever last used it. The form now reads the
  OAuth callback fragment explicitly and verifies the token with
  `supabase.auth.getUser()`.
- **`/api/ads/*` 401'd for admins.** The wall only knew the customer cookie, so
  every server panel on the ads dashboard was dead for the owner.
- **`/_next/image` was an open proxy** for any `*.cloudfront.net` or
  `*.supabase.co` host on the internet. Narrowed to the host derived from
  `NEXT_PUBLIC_SUPABASE_URL`.
- **Admin, partner and vault responses carried no `Cache-Control`.** They now
  answer `private, no-store`.

**One CSRF gap:** `/api/ads` authenticates the same admin cookie `/api/admin`
does and sat outside `CSRF_PROTECTED_PREFIXES` — a list whose own heading calls
it exhaustive. Added, and the coverage test now *derives* the roots from the
routes rather than from a second hand-kept list.

## 4. Google sign-in and session establishment

- **The OAuth callback left the layout signed-out.** `router.replace()` without
  `router.refresh()` meant the root layout stayed in its anonymous render after
  a Google return — so the promotion bar, the member state and the cart config
  were all wrong until a hard reload. Fixed.
- **The confirmation link discarded the destination it had just validated.**
  `/api/auth/signup` reads `nextPath`, validates it, threads it through — and
  the branded link every customer receives hardcoded `/account`. A shopper sent
  to sign up from a product page landed on their account instead. Fixed on both
  the signup and resend paths.
- **Sign-out uses GoTrue's default GLOBAL scope**, so logging out on a phone
  logs the customer out on their laptop. Confirmed, **not changed**: global is
  the *safer* option and which one this store wants is your call (§19).

## 5. Existing customers, affiliates and members through the new gate

**The critical one.** `CartProvider` lives in the root layout and fetched
everything it prices with in mount effects with empty dependency arrays. That
was correct while the store served anonymous visitors. Closing the default made
it wrong: the provider mounts on the sign-in portal, every one of those five
endpoints answers 401 there, and signing in is a client-side navigation that
never remounts a provider above the changing segment. **So the cart priced the
whole session on its built-in defaults.**

Measured in a real browser, same customer, same basket, with Free Shipping
Sitewide ON:

    signed in through the form:   Estimated shipping $15.00
                                  "Free shipping at $200 — $131.00 away"
                                  Estimated total    $88.14
    the same page, hard reloaded: Estimated shipping  $0.00
                                  Ambassador EXPLICIT15  −$10.35
                                  Estimated total    $62.79

$25.35 apart on a $69 basket, on the default path for every visitor. And the
direction that hurts is sales tax: the stale client holds
`nexusStates: []`, so on any store with a configured nexus the server's total
is *higher* than the shopper's and `expectedTotal` refuses the order outright.

Fixed by giving the five effects a `signedIn` dependency the layout already
resolves — no remount, so the basket survives. **Verified in the browser:**
after an in-page sign-in the cart now reads "Free shipping on every order",
shipping $0.00, and checkout agrees.

Two more in the same family:

- **Referred signups were attributed to nobody.** The link an ambassador
  actually shares is `/r/<code>`, which sets a cookie and never puts `?ref` on a
  URL — and the wall buries any hand-made one inside `next=`. So
  `referredByCode` was always empty: no 100-point welcome bonus for the
  customer, no referral bonus for the ambassador, and nothing backfills either.
  The form now reads the cookie the ambassador's own link sets.
- **The ambassador's code showed attached but worth nothing**, next to a CLEAR
  button that expires the 30-day cookie — the exact loss PR #153 calls "the
  single most expensive line this change removes", through a different door. The
  validation now re-runs when the session arrives. **Verified in the browser:**
  the cart shows "Explicit Fifteen · 15% customer discount".

## 6. Checkout and the money path

- **A retry after a cancelled attempt dead-ended forever.** The derived
  idempotency key came from the *first* dead order, making it a constant — so
  once a second attempt died, every click answered "Unable to create order
  record". Two dead attempts is an ordinary evening. The derivation now walks
  the chain.
- **An unresolvable dose id was silently re-priced to the default dose** and
  took no inventory hold. It is refused with a sentence the shopper can act on.
- **A one-cent divergence** between the previewed and charged total whenever a
  percentage discount met quantity-bundle savings: 76 of 200,000 randomised
  baskets, always a cent, always the server giving more. Both sides now round at
  the same moment.
- **Free shipping**, ON and OFF, verified end to end: $0 sitewide with shipping
  protection charged independently at 6%; totals identical across cart,
  checkout, the server quote and the receipt. A client cannot set a price, and
  an `expectedTotal` mismatch is refused.
- **A control-read blip told the shopper they had tampered with their own
  total.** `getShippingConfig` fell back to the *coded default*, whose
  `freeShippingSitewide` is false — the opposite of the live value — so a
  transient blip at pay time re-priced with shipping charged and answered
  "Altered total detected". The fallback is last-known-good now.

## 7. Promotions, gifts and profit alerts

- **"Coupon applied" over a total the coupon had not moved.** PR #153 split the
  two stacking licences everywhere the price is decided and left the OR behind
  in the sentence describing it.
- **The Apple Pay below-floor alert measured the address-less quote**, which
  zeroes both shipping legs — so with free shipping sitewide ON every wallet
  order was assessed as if delivery were free to the store and a genuinely
  loss-making one raised no notice at all.
- **A limited promotion stopped being limited on any transient error.** Failing
  open is documented and deliberate and stays; the ~0.1% of Supabase calls this
  store loses to a "JWT issued at future" 401 are now retried (that class is
  refused at the edge, so it provably never ran), and a genuine fail-open raises
  `promotion_claim_unenforced` instead of only a console line.
- **Concurrency proved**, not assumed: last unit, 10-for-3, one-use promotion —
  all correct under genuinely parallel connections.

## 8. Email marketing, Resend and delivery tracking

Seven defects, all fixed:

- **One order counted as full revenue by BOTH dashboards.** `marketing-source.ts`
  exists to prevent exactly this and the email dashboard honours it; the ROAS
  views never mentioned it. An ad click that did not convert followed weeks
  later by a campaign-email click that did was $150 on the Email tab *and* $150
  against TikTok spend on the Ads tab. With a 30-day window that is the ordinary
  repeat purchase.
- **A redelivered complaint raised a fresh alert every time** — three unresolved
  criticals and three Sentry events for one customer, on a day when the alert
  list is what you need readable.
- **`email.failed` was recorded as "ignored" and rendered as silence.** A
  permanently rejected signup confirmation read "No word yet", identical to one
  still in flight.
- **The account-toggle mirror scanned page one of the directory**, so past
  customer 1,000 someone who pressed "report spam" still saw the marketing box
  ticked — the exact state that code's own comment says it prevents.
- **"0 of N opened" for five channels that carry no pixel** — the panel built to
  end the "nobody opens our email" belief reproducing it.
- **The broadcast's refusal threw into its own catch**, so a page error on the
  subscriber read silently dropped every guest and at-checkout opt-in and
  reported a clean run.
- **The send ledger's joins were unpaged**, so they could only be wrong in
  production.

**And the webhook secret authenticated the URL, not the payload** (§18).

## 9. Ad tracking — Meta, TikTok, Reddit, Snapchat → Windsor → `/admin/ads`

The four field maps were checked against the **live Windsor API** and are
correct. Everything downstream of them was not:

- **An ad tagged with any uppercase letter read as ROAS 0.00** and its revenue
  vanished. The spend side lowercases; the order side did not. Both do now, and
  the views `lower()` on read for rows already stored. **Verified in the
  browser:** `?utm_source=TikTok&utm_content=Hook_A` stores `tiktok` / `hook_a`,
  with the click id kept verbatim.
- **An ad landing on an ambassador link lost its ad.** `/r/<code>` redirected to
  a path with no query, so the tags and the click id died at the route and the
  order read as organic.
- **Revenue landing on a day the creative did not spend disappeared** from every
  ROAS table — an ad returning 4x was listed as the store's worst performer.
- **Partially refunded orders contributed $0** instead of the money kept.
- **The dashboard truncated at PostgREST's 1000-row cap** and presented the
  prefix as a total.
- **The "Today" strip read a table that can never hold a row** — $0.00 forever,
  above a panel showing real money.
- **The six-hour fetch gate could not engage while the feed was broken**, which
  is the live state: 192 Windsor calls and **48 critical operator emails a day**.
- **All Snapchat spend was permanently untagged** — the documented mitigation
  existed only as a comment. Implemented, and only when the ad name is *already*
  a valid tag, so no join key is ever invented.
- **One duplicated ad/day pair aborted a whole connector's window**, silently.

## 10. Database and Supabase security

Verified directly against **production**:

    public tables with RLS off            0
    anon / authenticated table grants     0
    public views without security_invoker 0   (was 1)
    SECURITY DEFINER functions            only the 3 JWT helpers, all INVOKER
    storage buckets                       RLS on, zero policies

**`admin_control_current` was the one public view running with owner rights** —
so it read `admin_audit_logs` straight past the RLS protecting it, and its only
guard was a one-shot revoke that a `DROP VIEW` (which any column change
requires) would have removed while Supabase's platform default handed anon a
fresh grant. Behind it: commission percentages, shipping thresholds, every
control setting, readable with the key that ships in the browser. Fixed and
applied.

**Two lockdown migrations created the same policy name**, so whichever ran
second aborted its entire transaction — taking the anon revoke and the
default-privilege fix down with it, silently. Both are idempotent now, in either
order.

**The RLS sweep carried a hand-maintained list** and
`ambassador_wallet_ledger` was in no RLS statement anywhere in the repository.
Production was never exposed (Supabase's own `ensure_rls` event trigger covers
it — *not* the `rls_auto_enable` function this repo credits, which has no
`create event trigger` anywhere), but a rebuild from the checked-in SQL came up
with exactly one RLS-off table. The sweep enumerates now.

**The harness applied none of the security SQL** — 65 of 158 files, and all
fifteen security ones missing. So the target CLAUDE.md tells everyone to verify
against had one policy in the whole schema and no anon grants in either
direction: an engineer could verify the wall exactly as instructed and learn
nothing about the layer the gate commit calls the only one that cannot be
bypassed. It applies them now and asserts all three numbers.

## 11. API security

162 route handlers reviewed.

- **`/api/analytics/track` accepted `purchase`** — an unauthenticated route
  writing with the service-role key into the same table the payment webhook
  writes settled sales into. A stranger could post revenue.
- **Password reset could be self-locked-out.** A *denied* request still recorded
  a rate-limit hit, pushing the trailing window forward — so a customer tapping
  "Send reset link" five times could never drain the bucket, and with a
  mandatory account that locks them out of the whole store.
- Webhook HMAC verified timing-safe and replay-safe; exactly one confirmation
  per charge; cron bearer secret enforced.

## 12. Idempotency, concurrency and inventory

Five findings, every one reproduced against a real database and all five fixed:

- **Store credit and points could be spent twice.** The claim wrote the debit
  first and validated it with a *separate* read — two round trips under READ
  COMMITTED, so a later claim could finish its read before the earlier claim's
  insert committed and approve itself against a ledger without its rival in it.
  **Reproduced: $50 of credit, two concurrent claims, 250 rounds → 2 double
  spends.** Both cards charged the reduced amount; $100 of discount given away
  for $50 of liability. Now one locked function in the database, with a
  concurrency proof that fails five of its ten cases if the advisory lock is
  removed.
- **A refund delivered twice accumulated.** The live endpoint subscribes to both
  `refund.completed` and `*`, and both map to "refunded" with different event
  ids. A genuine $60 refund recorded $120, then $180 with the ambassador's whole
  commission reversed, then flipped to a full refund — restocking the entire
  order and returning every point and credit for a customer who kept the goods.
- **A degraded finalize stranded the inventory hold forever**, so units were
  decremented *and* permanently reserved; real stock became unsellable and
  compounded with every such order. The manual lane has released them since it
  was written; the card lane did not.
- **A shopper whose first two attempts died was locked out of checkout** (§6).
- **A limited promotion failed open on any transient error** (§7).

## 13. Customer-facing copy and UI

No marketing wording was changed. Three things that were factually wrong:

- **`/wholesale` published two catalogue product names to anonymous crawlers** —
  confirmed live in production HTML — through a hardcoded form placeholder the
  guard test could not see, because it read only `page.tsx` and only looked for
  `.name` bindings. It now follows the page's component imports and scans for
  the catalogue's literal names, read out of the seed.
- **Three surfaces described one order and none matched.** A $55 store-credit
  redemption read "Credits applied" in the email, "Adjustment" on the
  confirmation page, and *nothing at all* on the admin order page — whose five
  hand-written rows did not sum to the "Total charged" printed beneath them.
  All three derive from one function now.
- **The coupon form told the operator the opposite of the truth** — "worth
  nothing over $200 domestic" on a store where free shipping is sitewide.

## 14. SEO and the public surface

- **The sitemap advertised seven URLs that answer 307**, including the
  priority-1.0 home page — confirmed live in production. It derives from
  `isPublicPath()` now, so it cannot drift from the wall again.
- `robots.txt` updated to match.
- No source maps, no catalogue in `/_next` chunks, no product data reachable
  anonymously (§13).

## 15. Build and static analysis

Production build **exit 0**, 20.3s. `tsc` clean. `eslint` **0 errors** (two were
introduced by this audit's own work and fixed: a clock read during render and a
setState-in-effect). 59 warnings are pre-existing unused-parameter conventions.

**CI reported success while skipping 234 assertions.** The workflow ran vitest
with no database, so every DB-backed suite skipped — including the ones covering
the ROAS fan-out, gift redemption and promotion limits, five of which had landed
that same week. A `postgres:16` service is wired in, and a step now *fails* the
run if those suites skip.

## 16. Production configuration

**Applied to production this session**, each recorded in `migrations-applied/`:

    20260906T0700  ad_revenue: refunds retained, case-insensitive join keys
    20260906T0730  ROAS grains: FULL JOIN so no-spend-day revenue survives
    20260906T0830  claim_store_credit_hold / claim_points_hold  (atomic tender)
    20260906T0900  admin_control_current -> security_invoker; RLS + grant sweeps
    20260906T0930  ad_revenue honours the one-marketing-source rule

Verified after each: 0 tables without RLS, 0 anon grants, 0 views without
`security_invoker`, and `admin_control_current` still returning all 120 rows to
`service_role`.

**Deployment protection** is correct: SSO on everything except the custom
domain, so previews are private and the live site is public.
**Cron:** one entry, `/api/cron/sweep` every 30 minutes.
**Domains:** apex + `www` + three Vercel hosts.

**Control-store settings read from production:** `free_shipping_sitewide = true`;
Buy-2-Get-1 enabled; `referral.personal_discount_percent = 20`,
`default_commission_percent = 15`; `card_processing_fee` disabled at 0%;
`payment_processor.enabled = false` (cosmetic — the real gate is the
`CHECKOUT_ENABLED` env var); all `profit.*` blank, so coded defaults apply;
`tax.nexus_states` empty.

## 17. Regression matrix — the eleven merged PRs

| PR | What it changed | Regression found | Status |
|---|---|---|---|
| #153 | Discount competition, attribution | "Coupon applied" for a $0 coupon; one-cent preview divergence | fixed |
| #154 | Age gate off auth pages | none | verified |
| #155 | Profit floor alerts, not refusals | wallet alert measured the wrong quote | fixed |
| #156 | Tests before main | 234 assertions skipped in CI | fixed |
| #157 | $100 minimum removed | none | verified |
| #158 | The access wall | 4 holes + cart priced on defaults + referral attribution lost | fixed |
| #159 | Stay signed in | login page promoted a stored session | fixed |
| #160 | Free shipping sitewide | fallback inverted the live setting | fixed |
| #161 | Ad spend ingestion | uppercase tags unjoin; fetch gate can't engage; duplicate pair drops a window; Snapchat untagged | fixed |
| #162 | Email measurement | 7 defects, incl. double-counted revenue | fixed |
| #163 | ROAS + dashboard | 1000-row truncation; Today strip; no-spend-day revenue; refunds dropped | fixed |

## 18. Second pass — every remaining item, pushed as far as it goes

Each item below is exactly one of three things. Nothing is listed as "yours"
that I could reach with the tools in this session.

| # | Item | Class | Where it ended |
|---|---|---|---|
| 1 | `RESEND_WEBHOOK_SIGNING_SECRET` | **only you** | Code proved end to end against the real signing secret. One paste remains. |
| 2 | Windsor plan limit | **verified, resolved** | You detached Snapchat; the limit is gone. Verified live. Revealed a defect, now fixed. |
| 3 | `EMAIL_WEBHOOK_SECRET` in production | **verified** | Set. Proved by a safe existence probe. |
| 4 | `PAYMENT_WEBHOOK_SECRET` in production | **verified** | Set. Proved by a safe existence probe. |
| 5 | `CRON_SECRET` in production | **verified** | Set and correct. Proved from the runtime logs. |
| 6 | `CHECKOUT_ENABLED` / `VEYRA_*` | **only you** | No safe external check exists. `/admin/status` answers it in one click. |
| 7 | Supabase leaked-password protection | **only you** | Not a toggle — it needs the Pro plan. A business decision, not a defect. |
| 8 | Public routes `/vault` `/wholesale` `/contact` `/ambassador` `/partner` | **verified** | Intentionally public, each with its reason in code. Nothing protected leaks. |
| 9 | `/api/partner/program-stats` | **found and fixed** | Busiest path in production; four table scans per anonymous request. |
| 10 | `/api/admin/auth/session` | **found and fixed** | 401 on every anonymous visit to `/vault`. |

### 1. `RESEND_WEBHOOK_SIGNING_SECRET` — the one thing left for you

**Class: ONLY YOU.** There is no environment-variable tool in this session.
The Vercel integration exposes projects, deployments, deployment protection,
runtime logs and build logs — and no read or write of environment variables at
all. I could not set it, and I did not try to route around that.

What I did instead was remove every remaining doubt about what happens when you
do set it. Using the endpoint's own signing secret, read from Resend and never
written anywhere, I ran the deployed verification path four ways:

    valid signature                              200, event reaches applyDeliveryEvents
    one byte of the body changed                 401, nothing applied
    signature made with a different key          401
    valid signature replayed three hours later   401  (timestamp window)

The tampered-body case is the one that matters: the URL secret was still
correct in that request, and it was refused anyway. That is the whole
difference between today's behaviour and tomorrow's — today the URL is all that
is checked, and the URL sits in the Resend dashboard, in proxy and CDN access
logs, and in any screenshot of the webhook config.

`live-signature.test.ts` is checked in and holds **no secret**. It reads the two
values from the environment and skips loudly without them, so it is inert in CI
and decisive the moment someone supplies the endpoint's own keys.

**Your action, in full:** Resend → Webhooks → your endpoint → copy the Signing
Secret (begins `whsec_`) → Vercel → the `vanta-labs` project → Settings →
Environment Variables → add `RESEND_WEBHOOK_SIGNING_SECRET` for Production →
redeploy. The verification code is already deployed and activates the moment
the variable exists.

### 2. Windsor — resolved by you, verified by me, and it exposed a defect

**Class: VERIFIED, and one FIX.** The Basic-plan notice is gone. Live, this
session:

    facebook   last_2years   {"result":[]}
    tiktok     last_2years   {"result":[]}
    reddit     last_2years   {"result":[]}

An empty result, not a notice in place of data. Three connected sources —
`facebook` (two ad accounts, "Brenden Huntzinger" and "vanta labs"), `reddit`,
`tiktok` — which is the 3/3 you described.

**"Prove spend lands correctly" cannot be shown from live data, because there is
no live data.** Every connector returns an empty result for the last two years:
no campaign has ever spent a dollar through these accounts. A quiet day is a
successful ingest that writes nothing, and that is exactly what the ingest now
does. The mapping from a Windsor row to a `ad_spend_daily` row is proved by the
executed tests instead, which is the only honest proof available today.

**Detaching Snapchat exposed a real defect, now fixed.** Windsor does not answer
a detached connector with an empty result. It answers with a hard error:

    No snapchat account for user … was found, add your accounts at
    https://onboard.windsor.ai?datasource=snapchat

`snapchat` is still in `WINDSOR_CONNECTORS`, so the nightly sweep would have
reported a failed connector on every run for as long as it stayed detached. An
operator learns to ignore a signal that is always red, and that costs them the
one signal that means the feed is genuinely down.

A detached platform is now `skipped`, not `failed`. Three things were needed and
each has a test that fails without it:

- The body is read as **text before it is parsed**. The message arrives as a
  bare sentence, not JSON, sometimes under a 200 — so `response.json()` threw
  and the run reported "response was not JSON", and a body cannot be read twice.
- The message the ingest records is **written here, not passed through**.
  Windsor's own text names the account holder.
- The all-platforms-failed alarm counts only connectors that were **attempted**.
  All-detached is quiet; three connected platforms all failing still throws.

`WINDSOR_CONNECTORS` deliberately keeps `snapchat`. Reattaching it must not need
a deploy.

### 3–5. Production environment variables — verified without reading them

**Class: VERIFIED.** There is no environment-variable tool, so I used what the
deployed code already reveals about itself. Each probe is read-only, changes no
state, and writes no alert row.

**`EMAIL_WEBHOOK_SECRET` — SET.** `/api/webhooks/email` with a deliberately
wrong URL secret answered **401**. Unset, `getRequiredEnv` throws first and the
route answers 503. 401 is only reachable when the variable exists.

**`PAYMENT_WEBHOOK_SECRET` — SET.** `/api/webhooks/payment` with a
`veyragate-signature` header and an invalid signature answered **400 "Webhook
processing failed"** — the `WebhookSignatureError` branch, which sits *after*
the `getRequiredEnv` read and deliberately records no alert row. Unset, the same
request answers 500 "Webhook configuration is missing on the server."

  (The first attempt at this sent `x-webhook-signature`, which the route does
  not read, and got the header-guard 400 instead — a different branch, before
  the env read, and therefore no evidence at all. Worth recording, because the
  two 400s look identical from outside and only one of them proves anything.)

**`CRON_SECRET` — SET AND CORRECT.** This one is not externally probeable by
design: `/api/cron/sweep` compares in constant time and answers 401 both when
the secret is wrong and when it is unset. So the evidence is negative and comes
from the runtime logs. Vercel Cron invokes that route every 30 minutes; a
missing or wrong secret would produce a 401 on every invocation. Across twelve
hours, thirty distinct paths appear in the 401 breakdown and **`/api/cron/sweep`
is not one of them**.

**Production health, same window:** `/api/health` returns
`{"status":"ok","database":"ok"}`, and there were **zero 5xx responses in six
hours** — 200:1023, 401:115, 307:109, 304:5, 206:2, 400:2 (my two probes),
303:1, 405:1.

**A fixed defect confirmed from production.** That 401 breakdown is, almost
entirely, the anonymous gated fetches this branch eliminates: `/api/account/me`
85, `/api/catalog/promotions` 85, `/api/catalog/bac-water` 83,
`/api/catalog/bulk-savings-config` 83, `/api/offer/status` 52,
`/api/account/ambassador-discount` 50. Those disappear on merge.

### 6. `CHECKOUT_ENABLED` and the Veyra credentials — the honest limit

**Class: ONLY YOU.** I could not verify these and I am not going to imply
otherwise.

`isCheckoutOpen()` is read inside `/api/checkout/create-session`, which is
behind the account wall — anonymous requests get a 307 to the sign-in page and
never reach the gate. There is no anonymous reflection of it anywhere else. The
one indirect signal, "has this route ever answered 503", is empty across seven
days, but so is the route: the store has not launched, so nobody has attempted
checkout. **That is not evidence, and I am not counting it as any.**

The same holds for `VEYRA_API_BASE` and `VEYRA_SECRET_KEY`: both are read on
paths that require a session.

`/api/veyra/express-shipping-callback` *would* have given a clean existence
check for `VEYRA_SHIPPING_CALLBACK_TOKEN` — unset it answers 500, set it answers
401 to a wrong token — but sending that probe was refused by this session's own
safety classifier, and I did not attempt to work around the refusal.

**Your action:** open `/admin/status`. It reports every launch-critical
integration by name, never prints a value, and says in as many words whether
checkout can open. One page, one look.

### 7. Supabase leaked-password protection — not a toggle, a plan

**Class: ONLY YOU, and it is a business decision.** The previous version of this
report called it "one toggle". That was wrong in a way that would have wasted
your time.

The Supabase tools here cover the database, migrations, edge functions, branches
and project lifecycle. **There is no auth-configuration tool at all** — the
setting lives in GoTrue's platform config, not in a table `execute_sql` can
reach — so I could not enable it.

More to the point: **the `VantaLabs` organisation is on the Free plan, and
leaked-password protection requires Pro.** There is no toggle to flip today.

That is the one WARN-level security advisor outstanding; everything else the
advisor reports is INFO-level `rls_enabled_no_policy`, which is the correct and
intended state for service-role-only tables behind a deny-by-default wall.

**Two things worth raising with it, since the plan is the real subject.** The
Free plan also has no automated database backups, and this is a store about to
take real card payments — a store whose orders, customers and commission ledger
live in that one database. And a second project, `vanta-audit-harness`, has been
sitting in the same organisation since 2026-08-25; it is a leftover from an
earlier audit session and nothing in this codebase points at it. Neither is a
code defect and neither is mine to decide.

### 8. The public routes — intentional, and they leak nothing

**Class: VERIFIED. No change made, which is the correct outcome.**

You asked me not to treat this as an engineering blocker until I had determined
the intended access map. The map is not implicit — it is written into
`access-policy.ts`, entry by entry, with the reason for each:

- **`/contact`** — "Someone locked out of their own account is exactly the
  person who needs the contact form."
- **`/wholesale`, `/ambassador`, `/partner`** — "A prospective wholesale buyer
  or ambassador has no account yet by definition; putting recruitment behind a
  login ends recruitment."
- **`/vault`** — listed under surfaces with their **own** authentication
  boundary: "putting the customer gate in front of an admin login would lock the
  owner out of their own store."

That is architecture, not oversight, and all five stay public.

Verified in a real browser against a production build of this branch, signed
out, at 1280×800 and 390×844 — **56/56**:

    every route renders 200 for an anonymous visitor
    no console error, no sideways scroll at 390×844
    no credential of any kind in the served HTML
    no COA record  (the only "COA" on any of them is a nav LINK to
                    /coa-library, which is itself gated)
    no customer, financial or internal data
    /vault presents its own password form, not its contents

The catalogue half is additionally held by `public-pages-name-no-product.test.ts`,
which walks every public page plus one import hop and asserts against the
product names read out of the seed — so a name added to the catalogue tomorrow
is covered without anyone editing the test.

### 9. `/api/partner/program-stats` — found in production, fixed

**Class: FOUND AND FIXED.** This came out of the runtime logs, not the code: it
was the single busiest path in the entire store, **306 requests in six hours —
one every seventy seconds — before launch traffic exists.**

`/partner` polls it every 30 seconds from every open tab. The route was
`force-dynamic` with no cache and no rate limit, and `getPartnerProgramStats`
pages `partner_payouts` and `referral_orders` to exhaustion and reads `partners`
and `partner_program_stats` whole, all with the service-role key. So the cost
was (tabs × 2 per minute) × four table reads, growing with the ambassador
program, and payable by anyone on the internet with a `for` loop and no account.

These are public marketing counters on a recruitment page. One read per minute
per instance is the whole requirement, and the client's own poll now costs a
memory read. A read in flight is **shared** rather than duplicated, because the
TTL alone does not bound a stampede — on a cold instance every concurrent
request misses together. A failed read is never cached, so a transient database
blip is not pinned in front of the page for the rest of the window.

### 10. `/api/admin/auth/session` — the last anonymous 401 of its class

**Class: FOUND AND FIXED.** The browser pass above caught it: every anonymous
visit to `/vault` logged a console error, from a `GET /api/admin/auth/session`
answering **401** to the question "am I signed in?".

The body already said `{"authenticated": false}`. The status carried nothing the
caller did not have, and carried one thing nobody wanted: a line in production's
401 breakdown, on an **admin auth path**, that reads exactly like a real
refusal. This is the same defect the customer sign-in portal was cleared of
earlier in this audit, and the same reasoning applies — a probe that always
fails for the visitor who has not signed in yet teaches whoever reads the logs
to ignore the signal that matters.

The boundary does not live in that route and has not moved: it is
`verifyAdminSessionFromCookie`, and no admin data crosses either way. Both
callers now read the body rather than `res.ok`, and `/admin/products` still
denies on anything that is not an explicit yes.

### One thing I could not verify, stated plainly

**The repository's own checked-in QA scripts (`npm run qa:*`) no longer run
clean, and this is not caused by anything on this branch.** They have drifted
from the architecture in two ways that are worth knowing about:

- They target `http://127.0.0.1:3000` and set no `ignoreHTTPSErrors`. The
  harness is configured for the TLS front at `https://127.0.0.1:3443`
  (`NEXT_PUBLIC_SITE_URL`), so over plain http the `Secure` session cookie is
  never set, sign-in fails, the CSRF origin check refuses POSTs, and the
  confirmation hop dies on a certificate error. Most of the alarming lines in
  `qa:abuse` — "session fixation", "no session cookie to inspect", "not
  CSRF-guarded" — are that one cause, and none of them reproduce when the app is
  driven where it is configured to be driven.
- Several assertions predate the access wall. `qa:journey` expects an age gate
  on a fresh anonymous visit, which now redirects to sign-in; `qa:crossaccount`
  expects `/api/cart/restore` to answer 404 for an unknown cart id and it
  answers 401 — which is *more* private, not less, because 404 would confirm
  which ids exist.
- `qa:roles` refuses to report at all, because the admin account its own seed
  script creates has no 6-digit login code. It is right to refuse.

I did not rewrite them. Bringing that suite back in line is real work with real
judgement calls in it, it is test tooling rather than shipped behaviour, and
doing it unreviewed hours before a launch is the wrong trade. **What it costs
you is that I verified this branch with the suites and browser passes recorded
in §20, and not with those scripts.** They are worth fixing in the week after
launch.

## 19. Decisions I did NOT make for you

Each of these is real, understood, and left exactly as it is because it is a
business rule, not an engineering defect:

- **Organic traffic tagged with a platform `utm_source` is credited to that paid
  platform.** The revenue view keys on `utm_source` and ignores `utm_medium`, so
  an organic Instagram post tagged `utm_source=facebook` inflates paid ROAS.
  Fixing it means settling a tagging convention.
- **Ambassador vs ad revenue.** An ad that paid for a click onto an ambassador's
  link produces a sale the one-source rule awards to the ambassador. I excluded
  campaign, automation and cart-recovery revenue from ROAS and deliberately left
  `ambassador` in. Which side should carry it is yours.
- **Sign-out is global** — one device logs out all of them.
- **Ad spend is bucketed by UTC day** while the store's day is
  America/New_York, so an evening order can land either side of the spend that
  produced it. Real, bounded to the window edges, and not fixable on one side
  alone.
- **Every spend row is stored as USD** regardless of what the ad account
  reports.
- **Windsor's Meta connector has two ad accounts attached** — "Brenden
  Huntzinger" and "vanta labs". Still true after the plan was resolved; both
  are counted as one connected source.
- **The Supabase organisation is on the Free plan.** That is what puts
  leaked-password protection out of reach, and it is also why there are no
  automated database backups for a store about to take card payments. A cost
  decision, not a defect.
- **A second Supabase project, `vanta-audit-harness`,** has sat in the same
  organisation since 2026-08-25. Nothing in this codebase references it. Left
  alone.
- **`payment_processor.enabled = false` is cosmetic.** The real gate is the env
  var. Confusing, but changing which one wins is a behaviour change.
- **Six of the seven anonymous fetches on the portal are now gone** (§20); the
  seventh class — RSC prefetches of `/legal/*` — is Next's own and harmless.

## 20. Exact final state

    branch    claude/vanta-labs-launch-audit-px3297
    HEAD      8212dcd
    base      f81bf5fe38c2649aed2f36dc6290f02aad544ac3   (origin/main)
    ahead     31 commits, 113 files, +8694 / -431
    new tests 29 files
    working tree clean

The second pass added four commits, on top of the 27 the first pass left:

    d54572d  Detached ad platform is a skipped connector, not a nightly failure
    50406eb  Prove the Resend signature check end to end against the real endpoint
    07cbf48  The one anonymous endpoint that scans four tables now reads once a minute
    8212dcd  "Am I signed in?" is a question, and "no" is an answer

Every fix carries a regression test that **fails for the right reason** without
it — verified by reverting the fix and watching the specific case go red, not by
assertion count.

### Verification re-run after the second pass

    vitest, mocked                586 files   8936 passed   0 failed
    vitest, real Postgres         606 files   9166 passed   0 failed
                                              (10 skipped: the live-signature
                                               suite, which needs the endpoint's
                                               own keys and holds none)
    tsc --noEmit                  clean
    eslint .                      0 errors, 59 warnings (all pre-existing
                                  unused-var warnings in test files)
    next build (production)       compiled successfully
    NODE_ENV=test harness build   compiled successfully

Browser verification, on a production build of this branch against the local
harness with the security SQL applied, driven at `https://127.0.0.1:3443` as the
runbook requires:

    public surface, signed out    desktop 28/28   390x844 28/28

covering all five public routes for render, console errors, horizontal overflow,
credentials, COA records, `/vault`'s own login boundary, and the newly cached
program-stats endpoint.

The first pass's matrix — customer journey, ambassador link, sign-in portal,
adversarial, admin — stands at 99/99 with 0 console errors and is unaffected by
this pass's changes; three of the four new commits are in the ad-ingest and
webhook paths, which that matrix does not exercise, and the fourth is covered by
the 56/56 above.

Production, read-only, same session: zero 5xx in six hours, `/api/health` ok
with `database: ok`.

---

## Verdict

**READY FOR MAIN LAUNCH once `RESEND_WEBHOOK_SIGNING_SECRET` is set and
`/admin/status` confirms `CHECKOUT_ENABLED`.**

Merge `claude/vanta-labs-launch-audit-px3297`. Then:

1. Paste the Resend signing secret into the Vercel project and redeploy. Until
   that exists, possession of the webhook URL is write access to the suppression
   list, and a forged `email.complained` lands an unliftable suppression that
   the customer cannot undo from their account page by design.
2. Open `/admin/status` and read one line. If it says checkout can open, it can.

Nothing else on this branch is waiting on anyone. Leaked-password protection
needs the Pro plan and is your call, not a blocker; so is whether a store taking
card payments should be running its database without automated backups.
