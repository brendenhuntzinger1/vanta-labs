---
name: vanta-email-campaign
description: Vanta Labs' marketing-email kit. Use whenever the user wants to send, draft, design or "make" a marketing campaign, newsletter, product email, restock email, launch email, promo email or email blast for Vanta Labs — even if they only say "let's do a campaign about X". Builds the whole email from the checked-in templates, the store's own product photography and freshly made pasteable creatives, renders it at phone and desktop width, and hands the user pictures to approve before anything is loaded into the composer. Also use when the user asks how a campaign email should look, or wants a creative/hero image for an email.
---

# Vanta Labs email campaign kit

The user approved this look on 2026-09-11 and asked that we "pick up easily
depending on what the campaign is about". This skill is that pickup point. It
holds the templates, the assets and the process. Read it top to bottom before
making anything; the shortcuts are how the brand drifts.

## The owner's standing instruction (2026-09-11, verbatim intent)

> Keep this as is. When I go to a new chat I need it to remember exactly
> what I want. Eventually I'm going to send out email marketing campaigns
> with the picture like I showed you and like you developed. Those are just
> templates. We're going to fully customize them one by one as we send them,
> whenever we send them. It's going to be a very premium email marketing
> campaign. So remember this.

What that means in practice:

- The three layouts and four creatives are **starting points, never the
  deliverable**. Every campaign is built fresh for its subject: its own
  creative, its own copy, its own product selection, its own structure if the
  story needs one. Do not reuse a previous campaign's creative or headline.
- **Premium is the bar.** The references the owner chose were MADE, Hydrant,
  Nick's, Hennessy and Alexis Bittar. Hennessy is the closest to this brand.
  If a draft would not sit beside those, it is not finished.
- Each campaign is made **one at a time, together with the owner**: show the
  390px renders, take the changes, render again. The owner approves the
  pictures before anything is loaded or sent.
- The look was approved on 2026-09-11 and is recorded in
  `assets/creatives/` and `references/design-system.md`. Change the details
  per campaign; do not drift the system.

## What a campaign email is here

A Vanta campaign email is the dark card shell every store email already uses,
with one or more **pasted creatives** (flat images with the words baked in,
1040px wide) and data-driven blocks (product grid, mosaic, two-column, info
panel) between the copy. Three approved layouts exist as templates:

| Template | Built from | Use it for |
|---|---|---|
| `templates/email-restock.html` | Nick's + MADE: announcement bar, header nav, light creative, copy, 3-up grid with Buy now, batch strip, footer nav | A product is back, a product launch, "also in stock" |
| `templates/email-documented.html` | Hennessy: centred wordmark, dark creative, centred copy, two-column image + panel, hairline list, lineup strip, secondary ask | Brand and trust stories: the COA library, how testing works, back-in-stock alerts |
| `templates/email-new-in.html` | Hydrant + Alexis Bittar: typographic creative, 3x2 product mosaic, copy, three-column info panel, support, footer nav | Several products at once: new additions, a category, a collection |

Four creative templates make the pictures that go in them:

| Template | Look | Needs |
|---|---|---|
| `templates/creative-light.html` | Studio grey field, charcoal Fraunces headline, one product photo as shot | a product JPEG in `products/` |
| `templates/creative-dark.html` | Charcoal field, champagne glow, one cut-out vial with a faint reflection | a cut-out in `vials/` |
| `templates/creative-typographic.html` | Three stacked lines of giant serif, one solid, two outlined, three cut-outs in front | three cut-outs |
| `templates/creative-lineup.html` | A short strip of three cut-outs on a hairline, for mid-email | three cut-outs |

Reference renders of all four are in `assets/creatives/`. Three cut-outs
already exist in `assets/vials/` (GHK-Cu, BPC-157 + TB-500, NAD+). Making a
new cut-out costs a background-removal job on the connected image account, so
reuse these where the subject allows.

Every value, colour and size is in `references/design-system.md`. Facts about
the catalogue data that limit what a block can show are in
`references/data-findings.md`. The state of the composer work (which blocks
exist in code, which are still a proposal) is in `references/status.md`.

## The process

1. **Ground.** Read `../vanta-creative-director/references/brand.md` and
   `compliance.md`. They apply to the words inside a picture exactly as they
   apply to a caption: no human-use framing, no outcomes, no dosing, no
   invented scarcity, no numbers not re-verified on the live store, no emoji,
   no exclamation marks. Never use the homepage vial (`hero-vial-poster.jpg`);
   the user rejected it.

2. **Decide the story in one line** with the user's words: what the campaign
   is about, which products, which template. If the products are new to the
   kit, pull them from the catalogue (step 3). Say the plan in three sentences
   and keep going; do not block on it.

3. **Get the photography.** Product photos live in the public
   `product-images` bucket of the production Supabase project; read the URLs
   with a read-only query (see `references/data-findings.md` for the query and
   the bucket pattern). Download with `scripts/fetch-products.mjs`, which
   writes `products/<slug>.jpg`. If a product has no photo it renders the
   placeholder tile; say so and pick another product for the hero.

4. **Make the creatives.** Copy a creative template into the work directory,
   change the words and the product file names, and render with
   `scripts/render.mjs creative <file>` (1040px PNG via headless Chromium).
   One idea per creative. Headline four words or fewer. Eyebrow carries the
   product name and strength as printed on the label. The "Research use only"
   line and the VANTA mark stay.

5. **Assemble the email.** Copy an email template, replace the creative file
   names, the copy, the product cards (slug, name, strength, photo) and the
   links. Keep the shell rows untouched: header, footer, postal address,
   unsubscribe. Alt text on every creative repeats the words in the picture.

6. **Render and look.** `scripts/render.mjs email <file>` writes 390px and
   640px full-page PNGs. Look at both. Fix anything that wraps, overlaps or
   collides, then render once more. Send the user the 390px PNGs with
   SendUserFile; that is the approval surface, not a description.

7. **Deliver.** Until the composer has the new blocks (see
   `references/status.md`), hand the user the rendered HTML and the PNGs and
   say plainly what can and cannot be loaded into the admin today. Never send
   mail yourself and never touch production data.

## Hard rules

- Real photography only, from the catalogue bucket. No stock, no generated
  vials, no homepage assets.
- Champagne `#c7ae5e` is the only gold. No solid gold blocks; tint and hairline.
- Fraunces for display, Manrope for text, a monospace for lot numbers.
- Batch numbers and test dates only when the product row has real, per-product
  values. Today it does not; the batch strip stays link-only.
- Every link is a path on this site. Never a raw external URL.
- Creatives are 1040px wide and shown at 520. Alt text is mandatory.
- The three 390px renders go to the user before anything else happens.
