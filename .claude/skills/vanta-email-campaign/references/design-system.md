# Campaign email design system

Everything below was measured from the approved mockups of 2026-09-11 and the
live email shell in `website/src/lib/email/templates.ts`.

## Shell

| Part | Value |
|---|---|
| Page ground | `#050505`, 32px top and bottom, 16px side gutter |
| Card | max-width 520px, `#111111` (or `#0a0a0a` for the dark "documented" layout), 1px `rgba(255,255,255,0.12)` border, 16px radius, `overflow:hidden` |
| Text inset | 32px left and right on every copy row (the layout-alignment test pins this) |
| Full-bleed rows | creatives, mosaics and two-column blocks use a cell with **no `padding` property at all** so the alignment test skips them |
| Announcement bar | one line above the card, 12px, `#a3a3a3`, link in champagne with a 45% champagne underline |
| Header A | wordmark left in Fraunces 15px tracked 0.34em; nav right, 11px caps tracked 0.12em, `#a3a3a3` |
| Header B | centred wordmark, Fraunces 18px tracked 0.36em, "L A B S" under it at 9px |
| Footer | hairline, optional nav row (11px caps, `#c9c9c9`), "Vanta Labs · Research Use Only", support address, postal address, unsubscribe and preferences links |

## Palette

| Token | Hex | Role |
|---|---|---|
| Ink | `#f4f4f4` / `#ffffff` | headlines |
| Body | `#c9c9c9` | paragraphs |
| Muted | `#a3a3a3`, `#8a8a8a` | specs, labels |
| Hairline | `rgba(255,255,255,0.08–0.12)` | rules and borders |
| Champagne | `#c7ae5e` | eyebrows, links, the one filled button |
| Champagne tint | `rgba(199,174,94,0.08)` fill, `rgba(199,174,94,0.35)` border | panels |
| Charcoal tile | `#0a0a0a` | batch strip, info panel |

The old email gold `#F2C94C` is retired for new mail. Gold stays under about
8% of any frame; depth comes from tint and hairline, not fill.

## Type

| Role | Face | Size |
|---|---|---|
| Creative headline | Fraunces 400, italic word in champagne | 56–64px inside a 520-wide canvas (rendered at 2x) |
| Creative giant type | Fraunces 600 caps, `-webkit-text-stroke` champagne outline | 132px |
| Email H1 | Fraunces 500 | 30px / 1.12 |
| Email H2 | Fraunces 500 | 22–24px |
| Eyebrow | Manrope 700 caps, tracked 0.3em | 11px, champagne |
| Body | Manrope 400 | 15px / 1.65 |
| Card name | Manrope 600 | 14px |
| Spec / label | Manrope 400/700 | 12px / 10px caps tracked 0.18em |
| Lot numbers, numerals | Geist Mono, SFMono, Menlo fallback | 14–15px |

Load with one Google Fonts link in `<head>`; Georgia and the system sans are
the fallbacks and are acceptable.

## Buttons

- Primary: the bulletproof table button from `renderCtaButton`, `bgcolor="#c7ae5e"`, ink `#111111`, 16px 28px padding, 999px radius, caps 15px tracked 0.05em. One per email.
- Secondary / per-card: transparent pill, 1px champagne 55% border, champagne text, 9px 14px padding, 11px caps.

## Blocks

| Block | Shape | Data |
|---|---|---|
| Creative | `<img width="520">` in a no-padding cell, wrapped in one link | image, alt (mandatory), site path |
| Product grid | fluid-hybrid inline-block columns, `width:33.3%;max-width:152px;min-width:96px`, photo 12px radius, name, strength, Buy now pill | picked products |
| Mosaic | table with `border-spacing:4px`, three cells per row, photos at 6px radius, one link per tile; name list beneath in 11px caps | picked products or creatives |
| Two-column | two `inline-block` columns `max-width:260px`, a `@media (max-width:520px){.col{max-width:100%!important}}` rule stacks them; left photo, right `#141414` panel with eyebrow, 20px Fraunces heading, numbered mono steps | photo + text |
| Info panel | `#0a0a0a` tile, three cells, Fraunces numeral in champagne, 12px label, 12px muted line | three pairs |
| Hairline list | rows separated by 8% white rules, 14px | lines |
| Batch strip | `#0a0a0a` tile, two cells: Batch (mono) and Report link | product row, gated |

## Creatives

- Canvas 520px wide in CSS, `html{zoom:2}` so the screenshot is 1040px.
- Heights used: 600 (light), 640 (dark, typographic), 230 (lineup).
- Light: `radial-gradient(120% 90% at 50% 78%, #e9e9e9, #cfcfcf 45%, #a9a9a9)` with the photo masked by a radial gradient so its edges dissolve into the field.
- Dark: `#0a0a0a`, a champagne radial glow behind the vial, a `scaleY(-1)` reflection at 18% opacity masked to fade.
- Every creative carries "RESEARCH USE ONLY" bottom-left and "VANTA" bottom-right.
- Product cut-outs are the store's photos with the background removed and trimmed; 412x1006 px with the reflection still attached, cropped in CSS to the vial.
