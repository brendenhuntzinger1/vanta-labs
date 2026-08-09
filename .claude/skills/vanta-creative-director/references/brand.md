# Vanta Labs — verified brand truth

Every value here was read out of the production stylesheet (`website/src/app/globals.css`) and the live component code, not from a scrape. This matters: an automated brand-kit scrape of this site returned `#fb2c36`, `#ff6568`, `#ffa3a3` and friends as the "brand palette". Those are Tailwind's default `red-200/300/400/500`, harvested from admin delete buttons and error states. **None of them appear anywhere in the brand.** If a tool or a brief hands you pinks and reds for Vanta Labs, it scraped error styling.

## Palette

| Token | Hex | Role |
|---|---|---|
| Background | `#0a0a0a` | The page. Near-black, pure neutral. |
| Surface | `#141414` | Cards and panels. |
| Foreground | `#ffffff` | Primary text. |
| Muted | `#a3a3a3` | Secondary text — the one secondary value. |
| **Accent** | `#c7ae5e` | **The** Vanta gold. Champagne, not yellow. |
| Accent hover | `#d8c07a` | Hover and highlight only. |
| Hairline | `rgba(255,255,255,0.055–0.11)` | Borders. Always thin. |

**Gold is rationed to roughly 8% of any frame.** The palette is ~90% charcoal, ~8% champagne, ~2% bright accent. A previous pass through this codebase deliberately consolidated three competing golds into one and removed all blue tints so every dark value is pure neutral (R=G=B). Do not reintroduce either problem.

The house rule is **glass, not gold**: depth comes from translucent charcoal, thin warm hairlines and controlled light — not from filling shapes with metal. A solid gold block reads as mass-market the instant it appears.

## Typography

- **Display / headlines** — Fraunces (serif), weight 500, tight tracking
- **Body / UI** — Manrope
- **Monospace** — Geist Mono, used for batch and lot numbers

⚠️ The CSS variable is named `--font-cormorant-display` but is bound to **Fraunces**. Legacy name; trust the font, not the variable.

## Visual language

Dark matte laboratory. Product photographed on a dark field, lit from behind, with a soft contact shadow. Frame edges fall away rather than ending in a hard rectangle — a pasted-on photo border is the single most common way this brand looks cheap. Generous negative space, hairline borders, controlled glow rather than bloom.

**Motion**: 200–350ms, eased, restrained. Nothing bounces. Reduced-motion is respected everywhere on the site and creative should feel like it belongs to that same discipline.

**What it is not**: supplement, pharma, clinic, bodybuilding, gamer neon, or stock-photo science (no beakers of glowing liquid, no gloved hands holding pipettes at the camera). If a frame would look at home on a mass-market nootropics ad, it is wrong.

Think: premium biotech, Apple restraint, luxury laboratory.

## Voice

Precise and factual. Short declarative sentences, one idea at a time. No hype, no stacked adjectives, no emojis, no exclamation marks.

**Describe what a thing is, never what it will do.** This is both the brand's voice and its legal position, which is convenient — the disciplined version is also the compliant one.

Good: *"Batch VL-BPC-0826. Tested 4 August. The full report is on the site."*
Bad: *"Unlock your research potential with our premium peptides!"*

## What the business actually is

Direct-to-consumer e-commerce, not institutional procurement. Customers browse a catalogue, add to cart and check out themselves. There is no quoting, no purchase orders, no sales team. An automated persona pass on this brand produced "Procurement Specialist" and "Academic Researcher" — wrong, and it produces wrong creative.

Real mechanics that exist on the site and can be referenced:
- Public product catalogue across categories including Research Peptides, Growth Factors, Metabolic Research, Cognitive Research, Analytical Reference, Calibration Series, Solvents & Solutions *(these are the admin picklist — confirm a category has live products before building a concept around it)*
- **Public COA library**, filed per production batch, searchable by product, batch or lot number
- Membership programme with named tiers: Vanta Essential, Vanta Pro, Vanta Elite, Vanta Black
- Loyalty points and store credit
- Ambassador/referral programme with personal codes
- Coupon codes, quantity bundle pricing, subscribe-and-save
- Back-in-stock notifications
- Bacteriostatic water as a companion accessory

**Never attach a specific price, percentage, threshold or benefit to any of these in creative without re-verifying against the live store.** Multi-buy promotions are admin toggles that default to OFF and are frequently not running.

## The differentiator worth building on

Most of this category asks to be trusted. Vanta Labs publishes a batch-level COA library where a customer can search a lot number and read the actual report.

That is a genuine, checkable difference, and it is the strongest creative asset the brand has — partly because it is the rare marketing angle that gets *more* persuasive the more literal you make it. "Here is the document" needs no claim attached to it, which is exactly why it survives ad review when outcome-led creative does not.
