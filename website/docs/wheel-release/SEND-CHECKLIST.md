# Send checklist — wheel invitation

Everything below is copy-pasteable. Nothing here runs by itself.

**Source of truth for the copy** is `src/lib/email/wheel-invitation-preview.test.ts`
(`WHEEL_CAMPAIGN_COPY`). It is repeated here for convenience; if the two ever
disagree, the test wins, because the test is what renders the preview.

---

## Before anything

- [ ] **Confirm the date.** Two clocks disagree (see HANDOFF §1). Decide between
      Thursday 17 September and Friday 18 September, noon ET.
- [ ] **Decide the audience.** 29 (excluding everyone holding a live offer) or
      106 (everyone eligible). See HANDOFF §3.
- [ ] **Confirm `orders@vantalabsresearch.com` is a monitored mailbox**, because
      marketing replies land there — no `marketing_reply_to` is configured.

## 1. Schema — BEFORE the deploy, not after

**This order is not interchangeable and my first draft had it backwards.**
`customer-offers.ts:882` names `max_discount_cents` in its select list, and
PostgREST answers 42703 for a column that is not there. Deploying first would
break EVERY offer lookup — including the `cart_recovery` and `winback` gifts
live in production right now. The migration is additive and nullable, so the
code already running cannot see it.

## 2. Deploy

- [ ] Merge the wheel-only release. **Vercel deploys on every push to `main`**
      (see `.github/workflows/checks.yml`), so merging *is* deploying.
- [ ] Confirm `/spin` returns **404** in production. It should: the wheel is
      still off. If it renders, something enabled it early.

## 2b. Schema (reference)

```sql
-- src/lib/sql/spin-percent-cap.sql — additive, nullable, safe to re-run.
alter table public.customer_offers
  add column if not exists max_discount_cents integer;
```

- [ ] Applied.
- [ ] `select count(*) from customer_offers where max_discount_cents is not null;`
      returns 0 — nothing existing was touched.

## 3. Turn the wheel on

Control store, section `spin_wheel`. Admin → Control Centre, or:

**Prefer the admin screen.** If you write SQL instead, the `action` must be
exactly `admin_control_upsert`. The `admin_control_current` view filters on it:

```sql
select ... from admin_audit_logs where action = 'admin_control_upsert' ...
```

Any other action value inserts a row the view ignores, so the setting silently
does not take — which here means the wheel stays off and every recipient lands
on a 404. I made this exact mistake while testing, which is why it is called out.

```sql
-- Pick a NEW campaign id. Reusing an old one lets everyone who already span
-- under it spin again.
insert into public.admin_audit_logs (action, target_table, target_id, metadata, created_at)
values ('admin_control_upsert', 'spin_wheel', 'campaignId',
        jsonb_build_object('value', 'winback_2026q4'), now()),
       ('admin_control_upsert', 'spin_wheel', 'enabled',
        jsonb_build_object('value', true), now());

-- Then PROVE it took, rather than assuming:
select target_id, metadata->>'value'
  from admin_control_current
 where target_table = 'spin_wheel';
-- must return campaignId and enabled=true. If it returns nothing, the action
-- value was wrong and nothing has changed.
```

- [ ] Set. **This is the step that must not be forgotten** — with the wheel off,
      the email's button is not personalised and every recipient lands on a 404.
- [ ] `/spin` now renders (it will say the link is invalid without a token —
      that is correct).
- [ ] Admin → Email shows the wheel panel reading **Live**.

## 4. Create the campaign as a DRAFT

Compose it in Admin → Email. A campaign with `status = 'draft'` sends to nobody
however often the sweep runs — verified.

| field | value |
|---|---|
| Name | `Spin the Wheel — first reward` |
| Subject | `Spin the wheel for your reward` |
| Preview text | `Spin to reveal your reward. Qualifying purchase required.` |
| Headline | `A spin. A reward. Yours to reveal.` |
| CTA label | `Spin now` |
| CTA path | `/spin` |
| Segment | `account_no_order` (signed up, never ordered) |
| Offer | **none** — the wheel mints the prize, not the send |
| Hero image URL | `https://www.vantalabsresearch.com/images/spin-wheel-hero.png` |
| Hero image alt | `The Vanta Labs reward wheel: sixteen wedges including free GHK-Cu, KLOW, GLOW, Recon Water, free shipping and percentage discounts.` |

Body (three paragraphs, blank line between each):

```
Your first Vanta order could come with something extra. Spin the wheel to reveal your reward, then shop and redeem it with a qualifying order.

Every spin wins. Sixteen wedges, 15 rewards — free vials, free shipping and a discount or two. One spin per customer, and the result is saved to your account.

Your reward expires 72 hours after you spin. Every reward is redeemed against a qualifying order — the exact minimum for the reward you land on is shown before you spin, and again in your cart.
```

- [ ] Draft saved.
- [ ] The hero image loads from production — open the URL directly.
- [ ] Audience preview shows the count you expect.

## 5. Send yourself a test

- [ ] Test send received.
- [ ] The **Spin now** button and the **wheel image** both go to
      `/api/email/click?...` and land on `/spin?t=...` with a token.
- [ ] Spin it. The prize is revealed, saved, and the countdown starts.
- [ ] Open the same link again — it shows the same prize, does not re-spin.
- [ ] Add the prize's qualifying order to a cart and confirm the reward applies.

## 6. Schedule

Only after the preview is approved.

- [ ] Set `status = 'scheduled'` and `scheduled_at` to the confirmed instant:
      `2026-09-17T16:00:00Z` (Thu 17 Sep, 12:00 ET) **or**
      `2026-09-18T16:00:00Z` (Fri 18 Sep, 12:00 ET).
- [ ] Re-check exclusions immediately before. **This matters more than an
      earlier draft of this document said, and the correction is the point.**

      That draft claimed "the sender already re-resolves the audience at send
      time". It does not. `queueCampaign` resolves the audience **once**, when
      the campaign is queued, and never re-derives it — the comment on it says
      so plainly, and explains why (recomputing per batch would move people in
      and out of a segment mid-send).

      So the two exclusions behave differently, and only one of them is
      self-healing:

      | exclusion | when it is enforced | safe to rely on? |
      |---|---|---|
      | unsubscribed / suppressed | **every send**, and it fails closed (`sendMarketingEmail`, marketing.ts:215) | yes |
      | already purchased | **only at queue time** | no — re-check by hand |

      The send tail is real: the previous campaign delivered 78 in its first
      hour and 10 more over the following 32 hours. Anyone who buys inside that
      window still receives the invitation, because the list was fixed when the
      campaign was queued.

      Queue it at the moment you intend to send, not hours ahead, and the
      window is as small as it can be.

## While the campaign is live

Three things behave in ways worth knowing BEFORE they surprise you. All three
were established by reading the code and confirmed by an adversarial pass; none
is a bug to fix today.

### Do not change a wedge's REWARD IDENTITY while prizes are live

Safe at any time: relabelling a wedge, reordering the wheel, appending a wedge,
retuning `minSubtotalCents` or `maxDiscountCents`.

**Not safe:** changing a wedge's `reward.kind`, its `productSlug`, or its
`percent` — for a wedge somebody has already drawn. `prizeForOfferRow` matches a
stored offer back to a wedge on exactly those three fields and nothing else. If
it cannot find a match, `readExistingSpin` returns null, the re-insert hits the
unique index, and that customer gets a 503 telling them to try again — for as
long as the mismatch stands. Their prize row is fine; the page just cannot
describe it any more.

If a slug genuinely has to change mid-campaign, revoke the affected rows first
(`revoked_at`), which is the documented way support hands somebody a fresh spin.

### A PARTIAL send failure still reads "sent"

`campaign-sender.ts:801` marks a campaign `failed` only when NOTHING was
delivered and at least one recipient refused. A partial failure deliberately
stays `sent`, and the reasoning is sound — the people who did receive it really
did receive it, and "resend" would mail them twice.

The consequence is that per-recipient failures are not visible on the campaign
row. They are in `email_campaign_recipients`, so look there rather than at the
status:

```sql
select status, count(*), min(error) as example_error
  from public.email_campaign_recipients
 where campaign_id = '88016d5a-cea5-491b-84d2-bdabe4e7a041'
 group by status;
```

### The ~10% who are deferred can buy before they receive it

The 24-hour frequency guard defers anyone who has had a marketing email in the
last day. On the previous campaign that was 10 of 88; for this one it is about
14 of 103, measured on the morning of the send.

Deferred is not dropped — they go out over the following day or two. But the
audience was frozen at queue time and the send path re-checks only
non-mailability, suppression and the frequency guard, never purchase state. So
a deferred recipient who places their first order inside that window still
receives an invitation addressed to someone who has never ordered.

Small, and worth knowing rather than discovering from a reply.

## Rollback

Set `spin_wheel.enabled = false`. Immediate, no deploy. `/spin` and `/api/spin`
both 404. Prizes already won stay in `customer_offers` and stay redeemable,
which is correct — pausing a promotion should not confiscate a prize somebody
won. To withdraw those too, set `revoked_at`; the checkout already honours it.

## Explicitly NOT part of this send

- No reminder campaign. You said not yet, and none is built.
- No SMS. Unmerged and disabled.
- No automatic enrolment of new subscribers into a spin.
