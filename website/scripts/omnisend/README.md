# Omnisend account build

Everything Vanta Labs owns inside Omnisend is generated from this directory:
the two universal layouts, every email template, the SMS catalogue, the
segments, the automations, the sign-up form and the three campaign drafts.
Nothing here runs at request time; the Next.js app only ever talks to
Omnisend through `src/lib/omnisend/`. This directory is a build tool that
renders JSON for the Omnisend Public API (v2026-03-15) and keeps a registry of
the ids it created.

Every object was created **disabled** or as a **draft**. Nothing here enables
an automation, sends a campaign or sends a test message; the owner does that
from the Omnisend dashboard after review.

## Files

| File | What it holds |
|------|---------------|
| `lib.mjs` | The template DSL: palette, fonts, `hexId()`, `link()` (the grant route), text/button/image/section helpers, product sections with role-tagged components |
| `layouts.mjs` | The universal header and footer (`layouts:header`, `layouts:footer`) |
| `templates.mjs` | `TEMPLATES` (30 email templates, keyed), `SUBJECTS` (subject and preview per key), `TEMPLATE_KEYS` |
| `sms.mjs` | `SMS` (seven texts with `text` and `whenUsed`), `smsBody()`, `STOP_SENTENCE` |
| `segments.mjs` | `PROPERTY_SEGMENTS` (creatable at any time) and `EVENT_SEGMENTS` (creatable only once the event has been recorded) |
| `automations.mjs` | `AUTOMATIONS` (eight flows), built from the ids in `assets/` |
| `form.mjs` | The two-step sign-up popup with the TCPA consent block |
| `render.mjs` | Prints any asset as JSON: `node scripts/omnisend/render.mjs <asset>` |
| `assets.test.mjs` | Offline tests for all of the above (`npx vitest run scripts/omnisend/assets.test.mjs`) |

## Id registry (`assets/`)

Each file maps a key from the generator to the id Omnisend returned. They are
checked in because the automations and campaigns reference templates and
segments by id, and because updating an object needs its id.

| File | Shape | Written when |
|------|-------|--------------|
| `assets/created.json` | `{ "<template key>": "<templateID>" }` | a template is created |
| `assets/segments.json` | `{ "<segment key>": "<segmentID>" }` | a segment is created |
| `assets/automations.json` | `{ "<automation key>": "<automationID>" }` | an automation is created |
| `assets/form.json` | `{ "signup": "<formID>" }` | the form is created |
| `assets/campaigns.json` | `{ "<campaign name>": "<campaignID>" }` | a campaign draft is created |

Layout ids are fixed and referenced from `layouts.mjs` (header
`6aa985ecfa261ac55e04bae3`, footer `6aa985f7c29076c61d3838b1`).

`automations.mjs` refuses to render a flow whose templates or segments have
no id yet, so the order is: layouts, templates, segments, automations, form,
campaigns.

## Rendering, creating and updating

Render any asset to stdout:

    node scripts/omnisend/render.mjs layouts:header
    node scripts/omnisend/render.mjs template:cart-3-gift-code
    node scripts/omnisend/render.mjs segment:vl-recovery-gift-ready
    node scripts/omnisend/render.mjs automation:abandoned-cart
    node scripts/omnisend/render.mjs form

The rendered JSON is the request body for the matching Public API operation.
There is no API key in the repo, so creation goes through the Omnisend MCP
(`omnisend_create` / `omnisend_update` with the operation name and the JSON as
`payload`) or through `curl` with an `X-API-KEY` the owner supplies.

| Kind | Create | Update | Confirm |
|------|--------|--------|---------|
| Universal layout | `post_email_universal_layouts` | `put_email_universal_layouts_id` | `get_email_universal_layouts_id` |
| Email template | `post_email_templates` | `put_email_templates_id` (body includes `id`) | `get_email_templates_id`, `post_email_templates_id_render` |
| Segment | `post_segments` | recreate (segments are cheap; update the registry) | `get_segment_id` |
| Automation | `post_automations` (created disabled) | `put_automations_id` | `get_automations_id` (`isEnabled` must stay `false` until the owner enables it) |
| Form | `post_forms` (created as `draft`) | `patch_form_id` | `get_form_id`, `post_forms_form_id_render` |
| Campaign | `post_campaigns` (created as `draft`) | `patch_campaigns_id` for settings; the body is a copy (see below) | `get_campaigns_id` |

After a create, add the returned `id` to the matching `assets/*.json` under
the generator key. After an update, nothing changes in the registry.

Templates are also confirmable in one call: `get_email_templates` lists every
template and its name, which is how the thirty `VL ·` templates were checked
after upload.

### Changing a template after it has been used

`put_email_templates_id` changes the template object and nothing else.
Automations and campaigns do not reference templates by id: when either is
created, Omnisend copies the template into its own email-content object and
references that copy by `contentID`. A template change therefore reaches
nothing that has already been built from it until the copies are updated too.

- Every `sendEmail` action in `get_automations_id` carries its own
  `action.sendEmail.contentID`; every campaign draft carries
  `content.email.contentID` (`get_campaigns_id`). Update each copy with
  `put_email_content_id`: read it with `get_email_content_id`, send the
  template's `generalSettings` and `sections` plus the copy's `id`, and keep
  the trailing `badge` section exactly as read (it is accepted on write).
  There is no registry of these ids in `assets/`; read them from the
  automation or campaign each time.
- The header and footer links live in the universal layouts, not in the
  template, so a change to `link()` also needs `put_email_universal_layouts_id`
  for both layouts, with `{ id, name, content }` from `layouts:header` and
  `layouts:footer`.
- SMS text is stored inside the automation itself (`action.sendSms.message`),
  so a link change there needs `put_automations_id`.

`get_email_templates_id` returns `rows: null` for `universal_layout` sections,
so checking a template body says nothing about the header or footer; read the
two layouts separately.

### The abandonment split

The last email in the cart and checkout flows has four variants
(`*-3-gift-code`, `*-3-gift`, `*-3-code`, `*-3-plain`). A discount code or a
gift card may only appear in a variant the automation can guarantee, so the
flow splits twice on segments the store controls:

    vl-recovery-gift-ready  (vl_recovery_gift_ready is "yes")
      yes -> vl-recovery-code-ready ? gift-code : gift
      no  -> vl-recovery-code-ready ? code      : plain

The store sets those properties only after the gift or code exists, so a
variant never renders a blank card. The win-back flow does the same with
`vl-winback-ready`.

## What the plan and the API allow

Learned from the validator and from the account; do not spend time trying
these again.

- `settings.filter` on automations returns `402` on this plan. Split on
  segments instead.
- The `back in stock` trigger is not available to API-created automations; the
  restock email is a campaign (`campaign-restock`).
- Discount blocks cannot mint codes for an API store. Codes come from the
  store as contact properties (`vl_welcome_code`, `vl_recovery_code`,
  `vl_winback_code`) and are printed in text cards.
- The `personalized` and `recentlyViewed` recommenders fall back silently to
  best sellers; `product_cart_recovery` is the only one that is contact-aware.
- `post_automations` has no recipient-timezone option; delays only take
  `allowedWeekdays` and a `specificTime` mode. SMS quiet hours are an account
  setting.
- Email template styles: `letterSpacing` is in px, `textDecoration` is only
  `underline` or `line-through`, every section needs at least one row, a
  section's `borderRadius` is dropped, a product block needs role-tagged
  components.
- Form styles: colours must be six-digit hex (rgba is refused), `fontFamily`
  must be one of Omnisend's own stacks (the site's Fraunces/Manrope pairing is
  not one of them, so the form uses Inter), input and legal blocks need
  `styleProperties`, `targeting.device` is a single value (omit it for both),
  and `targeting.location` entries are `{ code, name }`.
- Campaign drafts send from the brand's configured sender. The account
  currently falls back to Omnisend's shared `soundest.email` address; a
  verified `vantalabsresearch.com` sender must be added in account settings
  before any campaign goes out.
- Frequency limiters of seven days come back as `1w`; that is the same value.

## Copy rules

Every customer-facing string in this directory follows the store's voice:

- no emoji and no exclamation marks;
- research use only, stated in every email footer and every text;
- "Recon Water", never "BAC Water";
- no invented claims, scarcity, countdowns, testimonials or shipping promises
  beyond the documented dispatch window;
- one primary action per email; every link goes through `link()` so it passes
  the grant route with the contact's token and UTM tags;
- alt text on every image;
- a code or a gift appears only where the automation split guarantees it;
- the final-day promotion says "ends today at 11:59 PM ET" once and uses no
  timer;
- no first-name token, because Omnisend's fallback syntax is undocumented;
- SMS starts "Vanta Labs:", ends "Reply STOP to opt out.", stays under 160
  characters with the shortened link, carries no code, and links with
  `medium: "sms"`.

The consent sentence in `form.mjs` (`SMS_CONSENT`) is the store's TCPA
wording copied exactly; do not widen it.

`assets.test.mjs` pins all of this. Run it, `tsc` and `eslint` before
committing:

    cd website
    npx vitest run scripts/omnisend/assets.test.mjs
    npx tsc --noEmit -p tsconfig.json
    npx eslint scripts/omnisend
