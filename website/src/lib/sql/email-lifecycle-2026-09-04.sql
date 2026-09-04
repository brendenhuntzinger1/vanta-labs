-- Run once in Supabase → SQL Editor. Idempotent; safe to re-run.
--
-- EMAIL LIFECYCLE ENGINE, 2026-09-04.
--
-- What this adds, and why each piece is here rather than in code:
--
--   1. Two automations that did not exist — the welcome introduction and the
--      reorder reminder — seeded DISABLED with the recommended copy, so
--      turning them on is a decision made in Admin → Email.
--   2. The recommended copy for the four existing automations. Their rows are
--      UPDATED here because the copy lives in the database by design (marketing
--      is rewritten more often than software is deployed) and the audit found
--      the live copy shouting ("YOU'RE MISSING OUT") and offering 15% off plus
--      free shipping thirty days after an order. Delays and offers are NOT
--      touched: those are the operator's and are edited in the admin.
--   3. `email_suppressions.source` — which message the person unsubscribed
--      from, so unsubscribes can be reported per campaign and per flow.
--   4. An index for the cart sweep's new clock (last activity, not first
--      sight) and the 'cleared' cart status.
--
-- Nothing here sends mail.

-- 1. New automations ---------------------------------------------------------

insert into public.email_automations (key, enabled, delay_days, subject, headline, body, cta_label, cta_path)
values
  ('welcome_intro', false, 1,
   'What Vanta Labs is, in one email',
   'Welcome to Vanta Labs',
   E'Thanks for joining. Here is the short version of how we work.\n\nEvery batch is third-party tested, and the certificate of analysis for any product is available before you order — look for the COA link on the product page or in the COA library.\n\nOrders ship tracked in plain packaging, and you get an email at every step.\n\nIf you have a question, reply to this email. A member of the team reads and answers every one.',
   'BROWSE THE CATALOG', '/products'),
  ('replenishment', false, 30,
   'Time to restock?',
   'Running low?',
   E'It has been about a month since your last order, which is roughly how long most research cycles run.\n\nIf you are due to restock, your previous order is saved in your account and can be reordered in a couple of clicks — same products, current batch COAs.\n\nIf you are set for now, no action needed.',
   'REORDER FROM MY ACCOUNT', '/account/orders')
on conflict (key) do nothing;

-- 2. Recommended copy for the existing automations ---------------------------
--
-- Subject, headline, body and button text only. `delay_days`, `offer_key`,
-- `promo_code` and `enabled` are left exactly as the operator set them.

update public.email_automations set
  subject = 'A gift toward your first Vanta Labs order',
  headline = 'Whenever you are ready',
  body = E'Thanks again for joining Vanta Labs.\n\nIf you have been looking over the catalog, here is something to make the first order an easier decision. The gift below is tied to this email address and applies automatically at checkout when you arrive from this message.\n\nEvery batch is third-party tested, with the certificate of analysis available before you buy.',
  cta_label = 'SEE THE CATALOG',
  updated_at = now()
where key = 'welcome_no_purchase';

update public.email_automations set
  subject = 'Your order, and how to get the most from it',
  headline = 'Thanks for your first order',
  body = E'A few things worth knowing now that your order is on its way or has arrived.\n\nYour batch: the certificate of analysis for each product is in the COA library, matched to the batch number on your vial.\n\nStorage: keep lyophilized vials sealed, dry and away from light until use. Details are on each product page.\n\nQuestions: reply to this email. A member of the team answers every message.\n\nThis is research material, supplied for laboratory research use only.',
  cta_label = 'VIEW MY ORDER',
  cta_path = '/account/orders',
  updated_at = now()
where key = 'post_purchase';

update public.email_automations set
  subject = 'Back in stock, and a note from us',
  headline = 'It has been a while',
  body = E'It has been some time since your last order, so here is a short update.\n\nThe catalog has moved on: new arrivals are in and the products you ordered before are stocked, with fresh batch COAs in the library.\n\nIf there is something you could not find last time, reply to this email and tell us.',
  cta_label = 'SEE WHAT IS NEW',
  updated_at = now()
where key = 'winback_30';

update public.email_automations set
  subject = 'A free GHK-Cu with your next order',
  headline = 'On us, when you are ready',
  body = E'We would like to make your next order an easy one.\n\nPlace a qualifying order and we will include a GHK-Cu at no charge. The gift is tied to this email address and applies automatically at checkout when you arrive from this message; the terms are below.\n\nEverything ships tracked, in plain packaging, with the batch COA available before you order.',
  cta_label = 'CLAIM THE GIFT',
  updated_at = now()
where key = 'winback_60';

-- 3. Which message prompted an unsubscribe ----------------------------------

alter table if exists public.email_suppressions
  add column if not exists source text;

comment on column public.email_suppressions.source is
  'The send that carried the unsubscribe link the person used, e.g. campaign:<uuid>, automation:winback_60, cart_recovery_t72h. Null for provider bounces/complaints and legacy rows.';

-- 4. Cart sweep clock and the cleared status --------------------------------

create index if not exists idx_abandoned_carts_status_last_updated
  on public.abandoned_carts (status, last_updated_at);

comment on column public.abandoned_carts.status is
  'active | recovered | cleared | expired. cleared = the shopper emptied the cart; never mailed again.';
