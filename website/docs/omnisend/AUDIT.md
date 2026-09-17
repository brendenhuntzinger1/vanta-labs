# Omnisend transition: audit of what sends today and who owns each message

Date: 2026-09-16. Companion to `OPERATIONS.md` (deliverability, launch,
rollback), `CHECKLIST.md` (state of the work) and the design spec at
`docs/superpowers/specs/2026-09-15-omnisend-marketing-system-design.md`.

Every claim about code below was traced from source at the commit this file
was written on, with `file:line` references relative to `website/`. Every
production figure is from the measurement taken on 2026-09-16 and is quoted
verbatim; nothing was re-queried while writing this. No address, phone number,
token, code, secret or webhook URL appears in this document by design.

Scope note on the branch. The Omnisend modules present on this commit are
`client.ts`, `config.ts`, `ownership.ts`, `contacts.ts`, `contact-payload.ts`,
`codes.ts`, `link-token.ts`, `events.ts`, `orders.ts`, `order-hooks.ts`,
`ledger.ts`, `catalog-sync.ts`, `reconcile.ts` and `reconcile-plan.ts`, the
click route `src/app/api/email/omnisend-link/route.ts`, the admin route
`src/app/api/admin/omnisend/sync/route.ts`, and the ownership switch wired
into the lifecycle cron and the campaign send route. Amended 2026-09-16
after the merge: the consent, cart, checkout and product-view hooks
(`hooks.ts`), the order-hook call sites (payment webhook, Shippo, admin
cancel and refund), the cart-offer sweep (`cart-offers.ts`) and the four
Omnisend cron jobs (`sweeps.ts`, `cart-offers.ts`) are on this branch; the
ownership gaps this audit found as F-02, F-04, F-06 and F-12 were fixed on
it the same day, and the findings below say so where they apply.

---

## 1. What sends today

Provider for everything: Resend, selected by the admin email control snapshot
(`src/lib/email/settings.ts:123-158`) and constructed in
`src/lib/email/provider.ts:30-32`. Two verified sending domains exist in
Resend (the root domain and a `mail.` subdomain), both in us-east-1. The
transactional From is the admin `from`; marketing sends From
`resolveMarketingFrom` (`settings.ts:165-167`) with Reply-To
`resolveMarketingReplyTo` (`settings.ts:181-183`), because the marketing
subdomain has no MX and cannot receive.

Two send paths exist and the distinction is the whole audit:

* `sendEmail` (`src/lib/email/send.ts:10-31`): never throws, no suppression,
  no unsubscribe header, no send log. Transactional only.
* `sendMarketingEmail` (`src/lib/email/marketing.ts:192-386`) rendering into
  `sendRenderedMarketingEmail` (`marketing.ts:406-581`): refuses sink
  addresses (`marketing.ts:210-213`), fails CLOSED when `email_suppressions`
  cannot be read (`marketing.ts:221-229`), refuses a suppressed address
  (`marketing.ts:231-234`), appends the reason line, the unsubscribe link and
  the CAN-SPAM postal address (`marketing.ts:267-324`), claims the 24-hour
  frequency guard `marketing_send_claim` (`marketing.ts:467-518`,
  `src/lib/email/frequency.ts:98-140`), sets `List-Unsubscribe` and
  `List-Unsubscribe-Post` (`marketing.ts:530-533`), sends with a hashed
  idempotency key (`marketing.ts:158-176`) and writes `email_send_log`
  (`marketing.ts:557-578`).

Every in-house marketing sender also asks `marketingBlockedReason`
(`settings.ts:253-260`): email disabled, provider not ready, or postal address
blank holds the send. The cart sweep (`src/lib/cart-recovery.ts:1653`), the
automation sweep (`src/lib/email/automations.ts:648-652`), the campaign batch
(`src/lib/email/campaign-sender.ts:390`), the queue drain
(`src/lib/email/marketing-queue.ts:67-71`) and the campaign send route
(`src/app/api/admin/email/campaigns/[campaignId]/send/route.ts:55-61`) all
stop on it.

### 1.1 Transactional (never suppressible, never gated by consent)

| Message | Trigger | Sender module | Template | Send-once / retry | Tables written |
|---|---|---|---|---|---|
| Account confirmation (signup) | `POST /api/auth/signup` | `src/app/api/auth/signup/route.ts:347-377` via `sendEmail` | `accountConfirmationTemplate` | one per address per minute (`claimAuthEmailSend`, `signup/route.ts:372`) | `email_send_log` under the `auth:` prefix (`src/lib/auth-email-audit.ts:77`, ignored by the frequency guard, `frequency.ts:65-67`) |
| Account confirmation resend | resend-confirmation route | `src/lib/auth-confirmation-email.ts:238-254` | `accountConfirmationResendTemplate` | same minute claim | same |
| Password reset | `POST /api/auth/password-reset` | `src/app/api/auth/password-reset/route.ts:197-207` | `passwordResetTemplate` | audit row | same |
| Email change confirmation | `POST /api/account/email-change` | `src/app/api/account/email-change/route.ts:154-165` | `emailChangeConfirmationTemplate` | audit row against the new address | same |
| Order confirmation (receipt) | paid side-effects of the processor webhook, and the manual approval lane | `src/lib/payment-webhook.ts:3185` and `:1824`, through `sendOrderEmailOnce` (`src/lib/email/order-email-once.ts:171-253`) | `orderConfirmationTemplate` | `order_email_log` unique slot claimed BEFORE the send; failed sends queued in `pending_emails` with `(orderId, kind)` (`payment-webhook.ts:3191-3199`) | `order_email_log`, `pending_emails` |
| Order confirmation resend (admin) | admin order action `resend_confirmation` | `src/app/api/admin/orders/[orderId]/route.ts:1005` | rendered from the record | its own numbered slot (`order-email-once.ts:108-128`) | `order_email_log`, `pending_emails` |
| Payment received (manual pay, verifying) | `POST /api/checkout/submit-payment`; admin `resend_email` on an unpaid order | `src/app/api/checkout/submit-payment/route.ts:129`; `src/app/api/admin/payments/[orderId]/route.ts:150` | `manualPaymentReceivedTemplate` | none; result discarded on the checkout path | none |
| Payment rejected | admin `reject` | `src/app/api/admin/payments/[orderId]/route.ts:104` | `manualPaymentRejectedTemplate` | none; result discarded | `admin_audit_logs` |
| Owner alert: payment to verify | same checkout route | `submit-payment/route.ts:144` | `newPaymentToVerifyTemplate` | none | none |
| Shipping update (shipped) and delivery confirmation | Shippo tracking webhook transition (`notificationFor`, `src/lib/shippo/service.ts:1712-1720`); admin single-order status change; admin bulk mark-shipped | `shippo/service.ts:1767` and `:1785`; `src/app/api/admin/orders/[orderId]/route.ts:441`; `src/lib/admin-orders.ts:452` | `shippingUpdateTemplate`, `deliveryConfirmationTemplate` | provider idempotency key `kind:orderId` (`order-email-once.ts:85-87`); failures queued with identity (`shippo/service.ts:1730-1745`) | `pending_emails` |
| Refund confirmation | processor refund webhook branch | `payment-webhook.ts:3556` via `sendOrderEmailOnce` | `refundConfirmationTemplate` | slot keyed on the cumulative amount (`order-email-once.ts:137-139`) | `order_email_log`, `pending_emails` |
| Reimbursement recorded | admin reimbursement action, cash only | `admin/orders/[orderId]/route.ts:717` | `reimbursementRecordedTemplate` | queued on failure | `pending_emails` |
| Replacement order | admin replacement action | `admin/orders/[orderId]/route.ts:870` | `replacementOrderTemplate` | queued on failure | `pending_emails` |
| Order cancelled | admin cancel action | `admin/orders/[orderId]/route.ts:965` | `orderCancelledTemplate` | queued on failure | `pending_emails` |
| Membership | the paid membership feature was removed on 2026-09-12 (`src/app/api/cron/sweep/route.ts:52-56`); the receipt kinds remain in the type (`order-email-once.ts:66-67`) and the templates remain, with no live sender found for welcome, trial or renewal mail | none | `membership*Template` (unused) | n/a | n/a |
| Affiliate / ambassador | partner-portal actions: application received, approved, denied, referral code assigned, info requested, invite, payout sent; commission earned in the paid lane | `src/lib/partner-portal.ts:318` (`sendAmbassadorEmail`, all seven), `payment-webhook.ts:1383` | `ambassador*Template`, `referralCodeAssignedTemplate`, `commissionEarnedTemplate` | queued on failure (`partner-portal.ts:329`, `payment-webhook.ts:1388`) | `pending_emails` |
| Contact form, wholesale enquiry (to support, plus auto-reply) | the two public forms | `src/app/api/contact/route.ts:91,136`; `src/app/api/wholesale/route.ts:119,133` | form templates | none; undelivered contact form recorded as a system alert | `system_alerts` |
| Critical system alert | `recordSystemAlert` with severity critical | `src/lib/monitoring.ts:142` | inline HTML | none | `system_alerts` |
| Admin test email | admin settings POST | `src/app/api/admin/settings/route.ts:148` | inline | none | none |
| Campaign test send | campaign send route, mode `test` | `campaigns/[campaignId]/send/route.ts:162` via `sendEmail` with the marketing headers attached by hand and a suppression refusal (`:101-106`) | campaign template with a `[TEST]` subject | none, deliberately unlogged | none |

Transactional retry: `retryPendingEmails` drains `pending_emails` with a
compare-and-set hold (`src/lib/email/retry-queue.ts:251`, hold at `:29`), up
to 5 attempts (`:12`), re-sending under the same `kind:orderId` idempotency
key and closing the `order_email_log` slot on success. The order-email reaper
(`src/lib/email/order-email-reaper.ts`) releases slots stranded at `sending`
after fifteen minutes and re-renders the receipt into the queue.

### 1.2 In-house marketing (through `sendMarketingEmail`)

| Message | Trigger | Sender | Template | Audience and consent gate | Frequency guard | Tables written |
|---|---|---|---|---|---|---|
| Cart recovery t30m (or the payment-failed variant) | `abandoned_carts` row with last activity 1h to 12h ago (`STAGE_WINDOWS`, `cart-recovery.ts:814-818`) | `runAbandonedCartSweep` (`cart-recovery.ts:1624`) → `reserveAndSendStage` (`:733`) | `cartRecoveryT30mTemplate` / `cartRecoveryPaymentFailedTemplate` (`:2036-2049`) | any address a cart was tracked for: a signed-in account or an address typed at checkout (`src/app/api/cart/track/route.ts:84-100`, `cart-recovery.ts:119`). No opt-in is required; `email_suppressions` is the only gate (`cart-recovery.ts:1907`) | `marketing_send_claim` taken before the stage claim (`:607-620`); a cart's own earlier stages do not defer its later ones (`frequency.ts:75-77`); one new sequence per address per 7 days (`RECOVERY_SEQUENCE_COOLDOWN_MS`, `:844`); at least 8h between stages (`:938`) | `abandoned_cart_emails` (stage claim with experiment variant, `:633-660`), `email_send_log` |
| Cart recovery t12h (batch-report proof) | 12h to 24h | same | `cartRecoveryT12hTemplate` (`:2050-2077`) | same | same | same |
| Cart recovery t24h (gift stage) | 24h to 72h | same, `mintOffer` behind the claim (`:2078-2129`) | `cartRecoveryT24hTemplate` | same, plus the gift is withheld from a band below the minimum | same; one gift per address per 30 days (`src/lib/cart-recovery-offers.ts:47`) | `customer_offers` (`cart_recovery_bac_water`, 412 live tokens in production), `abandoned_cart_emails` |
| Cart recovery t72h (last chance, code plus optional gift) | 72h to 96h | same, `mintCoupon` and `mintOfferOptional` behind the claim (`:2114-2197`) | `cartRecoveryT72hTemplate` | same; a code only when no recovery code was minted for the address in 30 days (`RECOVERY_DISCOUNT_COOLDOWN_MS`, `:910`) | same | `coupons` (source `cart_recovery`, bound to the address), `abandoned_cart_emails` |
| Cart recovery manual resend (admin) | operator button per cart and stage | `resendCartRecoveryEmail` (`src/lib/admin-cart-recovery.ts:445`, sends at `:759-846`) | the same four templates or the gift template | suppression via the wrapper only | wrapper claim | `abandoned_cart_emails`, `email_send_log`, `customer_offers` for an override gift |
| Welcome pair: `welcome_intro` then `welcome_no_purchase` | consented address with no paid order, `delay_days` after consent (account creation, or guest `opted_in_at`), inside a 14-day grace (`automations.ts:370-383`, `EVENT_GRACE_DAYS` at `src/lib/email/automation-catalog.ts:79`) | `runAutomationSweep` (`automations.ts:645`) | operator copy through `campaignTemplate` (`:879-893`) | `loadConsentedAudience` (`src/lib/email/audience.ts:202-286`): `customer_preferences.marketing_emails = true` union `marketing_subscribers` with null `unsubscribed_at`, minus `email_suppressions`, minus sink addresses | quiet-period pre-read (`:355-366`) then `marketing_send_claim` inside `claimAutomationSend` (`:124-160`); send-once index `email_send_log_automation_once` keyed on the address | `email_send_log` (claim row is the log row, `alreadyLogged: true` at `:904`); `customer_offers` when `offer_key` is set (`:834-849`) |
| Post-purchase (`post_purchase`) | first paid product order, `delay_days` later, 14-day grace (`:384-395`) | same | same | consented only (`:388`) | same; keyed on the order id | same |
| Replenishment (`replenishment`) | each paid order while it is still the latest (`:396-407`) | same | same | consented only | same; keyed on the order id | same |
| Win-back 1 and 2 (`winback_30`, `winback_60`) | last paid order older than `delay_days`, no grace (`:439-460`); win-back 2 only after win-back 1 went for the same episode and the ladder spacing elapsed (`:449-455`) | same | same; win-back 2 carries the gift (`winback_60_percent_15`, 70 live tokens in production) | consented only | same; keyed on `address:lastOrderAt` | same |
| Browse abandonment (`browse_abandonment`) | a `product_views` row 4h to 24h old for a consented account holder with no open cart and no purchase since (`:408-434`, `src/lib/email/browse-abandonment.ts:21-25`) | same | `browseAbandonmentTemplate` built from the live catalogue (`:585-610`) | consented account holders only; once per address per 7 days | same | `email_send_log`; `product_views` pruned |
| Restock alert (back in stock) | a stock line returning to positive through `notifyRestockedLine` (`src/lib/inventory-operations.ts:154`, `src/lib/admin-inventory.ts:475`, `src/lib/admin-products.ts:718`) | `notifyBackInStock` (`src/lib/back-in-stock.ts:80-127`, send at `:100`) | `backInStockTemplate` | anyone who asked on the product page (`back_in_stock_requests`); not the consented audience; suppression via the wrapper | wrapper claim; deferred sends are parked (`onDeferred: "queue"`) | `back_in_stock_requests.notified`, `email_send_log`, `marketing_send_queue` |
| Coupon announcement | admin announce action on a coupon (`src/app/api/admin/coupons/[couponId]/announce/route.ts:43`) | `broadcastCouponAnnouncement` (`src/lib/marketing-broadcast.ts:196-289`, send at `:266`) | `couponAnnouncementTemplate` | `getMarketingRecipientEmails` (`:41-131`): account opt-ins union `marketing_subscribers`; suppression via the wrapper | wrapper claim, parked on deferral; per-(coupon, recipient) dedup from `email_send_log` (`:223-248`) | `email_send_log`, `marketing_send_queue` |
| Birthday bonus | the sweep's `birthdayBonus` job (`sweep/route.ts:102`) on the customer's birthday | `runBirthdayBonusSweep` (`src/lib/rewards.ts:545`, send at `:613`) | `membershipBirthdayTemplate` | every account with a stored birthday, whether or not they opted into marketing; suppression via the wrapper only | wrapper claim, parked on deferral; once per year via `birthday_bonus_year` | `points_ledger`, `customer_preferences.birthday_bonus_year`, `email_send_log`, `marketing_send_queue` |
| Campaigns (customer and affiliate) | admin send now or schedule; `runCampaignSweep` picks up scheduled rows (`campaign-sender.ts:828-842`) | `queueCampaign` (`:124`) then `sendCampaignBatch` (`:379`, send at `:636`) in batches of 25 with a 20s budget (`:44-46`) | `campaignTemplate` or `buildAffiliateCampaignEmail` | `resolveAudience` on top of the consented set (`audience.ts:532`); affiliates through `resolveAffiliateAudience` | wrapper claim, or a claim taken before a gift mint (`:463`); a deferred recipient goes back to pending with `deferred_until` | `email_campaign_recipients`, `email_send_log`, `customer_offers` for gifts |
| Marketing queue drain | the lifecycle `marketingQueue` job (`lifecycle/route.ts:69`) | `drainMarketingSendQueue` (`marketing-queue.ts:58-176`, send at `:138`) | already rendered rows | suppression re-checked at delivery (`marketing.ts:420-451`); duplicates closed as already delivered (`marketing-queue.ts:124-136`) | re-claimed through the guard on every drain; up to 8 attempts (`:24`) | `marketing_send_queue`, `email_send_log` |

Production state of these senders on 2026-09-16: `email_automations` enabled
= `post_purchase`, `replenishment`, `welcome_intro`, `welcome_no_purchase`,
`winback_30`, `winback_60`; `browse_abandonment` disabled. Abandoned carts:
10 active + 2 held (all 12 mid-sequence, $2,306.85 in total), 18 recovered,
23 expired, 5 cleared. Recovery stages sent in the last 30 days: t30m 40,
t12h 33, t24h 30, t72h 20. `marketing_send_queue` empty. Resend: 1 segment,
0 broadcasts, 0 hosted templates, so nothing sends from inside Resend itself.

### 1.3 Omnisend today

Nothing. The account has 0 automations, 6 VL templates, 14 VL segments, 2
universal layouts, one draft form created from Omnisend's stock template on
2026-09-16 (not by this work), and no enabled sending. In the repo, every
Omnisend transport call passes `omnisendActive()` (`src/lib/marketing/omnisend/client.ts:72-78`),
which asks the ads environment gate before it reads `OMNISEND_API_KEY`, so a
preview deployment sends nothing. The entry points that reach Omnisend are
the admin sync route (contacts reconcile, catalogue push, snapshot; with dry
run), the consent, cart, checkout and product-view hooks, the order hooks from
the payment webhook, Shippo and the admin order actions, and the four cron
jobs in the sweep route (order backstop, catalogue every 6 h, contacts
reconcile every 24 h, cart offers every tick). All of them return at the gate
until `OMNISEND_API_KEY` is set on production.

---

## 2. Message-ownership table

Three owners. "In-house marketing" means the senders in section 1.2, which
stand down at cutover. The deciding rule is `marketingSendBlockedByOmnisend`
(`src/lib/marketing/omnisend/ownership.ts:44-46`), true when
`OMNISEND_MARKETING_OWNER` is the literal `true`, `1` or `yes`
(`src/lib/marketing/omnisend/config.ts:31-34`).

| Message type | Owner | The switch or rule that decides |
|---|---|---|
| Account confirmation, resend, password reset, email change | Resend-transactional | Always. `sendEmail` only; never consults the switch (`ownership.ts:23-28`) |
| Order receipt, receipt resend | Resend-transactional | Always. Spec §1: Omnisend has no equivalent that respects the store's rules |
| Payment received / rejected (manual pay) | Resend-transactional | Always |
| Shipping update, delivery confirmation | Resend-transactional | Always. Omnisend receives `order fulfilled` for segments only (`order-hooks.ts:201-210`), never to mail |
| Refund confirmation, reimbursement, replacement, cancellation | Resend-transactional | Always. Omnisend receives `order refunded` (full refunds only) and `order canceled` as data |
| Membership mail | none live | Feature removed 2026-09-12; templates unused |
| Affiliate / ambassador mail and affiliate campaigns | Resend-transactional for programme mail; In-house marketing via Resend for affiliate campaigns, permanently | Programme mail always Resend. Affiliate campaigns keep their sender under the switch: the lifecycle job runs `runCampaignSweep({ affiliateOnly: true })` and the admin send route lets `audience_kind = affiliate` through (F-12, fixed 2026-09-16); Omnisend has no affiliate audience |
| Cart recovery t30m / t12h / t24h / t72h | In-house marketing via Resend for carts already started (legacy-only mode) → Omnisend `abandoned-cart` and `abandoned-checkout` flows for every other cart | Under the switch the lifecycle job runs `runAbandonedCartSweep({ legacyOnly: true })`: only carts with a claimed stage continue, one owner per cart. Omnisend triggers on `added product to cart` and `started checkout` sent by `hooks.ts`; a cart with an in-house stage never sends either |
| Cart recovery manual resend (admin) | In-house marketing via Resend, legacy carts only | Under the switch `resendCartRecoveryEmail` refuses a cart with no in-house stage (it is Omnisend's) and still finishes a legacy cart by hand (F-06, fixed 2026-09-16) |
| Welcome pair | In-house marketing via Resend (legacy) → Omnisend `welcome` flow | `lifecycle/route.ts:59-62` stands the automation sweep down. Omnisend triggers on `subscribed to marketing` (`scripts/omnisend/automations.mjs:73`) |
| Post-purchase | In-house (legacy) → Omnisend `post-purchase` | same stand-down; Omnisend triggers on `paid for order` (`automations.mjs:143`) |
| Replenishment | In-house (legacy) → Omnisend `replenishment` | same; `paid for order` plus a 45-day wait |
| Win-back 1 and 2 | In-house (legacy) → Omnisend `win-back` | same; `paid for order` plus 60 days; code minted nightly by the reconcile (`reconcile.ts:425-457`) |
| Browse abandonment | In-house (legacy, disabled in production) → Omnisend `browse-abandonment` | same stand-down; Omnisend triggers on the server-side `viewed product` sent by `hooks.ts` for signed-in viewers, once per address and product per six hours |
| Sunset | Omnisend only | No in-house equivalent; segment-triggered (`automations.mjs:194-201`) |
| Restock alert | In-house marketing via Resend, permanently | Spec §3.1 and `ownership.ts:26-28`: back-in-stock is unsupported for API stores; keeps running under the switch |
| Coupon announcement | In-house marketing via Resend, permanently until the owner moves it | Spec §3.1: the owner may still want the one-off broadcast; keeps running under the switch |
| Birthday bonus email | In-house marketing via Resend, stands down at cutover | Points are still granted; the email is not sent while the switch is set (F-04, fixed 2026-09-16). A birthday flow can be built in Omnisend later |
| Campaigns (customer) | In-house marketing via Resend (legacy) → Omnisend campaigns | `lifecycle/route.ts:64-67` and the 409 at `send/route.ts:41-49` |
| Marketing queue (parked event mail) | In-house marketing via Resend | Keeps draining under the switch by design (`ownership.ts:23-25`); only carries restock, coupon and birthday mail after cutover |
| Transactional retries and both reapers | Resend-transactional | Never consult the switch (`lifecycle/route.ts:72-80`) |
| Omnisend sign-up form, SMS | Omnisend | Form disabled until the owner enables it; SMS starts from zero consent |

---

## 3. Consent and suppression model

### 3.1 Tables and columns

| Store | Meaning | Written by |
|---|---|---|
| `marketing_subscribers (email, source, opted_in_at, unsubscribed_at)` | Guest and at-checkout email consent, keyed by address. 106 active in production (checkout 10, oauth_portal 75, signup 21) | `recordMarketingOptIn` (`src/lib/marketing-broadcast.ts:148-170`) from checkout session creation (`src/app/api/checkout/create-session/route.ts:133`), signup (`src/app/api/auth/signup/route.ts:221`), the OAuth portal (`src/app/api/auth/session/route.ts:173`); after cutover also the reconcile with source `omnisend-form` (`reconcile.ts:276-290`) |
| `customer_preferences.marketing_emails` | Account holder email consent. 117 rows in production | account preferences route (`src/app/api/account/preferences/route.ts:22-27`); mirrored to false by the unsubscribe route, the delivery webhook and the reconcile |
| `customer_preferences.phone, sms_marketing, sms_consent_at, sms_opted_out_at` | SMS consent record added by commit 4f44c17 (`src/lib/sql/customer-sms-consent.sql`). In production every row has `sms_marketing = false`, no phone numbers, `sms_consent_at` never set | `preferences/route.ts:37-58`: stamps `sms_consent_at` on a tick and `sms_opted_out_at` on an untick; after cutover the reconcile stamps `sms_opted_out_at` from an Omnisend SMS unsubscribe (`reconcile.ts:297-323`) |
| `email_suppressions (email, reason, source, created_at)` | The authoritative marketing gate. 3 rows in production (bounced 1, complained 1, unsubscribed 1 via `cart_recovery_t30m`) | see 3.2 |
| `email_send_log` | Every marketing send and every `auth:` send; the frequency guard and the send-once index live here | `marketing.ts:557-578`, `marketing_send_claim` |
| `email_delivery_events` | Every provider webhook event, idempotent on the provider's event id (`src/lib/email/delivery-events.ts:258-330`) | the webhook |
| `email_engagement_events` | Opens and clicks joined back to a send | `src/lib/email/engagement.ts:153` |

Reason vocabulary (`src/lib/email/suppression-reasons.ts:47-50`): customer-
chosen `account_preference`, `unsubscribed`, `soft_bounce_run` may be lifted
by the customer re-ticking the box; provider-imposed `complained`, `bounced`
may not (`preferences/route.ts:87-91`).

### 3.2 How each signal flows today

* Unsubscribe link and Gmail one-click: `GET /api/unsubscribe` renders a
  confirmation and changes nothing (`src/app/api/unsubscribe/route.ts:132-147`);
  `POST` verifies the HMAC token (signed with `UNSUBSCRIBE_SECRET`, falling
  back to the service-role key, `src/lib/email/unsubscribe.ts:10-16`) and
  upserts `email_suppressions {reason: unsubscribed, source: <which send>}`
  then mirrors `marketing_emails = false` onto a matching account
  (`unsubscribe/route.ts:80-120`). It does not touch `sms_marketing` or
  `sms_opted_out_at` (finding F-05).
* Account box unticked: `email_suppressions {reason: account_preference}`
  (`preferences/route.ts:68-71`).
* Bounce and complaint: the Resend webhook at `POST /api/webhooks/email`
  (subscribed in Resend to delivered, bounced, complained, delivery_delayed,
  failed, opened, clicked; created 2026-08-31) requires both the URL secret and
  a valid Svix signature inside a five-minute window (`webhooks/email/route.ts:161-269`),
  records every event to `email_delivery_events` (`delivery-events.ts:441`),
  stamps opens and clicks onto `email_send_log` and `email_engagement_events`
  (`:450-478`), upserts `email_suppressions` with `complained`, `bounced`, or
  `soft_bounce_run` after three consecutive soft bounces with no delivery
  between (`:489-517`), mirrors `marketing_emails = false` (`:552-557`) and
  raises a system alert on first sighting (`:585-598`). `failed` and
  `delayed` suppress nothing (`:492-495`).
* STOP: there is no inbound SMS route in the app (`src/app/api/webhooks`
  holds `email`, `payment`, `shippo` only) and nothing sends SMS today, so
  STOP has no path.

### 3.3 After cutover

* Store → Omnisend (push): `collectContactFacts` (`contacts.ts:263`) reads
  the suppression list first. If that read fails the address has NO facts:
  `readSuppression` answers `known: false` (`contacts.ts:111-125`), the
  loader returns `null`, and every caller skips the address. Nothing is
  pushed on a guess, because a guessed `unsubscribed` would be mirrored back
  into the store by the next write-back; fail closed means do not push. With
  the list readable the email channel is derived in this precedence:
  suppressed → `unsubscribed` with the suppression's `created_at`; guest row
  active or `marketing_emails` → `subscribed` with the store's own timestamp
  and source; guest `unsubscribed_at` → `unsubscribed`; otherwise
  `nonSubscribed`, which sends no email channel block at all
  (`contact-payload.ts:178-185`, so Omnisend's own record is never
  overwritten with "unknown"). SMS is `subscribed` only when `sms_marketing`
  is true AND a phone number is stored, with `sms_consent_at` as the consent
  time; `sms_opted_out_at` → `unsubscribed`; anything else sends no phone
  identifier at all (`contacts.ts:234-238`, `contact-payload.ts:206`). A
  checkout phone number is never SMS consent: the loader reads only
  `customer_preferences.phone`. `sendWelcomeMessage: false` disables
  Omnisend's own stock welcome message, not the welcome automation
  (`contact-payload.ts:198`).
* Omnisend → store (write-back), nightly by the reconcile: `planWriteBack`
  (`reconcile-plan.ts:57-90`) turns an Omnisend `unsubscribed` into
  `email_suppressions {reason: unsubscribed, source: omnisend}` plus the
  account mirror (`reconcile.ts:243-273`), an SMS `unsubscribed` into
  `sms_opted_out_at` on the matching account only (`reconcile.ts:297-323`),
  and a `subscribed` address absent from both consent stores and not
  suppressed into `marketing_subscribers {source: omnisend-form}`. It never
  re-opens a suppression (`reconcile-plan.ts:61`). Every stamp it writes is
  dated with Omnisend's `statusChangedAt` (when the person actually
  unsubscribed), never with the run's own time. The write-back is skipped
  entirely if the suppression list cannot be read in full
  (`reconcile.ts:474-475`), the push is skipped if the consented audience
  cannot be read in full (`reconcile.ts:904`), and the watermark is held if
  any page or write failed (`reconcile.ts:539-540`).
* Bounces and complaints inside Omnisend stay in Omnisend (its own
  suppression); the store learns of them only as an `unsubscribed` status on
  the next reconcile, and only if Omnisend reports them that way.

---

## 4. Scheduled jobs and queues

Schedules (`vercel.json`): `/api/cron/sweep` every 30 minutes,
`/api/cron/lifecycle` at minutes 5, 20, 35 and 50. Both share
`handleCronRequest` (`src/lib/cron-runner.ts`): constant-time `CRON_SECRET`
check, one retry on a transient auth or gateway failure, a 50-second watchdog
inside the 60-second function budget, alerts de-duplicated for two hours.

### 4.1 Lifecycle (`src/app/api/cron/lifecycle/route.ts:52-81`)

| Job | Under `OMNISEND_MARKETING_OWNER=true` | Why |
|---|---|---|
| `cartRecovery` (runs first) | legacy-only: `runAbandonedCartSweep({ legacyOnly: true })`, reported with `mode: "legacy"` and the reason | carts the ladder already started finish in-house; every other cart is Omnisend's, so the two never race on one cart |
| `emailAutomations` | stands down (`:61`) | replaced by the Omnisend flows |
| `emailCampaigns` | affiliate-only: `runCampaignSweep({ affiliateOnly: true })`; admin send route answers 409 for customer campaigns and lets affiliate ones through | customer campaigns are replaced by Omnisend campaigns; affiliate broadcasts have no Omnisend audience |
| `marketingQueue` | keeps running (`:69`) | parked restock, coupon and birthday mail is not something Omnisend replaces (`ownership.ts:23-28`) |
| `emailRetry` | keeps running | transactional |
| `orderEmailReaper` | keeps running | transactional slot hygiene |
| `marketingSendReaper` | keeps running | releases stranded automation slots so the in-house engine is healthy if the switch is ever unset |

### 4.2 Sweep (`src/app/api/cron/sweep/route.ts:57-161`)

Two jobs here consult the switch: `birthdayBonus` (grants the points and
stands the email down while Omnisend owns marketing) and `omnisendCartOffers`
(runs only while Omnisend owns marketing). The restock notifications are
reached through inventory writes rather than a cron job. Everything else is
payments, fulfilment, inventory, commissions, ad spend and hygiene.
`couponHygiene` retires expired coupons, which includes the per-contact codes
minted for Omnisend once they age out.

Four Omnisend jobs are registered in this route: `omnisendOrderBackstop`
(paid product orders since a recorded floor, at most 7 days back, with no
delivered `paid for order` row, 50 a run), `omnisendCatalogSync` (every 6 h),
`omnisendContactsReconcile` (every 24 h) and `omnisendCartOffers` (every
tick; mints the band code and gift for Omnisend-owned carts 36 to 96 hours
after their last activity), each asking `omnisendActive()` before any read.

### 4.3 Queues

| Queue | Drained by | Notes |
|---|---|---|
| `pending_emails` | `retryPendingEmails` (lifecycle) and the admin manual retry | transactional; 5 attempts with backoff |
| `marketing_send_queue` | `drainMarketingSendQueue` (lifecycle) | marketing; 8 attempts; empty in production today |
| `email_campaign_recipients` | `sendCampaignBatch` (lifecycle) | stands down with the campaign job; a campaign mid-send at cutover stops where it is and resumes only if the switch is unset |
| `omnisend_events_sent` | the order backstop | exactly-once ledger, `(entity_id, event_name)` primary key (`src/lib/sql/omnisend-sync.sql:14-23`); claim is an insert, fails open on any error but a duplicate key (`ledger.ts:34-45`) |
| `omnisend_sync_state` | reconcile watermark and cadence stamps | `sql:31-35` |

---

## 5. Findings

Severity: P1 blocks or corrupts the cutover; P2 sends the wrong thing or
loses a message; P3 hygiene.

**F-01 (P1) Enabling the Omnisend welcome flow before the contact import
would mail every imported subscriber.** The welcome automation triggers on
`subscribed to marketing` (`scripts/omnisend/automations.mjs:73`), which
fires when a contact's email channel becomes `subscribed`, including a
contact created through the API by the reconcile push (`reconcile.ts:512-516`).
`sendWelcomeMessage: false` (`contact-payload.ts:137`) only suppresses
Omnisend's stock welcome message. The frequency limiter `once`
(`automations.mjs:82`) caps it at one entry per contact, not zero. The
rollout order in spec §11 therefore has to be: import contacts (dry run, then
live), verify statuses in Omnisend, and only then enable flows. Enabling
first sends a three-email welcome sequence with a welcome code to 106
addresses who subscribed as long ago as the store has existed. A related
edge: an address the reconcile flips from `unsubscribed` to `subscribed`
later (a customer re-ticking the box) will enter the flow then, which is
correct behaviour but should be understood.

**F-02 (P1, fixed 2026-09-16) The seven-day order backstop would have pushed
a backlog of `paid for order` events the moment the key was set.** The
backstop now records a floor (`omnisend_sync_state` key `order_backstop`,
`since`) the first time it runs with the integration live and never reports
an order paid before it, so old orders cannot enter post-purchase,
replenishment or win-back, and the in-house `post_purchase` that may already
have mailed them is not doubled. The webhook hooks report only orders paid
after the key is live. No drain step is needed in the launch order.

**F-03 (P1) On this branch, cutover ends every in-house sequence
mid-flight, and the exact consequence per sequence is:**

* Welcome pair: a subscriber who received `welcome_intro` (day 1) but not
  `welcome_no_purchase` (day 3, the offer) gets nothing further from the
  store, and Omnisend's welcome only fires on a status change, so an
  existing subscriber never enters it (F-01). Net: no first-order offer ever
  reaches anyone who subscribed in the last `delay_days + 14` days before
  cutover.
* Win-back ladder: a customer sent `winback_30` (the light message) never
  receives `winback_60` (the gift). Omnisend's win-back is entered only by a
  `paid for order` event (`automations.mjs:171`), which exists only for
  orders paid after the key was set. Every buyer already lapsed at cutover is
  outside both systems. The nightly reconcile still mints a win-back code for
  each of them (`reconcile.ts:425-457`) and pushes it as `vl_winback_code`,
  so codes accumulate on contacts no flow will ever show them to. Remedy: a
  segment-triggered win-back on `Lapsed 60`, or one campaign to that segment
  after the first reconcile.
* Post-purchase and replenishment: orders paid before cutover whose
  `delay_days` has not elapsed get neither the in-house message nor an
  Omnisend one (unless inside the 7-day backstop window, see F-02).
* Cart recovery: the 12 open carts ($2,306.85) stop at whatever stage they
  reached, and the stage windows (`cart-recovery.ts:814-818`) close, so the
  t72h message with the code is lost for any cart past 96 hours by the time
  the switch is unset. Fixed on this branch: the lifecycle job runs the
  ladder in `legacyOnly` mode under the switch, so a cart with a claimed
  stage finishes its remaining stages in-house and only carts with none are
  Omnisend's. The 412 live recovery gift tokens and their claims stay in
  `customer_offers` and expire on their own.
* Campaigns: a campaign with rows still `pending` at cutover stops and
  reports nothing; the admin sees the 409 only on a new send.

**F-04 (P2) In-house marketing senders that do not consult
`marketingSendBlockedByOmnisend`.** Only three call sites do
(`lifecycle/route.ts:56,61,66`, `send/route.ts:41`, plus the admin banner at
`automations/route.ts:35`). The following still mail under the switch:

* birthday bonus, `src/lib/rewards.ts:613` from the sweep (`sweep/route.ts:102`);
  a marketing email with a points offer to every account with a birthday on
  file, consented or not, gated only by suppression;
* restock alerts, `src/lib/back-in-stock.ts:100` (documented as intended);
* coupon announcement, `src/lib/marketing-broadcast.ts:266` (documented as
  intended);
* admin manual cart-recovery resend, `src/lib/admin-cart-recovery.ts:759-846`
  (F-06);
* the marketing queue drain, `marketing-queue.ts:138` (intended).

Because the in-house frequency guard cannot see Omnisend sends
(`ownership.ts:6-13`), each of these can land on the same day as an Omnisend
flow email. Fixed 2026-09-16 for the two that were not deliberate: the
birthday sweep still grants the points and stands the email down under the
switch, and the admin resend refuses an Omnisend-owned cart (F-06). Restock
alerts, the coupon announcement and the queue drain keep running by design.

**F-05 (P2) The site's unsubscribe route does not stop SMS.**
`unsubscribe/route.ts:80-120` writes `email_suppressions` and
`marketing_emails = false` only. An account that has both email and SMS
consent and clicks the email footer link would keep SMS consent, and the next
contact push would tell Omnisend `email: unsubscribed, sms: subscribed`,
which is a correct copy of the store's record but probably not what the
customer meant. Today it is moot (0 SMS consents). Before SMS is enabled,
decide whether the email opt-out page should offer, or imply, an SMS opt-out,
and make the account-settings copy say the two are separate. STOP itself is
handled by Omnisend after cutover and written back nightly; there is no
in-app STOP path (`src/app/api/webhooks` has no SMS route), so a customer who
texts STOP is stopped by Omnisend immediately but the store's record lags up
to 24 hours, and a phone-only contact with no account is never stamped
(`reconcile.ts:299-300`, `reconcile-plan.ts:64-66`).

**F-06 (P2, fixed 2026-09-16) Admin manual cart-recovery resend bypassed
ownership.** `resendCartRecoveryEmail` now refuses, before minting or
sending, any cart that has no in-house stage while Omnisend owns marketing
(`omnisendOwned: true` in its result), and still finishes a legacy cart by
hand exactly as the sweep does.

**F-07 (P2) DMARC is `p=none` with no reporting address.** The root DMARC
record enforces nothing. With two ESPs about to sign for the same
organisational domain (Resend today, Omnisend after the sender domain is
verified) and no `rua=`, there is no visibility of who else is sending as the
domain and no protection against it. Recommended in `OPERATIONS.md` §1: add
`rua=` first, then `p=quarantine; pct=10` after two clean weeks. No Omnisend
DKIM selector exists on any common name today, so until the sender domain is
registered Omnisend mail would be signed by a shared Omnisend domain and fail
DMARC alignment for the brand domain.

**F-08 (P3) A Resend bounce recorded before the webhook existed is invisible
to the store.** Resend holds 2 bounce-origin suppressions; one predates the
webhook (created 2026-08-31), and neither address is in
`email_suppressions`, `marketing_subscribers` or an opted-in account. Resend
itself refuses to send to them, so nothing is mailed today, but the store's
record is incomplete: if either address ever opts in, the store would tell
Omnisend `subscribed`, and Omnisend, which has never seen the bounce, would
mail it. Remedy: import Resend's suppression list once into
`email_suppressions` with `reason: bounced` and a source naming the import.

**F-09 (P2) Omnisend has no cross-flow quiet period.** The in-house rule is
one marketing email per address per 24 hours whoever sends
(`frequency.ts:14-24`). Omnisend's `frequencyLimiter` is per flow
(`automations.mjs:82,103,124,...`). A contact can receive abandoned-cart E1,
welcome E1 and a campaign on the same day. Omnisend account-level frequency
settings, if the plan offers them, need to be set by the owner; otherwise
this is an accepted regression and should be stated as one.

**F-10 (P2) Cart recovery moves from "any checkout email" to "subscribed
only".** Today a guest who types an address at checkout and abandons receives
up to four recovery emails with no opt-in (`cart/track/route.ts:84-100`,
`cart-recovery.ts:1907`). Omnisend's flows send only to `subscribed`
contacts (`automations.mjs:66`), and a non-subscribed cart owner is pushed
as `nonSubscribed` (`contacts.ts:214`). Recovery volume will fall to the
consented share of carts, which is unknown (open question Q-7). This is the
consent-correct direction, and the revenue effect should be measured against
the 30-day baseline (18 recovered).

**F-11 (P2) Partial refunds send no Omnisend event.** `onOrderRefunded` is
wired (payment webhook and admin refund action) only for a full refund; the in-house refund email goes
for every refund (`payment-webhook.ts:3556`). Omnisend segments that use
lifetime value will overstate a partially refunded customer. Low volume;
document or send `order refunded` with `refundedLineItems`.

**F-12 (P2, fixed 2026-09-16) Affiliate campaigns would have lost their
sender at cutover.** `audience_kind = affiliate` is now exempt from the
switch: the campaign sweep runs affiliate-only under it and the admin send
route lets an affiliate campaign through. Omnisend has no affiliate audience,
tags or merge fields, so this is permanent.

**F-13 (P3) The reconcile watermark cannot narrow the write-back.** Each
nightly push re-posts every contact (`reconcile.ts:494-523`), which updates
their `updatedAt` in Omnisend, so the next night's `updatedAtFrom` page
(`reconcile.ts:179-198`) returns the whole list again. Correctness is
unaffected; cost is audience/250 requests a night, capped at 40 pages
(10,000 contacts). Fine at 200 contacts; worth a note for later.

**F-14 (P3, closed 2026-09-16) The Omnisend click route carried the
recipient's address in the query string.** The v2 link token seals the
address inside the token with AES-256-GCM under a key derived from
`UNSUBSCRIBE_SECRET`; the route reads only `t`, `to` and the utm labels, and
the attestation handoff that follows an unattested click seals its payload
the same way. No address travels in any URL.

**F-15 (P3) `omnisend_events_sent` fails open on ledger errors**
(`ledger.ts:39-44`): an unreachable ledger sends the event anyway, relying
on Omnisend's own historical de-duplication by event id. Correct trade for
order events; cart events are debounced by the same ledger and would lose the
debounce during a ledger outage, and the cart-offer plan claim (a mint, not an
event) is being changed to fail closed for that reason.

**F-16 (P3) Data gaps that the contact push will surface as blanks.**
Production has no phone numbers on any preferences row, so SMS starts at
zero. `orders.country` holds either a code or a name (`contacts.ts:235-243`)
and anything unrecognised falls back to US. The CAN-SPAM postal address was
measured blank on 2026-09-15 (spec §2); while it is blank every in-house
marketing sender holds (`settings.ts:256-258`), and the Omnisend footer
layout needs it typed in by hand (Q-3).

**F-17 (P3) The reconcile's SMS opt-out set is always empty**
(`reconcile.ts:339-343`), so every previously opted-out contact is planned
again each run and rejected by the row read (`reconcile.ts:310`). Harmless,
one read per SMS opt-out per night.

**F-18 (P3) The Resend delivery events `failed` and `delayed` suppress
nothing** (`delivery-events.ts:492-495`) and the soft-bounce escalation
counts three in a row. A cold Omnisend sender domain could produce deferrals
that Omnisend records and the store never sees; the two suppression lists
will diverge and only the reconcile's `unsubscribed` status crosses over.

---

## 6. Feature flags and rollback

Names confirmed in `.env.example:223-245` and
`src/lib/marketing/omnisend/config.ts`:

| Flag | Where read | Effect | Default |
|---|---|---|---|
| `OMNISEND_API_KEY` | `config.ts:17-21` (configured), `client.ts:94-95` (the only read on a send path, after the environment gate at `client.ts:90-93`) | With it unset, `omnisendActive()` is false, every hook returns before any database read, the reconcile and catalogue sync report `skipped`, and the click route still works (the token is signed with the unsubscribe secret, not the key) | unset; production only |
| `OMNISEND_MARKETING_OWNER` | `config.ts:31-34` via `ownership.ts:44-46` | `true`, `1` or `yes`: cart recovery runs legacy-only (carts already started finish, no new ones), automations stand down, customer campaigns stand down and the admin send route answers 409 for them, affiliate campaigns keep sending, the birthday email stands down (points still granted), the admin cart resend refuses Omnisend-owned carts, and the cart-offer sweep runs; anything else, including a typo, means the in-house engine keeps sending, the direction that cannot double-mail | unset |
| `NEXT_PUBLIC_OMNISEND_BRAND_ID` | `src/components/omnisend-snippet.tsx` | Overrides the built-in brand id for the page-view script on a staging deployment; not a secret and not part of the server sync | unset (built-in id) |
| `UNSUBSCRIBE_SECRET` (fallback: the service-role key) | `link-token.ts:75-81`, `unsubscribe.ts:10-16`, `src/lib/email/link-grant.ts:99` | Signs the Omnisend link token, the unsubscribe token and the in-house browse grants; rotating it invalidates every `vl_link` on every contact until the next reconcile refreshes them (30-day tokens, `link-token.ts:61`) | falls back |
| `EMAIL_WEBHOOK_SECRET`, `RESEND_WEBHOOK_SIGNING_SECRET` | `webhooks/email/route.ts:162,242` | Both required or the webhook answers 503 and Resend redelivers | must be set |
| Ads environment gate | `src/lib/ads/ads-environment.ts` via `client.ts:90` | Preview, test and CI never reach Omnisend regardless of the key | deny by default |

Rollback, in order of severity (`OPERATIONS.md` §5 has the operator steps):

1. Stop Omnisend marketing: disable each automation in Omnisend and pause
   campaigns. Contacts, events and the catalogue keep syncing.
2. Return marketing to the in-house engine: unset `OMNISEND_MARKETING_OWNER`.
   The next lifecycle tick (at most 15 minutes) resumes all three jobs. Carts
   Omnisend mailed cannot be told apart from carts it did not, so the
   in-house ladder may start a cart Omnisend already mailed at stage one if
   it is still inside the windows; wait 96 hours after disabling the Omnisend
   cart flows before unsetting the switch if that matters.
3. Stop all Omnisend traffic: remove `OMNISEND_API_KEY`. Every gate closes,
   the ledger stops filling, the cron jobs report `skipped`.
4. Nothing to restore in consent: every write-back only narrows consent, and
   suppressions written with `source: omnisend` stay in force, which is the
   correct direction after a rollback.

Do not delete Omnisend contacts, the in-house engine, the Resend domains or
the Resend webhook as part of any rollback.

---

## 7. Open questions for the owner

* **Q-1 Sender domain records.** Which address and subdomain should Omnisend
  send from, and may the CNAME and TXT records Omnisend displays be added?
  Recommendation in `OPERATIONS.md` §1 is a dedicated subdomain distinct from
  the root and from Resend's `send.` and `mail.` subdomains. Nothing existing
  is removed. Should `rua=` be added to DMARC now, and is `p=quarantine`
  acceptable after two clean weeks?
* **Q-2 SMS approval.** SMS starts from zero consent and needs a verified
  sender, quiet hours and the Pro plan the owner intends to move to. Which
  flows may carry a text (spec §3.6 proposes abandoned checkout, abandoned
  cart, win-back and welcome), and should the email unsubscribe page also
  offer SMS opt-out (F-05)?
* **Q-3 Postal address.** The CAN-SPAM postal address was blank in production
  settings on 2026-09-15. It is required by every in-house marketing sender
  and by the Omnisend footer layout. Please supply it, or confirm it has been
  set since.
* **Q-4 Plan tier.** The current plan lacks conditional content (HTTP 402 on
  the attempt), so the code sections in templates cannot be hidden when a
  contact has no live code; the `vl_*_ready` flags
  (`contact-payload.ts:179-181`) are built for the filter once the plan has
  it. Discount blocks cannot mint codes for API stores and the back-in-stock
  trigger is unsupported, so restock alerts stay in-house. Confirm the plan
  change before flows that show a code are enabled.
* **Q-5 Discount amounts.** *Welcome resolved 2026-09-16: 15 percent off a
  first order, alone for now; a free GHK-Cu half is built and dormant (the
  addendum spec of that date).* Defaults in `codes.ts`: welcome 15 percent
  for 14 days, win-back 15 percent for 14 days, recovery 10 percent for 5 days
  (the spec table says 72 hours; the code says 5 days, choose one). The
  in-house ladder uses banded percentages and a product gift rather than a
  code at t24h; confirm whether the Omnisend flows should mirror the bands or
  use the flat defaults.
* **Q-6 Birthday and affiliate mail.** Should the birthday email move to an
  Omnisend date-triggered flow or stand down with the switch (F-04)? Should
  affiliate campaigns be exempt from the switch (F-12)?
* **Q-7 Cart-recovery audience.** Recovery will shrink to subscribed contacts
  (F-10). Is that acceptable, or should the checkout collect an explicit
  marketing tick so more cart owners are `subscribed` in Omnisend?
* **Q-8 Rollout order.** Confirm the sequence import → verify → drain the
  order backstop → enable flows one at a time (F-01, F-02), and that the
  welcome flow will not be enabled until the contact statuses have been
  checked in Omnisend.
* **Q-9 The stray form.** A draft form was created in Omnisend from the stock
  template on 2026-09-16 outside this work. Should it be deleted so only the
  built form (`scripts/omnisend/form.mjs`) exists, or is it the owner's own
  draft?
