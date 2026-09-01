# Affiliate Email System — design

Date: 2026-09-01
Status: approved (owner decisions recorded below)

## The shape of the problem

The owner asked for a small email marketing platform for the affiliate
programme: mass sends, hand-picked sends, personalisation, desktop and mobile
preview, test sends, drafts, scheduling, duplicating an old campaign,
duplicate-send protection, and history with delivery and click reporting.

Almost none of that is new machinery. **This store already has a campaign
system**, built for customers, and it already solves the hard parts:

| Requirement | Already exists |
|---|---|
| Batched, resumable sending | `email_campaign_recipients` claim queue, `campaign-sender.ts` |
| Duplicate-send protection | `unique (campaign_id, email)` — re-queuing cannot double-send |
| Drafts / schedule / test send | `/api/admin/email/campaigns/[id]/send`, modes `now` / `schedule` / `test` |
| Opens, clicks, bounces, history | `email_campaign_clicks`, `email_send_log`, `getEmailDashboard` |
| Unsubscribe + CAN-SPAM address | `sendMarketingEmail` |
| Reputation separation from receipts | `resolveMarketingFrom` |
| "Which orders genuinely qualify" | `qualifiesForMonthlyTierCount` (`ambassador-commission.ts`) |

So the design is **an extension of the existing campaign system, not a second
one beside it.** A parallel affiliate mailer would mean a second queue, a second
suppression check and a second history — three chances for affiliate mail to
drift out of step with the compliance rules that took this codebase a long time
to get right.

What is genuinely missing is four things:

1. an affiliate audience (approved ambassadors, all, hand-picked, or by sales activity);
2. per-recipient personalisation — every campaign today renders one identical body;
3. several resource buttons per message, so affiliates can be handed links to
   product pages, sale pages, images, video and ad material;
4. history filtered to affiliate campaigns, with per-link click attribution.

## Owner decisions

**Consent — no opt-in gate.** Affiliates are business partners; requiring them
to appear in the *customer* marketing store (`customer_preferences.marketing_emails`
/ `marketing_subscribers`) would silently shrink "Send to all affiliates" to
whichever affiliates happened to tick a customer marketing box. So the audience
is built from `ambassadors` directly.

The unsubscribe link and `List-Unsubscribe` header stay, because affiliate
campaigns still route through `sendMarketingEmail`. Three reasons: the original
brief asked for unsubscribe/preferences; 15 U.S.C. § 7704 requires an opt-out
and a postal address on commercial mail regardless of the recipient's
relationship; and Gmail/Yahoo have scored bulk mail without `List-Unsubscribe`
worse since February 2024. Routing around the one wrapper that owns all three
would be building a deliberate hole in the compliance layer.

An affiliate who unsubscribes lands in `email_suppressions` and stops receiving
**promotional** mail only. Approval, commission, payout and account email are
transactional, use `sendEmail` directly, and are untouched by any of this.

**Competitions are OUT OF SCOPE.** An early draft of this design was built
around one example the owner gave — "first affiliate to 10 sales wins $500" —
and mistook it for a feature. It is one message an owner might send, not a
subsystem. There is no competition tracking, leaderboard, winner selection or
bonus payout here, and nothing in the composer is shaped around any particular
promotion. The owner writes the message; the system delivers it.

## Architecture

### 1. Schema (`src/lib/sql/affiliate-email-system.sql`)

Additive and idempotent, in the house style.

`email_campaigns` gains:

- `audience_kind text not null default 'customer'` — `customer` | `affiliate`.
  Defaulted so every existing row keeps its current meaning, and so the customer
  composer needs no change.
- `affiliate_filter text` — `all_active` | `selected` | `no_sales` | `has_sales`.
- `affiliate_ids uuid[]` — the hand-picked set when `selected`.
- `link_buttons jsonb` — the extra resource buttons (see section 5).

`email_campaign_recipients` gains:

- `ambassador_id uuid` — who this recipient is, for personalisation.
- `merge_context jsonb` — **a snapshot of the merge values taken at queue time.**

  The snapshot is the important decision. Commission percent and referral code
  can change between the moment the owner presses Send and the moment the sweep
  reaches row 4,000. Resolving merge values per batch would mean two affiliates
  receiving materially different claims about their own rate from one campaign,
  and would make the preview a lie. It also turns N per-recipient lookups into
  one read at queue time.

`email_campaign_clicks` gains `link_index` and `link_label`, so "which button
was clicked" is answerable. Null means the primary CTA — which is what every
existing row already means, so no backfill is needed.

No new tables. Nothing here has its own RLS to configure, because nothing here
is a new table: the campaign tables already deny anon and authenticated by
default and are reached only by the service role.

### 2. Merge variables (`src/lib/email/affiliate-merge.ts`)

Pure and testable, no database.

`{{first_name}}`, `{{referral_code}}`, `{{referral_link}}`,
`{{commission_percent}}`, `{{affiliate_dashboard_link}}`. Two older spellings
(`{{affiliate_code}}`, `{{dashboard_link}}`) resolve as aliases so a saved draft
cannot start rendering literal braces at a real affiliate, but they are kept out
of the composer's chip list so one idea has one name on screen.

Two rules that matter:

- **Unknown variables are rejected at compose time**, not silently left in the
  body. `{{firstname}}` reaching a real affiliate as literal text is the failure
  mode, and the composer is the only place it can still be fixed.
- **Substitution happens before `campaignTemplate`**, which escapes the body. So
  a merge value cannot inject markup — it goes through the same `escapeHtml`
  every other campaign body does.

Missing first name falls back to a neutral greeting rather than rendering an
empty space after "Hey ".

### 3. Affiliate audience (`src/lib/email/affiliate-audience.ts`)

Approved ambassadors, optionally narrowed to a hand-picked set or to those with
(or without) qualifying sales, **minus
`email_suppressions`** — subtracted up front for the same reason the customer
audience does it: so the count the owner sees before pressing Send is the truth
rather than an overestimate that quietly shrinks.

Deduped by email, so two ambassador rows sharing an address receive one message.
Reads are bounded (`readAllRowsBounded`) and a truncated read is fatal, matching
`audience.ts`.

The has-sales / no-sales groups count with `commissionOrderCounts`, extracted
from `qualifiesForMonthlyTierCount` so they use the SAME definition of a real
sale as the commission engine — a refunded or reversed sale is excluded from
both. A second copy of that rule would eventually congratulate someone whose
only sale was refunded.

### 4. Sending

`queueCampaign` branches on `audience_kind` and writes `ambassador_id` +
`merge_context`; `sendCampaignBatch` applies the merge per recipient. Everything
else — claiming, the reaper, the time budget, retries, suppression, the
unsubscribe footer — is unchanged and shared.

**Double-click protection** gets one addition. The unique constraint already
makes a second send harmless at the recipient level, but the status guard is
read-then-write and two simultaneous clicks both see `draft`. A conditional
status claim (`update ... where status in ('draft','scheduled','paused')`,
matching the claim pattern already used for recipient rows) makes the second
click return a clean 409 instead of appearing to succeed.

### 5. Resource buttons and per-link clicks

An affiliate email carries a primary CTA plus up to six extra buttons, stored as
`link_buttons` jsonb on the campaign — content of one message, edited and
versioned with it, never queried across campaigns.

Which links can be click-tracked is a security decision, not a convenience one.
The click redirect resolves its destination FROM THE CAMPAIGN ROW and normalises
it to this origin, and that is exactly what stops it being an open redirect on a
domain affiliates have been trained to click. So:

* a plain site path is tracked, with the link index inside the signed payload so
  a click cannot be re-attributed to another button by editing a URL;
* an off-site URL (an image folder, a video) is rendered as a plain link and
  never routed through the redirect;
* a personalised URL (`{{referral_link}}`) is also linked directly — its
  destination differs per recipient, and the click route has only the campaign
  row to work from, so it could not resolve it even if it wanted to.

Both untracked cases still work perfectly as links. They are simply not counted,
and the composer says so.

### 6. Admin UI

Two new tabs on `/admin/partners` (which is where affiliates live, and reads as
Admin → Affiliates → Email Affiliates). The tab entries are a small addition to
`admin-partners-client.tsx`; all real logic lives in two new focused components
so that file does not grow another thousand lines.

Confirmation before a mass send is a modal naming the exact recipient count.

## Testing

Unit: merge rendering and validation, audience resolution and suppression
subtraction, the sales-based groups against refunded and reversed commissions,
per-recipient personalisation through the real send loop, and the double-send
claim under two concurrent callers.

Regression: the existing suite, particularly the email and ambassador files,
must stay green — the whole point is that transactional mail is untouched.

Browser: the local harness per `website/docs/BROWSER-TESTING-RUNBOOK.md`, at
desktop and 390x844.
