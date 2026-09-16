# Omnisend transition: verification record

Every row is one of: **configuration check** (read the configured object),
**unit test** (vitest, deterministic), **harness** (the local Next.js harness
against a local Postgres with the real schema, Omnisend gate OFF so nothing
leaves the machine), **seed test** (a real message delivered to an owner
mailbox or phone — only with the owner's authorisation), **production
evidence** (a real event observed after cutover). A row is PASS only with
the evidence named. "API accepted the request" is never inbox delivery.

Statuses: PASS · FAIL · BLOCKED (named dependency) · UNTESTED.

| # | Scenario | Method | Status | Evidence |
|---|---|---|---|---|
| 1 | New signup, email consent only → contact subscribed (email), no phone identifier, welcome code minted | unit + harness | PASS | unit: contact-payload.test.ts (email identifier with the store's status and timestamp, no phone identifier without SMS consent); hooks-source.test.ts (welcome code minted only for a never-bought address) |
| 2 | New signup with email and SMS consent → phone identifier with sms subscribed and consent source/time | unit | PASS | unit: contact-payload.test.ts (phone identifier carries sms status, consent source and createdAt from the store record) |
| 3 | Phone supplied without SMS consent → no phone identifier pushed | unit | PASS | unit: contact-payload.test.ts (phone present, smsConsent absent: no phone identifier); omnisend-sync-source.test.ts pins the guard |
| 4 | Previously unsubscribed / suppressed address in the import → pushed as unsubscribed, never re-subscribed by write-back | unit | PASS | unit: contact-payload.test.ts (suppressed → unsubscribed with the store's timestamp); reconcile-plan.test.ts (an Omnisend `subscribed` never re-subscribes a suppressed address; an unsubscribe becomes a suppression) |
| 5 | Duplicate event and retried webhook → one ledger row, one send | unit + harness | PASS | unit: ledger-source.test.ts (primary key claim, 23505 → false), order-hooks via order-wiring-source.test.ts and sweeps.test.ts (a delivered ledger row is never resent); client.test.ts (retry only on 429/500/503/524) |
| 6 | Cart abandoned → updated → recovered → purchased: events sent, exit on order, cart offers not minted after purchase | unit + harness | PASS (unit) / harness partial | unit: cart-plan.test.ts, hooks-source.test.ts, cart-offers-source.test.ts (event debounce, checkout ordering, purchase-since check, once-per-cart plan claim). Harness: the four omnisend_* cron jobs answered `skipped: not_production_environment` on 2026-09-16, proving the gate; a signed-in cart flow cannot run on the harness (no auth) |
| 7 | Purchase immediately before a queued recovery send → Omnisend exit condition (placed order) documented; store side stops minting | configuration + unit | PASS (configuration + unit) | automations.json / automations.mjs: abandoned-cart and abandoned-checkout exit on `placed order`; cart-offers skips a cart with a paid order since first_seen_at (cart-plan.test.ts) |
| 8 | Failed payment vs confirmed paid order → no paid event on failure | unit (source) | PASS | unit: order-wiring-source.test.ts (onOrderPaid only after the paid status write, in both paid lanes, never in the reversal branch); ownership-gaps-source.test.ts (cancel/refund hooks only when wasPaid) |
| 9 | Existing customer midway through the legacy cart sequence → finishes in-house, no Omnisend cart event | unit | PASS | unit: cart-recovery-legacy-only.test.ts (legacy-only sweep processes only carts with a claimed stage); hooks-source.test.ts (no cart event for a cart with an abandoned_cart_emails row); ownership-gaps-source.test.ts (admin resend refuses an Omnisend-owned cart) |
| 10 | Old in-house recovery link after cutover → still restores the cart | harness | PASS (harness) | 2026-09-16 local harness: a cart inserted 40 h old, opened through /cart/restore?id=…&k=<guest grant> at 390×844 restored one BPC-157 10mg line into the cart page; without the grant the API answered 401 Sign in to continue (ownership protected). Screenshot old-recovery-link-restored-cart-mobile.png |
| 11 | Every active gift/discount tier → code percent and gift text per band; checkout enforces assigned address, single use, expiry, minimum | unit | PASS (unit) | cart-plan.test.ts (band percent and gift text per tier, minimum from the band, Recon Water naming); codes-source.test.ts (assigned_email, max_redemptions 1, is_private, ends_at); coupon-validation.test.ts (assigned address enforced case-insensitively, expiry, redemption count) |
| 12 | Out-of-stock gift → dropped from the offer; expired offer → not promised | unit | PASS (unit) | cart-plan.test.ts / cart-offers-source.test.ts (unshippable gift dropped through unshippableGiftSlugsFor; expired offer not promised because properties are only pushed while live and the reconcile clears them) |
| 13 | Email unsubscribe in Omnisend → store suppression; SMS STOP → sms_opted_out_at | unit (plan) | PASS (unit) | reconcile-plan.test.ts (unsubscribe → suppression with source omnisend; sms unsubscribed → sms opt-out stamp; nothing widened) |
| 14 | Opt-out while a message is queued → Omnisend sending thresholds (configuration); store re-reads consent before every push | configuration + unit | PASS (configuration + unit) | automations.mjs sendingThresholds on every flow (Omnisend re-checks consent at each send); contacts.ts re-reads consent on every push (contact-payload.test.ts) |
| 15 | Quiet hours → Omnisend account setting (owner); SMS blocks only in flows | configuration | BLOCKED (owner: SMS settings) | post_automations exposes no quiet-hours or timezone field; SMS blocks are inside flows only and every flow is disabled |
| 16 | Provider/API outage and recovery → hook never throws, ledger releases claim, backstop retries paid orders | unit | PASS (unit) | client.test.ts (network failure → result, one retry, never throws); ledger-source.test.ts (release on a send that never happened); sweeps.test.ts (backstop retries undelivered paid orders after the stale-claim window) |
| 17 | Rollback without replaying completed marketing steps → ledger rows survive; in-house resumes; consent unchanged | unit + doc | PASS (unit + doc) | ownership.test.ts / ownership-source.test.ts (unset switch → in-house resumes); migration-snapshot-source.test.ts (snapshot rows for the comparison); MIGRATION.md rollback |
| 18 | Password reset, receipt and shipping email still function through Resend (unchanged paths) | unit (existing suites) | PASS (unit) | the existing transactional suites ran unchanged in the full run (705 files, 10,977 tests on 2026-09-16, after the review fixes); no transactional send path was edited except adding deferred Omnisend hooks after the existing sends |
| 19 | Omnisend link route: logged-out desktop and mobile (390x844) land on the target page past the account wall; expired token → sign-in | harness | PASS (harness) | 2026-09-16 local harness at 390×844: valid sealed token → 302 to /attest (Confirm to continue) with the destination preserved (no cookie beyond the browse grant is set; the attribution cookie was removed on 2026-09-16 as unread and not consent-gated); expired, tampered, missing and v1-shaped tokens → 302 /account/login?next=<destination>; `to=https://evil.example` and `to=//evil.example` → destination collapsed to /products. Screenshots omnisend-link-valid-attest-mobile.png, omnisend-link-invalid-mobile.png |
| 20 | Template render at 600 and 390 wide: hierarchy, one primary action, alt text, links carry the grant | preview render | PARTIAL | structure and copy pinned by scripts/omnisend/assets.test.mjs (43 tests: one primary button, alt text, grant link on every href, no address in URLs, copy rules); the visual render is Omnisend's and is checked by the owner in the template editor and a seed send |
| 21 | Seed sends of each template to an owner mailbox | seed | BLOCKED (owner authorisation; sender domain) | not sent: no sender domain authenticated and no authorisation to send |
| 22 | Production: first real event of each type observed in omnisend_events_sent and in Omnisend | production evidence | BLOCKED (cutover) | nothing has been enabled in production |
| 23 | Guest checkout beacon at 390×844: reaching /checkout stamps `checkout_started_at` on the guest's cart row once an address is typed; the Omnisend gate stays off | harness | PASS (harness) | 2026-09-16 local harness at 390×844, guest holding a marketing-link grant: product page → Add to Cart → /checkout. The arrival beacon posted `items: [], reachedCheckout: true` (a guest has no row yet, so nothing to stamp); typing the address fired the debounced items beacon with `reachedCheckout: true`, and the store answered 200 having created and stamped the row in the same call: one `abandoned_carts` row for the test address, status active, one line, `first_seen_at` and `checkout_started_at` equal (19:18:32). `omnisend_events_sent` stayed empty (gate off outside production). Screenshot checkout-guest-beacon-mobile.png |
| 24 | Sealed attestation handoff (v2): link click → /attest → confirm → destination preserved with UTM; the address never in any URL | harness | PASS (harness; the recorded branch needs an account) | 2026-09-16 local harness at 390×844: a v2 link token minted with the harness secret, opened through the click route with `to=/products/bpc-157-10mg` → 302 to `/attest?h=v2.<expiry>.<sealed>.<mac>`; both confirmations ticked, Confirm and continue → POST /api/attest 200 with only the handoff and the two booleans in the body. The harness has no auth users, so the outcome was `no_account` and the page went to `/account/login?next=/products/bpc-157-10mg?utm_source=omnisend&utm_medium=email`, destination and UTM intact. No request URL in the session contained the address or an `@` (network log filtered). The recorded/grant branch is pinned by api/attest/route.test.ts and needs a real account (GoTrue) to see in a browser. Screenshot attest-sealed-handoff-mobile.png |
| 25 | Regenerated template set in the account: every template, automation copy and campaign copy carries the reviewed design; nothing enabled | configuration + render | PASS (configuration) | 2026-09-16 21:40 to 21:49 UTC: 32 of 32 templates accepted by `put_email_templates_id` (after one refusal, "borderRadius must be not bigger than 200 pixels size", fixed in the generator and pinned by assets.test.mjs, 44 tests); 8 of 8 automations re-copied with `put_automations_id_blocks`, 27 new content ids in automation-content.json, `isEnabled` false on all 8 read back; 3 of 3 campaign copies updated with `put_email_content_id`, status draft on all 3, sender set to the verified domain address. Omnisend's own render of welcome-1, cart-1, cart-3-gift-code, checkout-2, post-purchase-1 and winback-1 captured at 390 wide (v2-*.png): one ivory primary button, the store's own product vial, the trust card, product placeholders where Omnisend fills real products at send time. Sender domain verified by the owner the same evening; every automation reads `support@` on the domain |

## Harness session, 2026-09-16

Local harness (`npm run harness:build && npm run harness:start`, PostgREST shim
on a local Postgres with the real schema, `NODE_ENV=test`, no Omnisend key).
Evidence files live outside the repository in the session's scratchpad;
nothing customer-shaped was used: the only address was
`omnisend-test@example.com` and the only cart was inserted for the test.

* `/api/cron/sweep` with the harness `CRON_SECRET`: `omnisendCartOffers`,
  `omnisendOrderBackstop`, `omnisendCatalogSync`, `omnisendContactsReconcile`
  each answered `skipped: "not_production_environment"` before touching the
  database.
* `/legal/privacy`, `/legal/cookies`, `/legal/terms` render the new Omnisend
  and SMS sentences (200).
* Omnisend click route: seven cases, see row 19.
* Old recovery link: see row 10.

Not possible on the harness: a signed-in product view, cart or checkout event
(the shim has no auth), a real Omnisend round trip (gated off outside
production by design), SMS. Those are covered by unit and source tests and by
the seed-test step of the launch order.

## Design pass, 2026-09-16 evening

The review in `DESIGN.md` changed the primary button, added the trust card
and the welcome grid, and kept the store's own product vial as the only
photograph. The push to the account went through the generator only (no
hand edits), so the registry ids and the tests describe what the account
holds. Six of Omnisend's own renders were screenshotted at phone width and
shown to the owner. Not seen yet: a real send (sender domain verified, seed
sends still the owner's call) and the dark-mode preview in Omnisend's editor.

## Harness session 2, 2026-09-16 (after the review fixes)

Rebuilt from a cleared `.next/cache` on the merged head. `omnisend-sync.sql`
was applied to the harness database twice without error (idempotent) and is
now part of `scripts/setup-local-harness.sh`, so a fresh harness carries the
three Omnisend tables. The catalogue wall was passed with a marketing-link
grant minted the way `signEmailLinkGrant` mints it, because the harness has
no GoTrue and a guest arriving from an email holds exactly that grant. The
only address used was `omnisend-test@example.com`; the only cart was the one
the test created. Rows 23 and 24 above.
