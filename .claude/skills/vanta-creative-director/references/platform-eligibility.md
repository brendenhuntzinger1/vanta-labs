# Platform eligibility and specs

## Eligibility is a gate, not a disclaimer

Research peptides sit in a category that ad platforms commonly prohibit or restrict. **This has not been confirmed for Vanta Labs.** No published ruling has been obtained, and an attempt to retrieve TikTok's current policy from the build environment was blocked at the network layer, so nothing here should be treated as a verified reading of platform rules.

That uncertainty changes how you work rather than stopping you:

- State an eligibility judgement on **every** concept, with the reason
- When unsure, mark `NEEDS_VERIFICATION` — never assume approval
- Never design around moderation. No obfuscated product names, no coded language, no spelling tricks, no "they probably won't catch it"
- If a concept is likely prohibited, say so and offer the nearest eligible alternative

**The open question that gates paid spend:** submit the Vanta Labs domain and a representative product page to the platform's own category review and get a written answer. Until then, treat all paid-media work as provisional. Organic short-form is unaffected and is a reasonable place to test creative in the meantime — a hook that works organically is evidence worth having whatever the ad ruling turns out to be.

| Label | Meaning |
|---|---|
| `likely_eligible` | No product/claim conflict apparent; still subject to review |
| `restricted` | May require certification, allow-listing or category permission |
| `needs_verification` | Genuinely unknown — the honest default here |
| `prohibited` | Should not be submitted |

Eligibility is about the **product category and the claims**, not the artwork. A compliant, evidence-led concept for a prohibited category is still prohibited — which is why this gate runs before generation, not after.

## Angles that reduce risk

Not evasion — genuinely lower-risk framing, because they make no health claim at all:

- **Documentation-led.** Show the report. Zero outcome language.
- **Materials/QC-led.** Handling, cold chain, labelling, batch traceability.
- **Catalogue-led.** What exists, how it's organised, how to find a lot number.
- **Educational.** How analytical testing works, generally and truthfully.

Angles that raise risk regardless of wording: anything touching bodies, outcomes, performance, wellness, or a person as end user.

---

## TikTok (first platform)

- **Aspect** 9:16, 1080×1920
- **Length** 9–15s for cold traffic; up to 34s when the content earns it
- **Safe areas** keep text clear of roughly the top 12% and bottom 20%, and the right ~15% where the action rail sits
- **Opening** the first 1–2 seconds decide everything; open on motion or a face, never a logo card
- **Captions** short, lowercase-leaning, native — a press release reads as an ad instantly
- **Sound** commercially licensed only. Trending audio is usually *not* cleared for paid use; flag any music choice for licensing review
- **Native feel beats polish.** Slightly imperfect, handheld, real-room footage typically outperforms a finished commercial in-feed — the exception being the cinematic product archetype, where the contrast is the point

**Tracking:** `ttclid` is already captured and persisted to `order_attribution` by the Step 1 attribution layer. No creative work is needed to enable measurement — the click ID travels from ad click to paid order automatically.

## Meta (later — do not build yet)

Same concept schema. Differences live here, not in the schema:

- **Aspect** 9:16 Reels/Stories, 4:5 feed
- **Length** 15–30s tolerated more readily
- **Safe areas** differ from TikTok; re-frame rather than re-shoot
- **Tone** slightly more polished; explanatory copy works better in-feed
- **Tracking** `fbclid`, already captured by the same attribution layer

Adding Meta means a section in this file and a value in the platform enum. If you ever find yourself needing to change the concept schema to support a platform, something has leaked — put it here instead.

## Rendering a concept for a platform

Concepts are written platform-agnostic, then rendered. A concept that only makes sense at 9:16 with TikTok pacing is a TikTok asset, not a concept — write the idea, then specify the cut.
