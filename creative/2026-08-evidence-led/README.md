# Evidence-led concepts — August 2026

Three concepts, three archetypes that had no entry in the ledger before this
brief. The existing ten are all `ugc_talking_head`, `curiosity_hook`,
`problem_solution` and `comparison_generic`; `documentation`,
`cinematic_product` and `educational` were unrepresented, which is the gap this
set fills.

| ID | Archetype | Length | Landing page | Gate |
|---|---|---|---|---|
| `vl-doc-001` | documentation | 12s | `/coa-library` | PASS |
| `vl-cin-001` | cinematic_product | 12s | `/products` | PASS |
| `vl-edu-001` | educational | 15s | `/products` | PASS |

All three pass `website/src/lib/ads/compliance.ts`. All three carry a populated
`claims_used` and an explicit `no_claims_made`.

## What prompted this

An 8-second black-and-gold offer cut (`BUY 2 GET 1 FREE` / `+ FREE
BACTERIOSTIC WATER`) was reviewed and should not run. Two blocking reasons:

1. **The offer does not exist.** `website/src/lib/admin-control.ts:660-661`
   defines exactly two multi-buy promotions — `buy_3_get_1_enabled` (Buy 3, Get
   1 Free) and `buy_2_get_1_half_enabled` (Buy 2, Get 1 at 50% off). There is no
   "Buy 2 Get 1 Free", and both default to `false`. No free-bacteriostatic-water
   promotion exists anywhere; `website/src/lib/bac-water.ts` treats BAC water as
   a paid cross-sell priced from the live catalogue row.
2. **`BACTERIOSTIC` is a misspelling of `bacteriostatic`**, in the second-largest
   type in the piece.

Secondary: `GLOW` and `GHK-Cu` labels are intercut on the same `Lot VL25001`;
on-screen type collides with the vial's own printed label; the RUO disclaimer is
duplicated with one instance clipped at the frame edge; gold runs far past the
~8% ration in `brand.md`; ten hard cuts in eight seconds against a 200-350ms
eased motion spec.

## Salvaging the existing render

If the cut is to be reused rather than replaced, the text layer needs all of:

| Current | Corrected |
|---|---|
| `BUY 2 GET 1 FREE` | `BUY 3, GET 1 FREE` — **and only if a human confirms `buy_3_get_1_enabled` is toggled on today** |
| `+ FREE BACTERIOSTIC WATER` | Delete. No such promotion exists. |
| `WHAT A DEAL` | Delete. Not brand voice (`brand.md`: no hype, one idea at a time). |
| `CLAIM THE OFFER →` in a filled gold pill | `See the offer` on a hairline gold rule — a rule, not a filled shape |
| RUO disclaimer, two instances, one clipped | One instance, above the bottom 20% safe area |
| `GLOW` and `GHK-Cu` intercut | One SKU throughout |
| Text over the printed label | Text in the black field only, never crossing the label |

That gets the asset to runnable. It does not make it a good ad — it is still a
discount card with no hook, opening on a logo, which
`references/platform-eligibility.md` names directly as the thing not to do.

## Open items before any of this ships

- **Eligibility is still ungated.** No written platform ruling has been
  obtained for the Vanta Labs domain. `vl-doc-001` and `vl-edu-001` are marked
  `needs_verification` accordingly. Organic is the honest place to test these
  until that answer exists.
- **`vl-doc-001` assumes `hasPublishedRecords = false`.** Confirm what
  `getCoaLibrarySnapshot()` returns in production. If reports are live, the
  third beat changes and its `claims_used` must name a real batch.
- **Music licensing.** `vl-cin-001` runs without voiceover and leans on its bed.
  Commercially licensed only; trending audio is not cleared for paid use.
- **`vl-edu-001`, the 2-8 C beat** sits nearest the reconstitution prohibition.
  It stays in the third person. If a reviewer wants more distance, cut shot 4 —
  the concept still works at 12s without it.

## Testing

Vary one axis at a time. The first useful comparison is `vl-cin-001` against the
corrected offer cut: same product, same asset class, same length, opposite
posture — offer-led versus object-led. That isolates whether this audience needs
a discount to click at all, which is the question everything else depends on.
