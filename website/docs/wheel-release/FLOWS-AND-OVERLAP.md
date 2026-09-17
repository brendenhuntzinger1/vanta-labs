# What is sending today, and whether the wheel collides with it

Read off production, not off the docs.

## Live email automations

`email_automations`, as production has them right now:

| key | on? | delay | offer it carries | subject |
|---|---|--:|---|---|
| `welcome_intro` | **yes** | 1 day | — | Search any batch before you order |
| `welcome_no_purchase` | **yes** | 3 days | `winback_60_percent_15` | Before your first order |
| `post_purchase` | **yes** | 14 days | — | Your order, and how to get the most from it |
| `replenishment` | **yes** | 30 days | `winback_60_free_shipping_10` | Ready to restock? 10% off + FREE Shipping |
| `winback_30` | **yes** | 40 days | `winback_60_bac_water_15` | Your next Vanta order just got better |
| `winback_60` | **yes** | 50 days | `winback_60_free_ghkcu` | A free GHK-Cu with your next order |
| `browse_abandonment` | no | — | — | Still looking at {{product_name}}? |

Plus the **cart-recovery ladder**, all four stages enabled: 30 minutes, 12h,
24h, 72h, at 10% with a 48-hour coupon expiry.

So: **six email automations and a four-stage cart ladder are sending today.**
This is the "current business running" you asked me not to disturb, and I have
not.

## The collision, named

`welcome_no_purchase` fires **three days after consent, to subscribers with no
order**, and hands them **15% off** (`winback_60_percent_15`).

The wheel invitation's audience is **subscribers with no order**.

They are the same people. That automation is what minted the 72 live
`winback_60_percent_15` offers sitting in the proposed audience — the most
recent a few hours before this was written. It is not a hypothetical overlap;
it is the same list, actively being mailed.

## What already stops them piling up

A real guard exists and campaigns are inside it.

**No address receives more than one marketing email in 24 hours, whoever is
sending.** It is enforced in the database (`marketing_send_claim`), takes a lock
on the address, and every marketing sender goes through the one function that
makes the claim — so two senders racing for one inbox serialise rather than both
deciding nobody mailed recently.

A campaign recipient who loses that race is **parked, not dropped**: the row
goes back to pending with `deferred_until`, no attempt is counted, and the
campaign cannot close as `sent` while somebody is still owed the message.

Transactional mail — receipts, shipping, auth, billing — is not gated by any of
this and never waits. That separation is correct and already in place.

### So the wheel campaign will not double-mail anyone within 24 hours.

Verified in the campaign sender: `claimMarketingSend` is called per recipient
before the send.

## The two gaps worth knowing

**1. Twenty-four hours is the only cap.** There is no weekly or monthly
frequency limit. A new subscriber can legitimately receive `welcome_intro` on
day 1, `welcome_no_purchase` on day 3, and the wheel invitation on day 4 —
three promotional emails in four days, none of them breaking the rule. That is
a judgement call for you, not a bug.

**2. The guard is email-only.** The rule as written is "one marketing *email*"
and it gates `sendMarketingEmail`. SMS does not pass through it. That costs
nothing today because SMS is not live, but it means **the cross-channel
coordination you asked for does not exist yet** — an SMS and an email could
reach the same person in the same minute. This needs closing before the SMS
launch, not before the wheel.

## The handoff to Omnisend

One switch, already built: **`OMNISEND_MARKETING_OWNER`**.

Unset (today) means the in-house senders own marketing. Set to `true` and the
cart-recovery ladder, the retention automations and the campaign sender all
stand down and log the same phrase. The reasoning in the code is worth keeping:
coordination between the two systems is impossible because the 24-hour guard
only knows about sends the site made and cannot see an Omnisend send. So the
answer is ownership, not coordination — exactly one of them sends.

That is the mechanism that stops old and new both mailing. It is the right
shape. What is not yet done is the mapping of each flow above onto a specific
Omnisend automation, and confirming an import will not restart a welcome flow
or replay old purchases — that work is unmerged and still to be verified.

## Recommendation for tomorrow

Nothing here blocks the wheel send. The 24-hour guard does its job, and a
deferred recipient still gets the message.

The thing to decide is not technical: subscribers who have not bought are
already receiving a 15% offer on day three. The wheel is a second offer to the
same list. Whether that is reinforcement or noise is your call, and it is the
same decision as the 29-versus-106 audience question.
