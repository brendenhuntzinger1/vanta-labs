# Campaign email creatives and blocks — design

Date: 2026-09-11
Status: look approved by the owner; composer changes proposed, awaiting the
decisions in §6. Branch `claude/serene-euler-ny6d6j`, no merge to main.
Working kit: `.claude/skills/vanta-email-campaign/`.

## 1. Why

The owner wants campaign emails that look like the best of what lands in a
consumer inbox (MADE, Hydrant, Nick's, Hennessy, Alexis Bittar were the
references) and wants to paste creatives into them. Today's composer has seven
text-first blocks, renders an image inside the 32px text inset with a hard
edge, uses a yellow (`#F2C94C`) the site does not use, and cannot link a card
to its own product.

## 2. What was approved

Three layouts and four creative styles, rendered in Chromium at 390px and
640px and accepted on 2026-09-11:

- **Restock** (Nick's + MADE): announcement bar, header with nav, light studio
  creative, copy, three-up product grid with Buy now, batch strip, footer nav.
- **Documented** (Hennessy): centred wordmark, dark creative, centred copy,
  two-column image + panel, hairline list, lineup strip, secondary ask.
- **New in** (Hydrant + Alexis Bittar): typographic creative, three-by-two
  mosaic, copy, three-column info panel, support, footer nav.

Creatives are flat 1040px images with the words baked in, made from the
store's own product photography (public `product-images` bucket) and three
cut-outs derived from it. The homepage vial is not used. Tokens, sizes and
block shapes are in the kit's `references/design-system.md`.

## 3. The composer changes

All blocks stay JSON in the campaign's `body` column, render HTML and the
plain-text twin in one pass, and forbid free HTML.

1. **Shell** (`renderLayout`, `renderCtaButton`): gold to `#c7ae5e`; Fraunces
   headline with Georgia fallback via one Google Fonts link; two header
   variants; announcement bar and footer nav as campaign-level fields. Update
   `layout-alignment.test.ts` (full-bleed rows carry no `padding` property so
   the inset check skips them) and `template-standards.test.ts` fixtures.
2. **Creative block**: `{ type: "creative", url, alt, path }`. Composer accepts
   clipboard paste, drag-drop or a prior upload; uploads through a new
   `POST /api/admin/email/creatives` that reuses `sniffImageType`, the 8 MB
   cap and a public `campaign-creatives` bucket, writing a JPEG twin for WebP.
   Alt text is mandatory and runs through `findCopyComplianceIssue`. The link
   is a site path validated by `cta-path.ts` and tracked through the indexed
   click route.
3. **Product grid** `{ type: "products", slugs, columns: 2|3 }` and **mosaic**
   `{ type: "mosaic", slugs | creatives, columns }`: the composer offers a
   picker over the live catalogue; the sender resolves name, photo and link at
   send, drops unpublished products, and registers each card in
   `link_buttons` so `buildCampaignLinkClickUrl` tracks it per card.
4. **Two-column** `{ type: "split", image, heading, steps | text }` and **info
   panel** `{ type: "panel", items: [{label, line}] x3 }`.
5. **Batch strip** `{ type: "batch", slug }`: renders batch number and report
   link from the product row; renders link only while batch data is not real
   per product.

## 4. Data findings

- All 35 published products share `batch_number = Vanta184290` and have no
  `testing_date`; photographed labels read `Lot VL25001`. The batch strip is
  gated until this is fixed, which is a separate task.
- BPC-157, GLP-2, GLP-3 and Recon water have no photo.
- Photos are WebP; email needs a JPEG twin.

## 5. Compliance

The creative-director references apply to the words inside a picture. What is
inside an image is not machine-checked; alt text is, and the operator owns the
picture. No lot numbers in creatives until the data is real. No numbers,
percentages or thresholds without re-verifying the live store.

## 6. Decisions outstanding

1. Gold and Fraunces in the shared shell (recommended yes).
2. `campaign-creatives` public bucket with the product-image checks (yes).
3. Creatives made by the owner and pasted, or produced on request from the kit
   templates (both).
4. Product picker from the live catalogue for grids and mosaics (yes).
5. Batch strip shipped link-only until batch data is real (yes).
6. Campaigns first, automations after (yes).

## 7. Plan

1. Shell restyle and tests; render all templates at 390px.
2. Creative block, upload route, paste and drop, alt check, JPEG twin.
3. Product grid and mosaic with the picker, send-time resolution, indexed
   tracking, tests for the text twin and for an unpublished product.
4. Two-column, info panel, gated batch strip.
5. Browser verification on the local harness at 390 by 844.
