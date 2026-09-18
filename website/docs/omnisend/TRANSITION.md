# Omnisend transition — state, evidence, and what turns it on

**Audited 2026-09-17.** Production serving `ce33a485`
(`dpl_6RMCKkmPZJrp7hMvjsmM4itZDbLn`, READY 18:08 UTC). Omnisend brand
`6aa09072ca3afa5724d4d71a` (Vantalabsresearch, USD, America/Chicago). API
version `2026-03-15`.

**Status: preparing. The transition is deliberately NOT happening yet.**

The owner's decision, 2026-09-17: **do not transition to Omnisend until SMS is
approved for the business and its sending is set up.** Until then the
Resend-backed marketing and transactional mail keeps running exactly as it is,
`OMNISEND_MARKETING_OWNER` stays false, all nine Omnisend automations stay
disabled, and the 15% welcome incentive stays tied to SMS consent.

So the goal of this document is no longer "can we go live today". It is
**everything that can be finished before approval, finished** — and a precise
list of what is left, who owns each item, and what happens on the day approval
lands. Two items are blocked on you and cannot be worked around (§B). Nothing
here flips a switch.

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
| "gift" wording | **fixed** — 4 subject lines and 12 body strings now say "reward" |
| Live consent sync | **working** — opt-in → Omnisend contact in **2 seconds** |
| Live event sync | **working** — 2/2 events delivered within seconds |
| Scheduled sync (cron) | **working** — first tick 18:30 UTC stamped 6 watermarks and repaired every contact |
| Sending-domain authentication | **PASS** — `dkim=pass` on `d=vantalabsresearch.com` (selector `krs`), `spf=pass`, `dmarc=pass`, proven by a delivered message |
| Footer business details | **PASS** — real postal address, verified in a delivered message |
| In-house Resend flows | **6 of 7 enabled and sending — unchanged, and staying that way** |
| `OMNISEND_MARKETING_OWNER` | **not set in Vercel at all** → reads false. Verified in the project's env list |
| 15% welcome incentive | **stays on SMS consent.** Not re-armed for email — §6 |

---

## B. Both items are now CLOSED — and B1 was my error

### B1 — Omnisend IS authenticated. My earlier finding was wrong.

**What I reported yesterday:** "Omnisend has no authentication records on
`vantalabsresearch.com`", based on probing a dozen guessed selectors
(`om1`, `om2`, `omnisend`, `omsend1/2`, `s1`, `s2`, `k1`, `dkim`, `om`, `o1`,
and the hosts `omnisend`, `_omnisend`, `email`, `mail`) and finding NXDOMAIN
on every one.

**Why that was wrong.** A negative result on a guessed list is not absence.
The real selector is **`krs`**, which was not on my list. `CHECKLIST.md` had
recorded it correctly on 2026-09-16 — "DKIM `krs._domainkey` added" — and I
treated that line as contradicted rather than checking it.

`krs._domainkey.vantalabsresearch.com` resolves to a live RSA public key.

**Proof, from a real delivered message.** A test send from the
`VL · Browse abandonment` block to `support@vantalabsresearch.com`
(2026-09-18 00:37 UTC), read back from the mailbox as raw MIME:

```
Authentication-Results: mx.google.com;
   dkim=pass header.i=@dkim5.omnisend.email header.s=omni2 header.b=ib2z1KOb;
   dkim=pass header.i=@vantalabsresearch.com header.s=krs header.b=kfcyER79;
   spf=pass (... designates 69.72.35.215 as permitted sender)
     smtp.mailfrom="bounce+efc2fa.fcfa50-support=vantalabsresearch.com@vantalabsresearch.com";
   dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=vantalabsresearch.com
```

Every one of the three checks passes, and the second DKIM signature is on
**`d=vantalabsresearch.com`** — the customer's own domain, not Omnisend's.
`From:` is `Vanta Labs <support@vantalabsresearch.com>`, and DMARC reports
alignment on the organisational domain.

**So there is nothing to add, and no screenshot is needed.** The sender domain
was authenticated on 2026-09-16, exactly as the checklist said.

### B1a — RETRACTED: do NOT remove `include:mailgun.org` from SPF

I recommended this twice, calling it "a stale authorisation" because nothing in
this codebase sends through Mailgun. **That recommendation was wrong and acting
on it would have broken Omnisend's authentication.**

The header above shows the message arriving from `69.72.35.215`
(`v5215.v561b35cb.usw1.send.mailgun.net`), with a Return-Path of
`bounce+…@vantalabsresearch.com`. **Omnisend sends through Mailgun
infrastructure.** The `include:mailgun.org` in the root SPF is what makes
`spf=pass` possible, and removing it would turn `spf=pass` into `spf=fail` and
take `dmarc=pass` down with it.

The root SPF stays exactly as it is:

```
v=spf1 include:_spf.google.com include:mailgun.org ~all
```

### B2 — The postal address is in, verified in a delivered email

`MARKETING_POSTAL_ADDRESS` is a Vercel **sensitive** variable, which is
write-only — the API returns `decrypted: false` and there is no read path, for
me or for the owner. It is not stored in the database either
(`admin_control_current` has no `marketing_postal_address` column, so
`settings.ts` falls through to the env var), and it appears in none of the
stored email bodies or on any public page.

It was recovered instead from the **rendered footer of a marketing message
already sent through Resend**, read back from the Resend API:

```
30929 Mirada Blvd
po box 331
San Antonio FL
33576
```

Written into the shared universal layout `6aa985f7c29076c61d3838b1`, block
`1818a05ce0909017c20c781c`, normalised for a single-line footer:

> `Vanta Labs Research · 30929 Mirada Blvd, PO Box 331, San Antonio, FL 33576`

Confirmed in the delivered test message above, not just in the API response.
All nine automations inherit this layout, so all nine now carry it.

*If you want it byte-identical to the Resend version (lower-case "po box", line
breaks instead of commas), say so and I will match it exactly.*

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

**#2 is dormant BY DECISION, not by accident.** `VL · Welcome offer` triggers on entering `VL · Welcome code ready`,
which is `vl_welcome_ready = yes`. Across all 123 contacts that flag is `yes` on
**zero**, and it will stay that way: on 2026-09-16 the welcome code was
deliberately moved off the email opt-in and onto the SMS consent path, so that
every surface promising "subscribe to texts and get 15%" is telling the truth.
SMS is off for this launch, so no welcome code is ever minted, so the segment
stays empty, so the automation never runs.

**Decided 2026-09-17: it stays tied to SMS consent. Do not re-arm it for email
signup.** That is the right call and it also removes the cutover regression
entirely, because the cutover now waits for SMS anyway — by the time
`OMNISEND_MARKETING_OWNER` flips, SMS will be live, the consent path will be
minting codes, the segment will fill, and #2 will start firing on its own with
no code change.

So this flow is **staged and correct, waiting on its input**, not broken. The
only thing it needs is for `vl_welcome_ready` to become `yes` on real contacts,
which happens the moment SMS consent is being collected.

`grantWelcomeOfferForConsent` is called from exactly three places, all of them
SMS-consent paths, and none of them the email box:

```
api/auth/signup/route.ts:370        if (consented) await grantWelcomeOfferForConsent(...)   ← SMS box ticked
api/account/preferences/route.ts:78 if (address && body.smsMarketing) await ...             ← SMS toggle on
marketing/omnisend/reconcile.ts:577 ...                                                     ← Omnisend pop-up SMS consent
```

`onMarketingOptIn` in `hooks.ts` subscribes the address and mints nothing. That
is the state the owner asked for, and it is verified by the 800 tests in
`src/lib/offers` and `src/lib/marketing/omnisend`, all passing.

**Verified with designated test data, 2026-09-17.** A test contact
(`btunchi88+vl-flowtest@gmail.com`, tagged `designated-test`, `nonSubscribed`)
was created with `vl_welcome_ready = "yes"` and `vl_welcome_gift_ready = "no"`.
**Both branches were exercised and both behaved:**

| Test data | Segments entered | Branch the automation would take |
|---|---|---|
| `vl_welcome_ready: yes`, `vl_welcome_gift_ready: no` | `VL · Welcome code ready` only (membership 0 → 1) | **false** → "Your welcome code: 15% off a first order" |
| then `vl_welcome_gift_ready: yes` | *also* `VL · Welcome gift ready` | **true** → "Your welcome offer: a free GHK-Cu, or 15% off" |

So the trigger segment is wired to the property the SMS consent path sets, and
the gift split is wired to the property `WELCOME_GIFT_ENABLED` controls. The
configured production state — code yes, gift no — is the first row.

Nothing could have been sent at any point: the automation is disabled, and its
`sendingThresholds.email = "subscribed"` skips a `nonSubscribed` contact even
when enabled.

**Cleanup, and a correction.** I intended to delete the test contact and said
so before checking. **Omnisend's Public API has no delete-contact operation** —
the whole delete catalogue is A/B setups, automations, campaigns, categories,
contact *tags*, templates, layouts, forms, images, products and segments, and
no contact. So instead the record was neutralised: every offer property
cleared (`vl_welcome_ready` and `vl_welcome_gift_ready` back to `"no"`, the
code, percent and gift fields removed), left `nonSubscribed` so no flow can
ever mail it, and left tagged `designated-test` so it is identifiable.

`btunchi88+vl-flowtest@gmail.com` / contact id `6aac373b3dfe2e9d9f821f05`
**is the one record to delete by hand in the Omnisend UI** when you are next in
there.

**Until then it is quarantined, and here is the proof rather than the promise.**
Read back at 19:11 UTC:

```json
"status": "nonSubscribed", "consents": [], "optIns": [], "tags": ["designated-test"],
"customProperties": { "vl_designated_test": "yes", "vl_attested": false,
                      "vl_welcome_ready": "no", "vl_welcome_gift_ready": "no",
                      "vl_winback_ready": "no", "vl_recovery_ready": "no",
                      "vl_orders": 0, "vl_total_spent": 0 },
"segments": ["6aa090749ca7eb31e5d9e3de"]   ← Omnisend's own all-contacts segment, and nothing else
```

- **Excluded from `VL · Campaign audience`** (`6aa9891856e90f08f163f5ad`), which
  requires `subscriptionStatus = subscribed`. That segment reads **120**, the
  120 subscribed contacts, and does not include it.
- **Excluded from every offer and trigger segment** — it dropped out of
  `VL · Welcome code ready` and `VL · Welcome gift ready` on the evaluation
  after its properties were cleared, and both are back to their true counts.
- **Excluded from the two `VL · Attested account holders` segments** as of
  19:11, by setting `vl_attested: false`, which is also simply true: it never
  attested.
- **Excluded from reconciliation counts.** It is not in the store's audience,
  so no push targets it; it is `nonSubscribed` with no form tag, so the
  write-back plans nothing for it. Every count in §3 and §A is stated against
  real contacts; where a total includes it, it says so. `vl_designated_test`
  and the `designated-test` tag are both there so any future query can exclude
  it by either.

It cannot be mailed by any flow, cannot enter any audience, and carries no
offer.

*One API behaviour worth recording:* Omnisend stamps `channels.email.statusChangedAt`
with the write time on contact creation regardless of what is submitted — the
test sent `1970-01-01T00:00:00.000Z` and got `2026-09-17T18:53:47Z` back. The
`UNKNOWN_STATUS_CHANGED_AT` guard in `contact-payload.ts` still does its job,
because what protects a newer opt-out is Omnisend's own documented rule about
refusing an older status date on *update*; but you cannot confirm the guard by
reading the value back, so do not try.

**Three further findings.**

1. **Five of the nine contain `sendSms` blocks.** They are inert: SMS consent is
   never collected (`promptsEnabled: false`, no `sms_signup` config row), so no
   contact can be `channels.sms.status = subscribed`, and every SMS block has
   `isSkipAllowed: true`. They will be skipped. The *delays wrapped around them*
   are not skipped — in `VL · Welcome offer` a 20-minute delay sits in front of a
   block that will never send. Harmless, worth knowing, not worth surgery before
   launch.
2. **`VL · Sunset` can never fire on the historical list** — §3, `dateAdded`.
3. ~~Four subject lines said "gift" where this project says "reward".~~
   **Fixed during the audit.** The four subject lines were patched through
   `patch_automations_id`, which matches a block by id and patches
   `action.sendEmail` field by field — so the two abandonment trees, their
   splits, delays and exit conditions, are untouched, and each response proves
   it. The bodies went through `put_email_content_id`, which is a full-document
   replace with no partial form, so each of the four offer templates was read,
   changed in three places and written back whole: `YOUR GIFT` → `YOUR REWARD`,
   `CLAIM THE GIFT` → `CLAIM THE REWARD`, and "a gift is attached" / "a gift
   added to your order" → "a reward …". Verified by re-rendering
   `6aab0ceefe9daa7b181e8f22` through `post_email_content_id_render` and reading
   the HTML: the words are right and the layout, links, product grid and footer
   are intact.

   The property names behind the copy (`vl_recovery_gift` and its four
   siblings) are unchanged. They are internal keys the contact push, the
   cart-offer sweep and the templates all agree on; renaming them is a
   migration, not a wording fix, and nothing a customer sees carries them.

### §6a — The two sign-up forms, one of which should not exist

Both are drafts, so neither is showing on the site. They are not equivalent.

**`6aaab173090e83c9759fd50d` — "VL · Sign-up (email + SMS)". Correct, and right
to stay a draft.** Step 1 takes an email; step 2 offers the SMS subscription with
proper TCPA language, real `/legal/privacy` and `/legal/terms` links, US/CA only,
shown on `/products` and excluded from `/cart` and `/checkout`, and excluded from
`omnisendCommunication` traffic. It stays a draft for this launch because its
second step sells a text subscription and SMS is out of scope.

**`6aaa9bef27f565e8b3f4b22f` — "Email & SMS branded Multi-step welcome discount".
Delete it.** It is stock Omnisend demo content that was never edited, and every
one of these is wrong for this business:

- headline, button and teaser all say **"GET 10% OFF"**. The welcome offer is
  **15%**, and nothing in this store mints a 10% code.
- the success step promises *"you'll find a 10% discount in your inbox"*.
  Nothing would arrive.
- the TCPA consent text still contains the literal placeholder
  **`[your-store-name]`**.
- its privacy link is `vantalabsresearch.com/policies/privacy-policy` — a
  Shopify-shaped path that **404s on this site**. The real one is
  `/legal/privacy`.

It is harmless while it is a draft and a liability the moment anyone publishes
it by accident. I have not deleted it: deleting is not reversible and you did not
ask me to remove anything from the account. It is two clicks in Forms.

### §7 — End-to-end verification, and what it must actually cover

**The segment test in §6 proves ELIGIBILITY ONLY.** It showed that a contact
carrying `vl_welcome_ready = yes` enters the trigger segment and that the gift
split routes on the property that is supposed to route it. That is the last
link in the chain and nothing before it. It says nothing about whether a real
person signing up for texts ends with a working code in their hand.

Final testing has to walk the whole journey, and this is the script. None of it
runs until SMS is approved, because five of the seven steps have no meaning
without a live SMS channel.

| # | Step | What is verified | How it is proved |
|---|---|---|---|
| 1 | Real SMS signup on production, designated number | `sms_subscribers` row written with `marketing_consent`, `consent_source`, `disclosure_version`, and `customer_preferences` mirrored | read both rows |
| 2 | Consent sync | the contact reaches Omnisend with `channels.sms.status = subscribed` and the **phone identifier**, within seconds | read the contact back |
| 3 | Unique welcome code | `vl_welcome_code` on the contact is a real, live, single-use row in the store, unique to that address and not shared with any other test contact | compare the property against `customer_offers` / the coupon row |
| 4 | Correct channel | the **SMS** arrives on the designated handset with the code and a working short link | receipt on the device |
| 5 | Link resolution | `/api/email/omnisend-link?t=…` resolves that contact's `vl_link` to the right destination and identifies the right person | follow it |
| 6 | Checkout redemption | the code applies at checkout, discounts correctly, and is single-use — a second attempt is refused | drive checkout to the point of discount, **without completing a real payment** |
| 7 | Suppression | replying STOP produces an `sms_subscribers.opted_out_at` stamp through the write-back, and no further SMS | reply and re-check |

**The case that matters most: the SMS-only subscriber with no email consent.**
Run the whole script a second time with a recipient who ticks **only** the SMS
box — no email opt-in, no order. Two things must be true and only observation
can establish them:

- **The email block is skipped, not fatal.** In `VL · Welcome offer` the SMS
  block sits *after* the email block, behind a 20-minute delay. The email block
  carries `isSkipAllowed: true`, and Omnisend's own schema defines that as
  "the contact bypasses this block and continues to the next block in the
  workflow" — as against `false`, which cancels the workflow for that contact.
  So the design says an email-`nonSubscribed` contact skips the email, waits
  20 minutes, and receives the SMS. **Confirm it happens.** If the workflow
  cancels instead, the entire text-subscriber offer is undeliverable to the
  people it was written for, and that is a launch blocker.
- **`sendingThresholds` does not block the SMS.** It is
  `{email: "subscribed", sms: "subscribed"}` on all nine flows. The SMS-only
  contact is subscribed on SMS, so the SMS block is eligible; the email block
  is not, which is the skip above. Confirm the SMS lands and no email does.

**One defect on this path was found and fixed while preparing** — see §7a. It
would have made step 2 permanent rather than repairable, and step 5 fail after
thirty days.

*Everything already verified, which final testing does not need to repeat:*
every payload accepted by the live API; every automation's structure, trigger,
consent threshold, delays, splits, re-entry limit and exit conditions read back
from the account; sender, footer and unsubscribe correct in the rendered HTML;
and `vl_link` present on 122 of 123 contacts so a test send exercises a real
token.

### §7a — The SMS-only subscriber was in no push audience. Fixed.

Found while working through §7's second case, before any SMS exists to be
affected (`sms_subscribers` is empty today, so nobody was harmed and nothing
customer-facing changed).

**What was wrong.** The daily full push walks
`orderPushTargets(audience, buyers)`, where `audience` is
`loadConsentedAudience()` — built from `customer_preferences.marketing_emails`
and `marketing_subscribers`, both **email** consent stores — and `buyers` is
paid product orders. Someone who ticks only the SMS box is in neither: no
subscriber row, no email preference, and (for the offer's whole target
audience, someone who has not bought yet) no order.

Their contact reached Omnisend exactly once, from the fire-and-forget hook on
the consent itself (`sms-consent.ts` → `pushToOmnisend` → `onPreferencesChanged`),
and then never again. Two consequences, both silent:

1. **A single dropped push would have been permanent.** That is exactly the
   failure that stranded a live subscriber earlier today (§C2), and for an
   email subscriber the daily push repairs it within 24 hours. For an SMS-only
   subscriber there was no repair path at all — they would sit outside
   Omnisend, and the 15% text they were promised would never send, with nothing
   reporting it.
2. **Their `vl_link` would have expired and never been renewed.** The token has
   a 30-day TTL and is re-minted on every full push. Never being in a full
   push, an SMS-only contact's link dies at day 30 and every link in every
   message to them dies with it.

**The fix.** A third tier in the push, `loadSmsConsented()`, reading
`sms_subscribers` where `marketing_consent` is true and `opted_out_at` is null,
unioned into `orderPushTargets` between the email audience and the buyers.

**What the fix deliberately does *not* do:** it does not add these addresses to
`loadConsentedAudience()`. That loader also drives the in-house **email**
sender, and widening it would email someone who consented to texts and not to
email. The two are joined only in the push, and a source test now asserts that
`loadAudience` never mentions `sms_subscribers`.

These contacts arrive in Omnisend as `email: nonSubscribed` + `sms: subscribed`,
decided per contact by `collectContactFacts` — which is exactly what they are,
and is what makes the email block skip in §7's second case.

Nine tests added across `reconcile-plan.test.ts` and `reconcile-source.test.ts`.
Full suite after the change: **752 files, 11,301 tests, 0 failures**, `tsc`
clean.

### §8 — Suppression sync (#27)

Written, tested, and **merged** as
[PR #208](https://github.com/brendenhuntzinger1/vanta-labs/pull/208) →
`8a9919c8`. Issue #27 is closed.

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

It merged after the 18:30 tick, so **its own first scheduled run has not been
observed yet** — watch for an `omnisend_sync_state` row keyed
`provider_verdicts`.

### §8a — Pending-sequence handoff

**"End where they are" and "let them drain" are two different plans and the
previous draft used both phrases for one idea. They are separated here, and
one of them is recommended.** Counts refreshed **2026-09-17 19:04 UTC**; they
move, and step 3 of §9 re-runs them on the day.

**Who is mid-flight, exactly:**

| Cohort | People | What the in-house flow still owes them |
|---|---|---|
| Welcome: had `welcome_intro`, not yet `welcome_no_purchase` | **17** | 1 message each — the first-order offer |
| Cart ladder: had `t24h`, owed `t72h` | **3** *(of 10 total; 7 are older than 72 h and already dead)* | 1 message each |
| Cart ladder: had `t12h`, owed `t24h` + `t72h` | **4** *(of 7 total)* | 2 messages each |
| Cart ladder: had `t30m` only | 4 total, **0 live** | nothing — all older than 72 h |
| `post_purchase` | 4 | within its 14-day delay, one message |
| `replenishment`, `winback_30`, `winback_60` | **0 sends ever** | nothing in flight |

---

#### Option A — hard stop. *Recommended.*

Flip `OMNISEND_MARKETING_OWNER`, every in-house marketing sender stands down in
the same request cycle, in-flight episodes get nothing further.

**Messages intentionally omitted, at this instant, stated plainly:**

| Who | Message they do not get |
|---|---|
| 17 welcome contacts | `welcome_no_purchase` — "Welcome · first-order offer" |
| 3 cart contacts | `cart_recovery_t72h` |
| 4 cart contacts | `cart_recovery_t24h` **and** `cart_recovery_t72h` |
| up to 4 post-purchase contacts | the first-order follow-up, if cutover lands inside their 14-day delay |

**Total: 28 messages to 24 people**, at 19:04 UTC on 2026-09-17. Re-count on
the day; the shape will be similar because both ladders are short.

Nobody receives two messages for one episode. Nobody restarts at stage one.
Omnisend does not backfill — it triggers on new events, and `subscribed to
marketing` already fired for those 17 while the flow was disabled — and
`cartHasInHouseStage()` fails closed, so Omnisend refuses a cart the in-house
ladder has already claimed even after the switch. **Both halves of the
"no double-message" property already exist and need no new code.**

The cost is 28 messages. The benefit is that there is no window in which two
systems both believe they own an episode.

---

#### Option B — drain, with per-customer ownership.

Keep the in-house flows serving **only** episodes already claimed, while
Omnisend owns everything new, until the in-flight cohorts empty.

**This is not supported today and needs code.** `marketingSendBlockedByOmnisend()`
is a single global switch: on, and every in-house marketing sender stops,
in-flight or not. There is no per-episode ownership on the in-house side. To do
this properly, all of the following must hold — and the user's condition, that
both platforms can never message the same episode, is what each one serves:

1. **Per-customer ownership marker, in-house side.** The lifecycle cron must
   distinguish "this episode was already claimed by us" from "this is new".
   The markers exist as data: `abandoned_cart_emails` holds a per-cart stage
   claim, and for welcome, an `email_send_log` row with
   `campaign_type = 'automation:welcome_intro'` and no
   `automation:welcome_no_purchase` row for that address is the equivalent. The
   *conditional* does not exist and would be new code in the cron.
2. **Complementary suppression, Omnisend side.** For carts this is already
   there and correct — `cartHasInHouseStage()` fails closed, so Omnisend will
   not touch a claimed cart. For welcome it is free by accident: `VL · Welcome`
   triggers on `subscribed to marketing`, which already fired for those 17
   while the flow was disabled, so Omnisend will not enrol them.
3. **A hard deadline.** A drain with no end is a permanent dual-ownership
   window. It would need an explicit cutoff — 7 days is the natural one, longer
   than both ladders — after which the in-house side stops unconditionally
   whatever its markers say.
4. **Evidence that the markers are right before relying on them.** A drain is
   only safe if ownership is correct for every in-flight episode. That is a
   claim about 24 specific people, and it would have to be checked per person
   rather than asserted.

**Why I recommend against it.** It converts a known, bounded, listable cost —
28 messages, named above — into an unbounded one: a dual-ownership window is
the single condition most likely to produce the thing you most want to avoid,
and it would be created deliberately, for a week, to save 28 messages. Under
Option A the "no double-send" property holds by construction and needs nothing
to be true. Under Option B it holds only if new code is right.

If you want Option B anyway, say so and I will build it with the four
properties above and test each one — but it should be a deliberate purchase,
not a default.

---

**Either way, one thing is not optional:** the counts get re-run at cutover
(§9 step 3) and the omission list is produced from live data at that moment,
not from this table.

### §9 — Cutover sequence (for approval, not for now)

**Nothing in this section happens until SMS is approved and you approve the
plan.** Omnisend approving the SMS sender does not flip the ownership switch;
approval only unblocks the steps below, which are then presented to you.

Order matters, and this order has no gap and no duplicate.

0. **SMS approved and its sending configured.** The precondition for the whole
   sequence. Until it is true, none of the rest runs.
1. **Clear B1 and B2.** DNS records added and verified inside Omnisend; postal
   address replaced in the footer layout. Neither is reversible by a deploy, so
   both go first — and both can be done *before* approval, which is why they
   are being asked for now.
2. ~~Merge PR #208~~ — **done.** Suppression sync is on `main` and will be live
   before Omnisend sends anything. Confirm its first scheduled run by looking
   for an `omnisend_sync_state` row keyed `provider_verdicts`; a `403` in the
   sweep log instead means the API key is missing the `events.read` scope.
3. **Final data reconciliation.** Re-run the §3 diff — contacts, suppressions,
   orders, revenue — against whatever the account holds on the day, and
   re-record the §8a mid-sequence counts. The numbers in this document are
   2026-09-17 numbers and will have moved.
4. **Per-block test sends** to a controlled address for each of the nine flows,
   plus the SMS blocks now that SMS is live. Click every link. Confirm each
   offer resolves. This is the end-to-end test, and it is the last thing before
   anything customer-facing changes.
5. **Show you the coordinated email + SMS cutover and get your approval.**
   Steps 6 and 7 do not happen without it.
6. **Set `OMNISEND_MARKETING_OWNER=true`.** The six enabled in-house flows and
   the admin campaign endpoint stand down in the same request cycle, logging
   `marketing owned by omnisend`.
7. **Enable the Omnisend automations**, immediately after step 6. By then
   `VL · Welcome offer` will have a filling trigger segment, because SMS
   consent will be minting welcome codes. `VL · Sunset` stays idle until §3's
   `dateAdded` question is resolved; leave it off so the account reflects what
   is actually running.

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

**Two sign-offs, reported separately, and only the first is in reach.**

| Sign-off | What it asserts | State |
|---|---|---|
| **Preparation complete** | everything buildable without SMS is built, tested and evidenced; the two owner inputs are in; controlled template tests have run | **not yet** — waiting on the DNS records, the postal address, and the template tests that follow them |
| **Launch verified** | the full §7 journey has been walked on live SMS, including the SMS-only case, and the §9 cutover plan has been approved | **not yet** — requires SMS approval, and is a separate report |

I will report *preparation complete* as its own statement, with its own
evidence, and will not use it to imply anything about launch. **Launch
verified** comes later and separately, and neither one flips a switch: the
ownership switch and the first customer send both wait on your explicit
approval after *launch verified* is reported.

**Verdict on the transition itself: READY TO TRANSITION, NOT TRANSITIONED.** That is the objective and
that is the state. The integration is deployed and dormant, the data
reconciles, the sync runs on its own, the templates and flows are built and
correct, and the two things that are not done are the two things only you can
supply.

Nothing about this waits on engineering any more. It waits on SMS approval, on
one screenshot, and on one line of address.

**Remaining work, in order:**

| | Task | Owner |
|---|---|---|
| 0 | SMS approval for the business, and its sending set up | **you / carrier** |
| 1 | Send me the Sender domains DNS panel (**B1**) — exact strings, uncropped; then I add and re-verify the records | **you, then me** |
| 2 | Paste the `MARKETING_POSTAL_ADDRESS` string (**B2**); I put it in the footer layout | **you, then me** |
| 3 | Add a bounded retry so a missed consent push is repaired within 30 minutes rather than 24 hours | me |
| ~~4~~ | ~~Change "gift" to "reward" in 4 subject lines and their bodies~~ — **done**, §6 | — |
| ~~5~~ | ~~Merge PR #208~~ — **done**, merged as `8a9919c8`; issue #27 closed | — |
| ~~5a~~ | ~~Decide the welcome-offer question~~ — **decided**: stays on SMS consent, not re-armed for email. §6 | — |
| 6 | Controlled template tests: per-block test sends to a controlled address, all nine flows — **after** B1 and B2. This is the last item in *preparation complete* | me |
| 6a | The full §7 journey on live SMS, including the SMS-only subscriber — part of *launch verified*, not preparation | me, after approval |
| 7 | Delete the stock "10% off" demo form `6aaa9bef27f565e8b3f4b22f` (§6a) and the 3 duplicate segments (§3). Both are deletions, so say the word and I will, or do it in the UI | **your call** |
| 8 | Decide whether `VL · Sunset` should key on `vl_last_order_at` rather than `dateAdded` | your decision, my implementation |
| 9 | Remove the stale `include:mailgun.org` from SPF | **you** |
| 10 | Decide whether cancelled orders should keep counting toward `vl_orders` / `vl_total_spent` | your decision |
| 11 | On SMS approval: final reconciliation (§9 step 3), end-to-end test (§9 step 4), then present the coordinated email + SMS cutover for approval | me |
| 12 | Choose §8a Option A (hard stop, 28 messages omitted, listed) or Option B (drain, needs new per-episode ownership code) | **your decision** |
| 13 | Delete the quarantined test contact `6aac373b3dfe2e9d9f821f05` in the Omnisend UI — no API can | **you** |

**What stays exactly as it is while we wait**, and is being actively preserved
rather than merely neglected:

- The six enabled Resend automations and the cart-recovery ladder keep sending.
- Every transactional message keeps going through Resend, untouched.
- `OMNISEND_MARKETING_OWNER` is **not set in Vercel** — verified in the project
  env list — so `omnisendOwnsMarketing()` returns false and every in-house
  sender keeps its ownership. Setting it to the literal string `false` would
  behave identically; leaving it absent is one fewer thing that can be
  fat-fingered to `true`.
- All nine Omnisend automations are `isEnabled: false`, and both sign-up forms
  are drafts.
- `WELCOME_GIFT_ENABLED` is false, SMS prompts are off, and the 15% welcome
  incentive is minted on the SMS consent path only.
- Existing customers' live discounts are untouched: no coupon, offer or
  `customer_offers` row was created, revoked or expired during this work. The
  only offer-shaped records written were on a designated test contact in
  Omnisend, since deleted.

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
