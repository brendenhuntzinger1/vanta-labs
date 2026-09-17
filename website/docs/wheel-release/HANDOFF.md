# Morning handoff — wheel campaign

Written overnight 2026-09-16/17. Nothing was merged, nothing was sent, and
production remains dark.

**The other files here, in reading order:**

| file | what it answers |
|---|---|
| `SEND-CHECKLIST.md` | Six copy-pasteable steps to get it out. Start here if you just want to send. |
| `README.md` | Can the wheel ship without the SMS work? (Yes, proven.) |
| `OFFER-INTERACTION.md` | What happens when a customer holds the welcome code *and* a wheel prize — measured at the till. |
| `FLOWS-AND-OVERLAP.md` | What is already sending today, and whether the wheel collides with it. |
| `OMNISEND-MAPPING.md` | Every flow mapped to its Omnisend replacement, both sides read live. |
| `AUDIT-FINDINGS.md` | 106 findings from an eleven-way audit, separated into what I reproduced and what I did not. **Three hard blockers for the SMS launch.** None affect the wheel. |
| `minimum-wheel-release.patch` | The 36-file release itself. |

---

## 1. Read this first: the send date is ambiguous

You asked for "tomorrow at noon America/New_York" and for the exact calendar
date confirmed. I cannot confirm it, because the two clocks I have disagree:

- The container clock reads **2026-09-17 03:00 UTC**, which is **Wednesday
  16 September, 23:00 ET** — so "tomorrow" is **Thursday 17 September**.
- The session metadata states today is **2026-09-17**, which would make
  "tomorrow" **Friday 18 September**.

You messaged me at about 23:00 ET on the Wednesday, so I have assumed you meant:

> **Thursday, 17 September 2026, 12:00 PM EDT** — `2026-09-17T16:00:00Z`

The other candidate is `2026-09-18T16:00:00Z`. **Confirm which before the
campaign is scheduled.** Everything else is ready either way; this is a
one-field change.

---

## 2. What is finished and verified

### The word "gift" had to become "reward"

Your rule: *"Use 'gift' only if every possible outcome is a product gift."*
The configured wheel is **16 wedges: 12 free products, 3 percentage discounts,
1 free shipping**. Four outcomes are not product gifts, so the copy uses
"reward" throughout. The subject you wrote is otherwise unchanged:

| field | text |
|---|---|
| Subject | Spin the wheel for a free **reward** |
| Preview | Spin to reveal your **reward**. Qualifying purchase required. |
| Headline | A spin. A **reward**. Yours to reveal. |
| CTA | Spin now |

A test pins this to the live prize table, so if the wheel ever becomes
all-product the copy rule is revisited deliberately rather than drifting.

### End to end, against real infrastructure — 59/59 checks

`scripts/qa-wheel-campaign.mjs` walks the real path: real Postgres, the real
cron route, the real captured MIME, the real payment webhook. Not mocked.

- A **draft** campaign mails nobody, however many times the sweep runs.
- Scheduling promotes it and the sweep sends.
- The delivered message carries: the wheel image, one tracked click URL shared
  by the hero **and** the button, a per-recipient signature, an unsubscribe link,
  `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058 one-click), the
  CAN-SPAM postal address, a plain-text alternative, and no use of "gift".
- **A link scanner cannot spend a spin.** A GET of every URL in the message,
  as a Gmail/corporate proxy does, created no offer. `GET /api/spin` is 405.
  The draw is POST-only by design.
- One spin per customer: a second spin returns the same prize; **eight
  concurrent spins from eight IPs produced exactly one prize.**
- A tampered link is refused (400, not merely rate-limited).
- A **failed payment leaves the prize spendable**; the retry pays and redeems
  exactly once; a **replayed webhook does not redeem twice**.
- A purchaser is excluded from the audience on re-check.
- Unsubscribe: a GET changes nothing, the one-click POST suppresses, and the
  next campaign cannot reach them.

### It survives images being blocked

Most clients block images by default, so the email was rendered with every
image request aborted, at 800px and at 390px. The headline, all three
paragraphs and the **Spin now** button still render and remain clickable, the
hero's alt text shows in its place, and there is no horizontal overflow at
either width. The message works as text.

### Two defects found and fixed

**Eight of the sixteen wheel labels were upside down.** Labels are rotated to
follow their wedge; anything landing between 90° and 270° is rotated past
vertical. At the rendered 340px a 7px inverted label just looks like a label —
it only became obvious in the 2400px render made for the email. Fixed, with a
geometry test that fails with exactly `[8..15]` if the flip is removed.

**A prize under its floor vanished silently.** A customer who wins something
they were already buying got nothing, with no explanation. The pricing is
correct (the gift lifts a unit out of the paid lines, so the floor is judged on
what you actually pay) but three things were wrong:

- `offerWithdrawnBy` was set only for the welcome-code case; a floor failure
  reported `null`, indistinguishable from "no offer here".
- Cart and checkout computed the shortfall from the **gross** basket, a
  different number from the one the till enforces. Two KLOW at $119.99 reads as
  $227.98 against a $200 floor in the banner and $119.99 against it at the till.
- With the shortfall reading zero and the offer unapplied, checkout blamed the
  **email address**.

The quote now reports the figure it enforced, at both floor checks. Verified:

| case | gift | reason | shortfall |
|---|---|---|---|
| below floor from the start | none | `minimum` | $35.01 |
| below floor, different product | none | `minimum` | $60.01 |
| clears floor, prize not in cart | applied | — | — |
| prize in cart, absorbed under floor | none | `minimum` | $80.01 |
| prize in cart, enough paid | applied | — | — |

### Full suite

**11,201 passing** on the working branch. One pre-existing test was updated
where it pinned the old silent behaviour; its intent (never blame the code for
a floor) is still enforced.

---

## 3. The audience

| | count |
|---|---|
| Email-consented, not suppressed | 116 |
| …minus 10 with a paid order | **106 eligible** |
| …minus 77 holding a live unredeemed offer | **29 proposed** |

The 77 hold `winback_60_percent_15` (72) or `cart_recovery_bac_water` (15);
10 hold both. **These offers are live right now** — the most recent was minted
hours ago, so that automation is actively running.

You instructed: *"If an offer interaction remains unresolved, exclude affected
customers from the proposed first audience and report the exclusion count."*
The wheel-vs-existing-offer interaction **is** unresolved (you paused it), so
the proposed audience is **29**, with **77 excluded**.

**29 is small.** Three options, your call:

1. **Send to 29.** Honours your rule exactly. A weak test.
2. **Send to all 106**, accepting that 77 receive a second offer while holding
   a first. They do not stack at checkout — the offer cookie selects one — but
   it is a second promotional message on top of a live one.
3. **Wait** for the 77 offers to expire (latest expiry 16 October) and send to
   a larger clean pool.

I did not choose. Nothing about the build depends on which you pick.

---

## 4. Exactly what you must do to send

Four steps, in order. **None of them happen automatically.**

1. **Deploy the minimum wheel release.** See `README.md` beside this file — 36
   files, proven to build and pass 10,414 tests on top of `main`, containing no
   SMS and no Omnisend code. The SMS work stays unmerged, as you asked.
2. **Apply `src/lib/sql/spin-percent-cap.sql`** — adds a nullable
   `max_discount_cents`. Without it the percentage wedges are uncapped.
3. **Turn the wheel on**: control section `spin_wheel`, `enabled = true`, and
   set `campaignId` to a new id for this campaign. **This is the step that must
   not be forgotten** — with the wheel off, `attachSpinLink` returns the
   destination unchanged and every recipient lands on a 404.
4. **Create the campaign and schedule it.** `status = 'draft'` sends to nobody;
   moving it to `scheduled` with a `scheduled_at` is what arms it. The exact
   copy is in `src/lib/email/wheel-invitation-preview.test.ts`, CTA path
   `/spin`, hero `https://www.vantalabsresearch.com/images/spin-wheel-hero.png`.

Rollback: set `spin_wheel.enabled = false`. Immediate, no deploy. Prizes already
won stay redeemable, which is correct.

---

## 5. Blockers, failed checks and unverified assumptions

**I could not verify these. Do not treat them as done.**

- **Real inbox delivery.** I cannot send to Gmail or iCloud from here without
  sending real mail from production. The message was verified as captured MIME,
  not as a delivered inbox render.
- **DMARC.** DNS resolution is blocked from this container — my first attempt
  reported "no SPF/DMARC" purely because `dig` is not installed, which was
  meaningless. Via Resend's API both `vantalabsresearch.com` and
  `mail.vantalabsresearch.com` are **verified**, with **DKIM and SPF confirmed**.
  DMARC is not visible through that API and remains unchecked.
- **Reply-to is not configured.** Production has no `marketing_reply_to`, so it
  falls back to `orders@vantalabsresearch.com`. Resend reports **Receiving:
  disabled** on both domains, so whether that mailbox is monitored depends on MX
  I cannot read. You asked for a monitored inbox — please confirm this one is.
- **Tesamorelin has 5 units.** At 1-in-16 odds it is the one prize a campaign
  can exhaust. The admin panel flags it amber. Consider swapping the wedge or
  restocking before a larger send.
- **The SMS launch has three hard blockers**, confirmed against production and
  written up in `AUDIT-FINDINGS.md`: every SMS consent write fails silently
  because `sms_subscribers` has no `email` column; there is no inbound SMS
  handler at all, so a STOP never reaches the store; and the 15% code can be
  minted from an email alone with no phone number. **None of these touch the
  wheel campaign** — but none of them should meet a carrier review either.
- **Three prize products have no image**: `recon-water`, `glp-3`, `glp-2`. This
  does not affect the wheel email (which uses the wheel image) but does affect
  any template using product photography.
- **I could not photograph the SMS placements.** They render only for a
  signed-in customer whose `/api/offers/welcome` status is `eligible`; an
  anonymous visitor with a browse grant sees none of them. That is correct
  behaviour and worth knowing — no prompt is ever shown to someone the offer is
  not open to — but it means the visual walkthrough of those placements still
  needs a real customer session. The consent wording itself is verified below.

### The SMS consent wording, verbatim

`src/lib/sms-consent-text.ts`, shown beside every opt-in box:

> Yes, I would like to receive recurring automated marketing text messages from
> Vanta Labs at the number above. Consent is not a condition of purchase.
> Message frequency varies. Message and data rates may apply. Reply STOP to
> cancel at any time or HELP for help.

That carries all five elements a carrier review looks for: identified sender,
recurring/automated disclosed, consent-not-a-condition, frequency and rates,
and both keywords. The version string (`2026-09-16`) is stored on each consent
row, so a dispute can be answered with the text that person actually saw.

---

## 6. Ready for the Omnisend transition

- The **handoff switch already exists**: `OMNISEND_MARKETING_OWNER`. Unset means
  the in-house senders own marketing. Set true and the cart-recovery ladder,
  the retention automations and the campaign sender all stand down. One switch,
  one owner — the old and new systems cannot both send. The reasoning in the
  code is right: the two systems cannot coordinate, because the 24-hour
  frequency guard only knows about sends this site made and cannot see an
  Omnisend send. So the answer is ownership, not coordination.
- The whole Omnisend integration (~25 modules) is built and unmerged, as asked.
  **All nine Omnisend automations are disabled** — nothing there is sending.
  The flow-by-flow mapping is in `OMNISEND-MAPPING.md`. One thing in it needs
  fixing before anything is enabled: `VL · Welcome` and `VL · Welcome offer`
  have **no exit condition**, so a contact who subscribes and then buys would
  still receive *"Your welcome code: 15% off a first order"* on day three. Every
  other flow exits on purchase correctly.
- **What is currently sending, and the overlap with this campaign, is in
  `FLOWS-AND-OVERLAP.md`.** Short version: six email automations and a
  four-stage cart ladder are live; `welcome_no_purchase` already gives
  never-purchased subscribers 15% off on day three, which is the same list the
  wheel targets; a 24-hour one-marketing-email-per-address guard covers
  campaigns too, so nothing double-mails; the guard does **not** cover SMS,
  which must be closed before the SMS launch.
- **Templates still use one static image.** Every Omnisend template shares a
  single hero — the GHK-Cu home-page poster — and **no template uses
  per-product imagery at all**, so a cart email about GLOW shows a GHK-Cu vial.
  The product images *are* already synced to Omnisend (`catalog-payload.ts`),
  so the data exists and the templates simply do not reference it. Of 34 active
  products, 30 have a product image; **GLP-2 and Recon Water have none at any
  level**, and BPC-157 and GLP-3 have only a dose image to fall back on.
  I did not change the templates: regenerating them writes to your live
  Omnisend account, and you asked to see previews before anything is applied.

## 7. Not built

- The reusable wheel **campaign builder**. The panel added to Admin → Email
  gives you the kill switch, the campaign id, live results and the prize table
  with stock — read-only. Editing prizes and probabilities from a form means
  moving the prize table into the database, which is a real migration and a real
  question about prizes already awarded. Deliberately not faked.
- Omnisend template redesign with real product photography.
- Any day-3 / day-7 automatic enrolment. Explicitly out of scope, and absent.
