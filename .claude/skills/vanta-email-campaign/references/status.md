# Where the composer work stands

Updated 2026-09-11. Keep this current: it is what the next session reads to
know whether a designed email can be loaded into the admin or only handed over
as HTML.

## Approved

- The look: three layouts (restock, documented, new-in) and four creative
  styles, rendered in `assets/creatives/` and reproduced by the templates.
- The direction: pasted creatives with the words baked in, the store's own
  photography, champagne not yellow, Fraunces headlines.
- The user's instruction: no merge to main while developing; work on the
  branch `claude/serene-euler-ny6d6j`.

## Not yet built in the app

The admin composer (`website/src/components/admin-block-composer.tsx`) still
has seven blocks: heading, paragraph, list, button, image, divider, spacer.
The image block renders inside the 32px text inset with a hard edge, and the
button block can only point at the campaign's single CTA. So a designed email
from this kit **cannot yet be loaded into the composer as blocks**.

Proposed and awaiting the user's decisions (full write-up in
`website/docs/superpowers/specs/2026-09-11-campaign-email-creatives-design.md`):

1. Shell restyle in `renderLayout`: gold `#F2C94C` to `#c7ae5e`, Fraunces
   headline, header variants, announcement bar and footer nav as campaign
   fields.
2. Creative block: paste or drop an image, upload to a public
   `campaign-creatives` bucket through the same sniff-and-size checks as
   product images, JPEG twin for WebP, mandatory alt text, site-path link.
3. Product grid and mosaic blocks: pick products from the live catalogue,
   resolve name, photo and link at send, track each card through the indexed
   click route (`buildCampaignLinkClickUrl`, `link_buttons` on `email_campaigns`).
4. Two-column and info panel blocks.
5. Batch strip, gated on real per-product batch data.

## Until then

Deliver a campaign as rendered HTML plus 390px and 640px PNGs. The HTML can be
sent through any client that accepts raw HTML, but the store's own sender only
renders `campaignTemplate`, so it is not a one-click load. Say this to the user
plainly rather than implying the admin can take it.
