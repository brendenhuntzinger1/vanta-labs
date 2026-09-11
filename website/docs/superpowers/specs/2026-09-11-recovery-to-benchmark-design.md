# Recovery programme to benchmark — design

Date: 2026-09-11
Status: approved in principle by the owner in chat; this is the written spec
for review before implementation. Evidence is from production
(`mlpimwgkwuqpsvsrlpqv`, read-only), Resend, public DNS, and `main` at 7f1e78d.

Scope: abandoned-cart recovery, the welcome flow's measurement, a new browse
abandonment flow, and the measurement that decides whether any of it works.
Nothing here changes payments, orders, suppression, consent or the guest grant.

## 0. Decisions the owner has already taken

These are inputs to the design, not open questions.

| Decision | Consequence here |
|---|---|
| Benchmarks: Klaviyo abandoned-cart average is the floor, top decile the target | §3 defines the metrics so they can be read against those numbers |
| Sender test is "Brenden at Vanta Labs" vs "Vanta Labs", same address, same domain, DNS untouched | §4: display name is the only variable |
| Both metric families: benchmark-comparable and strict | §3 reports both, side by side, never blended |
| Bot and privacy opens must not flatter the system | §3.2: every open and click is stored with what fetched it, and classified at read time |
| Browse abandonment: simple, consented, no incentive, no annoying collisions | §6 |
| Holdout deferred | none built; §3.6 says how incrementality is read without one |
| No migration to Klaviyo or Omnisend | nothing leaves the repo; §9 lists what would change that |
| Seed sends authorised, limited to controlled seed addresses | §5 |
| The goal is profitable recovered orders, not Primary-tab placement or opens | success criteria in §4.4 and §6.6 are orders and gross profit; placement is diagnostic only |

## 1. Where the system stands

Real customers only; the owner's test addresses excluded. "New system" means
sends after the guest grant and click-based attribution shipped on 2026-09-08.

| Window | Sends | Opened (any) | Opened ≥60 s after send | Clicked | Restored | Attributed orders |
|---|---|---|---|---|---|---|
| New system, 09-08 to 09-10 | 39 | 15 | 10 | 0 | 0 | 0 |
| September to date | 74 | 35 | | 1 | 0 | 0 |
| Welcome flow, September | 95 | 19 | | 0 | | 0 |

Against the benchmark, per email sent:

| Metric | Klaviyo average | Top decile | Us, benchmark-style | Us, strict |
|---|---|---|---|---|
| Open | 50.5% | | 38% | 26% |
| Click | 6.25% | 13.33% | 0% (new), 1.4% (Sept) | same |
| Placed order | 3.33% | 7.69% | 1.4% (Sept) | 0% |

What is proven sound and is not being touched: the delivered message carries the
correct tracked link and gift token; the production click route answers with a
redirect to the restore page; the guest-grant journey passed 34 adversarial
checks on the harness on 09-08; zero bounces and zero complaints on the
marketing subdomain since 09-01.

What the data says the constraint is: the envelope. Welcome and cart recovery
have different offers, different copy and different timing, and identical
outcomes. Every message goes out as "Vanta Labs" from `news@` on a subdomain
created 2026-09-02, as a dark card with product images, to an audience that is
~80% Gmail. Placement cannot be seen from the provider ("delivered" means
accepted) and the connected Gmail account receives none of this mail.

Volume: ~11 carts a week with an address, ~35–40 recovery sends a week. At the
Klaviyo average, 150 delivered sends yield ~9 clicks and ~5 orders; at the top
decile ~20 and ~12. Below ~150 sends the benchmark cannot be read.

## 2. Goals and non-goals

Goals, in priority order:

1. Know, per delivered email, how many humans engaged, restored a cart, started
   checkout, paid, and what that was worth after incentives and cost of goods.
2. Move that funnel to the Klaviyo average within one measurement window
   (~150 delivered sends), and toward the top decile after.
3. Add the third of the three flows that produce most automated revenue.

Non-goals: open rate as a success metric; Gmail Primary placement as a goal;
any DNS, domain or provider change during the sender experiment; a holdout;
SMS; migrating to a third-party ESP; rewriting the offer ladder, the guest
grant, suppression, consent or frequency rules.

## 3. Measurement

### 3.1 Denominators

- **Sent**: a row in `email_send_log` with status `sent` (cart recovery also in
  `abandoned_cart_emails`).
- **Delivered**: an `email.delivered` event in `email_delivery_events` for the
  send's `provider_message_id`. Recovery sends before 2026-09-04 carry no
  provider id and are reported as "delivery unknown", never as delivered.
- **Bounced / complained / unsubscribed**: from the same events table and
  `email_suppressions`, per send. Guardrails, reported beside every rate.

### 3.2 Engagement, recorded raw and classified at read time

New append-only table `email_engagement_events`:

| column | meaning |
|---|---|
| `campaign_type`, `reference_id`, `recipient_email` | the send, same identity `email_send_log` uses |
| `kind` | `opened` or `clicked` |
| `at` | when the fetch or click happened |
| `source` | `pixel` (our image), `click` (our redirect), `provider` (Resend `email.opened` webhook) |
| `user_agent` | the fetching client, raw |

All four first-party tracker routes and the webhook's `email.opened` handler
write a row. The existing first-touch columns (`opened_at`, `clicked_at` on
`abandoned_cart_emails` and `email_send_log`) keep working unchanged, so nothing
that reads them today changes behaviour.

Classification is a pure function over those rows, so the rule can be tightened
later without losing history:

- **Any open** (benchmark-comparable): at least one `opened` row.
- **Human open**: an `opened` row at least 60 seconds after `sent_at` whose
  user agent is not on the scanner list. Apple Mail Privacy Protection and
  corporate link scanners fetch within seconds of delivery; in September's data
  every open under 40 seconds is one of those and every open over 5 minutes
  is a plausible read. The threshold and the scanner list live in one module.
- **Any click** (benchmark-comparable): at least one `clicked` row.
- **Human click**: a `clicked` row whose user agent is not on the scanner list
  and which is at least 10 seconds after `sent_at`.
- **Human engagement**: human open or human click.
- **Restored**: `abandoned_carts.restored_at` set. This step is the bot-proof
  one: it requires a page to execute and call the restore endpoint, which no
  link scanner does. It is the anchor of the strict funnel.
- **Checkout started after restore**: `checkout_started_at` later than
  `restored_at` on the same cart.

### 3.3 Orders and money

Two attributions, reported side by side, never summed:

- **Benchmark-comparable placed order**: a paid product order from the same
  address within 5 days after a send that had any open or click before the
  order. The most recent qualifying send gets the credit; an order is counted
  once. This is Klaviyo's default (5-day, open-or-click, last touch), which is
  what its 3.33% and 7.69% figures mean.
- **Strict placed order**: a paid product order with
  `marketing_source_kind = cart_recovery` (click cookie or recovery coupon),
  exactly as `getCartRecoveryFunnel` credits today. Revenue is net of refunds,
  ledger-based; incentive cost and cost of goods come from the existing funnel;
  gross profit is revenue minus both.
- **Self-serve within window**: a paid order within 5 days with no open or
  click. Reported as context, credited to nothing.

### 3.4 Grain and window

Per stage, per experiment arm, and in total; rolling 28 days by default, with
the range selectable. Internal and seed addresses are excluded through the
existing `internal-addresses.ts` list, extended with the seed mailboxes from §5.

Each rate is shown with its floor (Klaviyo average) and target (top decile)
beside it, and with the delivered count, so a reader sees at once whether the
window is big enough to read. Below 150 delivered the panel says so.

### 3.5 The welcome flow

The same open and click classification is applied to `automation-stats.ts`, so
the welcome flow's opens stop being reported as if every prefetch were a read.
No other change to the welcome flow in this spec.

### 3.6 Incrementality without a holdout

A holdout is deferred (owner decision). Until volume supports one, the honest
reading is the gap between the strict number and the self-serve number: a
programme that is working shows strict recoveries rising while self-serve
recoveries do not fall.

## 4. The sender experiment

### 4.1 The single axis

From display name. Control (arm `a`): `Vanta Labs <news@mail.vantalabsresearch.com>`.
Treatment (arm `b`): `Brenden at Vanta Labs <news@mail.vantalabsresearch.com>`.
The address, the sending domain, DKIM, SPF, DMARC, Reply-To (`orders@`), the
List-Unsubscribe headers, the subject, the body and the timing are identical
across arms. No DNS change of any kind is made while the experiment runs.

"Brenden" is the owner's real name and replies reach a mailbox a person reads,
so this is a named person at the company, not an invented individual.

### 4.2 Assignment and recording

- Assignment is the existing `recoveryVariantFor(cartId)`: deterministic,
  stable across the cart's whole sequence, recorded on the send row.
- The subject-line test currently occupying that variant is retired: both arms
  have zero clicks and running two axes at once would attribute nothing.
  Subjects revert to the control copy on both arms.
- New nullable column `abandoned_cart_emails.experiment` names the axis the
  variant belonged to (`sender-name-2026-09`). Existing rows are null and are
  reported under "subject-line (retired)". The funnel groups by
  `(experiment, variant)`.

### 4.3 Mechanism

`MarketingSendOptions` gains `fromDisplayName?: string`. In
`sendRenderedMarketingEmail`, when present, it replaces only the display name of
the resolved marketing From; the address is never touched. The value is
sanitised (no angle brackets, quotes or line breaks). `send.ts` is not changed,
so `reputation-separation.test.ts` stays as it is. The idempotency key does not
include the From, so a retry of the same message keeps the same key.

Cart recovery passes the arm's display name; every other marketing sender passes
nothing and is unaffected.

### 4.4 Reading it

Primary: the strict funnel per delivered — human clicks, restored, paid, gross
profit — with the benchmark-comparable rates beside it. Guardrails per arm:
complaint rate, bounce rate, unsubscribe rate. The experiment is read at 150
delivered sends per arm or eight weeks, whichever comes first. The winner
becomes the sender for the welcome flow too. The template (light, text-forward
vs the current dark card) is the second experiment, run after this one reads,
and its ordering may be brought forward by what §5 finds.

## 5. Placement diagnosis

Runs first, before any code from §3, §4 or §6, and changes nothing in
production except that seed mailboxes receive mail.

- **Seeds**: the owner's Gmail (readable through the connected account) plus
  one Outlook, one Yahoo and one iCloud address the owner supplies. All are
  added to the internal-address list so nothing counts them.
- **What is sent**: each of the four stages rendered by the real template code
  with a representative cart, through the real provider account, from the real
  marketing From, with the real Reply-To and both List-Unsubscribe headers. Sent
  once under each display name from §4.1. Tracking links point at the real
  routes with a null id, so nothing is stamped.
- **What is read**: for Gmail, the message's labels (Inbox, Promotions, Spam)
  and its `Authentication-Results` header, both read through the API. For the
  other three, the folder or tab, reported by the owner from a checklist.
- **What is not changed**: DNS, sender, template. Enrolling both domains in
  Google Postmaster Tools is recommended and is observation only; it can happen
  during the experiment.
- **Decision rules**: any seed in Spam is a deliverability defect and is fixed
  before the experiment starts. Gmail Promotions is noted, the sender
  experiment proceeds, and the template axis becomes the next experiment.
  Primary everywhere means the constraint is content or audience, and the
  sender experiment proceeds as planned.

## 6. Browse abandonment

### 6.1 Why it is cheap here

The wall means every product viewer is a signed-in account, and the product page
already resolves the viewer server-side. Identification is 100%, which no
third-party tool achieves.

### 6.2 Recording a view

New table `product_views (id, customer_user_id, email, slug, viewed_at)`,
indexed on `(email, viewed_at desc)`. The product page schedules the insert with
Next's `after()` for signed-in viewers only; visitors on a marketing-link grant
are not recorded (no account, no consent record of their own). One row per
address, slug and hour, so a shopper refreshing a page does not write ten rows.
The write never blocks or fails the page. Rows older than 30 days are pruned by
the sweep.

### 6.3 The automation

A new key `browse_abandonment`, last in `AUTOMATION_KEYS` so every other
message to an address wins the tick. Its `email_automations` row is inserted
disabled; the operator enables it.

A target is an address whose most recent product view is between 4 and 24
hours old (constants in code; a view older than 24 hours never triggers, the
same shape as `EVENT_GRACE_DAYS`), and which:

- is in the consented audience and holds an account;
- has no open abandoned cart (`CART_STATUS_OPEN`) — the cart flow owns those,
  including carts that reached checkout;
- has no paid product order at or after the view;
- has not received `browse_abandonment` in the last 7 days (reference id is
  the address plus the view's day, the 7-day rule is the already-sent lookback);
- is not inside the 24-hour quiet period (the existing frequency guard);
- is not suppressed (checked again at send, as today).

Collisions, stated: an open cart means no browse email; a purchase after the
view means no browse email; a welcome or post-purchase message earlier in the
same sweep means the browse email is deferred by the quiet period, and if the
view has aged past 24 hours by then it is dropped rather than sent late. The
same address never receives more than one browse email a week.

### 6.4 The email

A dedicated template, `browseAbandonmentTemplate`: the product's image, name and
price from the catalogue, the COA link when the catalogue holds one, a short
note, one button to the product page through the automation click tracker,
which already mints the browse grant so a signed-out click reaches the page. No
incentive, no code, no gift. Subject, headline and body are operator-editable
through the automation's row like the others, with one merge token,
`{{product_name}}`. Copy is written under the brand's compliance rules and
must pass `copy-compliance.ts`; the template is registered in
`template-standards-inputs.ts` so the sweep test covers it.

### 6.5 Attribution and reporting

The automation click cookie already credits an order to
`automation:browse_abandonment`; `automation-stats.ts` reports the new key with
no change beyond the classification in §3.5.

### 6.6 Success

Judged like the cart flow: human clicks, orders and gross profit per delivered,
with complaint and unsubscribe rates as guardrails. Omnisend's figure for this
flow's share of automated orders is the reference; there is no per-email
benchmark quoted for it, so it is read against the cart flow's own rates.

## 7. Data model changes

All additive. No existing column, constraint, index or RLS posture changes.
Every new table is RLS-on with no policies, matching the rest of the schema.

| Change | Migration |
|---|---|
| `email_engagement_events` table and `(campaign_type, reference_id)` index | new file under `src/lib/sql/` |
| `abandoned_cart_emails.experiment text` | same file |
| `product_views` table, `(email, viewed_at desc)` index | same file |
| `email_automations` row `browse_abandonment`, `enabled = false` | same file |

## 8. Code map

| Area | Files |
|---|---|
| Engagement events | `src/app/api/email/track/{open,click}/route.ts`, `src/app/api/email/{automation-open,automation-click}/route.ts`, `src/lib/email/engagement.ts`, `src/lib/email/delivery-events.ts`, new `src/lib/email/engagement-classification.ts` |
| Funnel | `src/lib/admin-cart-recovery.ts` (`getCartRecoveryFunnel`, `getCartRecoveryStats`), `src/lib/email/automation-stats.ts`, `src/components/admin-cart-recovery-client.tsx` |
| Sender experiment | `src/lib/email/marketing.ts` (`MarketingSendOptions`, `sendRenderedMarketingEmail`), `src/lib/cart-recovery.ts` (`reserveAndSendStage`), `src/lib/cart-recovery-experiments.ts`, `src/lib/email/templates.ts` (subjects back to control) |
| Browse abandonment | `src/app/products/[slug]/page.tsx`, new `src/lib/product-views.ts`, `src/lib/email/automation-catalog.ts`, `src/lib/email/automations.ts` (`selectAutomationTargets`, sweep), `src/lib/email/templates.ts`, `src/lib/email/template-standards-inputs.ts`, `src/components/admin-email-client.tsx` |
| Exclusions | `src/lib/email/internal-addresses.ts` |
| Harness | `scripts/setup-local-harness.sh` (new migration in the applied list) |

## 9. What must keep working, and how that is checked

Unit suites that pin the invariants this touches, all green on `main` before
any change and required green after: `cart-recovery-experiments`,
`cart-recovery-sequence`, `cart-recovery-attribution`,
`cart-recovery-frequency-deferral`, `marketing-choke-point` (no new file may
call `sendEmail`), `reputation-separation` (transactional path untouched),
`marketing-idempotency`, `engagement-measurement`, `webhook-observability`,
`templates-sweep` and `template-standards` (new template registered),
`copy-compliance`, `automation-boundaries`, `automation-dedupe-guard`,
`automation-send-once`, `automation-frequency-deferral`, `access-policy` (no
new public path: the view is recorded server-side and the tracker routes are
already public), `private-routes-noindex`.

Harness suites, run against the local harness before anything merges:
`qa-guest-recovery.mjs` (34 checks), `qa-automation-truth.mjs` (12),
`qa-campaign-truth.mjs` (9), plus a new `qa-browse-abandonment.mjs` that walks a
signed-in view, the 4-hour wait, the open-cart and purchased exclusions, the
7-day rule and the quiet period against the real sweep.

Browser, on the harness at desktop and 390×844: a recovery click under each
display name lands in a buyable cart; a browse-abandonment click lands on the
product page signed out.

## 10. Rollout order

1. Placement diagnosis (§5). No code. Now.
2. Engagement events and the funnel (§3). Additive writes and read-side
   changes; shipped first so the experiment is measured from its first send.
3. Sender experiment switched on (§4).
4. Browse abandonment shipped disabled, verified on the harness, then enabled
   by the operator (§6).
5. Template experiment, after the sender axis reads.

## 11. Risks and mitigations

- A named sender draws replies as if to a person. Reply-To is `orders@`, which
  is read; the seed test confirms the reply path before the first customer send.
- The 60-second open rule misclassifies a genuinely instant read. Both numbers
  are shown; the strict funnel does not depend on opens at all.
- `experiment` null on historical rows. Reported as the retired subject test,
  never pooled with the new one.
- Product-view writes on every product render. Signed-in only, deduplicated per
  hour, scheduled after the response; the page cannot be slowed or failed by it.
- Seed inboxes carry history with the sender. Noted in the diagnosis; a fresh
  seed is better than an old one where the owner can supply it.
- Low volume. Every panel shows delivered count beside the rate, and says when
  the window is too small to read.

## 12. Owner items outside the code

- Seed addresses for Outlook, Yahoo and iCloud (§5).
- Google Postmaster Tools enrolment for both domains (a DNS TXT record;
  observation only).
- DMARC is `p=none` and the subdomain publishes no record of its own. Moving to
  `p=quarantine` is worthwhile and is deliberately deferred until the sender
  experiment has read, so the reputation variables stay controlled.
- `RESEND_WEBHOOK_SIGNING_SECRET` is still unset (from the 2026-09-07 audit).
  Unrelated to this design and still open.

## 13. Status at the end of 2026-09-11

| Section | State |
|---|---|
| §3 Measurement | Shipped. `email_engagement_events` records every open and click with its user agent; opens inside 60 s of the send or from a known scanner, and clicks inside 10 s, are classified non-human at read time. The lifecycle funnel (eligible → attempted → sent → delivered/bounced → human open → click → restored → checkout → paid → revenue → gross profit) renders per flow and stage on Admin → Email and Admin → Cart recovery, with strict (marketing-source) and benchmark-style (5-day open-or-click) paid columns side by side and a "too few sends" flag under 150 delivered. |
| §4 Sender experiment | Deferred. The placement diagnosis put the offer stages in Promotions whatever the wording, while the sender was constant; the shape of the message, not the name on it, was the variable that mattered. The subject experiment on stages 1 and 3 continues under the key `subject-2026-09-plain`; the sender-name arm can be added to the same framework once the restrained shape has enough sends to read. |
| §5 Placement diagnosis | Done. Readings and reasoning in the diagnosis log. Consumer-Gmail tab readings for the two probes (P1 text-on-white, P2 COA-led) are still with the owner. |
| §6 Browse abandonment | Shipped, disabled. `product_views` is recorded for signed-in viewers; the `browse_abandonment` automation exists with its row switched off. Enable it in Admin → Email once the funnel shows the cart stages converting in the restrained shape, so the two can be read separately. |
| §7 Data model | Applied to production: `email_engagement_events`, `abandoned_cart_emails.experiment`, `product_views`, the `browse_abandonment` row. The schema snapshot is regenerated. |
| §10 Rollout | Layers 1–4 are on `main` together. Nothing in them changes what is sent to a customer who was already mid-sequence except the wording of stages 3 and 4 and the 8-hour minimum gap, both of which only make a message later or plainer, never extra. |

Beyond this spec, from the lifecycle audit: the 8-hour minimum gap between
cart stages, the payment-aware first stage for a shopper whose card was
declined or whose checkout expired, and the plain welcome-offer copy.

