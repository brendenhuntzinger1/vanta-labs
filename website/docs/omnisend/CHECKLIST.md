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
- [x] Omnisend account inventoried (brand connected, platform `other`, America/Chicago, USD; 6 VL templates, 14 VL segments, 0 automations, 1 draft stock form not created by this work)
- [ ] Message-ownership table written (AUDIT.md)
- [ ] Bugs, missing events, duplicate-send risks and data gaps listed (AUDIT.md)
- [ ] Consent snapshot table + cutoff timestamp + rollback procedure in the repo
- [ ] Feature flags documented (`OMNISEND_API_KEY`, `OMNISEND_MARKETING_OWNER`, `OMNISEND_LINK_SECRET`)

## 2. Role of Resend
- [ ] Decision recorded: Resend keeps every transactional and operational message; Omnisend owns marketing email, SMS, segmentation and marketing automations; the store stays authoritative for orders, payments, inventory, discounts, gifts, memberships and checkout
- [ ] No Omnisend order-confirmation or shipping flow (only `order fulfilled` etc. events for segmentation)
- [ ] Marketing unsubscribe stops marketing in both systems (write-back + push); transactional unaffected

## 3. Omnisend eligibility and readiness
- [!] Sender domain authentication in Omnisend — owner adds the DNS records Omnisend shows under Store settings → Sender domains (no API exposes this)
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
- [ ] Reconciliation report: source totals, destination totals, matched/created/duplicates/suppressed/failures
- [ ] Batch result polling (Omnisend batches are asynchronous)
- [ ] Post-cutoff delta sync verified (watermark)
- [ ] Resend bounce list vs store suppressions reconciled (see AUDIT.md)

## 5. Existing abandoned carts and active sequences
- [x] Counted: 12 open carts, all mid-sequence (10 active, 2 held), $2,306.85
- [ ] Handoff rule implemented: carts with an in-house stage finish in-house (legacy-only sweep); carts with none are Omnisend's
- [ ] Queued/in-flight work reconciled (marketing_send_queue empty on 2026-09-16; automations stand down)
- [ ] 412 live recovery gift tokens and 70 win-back tokens keep redeeming at checkout (nothing revoked)
- [ ] Old recovery links tested after cutover

## 6. Store integration
- [x] Transport, gate, ledger, link token, click route, contacts, codes, events, orders, catalogue (Tasks 1–5)
- [x] Order hooks module (paid/fulfilled/cancelled/refunded)
- [ ] Order hooks wired into payment webhook (both paid lanes), Shippo, admin cancel/refund
- [ ] Consent hooks (opt-in, preferences), cart/checkout events, product views
- [ ] Backstop sweeps and cron registration (orders, catalogue, contacts reconcile, cart offers)
- [ ] Payment failure never produces a paid event (test)
- [ ] Recovery offers minted by the store and enforced at checkout (code + banded gift)

## 7. Account customisation and templates
- [x] Header/footer universal layouts, brand images uploaded
- [x] 6 of 20 templates in Omnisend (welcome-1/2/3, post-purchase-1, winback-2, sunset)
- [ ] Remaining templates uploaded (cart, checkout, browse, post-purchase-2, replenishment, winback-1, campaigns)
- [ ] New templates: new product, general promotion, final-day promotion, VIP milestone, repeat-customer
- [ ] SMS variants catalogued
- [ ] "Recon Water" everywhere customer-facing; no invented claims
- [ ] Rendered previews checked at 390 and 600 wide
- [!] Postal address in the footer — owner supplies
- [!] Sender name / reply-to configured in Omnisend — owner

## 8. Automations
- [ ] Welcome, abandoned cart, abandoned checkout, browse abandonment, post-purchase, replenishment, win-back, sunset created — all DISABLED
- [ ] Timings and rationale documented as hypotheses
- [ ] Frequency limiter + sending thresholds on every automation

## 9. Offer economics
- [ ] Live gift/discount system audited against the Omnisend flow
- [ ] Boundary tests: below floor, band edges, out-of-stock gift, expired token, repeat redemption, recent buyer

## 10. Deliverability and analytics
- [x] DNS inspected (no changes made)
- [ ] UTM scheme documented; attribution overlap documented
- [ ] Metrics list and baseline documented

## 11. End-to-end verification
- [ ] Test matrix executed against the local harness with test contacts; passed/failed/blocked recorded

## 12. Controlled transition
- [ ] Launch summary, rollout order, cohort and spend limits, rollback steps

## 13. Final delivery
- [ ] Implemented list, ownership table, IDs, reconciliation, handoff, evidence, status, rollback, costs, promo guide
