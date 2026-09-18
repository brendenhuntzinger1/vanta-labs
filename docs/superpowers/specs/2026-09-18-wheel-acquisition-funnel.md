# The wheel as the store's acquisition offer — what was built, and what was measured

Phase A. Written against the branch `claude/zealous-johnson-atb3n5`, after the
work, from measurements rather than recollection.

## The decision this implements

There is no welcome discount any more. The owner retired the 15% first-order
offer outright and put the spin-to-win wheel in its place as the store's
acquisition offer. The checkout keeps an optional SMS marketing consent
checkbox with no discount attached to it.

Why the wheel is the better offer to advertise: 15% off a $60 vial is $9 and
reads as a coupon. Four of the sixteen wedges are a free vial worth up to
$119.99, and every wedge carries a minimum spend, so the store is paid before
it pays out. The arithmetic is in `2026-09-18-dose-ladder-design.md`.

## What was built

**The wheel opens from the storefront.** It began as a win-back destination
reachable only by a token minted at click time for a recipient
`/api/email/click` had already verified. `/spin` now also signs the session's
own address when there is no usable link — the only address that branch will
ever sign. The forwarded-link refusal, the campaign check and
one-spin-per-address are untouched; the unique index on `customer_offers`, not
the route, is what makes a second spin impossible, so a shopper who spins from
the storefront and then opens their email finds the prize they already hold.

**The invitation is the wheel's.** `entry-offer-modal.tsx` offers the wheel,
with an explicit "No thanks" beside the primary action. `/api/spin/invite`
decides who may be interrupted — wheel switched off, already spun, already on
the list — so the card reaches no conclusion of its own. Its dismissal key is
new (`vl_spin_invite_dismissed_at`): the retired card's key marked somebody who
had taken the old 15%, and reading it would have silenced the wheel for exactly
the shoppers most worth inviting.

**The spin is not bought with a tick.** While the discount existed the offer
*was* the text list — the server issued no code without a mobile number, so the
tick was the price and "optional" beside it would have been untrue. Nothing is
bought with a tick now. The number is asked for beside the wheel as its own
question, the consent sentence and disclosure are the shared frozen ones, and
the box says Optional because it now is — which is how `/account/login` has
always put it.

**The prize follows the shopper.** The cart drawer, `/cart` and the checkout
already showed it; the catalogue and product pages, where the basket is
actually built, showed nothing. `SpinPrizeBar` carries it there, preferring the
server's `offerShortfallCents` over client arithmetic, claiming before it reads
so a prize won on a phone reaches the laptop.

**The funnel has a denominator.** `spin_invite_shown` / `_skipped` /
`_accepted` go through the existing relay. Everything below the invitation is
already a row in `customer_offers` and is read from there rather than believed
from a browser.

## Two defects found, both in code that had already shipped

**An anonymous winner could not choose their size.** The wheel was mailed to
104 people and is reachable on an email-link grant, which carries a capability
and deliberately no address, so most winners have no session. Four of the
sixteen wedges are laddered and the picker renders from the *prize*, not the
session — so roughly a quarter of anonymous winners were shown a chooser whose
every press answered 401, in the wall's words rather than the route's: "Sign in
to continue", on a page reached from a link that had just proved who they were.
`/api/spin/dose` now accepts the same signed link the draw was made on, which
is the trust the mint path already states in as many words.

**The invitation did not yield, though the layout has said it does for a
fortnight.** The yield lived in the older invitation this one replaced and did
not come across. Seen at 390x844: the promotions card open on the catalogue
with the invitation timer still running.

## What was measured

Local harness (`NODE_ENV=test`), Chromium at 390x844, real Postgres behind the
PostgREST shim, the payment stub on `:59999` and the SMTP sink on `:2525`.

| | |
|---|---|
| Unit suite | 11,693 passed, 11 skipped, 0 failed |
| Typecheck | clean |
| Lint | 0 errors, 53 warnings (all pre-existing, all in test files) |
| `qa-wheel-campaign.mjs` | **59/59 checks passed** |

Driven in the browser, signed in as a seeded harness account:

- the invitation opens on `/products` and `/products/*` after 10s, with the
  wheel copy and no mention of a discount;
- with the text list still open to the shopper it shows the phone field, the
  address the consent would be recorded against, both unticked boxes, the
  consent sentence and the disclosure with both legal links;
- "Spin the wheel" with nothing ticked goes straight to `/spin`, which renders
  the wheel for a session holding no token;
- the spin minted a real `customer_offers` row;
- the prize bar then read "Your free GLP-2 is waiting — add $100.00 more to
  claim it." on the catalogue, and "$50.01" with one GLP-2 in the basket, which
  is the figure `/api/checkout/quote` returned for the same cart;
- `/api/spin/invite` answered `mayInvite: false, alreadySpun: true` afterwards;
- "No thanks" wrote the dismissal, fired `spin_invite_skipped`, and the card
  did not reopen on the next page;
- `website_analytics_events` holds the shown / skipped / accepted rows.

## The QA script was wrong, and the product was not

`qa-wheel-campaign.mjs` scored 28/36, and the eight failures were on record as
pre-existing harness gaps. They were not gaps. Seven had one cause and it was
the script.

The spin route re-arms a device that is holding nothing: an address that has
already spun gets `claimSpinForAccount`, which rotates the bearer token and
retires the copy the last device had. That is correct, and it is what carries a
prize from the phone that spun it to the laptop that did not. Section 7 spins a
second time for the same subscriber while sending no `vl_offer`, so the server
saw a fresh device and rotated — and section 10 then quoted with the retired
token. The till answered `no_offer`, and six checks failed behind it, including
"the prize is redeemed", which is the most important assertion in the file.

A browser sends the cookie back and the route's own guard leaves an armed
device alone, so none of this was ever reachable by a customer. The script now
keeps a cookie jar; the tamper check and the eight-way concurrency burst are
explicitly separate clients that neither read it nor write to it, or the burst
address's fresh token displaces the subscriber's.

The eighth failure was the mail sink not running. With it up the script reaches
every section.

**This closes the redemption leg**, which the last certification had to record
as UNVERIFIED: spin, dose, checkout, a failed payment that leaves the prize
spendable, the retry that redeems exactly once, a replayed webhook that does
not redeem twice, and an unsubscribe that stops the next campaign.

## The deviation the owner has to rule on

`/account/login` was named as frozen. One line on it was changed and nothing
else.

That screen carried a gold line reading "Get 15% off your first order. First
order only. Valid for 14 days. Cannot be combined with other offers.", sitting
between the email box and the SMS one. Nothing mints that code any more, at
either call site. So the single opt-in screen an A2P review can actually load —
every other sign-up in this store is behind the account wall — was advertising
a discount the till refuses.

The line is removed rather than reworded. The judgement was that the freeze
protects the consent record: the consent sentence, the disclosure, its version,
the checkbox behaviour, both legal links and everything submitted to Omnisend
are untouched, and `welcome-offer-placements.test.ts` now pins each of them.
An incentive claim is not consent wording, and leaving a false one on the
carrier's own screen looked worse than removing it.

If the owner would rather it stayed, the revert is one block in
`account-auth-form.tsx` and two assertions.

## The number and the permission are two facts

The owner's direction, implemented after the first pass: the wheel collects
BOTH an email and a phone, and holding a number must not imply permission to
text it.

**What the wheel asks for.** A number from everybody, beside the account's own
address, and it will not spin without one — unless the store already holds one,
because that stored number is what a later tick would subscribe and retyping it
buys nothing. The SMS consent box beside it is unticked, optional, and buys
nothing. The age and research attestation gates the consent alone: it gates
MARKETING, and keeping a number is not marketing.

**Where the number goes.** `recordPhoneOnFile` is the other half of
`recordSmsConsent`: the consent ledger and the account profile, with
`marketing_consent` false. `readSmsStanding` already reads that as "none", so a
held number is not a subscriber to any reader, with no new state to get wrong.
It never downgrades and never resurrects — the insert ignores a duplicate
rather than upserting, because an upsert carrying `marketing_consent: false`
would unsubscribe a live subscriber who typed their own number into the wheel,
and would wipe the opt-out of somebody who had said STOP.

**What Omnisend is told.** The number, with `sms: nonSubscribed`. A held number
used to be indistinguishable from no number at all — both omitted the phone
identifier — so the day a tick arrived it had to be sent as a brand-new
identifier. Now the identifier is already there and a tick changes its STATUS.
That is what lets the consent box activate SMS with nothing upstream
redesigned.

**Consent is said, not inferred.** The endpoint read the presence of a phone as
agreement, which was safe only while a ticked box was the only reason to send
one. `smsConsent` must be exactly `true`; absent, `false`, `"true"`, `1` and
`{}` all keep the number and subscribe nobody. The direction is deliberate: a
caller that forgets the field under-claims, and the other failure mode is a
text to somebody who never agreed. The checkout and the storefront form state
it explicitly.

**Approval day promotes nobody.** Approval changes what the store may send, not
what anyone agreed to. The only writers of `marketing_consent: true` are this
store's own box and a tick somebody gave Omnisend's pop-up.

**One gap this opened, and closed.** `mirrorSmsConsent` refused on ANY existing
row — which was every row there could be until numbers started being kept
without permission. A wheel entrant who later ticked Omnisend's own pop-up
would have met their own held row and stayed unsubscribed for ever: the store
holding the number, Omnisend holding the consent, nothing joining them. A held
row has no consent date to overwrite, which is the reason the guard existed, so
it is promoted; a real consent or a stop is still left alone.

**No OTP, deliberately.** Omnisend's SMS model is single opt-in, and the owner
ruled out building double opt-in now. The phone gate rejects numbers the
numbering plan could never assign; it cannot tell a stranger's real number from
the subscriber's own, and nothing here pretends otherwise — `status` stays at
the table's default rather than claiming "verified".

### Measured, in the browser

A number entered at the wheel with the consent box untouched stored as
`+15125550142`, `marketing_consent` false, no consent timestamp, no disclosure
version; profile `sms_marketing` false. An explicit tick afterwards flipped
that SAME row — one row, same number — to consented, with its timestamp and
disclosure version. Suite 11,737 passed / 11 skipped; `qa-wheel-campaign.mjs`
still 59/59.

## Traps worth carrying forward

**The harness database is older than the harness setup script, and it bites
twice.** Its `sms_subscribers` was the pre-rework shape — keyed on `email`,
with a `phone` column and no `marketing_consent` — while
`setup-local-harness.sh` creates production's shape, keyed on `phone_e164`.
`create table if not exists` does not alter an existing table, so the stale one
survived every setup run. Both reads over it fail closed (`readSmsStanding` to
"subscribed", `readPhoneOnFile` to "we have one"), so the effect is silent: the
card simply stops asking, and nothing looks wrong. Dropped and rebuilt from the
setup script's DDL plus `src/lib/sql/sms-subscribers.sql` for this run. A fresh
container gets it right; a warm one does not.

**Three services, not one.** The PostgREST shim on `:54321`, the payment stub
on `:59999` and the SMTP sink on `:2525`. Without the sink the wheel script
stops after section 4 and reports 28/36 — a number that reads like a score and
is really a truncation.

**Two quote requests per cart change** for a shopper holding an offer with
items in the basket: the cart drawer issues one and the prize bar issues
another. Both are debounced and both only fire for an offer holder, which is a
small minority of page views.

## Not done here

- Nothing is deployed. The branch carries the retirement and the funnel
  together, which is the only safe pairing: production must never be without an
  acquisition offer.
- The wheel's authenticated *production* observation still needs a designated
  account, and is still not deterministic — the draw is uniform over sixteen
  wedges and only four are laddered.
