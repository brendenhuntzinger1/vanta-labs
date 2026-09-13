-- ---------------------------------------------------------------------------
-- ONE OPTIONAL HERO IMAGE PER CAMPAIGN.
--
-- The composer could not send artwork. campaignTemplate took no image, and the
-- `body` column is escaped on the way out on purpose — it is operator input
-- that reaches the whole list — so there was nowhere for a picture to go and no
-- safe way to smuggle one through the copy.
--
-- Two nullable columns, no default and no backfill. Every existing row stays
-- NULL, and a NULL hero renders the document the template rendered before these
-- columns existed, byte for byte (campaign-hero-image.test.ts).
--
-- NOT A URL CONSTRAINT. The check that decides whether an address is usable
-- lives in lib/email/blocks.ts (https only) and runs at render time, so a row
-- that somehow holds a bad value drops the image and still sends. Duplicating
-- that rule here would be a second opinion to keep in step with the first.
-- ---------------------------------------------------------------------------

alter table public.email_campaigns
  add column if not exists hero_image_url text,
  add column if not exists hero_image_alt text;

comment on column public.email_campaigns.hero_image_url is
  'Optional absolute https URL rendered once, above the headline. NULL means no hero.';
comment on column public.email_campaigns.hero_image_alt is
  'Alt text for the hero. Most clients block images, so for many recipients this IS the message.';
