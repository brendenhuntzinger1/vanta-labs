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

## 1. Deploy

- [ ] Deploy the minimum wheel release (`minimum-wheel-release.patch`, 36 files).
      The SMS/Omnisend work stays unmerged.
- [ ] Confirm `/spin` returns **404** in production. It should: the wheel is
      still off. If it renders, something enabled it early.

## 2. Schema

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

```sql
-- Pick a NEW campaign id. Reusing an old one lets everyone who already span
-- under it spin again.
insert into public.admin_audit_logs (action, target_table, target_id, metadata, created_at)
values ('control.update', 'spin_wheel', 'campaignId',
        jsonb_build_object('value', 'winback_2026q4'), now()),
       ('control.update', 'spin_wheel', 'enabled',
        jsonb_build_object('value', true), now());
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
| Subject | `Spin the wheel for a free reward` |
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
- [ ] Re-check exclusions immediately before: anyone who has since purchased or
      unsubscribed must drop out. The sender already re-resolves the audience at
      send time, and a purchaser was verified to drop out on re-check.

## Rollback

Set `spin_wheel.enabled = false`. Immediate, no deploy. `/spin` and `/api/spin`
both 404. Prizes already won stay in `customer_offers` and stay redeemable,
which is correct — pausing a promotion should not confiscate a prize somebody
won. To withdraw those too, set `revoked_at`; the checkout already honours it.

## Explicitly NOT part of this send

- No reminder campaign. You said not yet, and none is built.
- No SMS. Unmerged and disabled.
- No automatic enrolment of new subscribers into a spin.
