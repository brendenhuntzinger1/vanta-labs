# Omnisend transition — state, evidence, and what turns it on

**Audited 2026-09-17.** Production serving `ce33a485`
(`dpl_6RMCKkmPZJrp7hMvjsmM4itZDbLn`, READY 18:08 UTC). Omnisend brand
`6aa09072ca3afa5724d4d71a` (Vantalabsresearch, USD, America/Chicago). API
version `2026-03-15`.

**Verdict: NO-GO today, on two owner actions and nothing else.** Both are
outside the codebase — DNS records only Omnisend's own settings screen can give
you, and a postal address only you can supply. Every engineering item is done,
deployed and evidenced below. SMS is excluded from this launch entirely, stays
disabled, and delays nothing.

Every claim here is a live API response, a production database query, or a DNS
lookup made during the audit. Where something is untested, it says so.

---

## A. What is true right now

| | |
|---|---|
| Contacts in Omnisend | **123** — 120 subscribed, 1 unsubscribed, 2 never-consented buyers |
| Reconciles against the store | **exactly**, with both differences explained — §3 |
| Products in Omnisend | 34 slugs + variants, correct IDs, prices and URLs |
| Order history in Omnisend | 17 paid product orders, $2,227.21, 13 customers |
| Automations built | **9 of 9**, all `isEnabled: false` |
| Automations that can actually fire today | **7 of 9** — §6 |
| Automations verified by a real send | **none** — §7 |
| Live consent sync | **working** — opt-in → Omnisend contact in **2 seconds** |
| Live event sync | **working** — 2/2 events delivered within seconds |
| Scheduled sync (cron) | **working** — first tick 18:30 UTC stamped 6 watermarks and repaired every contact |
| Sending-domain authentication | **absent** — **B1** |
| Footer business details | **placeholder** — **B2** |
| In-house Resend flows | **6 of 7 still enabled and sending** |

---

## B. The two blockers

### B1 — Omnisend has no authentication records on `vantalabsresearch.com`

Checked by DNS-over-HTTPS against `dns.google` on 2026-09-17:

```
vantalabsresearch.com            TXT    v=spf1 include:_spf.google.com include:mailgun.org ~all
_dmarc.vantalabsresearch.com     TXT    v=DMARC1; p=none;
resend._domainkey…               TXT    present  (Resend)
google._domainkey…               TXT    present  (Google Workspace)
vantalabsresearch.com            MX     1 smtp.google.com.
om1._domainkey…                  CNAME  NXDOMAIN
om2._domainkey…                  CNAME  NXDOMAIN
omnisend._domainkey / _omnisend  TXT    NXDOMAIN
```

Also probed and absent: `omsend1`, `omsend2`, `s1`, `s2`, `k1`, `dkim`, `om`,
`o1` `._domainkey`, and the hosts `omnisend`, `email`, `mail`.

**Consequence.** Mail Omnisend sends as `support@vantalabsresearch.com` will be
DKIM-signed and SPF-authorised by *Omnisend's* domain, not ours, so it will not
be DMARC-aligned with `vantalabsresearch.com`. DMARC is `p=none`, so nothing is
rejected on that basis today — but this is unauthenticated mail from the domain
that also carries every receipt and every password reset.

**This contradicts `LAUNCH.md`, which claimed "Sender domain | verified
2026-09-16".** That line was wrong.

**Only you can clear it.** Omnisend's Public API exposes no sender-domain or DNS
operation — the entire operation catalogue was searched, and
`get_brands_current` returns only name, currency, timezone and website. The
CNAME targets are per-account and live in **Omnisend → Settings → Sender
domains**. Copy them from there. Do not guess them, and do not touch the
existing `resend._domainkey` or `google._domainkey` records, which carry the
transactional mail and the mailbox itself.

**Verification is not a promise about placement.** It removes one specific,
measurable failure. It does not guarantee the inbox, and it says nothing about
opens.

*Same record, smaller point:* the apex SPF still carries
`include:mailgun.org`. Nothing in this codebase sends through Mailgun. It is a
stale authorisation and should go — but it is an edit to a live record that also
authorises Google Workspace, so it is yours to make deliberately, not something
to slip in during a migration.

### B2 — The footer still says where the postal address should be

Universal layout `6aa985f7c29076c61d3838b1` ("VL Footer"), block
`1818a05ce0909017c20c781c`, renders literally:

> `[[account.name]] · POSTAL ADDRESS — owner to replace before the first send`

All nine automations end with this layout. A commercial email without a physical
postal address is a CAN-SPAM violation, and this one announces itself. The
unsubscribe link beside it (`[[unsubscribe_link]]`) is correct and present.

Give me the mailing address and I will replace the block, or do it in the
Omnisend editor — it is one text block.

---

## C. Resolved during this audit

Two things were genuinely broken when the audit started and are now fixed and
verified. Both were fixed by the **scheduled** sync, which is why §4 matters.

### C1 — 121 contacts had no `vl_link`, so every link in every template was dead

Every CTA, footer link and offer button in all nine automations is built as
`…/api/email/omnisend-link?t=[[contact.custom_properties.vl_link]]&to=…`. The
121 bulk-pushed contacts carried only `vl_attested`, `vl_orders`,
`vl_total_spent` and the order dates — **no `vl_link`, no `vl_link_ends`, and
none of the offer-readiness flags**. Emails to them would have carried an empty
token in every link, and the `VL · Welcome offer` flow — which triggers on
entering a segment defined by `vl_welcome_ready = yes` — could never have fired.

**Fixed by the 18:30 cron tick.** `zpeezani@gmail.com`, bulk-pushed at 16:36,
read back at 18:32:

```json
"vl_link": "v2.QUxAizF4Dzue_ECGM4xfUbMz5mXhaWW4Y_8zwsOx7tlT…",
"vl_link_ends": "2026-10-17",
"vl_welcome_ready": "no",  "vl_welcome_gift_ready": "no",
"vl_winback_ready": "no",  "vl_recovery_ready": "no",
"vl_recovery_gift_ready": "no", "vl_recovery_percent": 0
"firstName": "Zarkhan", "lastName": "Peezani"
"updatedAt": "2026-09-17T18:31:17.954Z"
```

### C2 — One live subscriber was stranded as `nonSubscribed`

`samanthastilesco@gmail.com` consented at **18:10:10.592 UTC**
(`marketing_subscribers`, source `signup`). Her Omnisend contact was created 49
seconds later **by the product-view event**, as `nonSubscribed` with empty
`consents`, empty `optIns` and null `customProperties`. Her opt-in push did not
land; the event path's did.

**Repaired by the same 18:30 tick**, read back at 18:32:

```json
"status": "subscribed",
"statusChangedAt": "2026-09-17T18:31:16.439Z",
"consents": [{"channel":"email","createdAt":"2026-09-17T18:10:10.592Z","source":"api:signup"}]
```

Her original consent moment survived on the consent record, to the millisecond.
The channel's `statusChangedAt` is the repair time, which is the only date
Omnisend will accept for a status it is changing now.

**The structural point survives the fix, and it is in §4.** The repair worked
because `omnisend_sync_state` was empty, so the first tick treated the push as
never-run and did it immediately. From here the full push is on a 24-hour
cadence, so the *next* missed consent push waits up to 24 hours. That is a real
gap in "durable delivery" and it is listed in §10 as work, not as done.

I could not root-cause the original miss. Vercel's runtime logs returned **one
log line in forty minutes** across the entire production project, so the absence
of an error there is evidence of nothing. Eleven minutes after the miss the
identical path worked perfectly for another customer (§4), so it is not a broken
code path — it is a single push that failed with no short retry behind it. I am
not going to guess at a cause and call it fixed.

---

## D. The sections of the brief

### §1 — Inventory and migration matrix

**Everything that can put a message in front of a customer.**

| Flow | Sender today | Trigger today | Replacement | Data it depends on | Final sender |
|---|---|---|---|---|---|
| Welcome · introduction (`welcome_intro`, +1d) | Resend, **enabled** | consent, no order | `VL · Welcome` | contact + consent | **Omnisend** |
| Welcome · first-order offer (`welcome_no_purchase`, +3d) | Resend, **enabled** | consent, no order | `VL · Welcome offer` | `vl_welcome_ready`, `vl_welcome_code` | **Omnisend** |
| First-order follow-up (`post_purchase`, +14d) | Resend, **enabled** | first paid order | `VL · Post-purchase` | `paid for order` event | **Omnisend** |
| Reorder reminder (`replenishment`, +30d) | Resend, **enabled** | each paid order | `VL · Replenishment` | `paid for order` event | **Omnisend** |
| Win-back 1 (`winback_30`, +40d) | Resend, **enabled** | last order age | `VL · Win-back` | `vl_last_order_at`, `vl_winback_ready` | **Omnisend** |
| Win-back 2 (`winback_60`, +50d) | Resend, **enabled** | last order age | `VL · Win-back` stage 2 | same | **Omnisend** |
| Browse follow-up (`browse_abandonment`) | Resend, **disabled** | product view | `VL · Browse abandonment` | `viewed product` event | **Omnisend** |
| Cart-recovery ladder | Resend | cart tracked | `VL · Abandoned cart` | `added product to cart`, `vl_recovery_*` | **Omnisend** |
| Checkout recovery | Resend | checkout started | `VL · Abandoned checkout` | `started checkout` event | **Omnisend** |
| List hygiene / sunset | none | — | `VL · Sunset` | Omnisend engagement events | **Omnisend** |
| Admin campaign broadcasts | Resend | manual | Omnisend campaigns | `VL · Campaign audience` | **Omnisend** |
| Order confirmation, payment, shipping, refund | Resend | order lifecycle | **none** | — | **stays Resend** |
| Account confirmation, password reset, email change | Resend | auth | **none** | — | **stays Resend** |
| Contact form, wholesale enquiry, partner portal | Resend | form | **none** | — | **stays Resend** |
| Back-in-stock alerts | Resend | inventory | **none** | — | **stays Resend** |
| Monitoring and operator alerts | Resend | system | **none** | — | **stays Resend** |

**What deliberately stays outside Omnisend, and why.** Everything transactional.
Omnisend is a marketing platform; a receipt or a password reset routed through it
inherits marketing suppression semantics — an unsubscribe would stop a password
reset — and adds a third-party dependency to the one class of mail that must
never fail. Back-in-stock stays because Omnisend cannot do it for an API-only
store. The one-off admin broadcast stays available because you may still want it.

**The switch.** `OMNISEND_MARKETING_OWNER` is a single server setting read in one
place (`marketing/omnisend/config.ts`). When true,
`marketingSendBlockedByOmnisend()` stands down every in-house marketing sender —
the lifecycle cron jobs and the admin campaign endpoint — with one logged reason,
`marketing owned by omnisend`. Transactional mail, its retries, the reapers and
the held-back event queue never consult it. **Currently unset.**

### §2 — The integration, deployed

Merged as `ce33a485` (PR #200) and live. Four defects were found by pushing real
data at the live API. Each had been green in tests, because the tests asserted
the builder's *output* rather than the API's *rule*:

1. **A `nonSubscribed` contact was refused.** Omnisend's email identifier
   requires a `channels.email` block even when the status is `nonSubscribed`.
   1 of 41 refused. Fixed; the block is always present now, dated
   `1970-01-01T00:00:00.000Z` so it can never re-date a newer opt-out backwards.
2. **Variant IDs contained `#`.** Omnisend's variant-ID charset is
   `[A-Za-z0-9_-]`. All 34 products refused, every run. Fixed with
   `omnisendVariantId()` and a `__` separator — verified live as
   `thymosin-alpha-1__caa9d502-677d-44f1-a498-b36712ad2694`.
3. **`eventID` was not a UUID**, so **every** event of every kind was refused:
   views, carts, checkouts, orders. Fixed with a deterministic UUIDv5
   (`omnisendEventId`), pinned by a test and cross-checked independently against
   Python's `uuid.uuid5` with the same namespace.
4. **Order lines matched 0 of 101 rows.** `order_items.product_id` is
   `<slug>::<doseId>` (93 rows) or a bare slug (8 rows) — never a product UUID.
   Fixed with exported pure parsers and a dose-ID fallback for renamed products.

Verified against the documentation for `2026-03-15`, the version the client
actually pins. No API-version migration was attempted.

**The unresolved historical order line:** `VL-49CA32C1` ($1.00, membership)
carries no customer email. It cannot be attributed to a contact and is correctly
absent from Omnisend. It is accounted for in §3.

### §3 — Reconciliation against Omnisend's actual records

Not against what the API returned at push time — against what is in the account
now, read back and diffed.

**Contacts.** The store's audience (consented subscribers ∪ account opt-ins ∪
paid product buyers) was listed in SQL and diffed against all 122 contacts read
from Omnisend at 18:22 (123 by 18:32, the difference being the live signup below):

- **in the store, not in Omnisend:** `joelcadyy@gmail.com` — he opted in 90
  seconds before the diff ran, and was present on re-check. Not a gap.
- **in Omnisend, not in the store's audience:** `parguello352@gmail.com` — she is
  on the suppression list, and the reconciler deliberately pushes suppressed
  addresses so Omnisend mirrors the opt-out. Correct.
- **everything else identical.**

**Suppressions.** 3 rows in `email_suppressions`; 1 unsubscribed contact in
Omnisend. The other two are `bounced@resend.dev` and `complained@resend.dev` —
provider sink addresses that `isNonMailableAddress` drops before any push. Fully
explained.

**Consent was not assumed.** The two buyers who never consented —
`abry.jacobi@gmail.com` and `ibarradamian16@gmail.com` — were pushed as
**`nonSubscribed`** with empty `consents` and `optIns`, and they are still
`nonSubscribed` after every push and repair in this audit. **No historical buyer
was marked a marketing subscriber.**

**Original timestamps are preserved where Omnisend allows it.**
`zpeezani@gmail.com` opted in at `2026-09-09 18:40:02.252+00`, source
`oauth_portal`; Omnisend holds
`{"channel":"email","createdAt":"2026-09-09T18:40:02Z","source":"api:oauth_portal"}`.
On the live path the channel date is preserved too — joelcady's
`statusChangedAt` is `2026-09-17T18:21:04.8Z`, his own consent moment to the
millisecond, not the write time.

**The one place it is not preserved, and it has a consequence.** Every
bulk-imported contact's Omnisend `createdAt` is the import moment (16:33–16:36
UTC today), not the original signup. Omnisend assigns `createdAt` itself and it
cannot be back-dated. The `VL · Unengaged 120 days` segment — the sole trigger
for `VL · Sunset` — filters on `dateAdded notInTheLast 120 days`, so **it will
match nobody until 2027-01-15**, whatever their real history. If sunset should
work on the historical list, that segment needs to be rewritten against
`vl_last_order_at` or the consent date instead of `dateAdded`.

*Cosmetic, noted:* re-pushing produced a duplicate consent record on some
contacts (`2026-09-09T18:40:02Z` and `…:02.252Z`, same channel, same source).
Harmless; the earliest still governs.

**Revenue.**

| | Store | Omnisend | Difference |
|---|---|---|---|
| Paid orders | 19 | 17 | 2 |
| Revenue | $2,243.20 | $2,227.21 | $15.99 |
| Distinct buyers | 13 (+1 null-email) | 13 | 1 |

Both differences are the same two orders, and both exclusions are correct:

- `VL-E2C17DE7` — **$14.99, `order_type = 'test'`.** A test order is not a purchase.
- `VL-49CA32C1` — **$1.00, `customer_email` NULL.** No contact to attribute it to.

$14.99 + $1.00 = **$15.99**, exactly. Nothing else differs.

*A judgement call you may want to revisit:* cancelled orders still count toward a
contact's `vl_orders` and `vl_total_spent` (`VL-EA5529EF`, $45.47). It inflates
one contact's lifetime value.

**Catalogue.** Spot-checked `thymosin-alpha-1`: product ID is the slug, variant
ID uses the `__` separator, price `60` — not the `$0.00` the old
`coalesce(sale_price_cents, price_cents)` produced, because `sale_price_cents`
is `0` rather than null when there is no sale; the fix is live. Category
`repair-recovery-research`, canonical URL, live image.

**Deduplication.** No duplicate contacts. **Three duplicate segments** exist —
harmless but confusing, and in each case the one in use should be the one kept:

| Name | IDs | In use |
|---|---|---|
| VL · Unengaged 120 days | `6aaae34d…` / `6aa98959…` | Sunset uses `6aaae34d`; the other is orphaned |
| VL · Attested account holders | `6aa98910…` / `6aa9890f…` | neither; both hold 118 contacts |
| VL · Recovery gift ready | `6aaaae67…` / `6aaaae66…` | cart/checkout use `6aaaae67`; the other is orphaned |

### §4 — Automatic ongoing syncing

**Both halves proven, with evidence created after the deployment.**

**The inline hooks:**

| Path | Evidence | Latency |
|---|---|---|
| Consent → contact | `joelcadyy@gmail.com` opted in at 18:21:04.800; contact `6aac2f925256534a8babd4cd` created 18:21:06 as `subscribed`, carrying his own consent timestamp, source `api:oauth_portal`, first and last name, `vl_link`, and membership in 7 segments | **2 s** |
| Browse → event | `omnisend_events_sent` rows `view:80c9286f388a296b:glp-3` (18:10:58) and `view:41ed7f41f06f118c:glp-3` (18:21:15), both `delivered = true`, `attempts = 1` | **seconds** |

Both were real customers on the live site, not fixtures. Neither required an
export.

**The scheduled sweep.** `omnisend_sync_state` was **empty** when the audit
began — no Omnisend job had ever completed a scheduled run, because
`ce33a485` deployed at 18:08 and `/api/cron/sweep` runs at `*/30`, so the last
tick preceded the deploy. The **18:30 tick** was watched. It stamped six
watermarks:

```
order_backstop              @ 18:30:36
contacts_reconcile          @ 18:30:37
migration                   @ 18:30:38
catalog_sync                @ 18:30:38
batches                     @ 18:31:16
contacts_reconcile_cadence  @ 18:31:16
```

and in the same run repaired **every contact** — backfilling `vl_link`,
`vl_link_ends`, the four offer-readiness flags and the customer names onto every
bulk-imported row, and flipping the one stranded subscriber to `subscribed`.
Read back afterwards: **122 of 123 contacts carry a `vl_link`.** The one that
does not is `parguello352@gmail.com`, the unsubscribed contact, who receives no
marketing and therefore needs no link. That is C1 and C2, fixed by the scheduled
path rather than by hand.

**Durability, as built.** Events are ledgered in `omnisend_events_sent`, keyed by
a deterministic UUIDv5 of the entity, so a retry can never double-send and a
failure is visible as `delivered = false` with `last_error`. Order events have a
bounded backstop (7 days, 50 a run). Contact upserts fire through Next's
`after()`, so they never delay a checkout and never throw into the caller.
Catalogue pushes are capped at one per six hours, the full contacts push at one
per twenty-four, both stamped in `omnisend_sync_state`.

**The gap I am naming rather than papering over.** A contact upsert that fails
has no short retry — only the 24-hour full push. C2 is what that looks like from
the customer's side, and it only self-healed today because the watermark was
empty. Closing it properly means the 30-minute reconcile tick should repair
contacts whose store-side consent disagrees with Omnisend, not just the daily
push. **Not done**; §10, item 3.

### §5 — Omnisend as the sending platform

| Setting | Value | State |
|---|---|---|
| Sender email | `support@vantalabsresearch.com` | consistent across all 9 automations, every block |
| Sender name | `Vanta Labs` | consistent |
| Reply-to | not set per block; replies go to the sender address | `support@` is a real Google Workspace mailbox (`MX 1 smtp.google.com`) and is monitored |
| Domain authentication | **absent** | **B1** |
| SPF | `include:_spf.google.com include:mailgun.org ~all` | no Omnisend; stale Mailgun include |
| DKIM | Resend and Google only | no Omnisend selector exists |
| DMARC | `v=DMARC1; p=none;` | monitoring only; no alignment enforced |
| Unsubscribe | `[[unsubscribe_link]]` in the footer | present and correct |
| Business details | **placeholder text** | **B2** |
| Tracking domain | Omnisend's own for assets; every customer-visible link routes through `/api/email/omnisend-link` on our domain | acceptable |
| Sending limits | **not readable** — the Public API exposes no plan or quota operation | confirm in the Omnisend UI that the plan covers 122 contacts and the volume you expect |

The existing Resend authentication (`resend._domainkey`, and SPF
`include:amazonses.com` on `send.vantalabsresearch.com`) and the Google Workspace
records are untouched and must stay untouched: they carry every receipt and the
inbox itself.

### §6 — The nine automations, as they actually are

All nine read back from the live account. All nine `isEnabled: false`. All nine
`sendingThresholds.email = "subscribed"`, so a `nonSubscribed` contact is never
mailed — that is the consent guard, and it is uniform across every flow.

| # | Automation | Trigger | Re-entry | Exit conditions | Offer logic |
|---|---|---|---|---|---|
| 1 | `VL · Welcome` | `subscribed to marketing` | **once, ever** | none | splits on `VL · Welcome code ready` — code variant or plain |
| 2 | `VL · Welcome offer` | entered `VL · Welcome code ready` | **once, ever** | none | splits on `VL · Welcome gift ready` — "free GHK-Cu or 15%" vs "15%" |
| 3 | `VL · Abandoned cart` | `added product to cart`, 1 h inactivity | 1 week | `placed order`, `started checkout` | 3 emails, then a two-level split on recovery reward / recovery code |
| 4 | `VL · Abandoned checkout` | `started checkout`, 1 h inactivity | 1 week | `placed order` | same two-level split |
| 5 | `VL · Browse abandonment` | `viewed product`, 4 h inactivity | 1 week | `added product to cart`, `started checkout`, `placed order` | none — one note, no offer |
| 6 | `VL · Post-purchase` | `paid for order` | 30 days | none | none; splits on `VL · Repeat customers`, then `VL · VIP (spent over 500)` |
| 7 | `VL · Replenishment` | `paid for order`, +45 d | 60 days | none | none; suppresses itself for `VL · Bought in last 30 days` |
| 8 | `VL · Win-back` | entered `VL · Lapsed 60 days` | 32 days | **`paid for order`** | splits on `VL · Win-back code ready` |
| 9 | `VL · Sunset` | entered `VL · Unengaged 120 days` | 180 days | none | none; tags `engaged` or `sunset` on click |

**The exclusions are coherent.** `VL · Sunset` tags `sunset`;
`VL · Campaign audience` is `subscribed AND tags noneOf ['sunset']`, so a sunset
contact drops out of broadcasts by itself.

**Which of the nine can actually fire today.** "Built" is not "reachable", and
two of them are not. I read every trigger segment's membership back from the
account rather than assuming it.

| # | Automation | Can it fire today? |
|---|---|---|
| 1 | `VL · Welcome` | **yes** — triggers on each new subscriber |
| 2 | `VL · Welcome offer` | **no** — see below |
| 3 | `VL · Abandoned cart` | **yes**; its offer branch arms itself at cutover |
| 4 | `VL · Abandoned checkout` | **yes**; same |
| 5 | `VL · Browse abandonment` | **yes** |
| 6 | `VL · Post-purchase` | **yes** |
| 7 | `VL · Replenishment` | **yes** |
| 8 | `VL · Win-back` | **yes, from about 2026-09-21** — no buyer is 60 days lapsed yet; the oldest last-order is 2026-08-25. Codes mint themselves once one is |
| 9 | `VL · Sunset` | **no** — the `dateAdded` segment cannot match until 2027-01-15 (§3) |

**#2 is the one that matters, and it is a cutover regression you have to decide
about.** `VL · Welcome offer` triggers on entering `VL · Welcome code ready`,
which is `vl_welcome_ready = yes`. Across all 123 contacts that flag is `yes` on
**zero**, and it will stay that way: on 2026-09-16 the welcome code was
deliberately moved off the email opt-in and onto the SMS consent path, so that
every surface promising "subscribe to texts and get 15%" is telling the truth.
SMS is off for this launch, so no welcome code is ever minted, so the segment
stays empty, so the automation never runs.

Today's in-house `welcome_no_purchase` — **enabled, sending, +3 days** — is the
flow that carries the first-order offer. Standing it down at cutover without
arming #2 **removes the first-order discount from the email programme
entirely.** Two ways out, and it is your call:

* **Re-arm the welcome code on the email opt-in path.** One condition in
  `marketing/omnisend/hooks.ts` (`onMarketingOptIn`), which already has the
  minting code behind it. It reverses a decision you made on purpose eight days
  ago, and it means paying 15% for an address you may already hold.
* **Accept no first-order offer on email** until 10DLC clears and the SMS path
  goes live. Eight of nine flows run; new subscribers get the welcome series
  without a discount.

Doing nothing is the second option, silently. I would rather you chose it.

**Three further findings.**

1. **Five of the nine contain `sendSms` blocks.** They are inert: SMS consent is
   never collected (`promptsEnabled: false`, no `sms_signup` config row), so no
   contact can be `channels.sms.status = subscribed`, and every SMS block has
   `isSkipAllowed: true`. They will be skipped. The *delays wrapped around them*
   are not skipped — in `VL · Welcome offer` a 20-minute delay sits in front of a
   block that will never send. Harmless, worth knowing, not worth surgery before
   launch.
2. **`VL · Sunset` can never fire on the historical list** — §3, `dateAdded`.
3. **Four subject lines say "gift" where this project says "reward"** —
   "A gift for your saved cart", "A gift and a code for your saved cart", and the
   two checkout equivalents; the bodies carry "YOUR GIFT" and "CLAIM THE GIFT".
   §10, item 4.

### §7 — End-to-end verification

**Not done, and API acceptance is not it.**

What *is* verified: every payload is accepted by the live API; every automation's
structure, trigger, consent threshold, delays, splits, re-entry limit and exit
conditions were read back from the account; the templates carry the right sender,
footer and unsubscribe link; and every contact now holds a real `vl_link`, so a
test send would exercise a real link rather than an empty token.

What is **not** verified: that a real recipient receives a real message with a
working link and a working offer. That needs Omnisend's per-block test send
(`post_automations_id_blocks_block_id_test_email`) to a controlled address —
which is now unblocked, since C1 is fixed. Enabling a customer-facing flow merely
to prove it works is the thing the brief forbids, and is not required: the test
send is a real render through the real template to a real mailbox.

### §8 — Suppression sync (#27)

Written, tested, and open as
[PR #208](https://github.com/brendenhuntzinger1/vanta-labs/pull/208).

Omnisend's contacts API carries a channel status and no bounce field, so the
write-back can mirror an unsubscribe and nothing else. After cutover that would
leave hard bounces and spam complaints — the two facts that actually damage a
sending domain — reaching the store not at all, on the domain that also carries
every receipt. Resend's webhook does that job today and stops seeing marketing
mail at cutover.

The new sweep pulls `POST /api/events/query` for `marked message as spam` and
`message delivery failed` and turns them into suppressions **asymmetrically**: a
complaint is certain and writes `complained` (provider-imposed — the customer
cannot lift it); a delivery failure does not say whether it is permanent, so it
only feeds the store's existing consecutive-run escalation (`soft_bounce_run`,
customer-reversible) unless its own properties say the failure was permanent. A
verdict is written only when it is strictly stronger than what is held **and**
not older than the row it would replace. The watermark advances only on a clean
run.

Pulled rather than pushed on purpose: Omnisend's Public API exposes no webhook
registration, and an unsigned inbound endpoint that could suppress any address is
the exact hole `webhooks/email/route.ts` was written to close.

### §9 — Cutover sequence

Order matters, and this order has no gap and no duplicate.

1. **Clear B1 and B2.** DNS records added and verified inside Omnisend; postal
   address replaced in the footer layout. Neither is reversible by a deploy, so
   both go first.
2. **Merge PR #208** and let it deploy, so suppression sync is live *before*
   Omnisend sends anything.
3. **Decide the welcome-offer question (§6).** If you re-arm the code on the
   email path it must be deployed before step 4, or the first-order offer
   disappears the moment the in-house flows stand down.
4. **Per-block test sends** to a controlled address for each of the nine flows.
   Click every link. Confirm each offer resolves.
5. **Set `OMNISEND_MARKETING_OWNER=true`.** The six enabled in-house flows and
   the admin campaign endpoint stand down in the same request cycle, logging
   `marketing owned by omnisend`.
6. **Enable the Omnisend automations**, immediately after step 5. Seven will
   fire; `VL · Welcome offer` and `VL · Sunset` will sit idle until §6 and §3
   are resolved. Enable them anyway — an idle flow sends nothing — or leave
   those two off so the account reflects what is actually running.

**Why there is no gap.** Every in-house flow is delay-based, not
deadline-based — a customer whose reorder reminder fell due in the minutes
between steps 5 and 6 is picked up by `VL · Replenishment` on its own schedule.

**Why there is no duplicate.** Ownership is exclusive by construction: exactly
one system sends marketing, decided by one setting, because the site's 24-hour
frequency guard cannot see a message Omnisend sent, and two systems that cannot
see each other cannot share a quiet period.

**Nobody restarts from stage one.** Omnisend automations do not backfill — they
trigger on events, and events only began flowing at 18:08 today. The Welcome
flow is `frequencyLimiter: {mode: "once"}`, so no contact can ever receive it
twice. The 118 historical subscribers were *created already subscribed*, so no
`subscribed to marketing` transition happened for them.

*One risk to watch rather than assume away:* a contact whose status later
transitions nonSubscribed → subscribed **will** legitimately trigger the Welcome
flow. That is correct — they are a new subscriber — but it is why step 4 belongs
before step 6, so you see what the flow actually sends first.

**Rollback.** Unset `OMNISEND_MARKETING_OWNER` and disable the nine automations.
The in-house flows resume on the next cron tick (≤15 minutes) with no data
migration and no state to unwind, because `email_send_log` kept running
underneath the whole time. Suppressions Omnisend wrote stay — correctly. An
unsubscribe is an unsubscribe whoever observed it.

### §10 — Readiness and handover

**GO / NO-GO: NO-GO**, on B1 and B2 alone. Neither is a code defect; neither
needs design. Both are yours.

**Remaining work, in order:**

| | Task | Owner |
|---|---|---|
| 1 | Add Omnisend's DNS records from Settings → Sender domains (**B1**) | **you only** |
| 2 | Replace the footer postal-address placeholder (**B2**) | **you**, or me given the address |
| 3 | Add a bounded retry so a missed consent push is repaired within 30 minutes rather than 24 hours | me |
| 4 | Change "gift" to "reward" in 4 subject lines and their bodies | me |
| 5 | Merge PR #208 | me |
| 5a | **Decide the welcome-offer question in §6** — re-arm the code on email, or launch without a first-order offer | **your decision** |
| 6 | Per-block test sends to a controlled address, all nine flows | me |
| 7 | Delete the 3 duplicate segments | me |
| 8 | Decide whether `VL · Sunset` should key on `vl_last_order_at` rather than `dateAdded` | your decision, my implementation |
| 9 | Remove the stale `include:mailgun.org` from SPF | **you** |
| 10 | Decide whether cancelled orders should keep counting toward `vl_orders` / `vl_total_spent` | your decision |

**Platform limitations no amount of work removes.**

- Omnisend's Public API has **no webhook registration**, so every inbound fact
  must be pulled. That is why §8 is a sweep rather than an endpoint — and it is
  the safer design anyway.
- The Public API exposes **no sender-domain, DNS, plan or quota operation**. B1
  and the sending limits can only be read and set in the Omnisend UI.
- Omnisend assigns contact `createdAt` itself, so **historical signup dates
  cannot be restored**. Consent dates survive on the consent record;
  `dateAdded` segments do not.
- Omnisend's contacts API has **three statuses and no bounce field**. §8 exists
  because of that and cannot be replaced by a simpler mirror.

**Monitoring after this session.** What exists is what runs in the cron:
`omnisend_events_sent.delivered = false` with `last_error` is the failure surface
for events; `omnisend_sync_state` shows whether each job is keeping its cadence;
and the sweep logs a refused page or a missing `events.read` scope in words
rather than as silence. There is **no alerting** on any of it. I am not going to
claim unattended monitoring that is not implemented. If you want it, the honest
shape is a sweep job that alerts when undelivered events cross a threshold or
when an `omnisend_sync_state` watermark goes stale, and it is not written.

**Nothing has been turned on.** All nine automations remain disabled,
`OMNISEND_MARKETING_OWNER` remains unset, `WELCOME_GIFT_ENABLED` is false, and
SMS prompts remain off.

**The single step that makes Omnisend the live sender is §9 step 5 — setting
`OMNISEND_MARKETING_OWNER=true` — followed immediately by enabling the nine
automations. At that moment the six in-house Resend flows stop and Omnisend's
nine start. Neither has been done, and neither will be without your word.**
