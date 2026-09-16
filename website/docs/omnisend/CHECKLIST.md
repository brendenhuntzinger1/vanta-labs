# Omnisend transition — working checklist

Durable state for the email + SMS migration. Updated as work lands; anything
unticked here is not done, whatever a commit message says. Branch:
`claude/hopeful-gauss-ko2jj8`. Nothing merges to `main` until the owner has
walked through it, and nothing in Omnisend is enabled or sent.

Legend: `[x]` done and verified · `[~]` in progress / partial · `[ ]` not started
· `[!]` blocked on something outside the repo (named).

## 1. Audit before changing production behaviour
- [x] Resend account inventoried (2 verified domains, 1 segment, 0 broadcasts, 0 hosted templates, 2 bounce suppressions, 1 webhook with delivery/bounce/complaint/open/click events)
- [x] DNS inventoried (root SPF Google-only + DMARC p=none; Resend on `send.` subdomain with SES SPF and `resend._domainkey`; no Omnisend DKIM on the common selectors)
- [x] Store consent, suppression, cart, offer and automation state counted (see AUDIT.md)
- [x] Omnisend account inventoried (brand connected, platform `other`, America/Chicago, USD; before this work: 6 VL templates, 14 VL segments, 0 automations, 1 draft stock form not created by this work)
- [x] Message-ownership table written (AUDIT.md §2)
- [x] Bugs, missing events, duplicate-send risks and data gaps listed (AUDIT.md §5, F-01..F-18; F-02/F-04/F-06/F-12 fixed on the branch)
- [x] Consent snapshot table + cutoff timestamp + rollback procedure in the repo (migration-snapshot.ts, migration-state.ts, MIGRATION.md)
- [x] Feature flags documented (`OMNISEND_API_KEY`, `OMNISEND_MARKETING_OWNER`; links sign with `UNSUBSCRIBE_SECRET`) — AUDIT.md §6

## 2. Role of Resend
- [x] Decision recorded: Resend keeps every transactional and operational message; Omnisend owns marketing email, SMS, segmentation and marketing automations; the store stays authoritative for orders, payments, inventory, discounts, gifts, memberships and checkout
- [x] No Omnisend order-confirmation or shipping flow (only `order fulfilled` etc. events for segmentation)
- [x] Marketing unsubscribe stops marketing in both systems (write-back + push); transactional unaffected

## 3. Omnisend eligibility and readiness
- [x] Sender domain authentication in Omnisend — verified 2026-09-16 (SPF merged with the existing Google record, DKIM `krs._domainkey` added, DMARC unchanged); every automation and campaign draft now sends from `support@` on the domain
- [!] US SMS approval / toll-free or 10DLC verification — owner checks Omnisend → SMS settings; treat as NOT approved until the dashboard says so
- [!] Business and catalogue disclosure to Omnisend — owner confirms the account application names research peptides honestly
- [x] Plan limits learned: conditional content (section filters) is NOT on this plan (402); discount blocks cannot mint codes for API stores; back-in-stock trigger unsupported for API stores; recommenders fall back silently

## 4. Contact migration
- [x] Field map (contact-payload.ts + spec §5.1)
- [x] Consent copied exactly, never widened (contact-payload, reconcile-plan, tests)
- [x] Phone only with SMS consent; checkout phone is not consent
- [x] Historical timestamps preserved (`statusChangedAt`, `consent.createdAt` from store records)
- [x] `sendWelcomeMessage: false` on every import
- [x] Idempotent batched push with dry run (`reconcileOmnisendContacts({ dryRun })`)
- [x] Reconciliation report: source totals, destination totals, matched/created/duplicates/suppressed/failures
- [x] Batch result polling (Omnisend batches are asynchronous)
- [~] Post-cutoff delta sync: watermark implemented and unit-tested; verified against Omnisend only after the first live run
- [x] Resend bounce list vs store suppressions reconciled (2 pre-webhook bounces, neither mailable; AUDIT.md F-08) (see AUDIT.md)

## 5. Existing abandoned carts and active sequences
- [x] Counted: 12 open carts, all mid-sequence (10 active, 2 held), $2,306.85
- [x] Handoff rule implemented: carts with an in-house stage finish in-house (legacy-only sweep); carts with none are Omnisend's
- [x] Queued/in-flight work reconciled (marketing_send_queue empty on 2026-09-16; automations stand down)
- [x] 412 live recovery gift tokens and 70 win-back tokens keep redeeming at checkout (nothing revoked)
- [x] Old recovery links tested on the harness (VERIFICATION.md row 10)

## 6. Store integration
- [x] Transport, gate, ledger, link token, click route, contacts, codes, events, orders, catalogue (Tasks 1–5)
- [x] Order hooks module (paid/fulfilled/cancelled/refunded)
- [x] Order hooks wired into payment webhook (both paid lanes), Shippo, admin cancel/refund
- [x] Consent hooks (opt-in, preferences), cart/checkout events, product views
- [x] Backstop sweeps and cron registration (orders, catalogue, contacts reconcile, cart offers)
- [x] Payment failure never produces a paid event (order-wiring-source.test.ts)
- [x] Recovery offers minted by the store and enforced at checkout (code + banded gift)

## 7. Account customisation and templates
- [x] Header/footer universal layouts, brand images uploaded
- [x] 34 templates in Omnisend (assets/created.json), including the welcome-2-code and welcome-3-nocode twins for the welcome split and the welcome-offer / welcome-offer-code pair (2026-09-16)
- [x] Remaining templates uploaded (cart, checkout, browse, post-purchase-2, replenishment, winback-1, campaigns)
- [x] New templates: new product, general promotion, final-day promotion, VIP milestone, repeat-customer
- [x] SMS variants catalogued (scripts/omnisend/sms.mjs)
- [x] "Recon Water" everywhere customer-facing; no invented claims (assets.test.mjs)
- [~] Rendered previews: structure pinned by assets.test.mjs; visual check in Omnisend's editor is the owner's
- [x] Premium and conversion review against Omnisend's published benchmarks, its design guidance and premium brands on the platform (DESIGN.md): one ivory primary action per email, "good to know" card of canonical claims on cart, checkout and welcome, real product photographs in the welcome grid, image weights under 100 KB
- [x] Welcome hero is the store's own product vial, never a generic or generated one
- [x] Pop-up leads with the welcome offer (15% off a first order, 14 days stated), purity sentence in its checkable form ("Every batch report we publish shows above 99% purity"), shown after 4 seconds; re-read the purity sentence whenever a report is published
- [!] Dark-mode preview (Gmail iOS, Outlook) in Omnisend before the first send — owner
- [!] Postal address in the footer — owner supplies
- [x] Sender name / reply-to configured in Omnisend — Vanta Labs, `support@` on the verified domain (2026-09-16)

## 8. Automations
- [x] Welcome, abandoned cart, abandoned checkout, browse abandonment, post-purchase, replenishment, win-back, sunset created — all DISABLED
- [x] Timings and rationale documented as hypotheses (scripts/omnisend/README.md, OPERATIONS.md §3)
- [x] Frequency limiter + sending thresholds on every automation
- [x] Welcome never shows a blank code: E1 carries none; the generic SMS goes only to contacts without an offer; E2/E3 split on vl-welcome-ready
- [x] Welcome offer flow (disabled): enters on vl-welcome-ready, splits on vl-welcome-gift-ready, vial email + text or code email + text; once per lifetime
- [x] Win-back enters on vl-lapsed-60 (not on every paid order) so a repeat buyer who lapses again is won back again; limiter 32 d
- [x] Post-purchase: repeat thank-you only for a second order, VIP milestone a week later

## 9. Offer economics
- [x] Live gift/discount system audited and reused (cart-offers.ts, cart-plan.ts)
- [x] Welcome offer decided by the owner (2026-09-16): 15% off a first order, alone for now; the free GHK-Cu half is built and dormant (WELCOME_GIFT_ENABLED), with the checkout rule that a welcome code typed over the vial withdraws the vial (welcome-offer-exclusive.test.ts)
- [!] GHK-Cu unit cost: the catalogue records a figure far above the couple of dollars the owner quoted; confirm which is right before flipping the vial on
- [!] SMS incentive: shape to be decided (a stacked open-ended percentage is not recommended; see the addendum spec §1)
- [x] Boundary tests: below floor, band edges, out-of-stock gift, expired token, repeat redemption, recent buyer

## 10. Deliverability and analytics
- [x] DNS inspected (no changes made)
- [x] UTM scheme documented; attribution overlap documented (OPERATIONS.md §2)
- [x] Metrics list and baseline documented (OPERATIONS.md §3)

## 11. End-to-end verification
- [~] Test matrix executed (VERIFICATION.md: 21 PASS, 1 PARTIAL, 3 BLOCKED on the owner) against the local harness with test contacts; passed/failed/blocked recorded
- [x] Adversarial review of the merged diff, three fix branches merged and re-verified (contacts fail closed by not pushing; order events carry no phone and release the claim on a transient refusal; the cart-offer claim fails closed and the welcome code is retired at first payment); full suite, lint and typecheck green after each
- [x] Harness carries the Omnisend tables (omnisend-sync.sql in setup-local-harness.sh; applied twice without error); guest checkout beacon and sealed attestation handoff browser-checked at 390×844 (VERIFICATION.md rows 23–24)

## 12. Controlled transition
- [x] Launch summary, rollout order, cohort and spend limits, rollback steps (LAUNCH.md, OPERATIONS.md §4-5)

## 13. Final delivery
- [x] Implemented list, ownership table, IDs, reconciliation, handoff, evidence, status, rollback, costs, promo guide
