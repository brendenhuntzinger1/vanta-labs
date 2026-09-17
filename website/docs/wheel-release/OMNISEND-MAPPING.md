# Every marketing flow, mapped to its Omnisend replacement

Both sides read live: the in-house side from `email_automations` in production,
the Omnisend side from the Omnisend API on 2026-09-17.

**All nine Omnisend automations are `isEnabled: false`.** Nothing there is
sending. Every flow below exists, is built, and is dark.

## The mapping

| In-house (live today) | delay | offer it carries | → Omnisend flow | Omnisend state |
|---|--:|---|---|---|
| `welcome_intro` | 1 day | — | **VL · Welcome** | disabled |
| `welcome_no_purchase` | 3 days | `winback_60_percent_15` | **VL · Welcome offer** | disabled |
| cart-recovery ladder (30m / 12h / 24h / 72h) | — | 10%, 48h expiry | **VL · Abandoned cart** | disabled |
| *(no in-house equivalent)* | — | — | **VL · Abandoned checkout** | disabled |
| `browse_abandonment` *(off)* | — | — | **VL · Browse abandonment** | disabled |
| `post_purchase` | 14 days | — | **VL · Post-purchase** | disabled |
| `replenishment` | 30 days | `winback_60_free_shipping_10` | **VL · Replenishment** | disabled |
| `winback_30` + `winback_60` | 40 / 50 days | bac water / free GHK-Cu | **VL · Win-back** | disabled |
| *(no in-house equivalent)* | — | — | **VL · Sunset** | disabled |

Transactional mail — receipts, shipping, delivery, auth, account and billing —
is **not** in this table and must not be. It does not go through
`sendMarketingEmail`, is never frequency-gated, and stays on Resend.

## What does not line up, and matters

### 1. Two welcome flows never stop when someone buys

`VL · Welcome` and `VL · Welcome offer` both have **`exitConditions: []`**.

Every other flow exits properly: Win-back exits on `paid for order`, Abandoned
cart exits on `placed order` and `started checkout`, Abandoned checkout exits on
`placed order`, Browse abandonment exits on all three.

So a contact who subscribes and buys the next day would still receive, on
day three, an email whose subject is *"Your welcome code: 15% off a first
order"* — for an order they have already placed.

That is precisely the thing you asked to be prevented: *"Successful payment must
stop inappropriate recovery and first-order messages."* **Add
`paid for order` as an exit condition to both before either is enabled.**

### 2. Replenishment timing differs

In-house fires at 30 days; the Omnisend flow waits 45. Not wrong, but it is a
change in behaviour at cutover rather than a like-for-like move — worth a
deliberate decision rather than discovering it later.

### 3. Win-back is two stages in-house, one flow in Omnisend

In-house: `winback_30` at 40 days with a bac-water gift, `winback_60` at 50 days
with a free GHK-Cu. Omnisend: one flow with an internal 30-day delay and a
segment split. The ladder shape is preserved; the offers attached to each rung
are not obviously the same. Check the rungs match before cutover.

### 4. Omnisend flows send SMS; the in-house ones never did

Abandoned cart, abandoned checkout, welcome and win-back all contain
`sendSms` steps. Every one carries `isStopKeywordIncluded: true` and
`"Reply STOP to opt out."`, and every flow is gated
`sendingThresholds: {email: "subscribed", sms: "subscribed"}` — so no contact
receives a text without an SMS subscription. That is the right shape.

But it means **cutover is also the moment SMS starts**, unless those steps are
removed first. Given SMS is awaiting carrier approval, the flows should either
stay dark until it lands, or ship with the SMS steps removed and re-added later.

### 5. Sunset is new

There is no in-house equivalent. It tags `engaged` or `sunset` based on a click
in a seven-day window. Nothing to migrate; just be aware it will start doing
something that nothing does today.

## The cutover mechanism

One switch: **`OMNISEND_MARKETING_OWNER`**. Unset today, so the in-house senders
own marketing. Set to `true` and the cart-recovery ladder, the retention
automations and the campaign sender all stand down and log the same phrase.

The reasoning in the code is sound and worth preserving: the two systems cannot
coordinate, because the 24-hour frequency guard only knows about sends this site
made and cannot see an Omnisend send. So the answer is ownership, not
coordination — exactly one system sends.

### The order that follows from that

1. Fix the two missing exit conditions (§1).
2. Decide the replenishment delay (§2) and check the win-back rungs (§3).
3. Decide what happens to the SMS steps (§4).
4. Enable the Omnisend flows **and** set `OMNISEND_MARKETING_OWNER=true` in the
   same change. Doing either alone is the failure mode: flows on with the switch
   unset means both systems send; the switch set with flows off means nobody
   does.
5. Watch `email_send_log` for the in-house senders going quiet.

## Still to verify before any of that

Not done, and not safe to assume:

- That importing contacts will not re-trigger `VL · Welcome` for existing
  subscribers. Its trigger is `subscribed to marketing`, and whether an import
  counts as that event is the single most important thing to test — getting it
  wrong mails the whole list a welcome sequence.
- That historical purchase events replayed into Omnisend do not fire
  Post-purchase or Replenishment retroactively.
- Reconciliation counts: contacts, consent state per channel, suppressions and
  unsubscribes matching on both sides before and after.

These are the remaining Omnisend work. None of them block tomorrow's wheel
campaign, which does not touch Omnisend at all.
