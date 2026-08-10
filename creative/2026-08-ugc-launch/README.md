# Vanta Labs — 10 UGC concepts (Aug 2026)

Products in scope, from the three label renders supplied:

| Product | Live slug | Landing path |
|---|---|---|
| GLP-1 5mg, lyophilized powder | `glp-1` | `/products/glp-1` |
| GHK-Cu 100mg, lyophilized powder | `ghk-cu` | `/products/ghk-cu` |
| Bacteriostatic Water 10mL | *not confirmed in catalogue* | `NEEDS_VERIFICATION` |

---

## Read this before shooting anything

**1. Eligibility gate — partially resolved as of 10 Aug 2026.**
No written category ruling has been obtained for the Vanta Labs domain. But a
competitor screen recording supplied by the operator shows a research-peptide
seller running a **paid** TikTok ad in-feed — "Ad" label, Shop coupon sticker,
spark code — for a research compound, carrying the disclaimer *"For research use
only. Not for human consumption."*

That is real evidence the category is **not blanket-prohibited** on TikTok, and it
moves the honest read from "genuinely unknown" to "the category demonstrably runs;
get your own ruling." Two caveats that stop it being a green light:

- Approval is **per-advertiser and per-account**, not per-category. Another
  account clearing review says nothing about whether yours will.
- The observed ad was for a non-GLP compound. **GLP-1 remains the highest-risk
  item in the catalogue** because the compound class is publicly tied to weight
  loss, and moderation reads the category, not the copy.

**Revised recommendation:** submit for category review, but lead the submission
with a low-risk item — Bacteriostatic Water or GHK-Cu — not GLP-1. Keep organic
running in parallel; a hook that works organically is evidence worth having
whichever way the ruling lands. Every concept below stays `needs_verification`
until a written answer exists.

**2. There are no published COAs yet.**
`coa-library-notice.tsx` states, in the operator's own words, that Vanta-branded
batch-specific COAs *"are currently being prepared and will be added to this
library as they become available."* That means:

- **No purity figure appears in any concept.** The product description says
  ">=99%", but the substantiation test requires that value on a published report
  in the live library. It isn't there. The number stays out of creative until it is.
- **Lot VL25001 is never presented as a batch with a readable report.** It is
  render artwork. Concepts may show that a lot number is printed on the vial —
  that is visibly true — but never "search this lot and read its COA".
- The honest documentation angle right now is the one the site already makes:
  *ask support for the available third-party testing documentation before you order.*
  That is verbatim substantiated, and it is a stronger ad than a claim would be.

**3. No price appears in any concept.** The SQL sets 5mg at $49.99 and GHK-Cu
100mg at $74.99, but promotions are admin toggles that default off and prices must
be re-verified against the live store on the day. If you want a price-led variant,
verify first, then add it.

**4. The supplied renders are off-brand as-is.** They are high-key white-field.
Vanta is dark matte laboratory — near-black `#0a0a0a`, one champagne accent
`#c7ae5e` rationed to ~8% of frame, light from behind, soft contact shadow. The
white renders are usable as a *deliberate* contrast beat (a clean product insert
cut against dark UGC), but not as the default look. Any cinematic insert should be
re-lit or regraded to dark field.

**5. Compliance floor, applied to all ten.** No human use, no second-person
outcome framing, no dosing, no reconstitution or mixing guidance (this is why the
Bacteriostatic Water concepts are catalogue-led and stop at "it exists, it's
listed"), no medical/metabolic/cosmetic/performance claim explicit or implied, no
invented reviews or results, no manufactured scarcity, no named competitors.
"For laboratory research use only" is on screen in every concept.

**6. Registry.** `registry.py similar` was run against the ledger before drafting.
The ledger is empty — this is the first creative registered, so no angle here is a
repeat. All ten are registered at status `draft` in `creative-history.json`.

---

## The test matrix

Ten concepts, ten different underlying angles — not ten rewrites of one. The
paired variants vary exactly one axis so a result is attributable:

| Pair | Axis varied | Everything else held |
|---|---|---|
| 001 vs 002 | Hook only (first 2s) | script, shots, CTA, LP |
| 003 vs 004 | Opening frame (face vs product) | message, length, CTA |
| 005 vs 006 | Length (9s vs 30s) | angle, hook family, LP |
| 007 vs 008 | CTA + landing page (product vs COA/support) | hook, script, format |
| 009, 010 | Standalone angles — no paired control yet | — |

---

# The concepts

---

## vl-ugc-001 — "I ordered it to see what showed up"

```
CONCEPT_ID        vl-ugc-001
ARCHETYPE         ugc_talking_head
PLATFORM          tiktok
HYPOTHESIS        An unboxing framed as verification — not excitement — outperforms
                  a standard unboxing, because this category's buyers are worried
                  about authenticity, not novelty. Disproved if CTR sits at or
                  below the account trailing rate for the cinematic control.
ELIGIBILITY       needs_verification — GHK-Cu is a lower-risk item than GLP-1 for
                  a first submission; no health claim anywhere in the concept.
LENGTH            15s
AUDIENCE          Adults 25-44 who have bought research materials online before and
                  have been burned by an unlabelled vial in a bubble mailer.
```

**HOOK (0:00–0:02, verbatim)**
> "I bought this specifically to see whether the label matched the listing."

**OPENING_FRAME** Handheld, real desk, daylight from a window. A hand is already
mid-motion lifting the GHK-Cu vial out of the packaging. No logo card, no title.
Face is partially in frame, off-centre left.

**SCRIPT**

| Time | Spoken | On screen |
|---|---|---|
| 0:00–0:02 | "I bought this specifically to see whether the label matched the listing." | — |
| 0:02–0:06 | "GHK-Cu, hundred milligram, lyophilized powder. That's what the site said. That's what's printed." | `GHK-Cu 100mg` |
| 0:06–0:10 | "Lot number on the vial. Storage condition on the vial. Research use only on the vial." | `Lot no. printed` / `Store at 2–8C` |
| 0:10–0:13 | "It's a boring result. Boring is the point." | — |
| 0:13–0:15 | "Vanta Labs. It's on the site." | `For Laboratory Research Use Only` |

**SHOT_LIST**
1. (0:00–0:02, 2s) Handheld MS, talent lifting vial from mailer. Slight overshoot on the move — keep it.
2. (0:02–0:06, 4s) Over-shoulder, phone-macro on the label. Rack from cap to label text.
3. (0:06–0:10, 4s) Three quick 1.3s pushes: lot line, storage line, RUO line.
4. (0:10–0:13, 3s) Back to talent, vial held loosely, shrug delivery.
5. (0:13–0:15, 2s) Vial set down on desk. Hold.

**VISUAL_DIRECTION** Native, not graded to hell. Real room, one window source,
mild handheld. Keep the white vial reading cool against a warm desk. The only
brand element is the on-screen type: Manrope, white, and one hairline rule in
`#c7ae5e` under the final text card. Gold nowhere else.

**ON_SCREEN_TEXT** `GHK-Cu 100mg` · `Lot no. printed` · `Store at 2–8C` ·
`For Laboratory Research Use Only`. All set inside the middle 60% of frame —
clear of the top 12%, bottom 20% and the right 15% action rail.

**VOICEOVER** None — live sync sound only. Flat, unimpressed delivery. No enthusiasm.

**CTA** "It's on the site under Tissue Research."

**CAPTION** `bought it to check the label against the listing. label matched. research use only.`

**LANDING_PAGE** `/products/ghk-cu` — the ad is about this specific listing, so the
listing is the destination. Sending checking-behaviour traffic to a category page
loses the thread.

**CLAIMS_USED**
- "GHK-Cu, 100mg, lyophilized powder" — live catalogue (`load-evo-catalog-grouped.sql`, `ghk-cu` 100mg dose) + supplied label artwork.
- "Lot number printed on the vial" — visible on supplied label artwork.
- "Store at 2–8C" — printed on supplied label artwork. Confirm shipped label matches before shoot.
- "For laboratory research use only" — printed on label; site-wide product framing.
- No purity, no COA, no outcome claim made.

---

## vl-ugc-002 — hook variant of 001

```
CONCEPT_ID        vl-ugc-002
ARCHETYPE         ugc_talking_head
HYPOTHESIS        A question hook out-hooks a statement hook on the same body.
                  Disproved if CTR gap vs 001 is UNRESOLVED at 5k impressions each.
ELIGIBILITY       needs_verification — identical surface to 001.
LENGTH            15s
```

**Everything is identical to vl-ugc-001** — same shots, same body script, same
on-screen text, same CTA, same caption, same landing page, same talent, same room,
same day. **Only the first two seconds change:**

**HOOK (0:00–0:02, verbatim)**
> "How do you actually know what's in the vial you just bought?"

**OPENING_FRAME** Same handheld lift, but talent is looking at camera, not the vial.

Shoot 001 and 002 back-to-back in one session. If anything else drifts — lighting,
wardrobe, room — the test is void.

**CLAIMS_USED** Same as 001. The hook is a question and asserts nothing.

---

## vl-ugc-003 — "the boring part of the label"

```
CONCEPT_ID        vl-ugc-003
ARCHETYPE         ugc_talking_head / educational
HYPOTHESIS        Teaching the four things a research label must carry earns
                  attention without a claim, and qualifies the click. Disproved if
                  view-through is fine but CTR is decisively below account trailing.
ELIGIBILITY       needs_verification
LENGTH            22s
AUDIENCE          Careful buyers; people who read the listing twice.
```

**HOOK** > "Four things should be printed on a research vial. Most of what I get sent has two."

**OPENING_FRAME** Face, centre, close. Talking already. Vial not yet visible.

**SCRIPT**

| Time | Spoken | On screen |
|---|---|---|
| 0:00–0:03 | "Four things should be printed on a research vial. Most of what I get sent has two." | — |
| 0:03–0:07 | "What it is. How much is in there." | `1. Compound` `2. Quantity` |
| 0:07–0:12 | "The form it's supplied in — this one's a lyophilized powder." | `3. Form` |
| 0:12–0:17 | "A lot number, so the vial ties back to a batch. And the storage condition." | `4. Lot no.` `Store at 2–8C` |
| 0:17–0:20 | "And it says what it's for. Laboratory research use only." | `For Laboratory Research Use Only` |
| 0:20–0:22 | "That's the whole bar. It's low. Meet it." | — |

**SHOT_LIST**
1. (0:00–0:03, 3s) MCU face, handheld, centre.
2. (0:03–0:12, 9s) Cut to over-shoulder macro; talent points at each line with a fingertip.
3. (0:12–0:17, 5s) Two macro pushes, lot line then storage line.
4. (0:17–0:22, 5s) Back to face, vial now in hand at chest height.

**VISUAL_DIRECTION** Native room, single soft source. Numbered on-screen counters
in Geist Mono, white, with the numeral in `#c7ae5e` — that mono/gold pairing is the
only brand flourish and it earns its place on a lot number.

**VOICEOVER** None. Sync sound, instructional but not lecturing.

**CTA** "Vanta Labs, if you want to see one that does."

**CAPTION** `four things. lot number is the one people skip. research use only.`

**LANDING_PAGE** `/products/glp-1` — highest-intent listing, and the label in shot
is the GLP-1 5mg. Swap the product and LP together, never separately.

**CLAIMS_USED**
- "Lyophilized powder", "5mg", "GLP-1" — live catalogue + label artwork.
- "Lot number", "Store at 2–8C", "For laboratory research use only" — printed on supplied label artwork.
- "Most of what I get sent has two" — **talent's own experience, stated in first person.** This must be genuinely true for the person on camera. If it isn't, cut the second half of the hook. Do not script this for someone who hasn't bought in this category.

---

## vl-ugc-004 — opening-frame variant of 003

```
CONCEPT_ID        vl-ugc-004
ARCHETYPE         ugc_talking_head / educational
HYPOTHESIS        Opening on the product rather than the face holds the same
                  audience at lower cost. Disproved if 2s view rate is decisively
                  below 003.
ELIGIBILITY       needs_verification
LENGTH            22s
```

Identical script, shots 2–4, text, CTA, caption and landing page to **vl-ugc-003**.
Only the opening frame changes:

**OPENING_FRAME** Extreme macro on the vial cap, rack-focusing down to the label as
the first line lands. No face until 0:03. Same audio, same words.

**CLAIMS_USED** Identical to 003.

---

## vl-ugc-005 — "nine seconds, one question" (short cut)

```
CONCEPT_ID        vl-ugc-005
ARCHETYPE         curiosity_hook
HYPOTHESIS        A 9s cut of the documentation angle wins on cold traffic where a
                  30s cut can't survive the scroll. Disproved if completion is high
                  on both and CTR is decisively worse on the short.
ELIGIBILITY       needs_verification
LENGTH            9s
```

**HOOK** > "I asked them for the testing documentation before I ordered. They sent it."

**OPENING_FRAME** Talent holding phone in one hand, vial in the other, mid-sentence.

**SCRIPT**

| Time | Spoken | On screen |
|---|---|---|
| 0:00–0:03 | "I asked them for the testing documentation before I ordered. They sent it." | — |
| 0:03–0:06 | "Their COA library page literally tells you to do that. Contact support first." | `COA Library` |
| 0:06–0:09 | "Vanta Labs. Ask before you buy." | `For Laboratory Research Use Only` |

**SHOT_LIST**
1. (0:00–0:03, 3s) MS handheld, both hands full, natural.
2. (0:03–0:06, 3s) Phone screen insert — the live `/coa-library` page scrolled to the notice panel. Screen-record it, do not mock it up.
3. (0:06–0:09, 3s) Vial down on desk, hold, cut on the beat.

**VISUAL_DIRECTION** Native. The phone-screen insert is the hero — real page, real
scroll, slight finger blur. A mocked-up page here would be fabricated evidence.

**VOICEOVER** None.

**CTA** "Ask before you buy."

**CAPTION** `asked for the testing docs first. that's what the page tells you to do.`

**LANDING_PAGE** `/coa-library` — the ad's payoff *is* that page. Sending this to a
product page breaks the promise.

**CLAIMS_USED**
- "Their COA library page tells you to contact support first" — verbatim substantiated by `coa-library-notice.tsx`: *"Contact our support team before ordering. We're happy to provide available third-party testing documentation for the production batches supplying our current inventory."*
- "I asked them and they sent it" — **only shootable if this actually happened for the talent.** Have them make the request for real, keep the reply, and shoot after. If support does not send documentation, this concept is dead and must not be shot.
- No purity figure, no batch report shown, no claim that a Vanta-branded batch COA is published — because none is yet.

---

## vl-ugc-006 — long cut of 005

```
CONCEPT_ID        vl-ugc-006
ARCHETYPE         curiosity_hook / documentation
HYPOTHESIS        Same angle at 30s converts better on warm/retargeting traffic
                  because it has room for the objection. Disproved if warm CTR and
                  ATC both come in decisively below the 9s cut.
ELIGIBILITY       needs_verification
LENGTH            30s
```

Same hook, same talent, same room, same landing page as **vl-ugc-005**. The body
expands:

| Time | Spoken | On screen |
|---|---|---|
| 0:00–0:03 | "I asked them for the testing documentation before I ordered. They sent it." | — |
| 0:03–0:09 | "Here's the thing nobody in this category says out loud: most sites just tell you it's tested." | — |
| 0:09–0:16 | "This one says the batches are independently third-party tested through a U.S.-based manufacturing partner, and that their own batch-specific COAs are still being prepared." | `Independently third-party tested` |
| 0:16–0:23 | "That's a more honest sentence than I usually get. It's on their COA library page. Go read it yourself." | `COA Library` |
| 0:23–0:27 | "And it tells you to contact support before ordering, which is what I did." | `Contact support before ordering` |
| 0:27–0:30 | "Vanta Labs. Research use only." | `For Laboratory Research Use Only` |

**SHOT_LIST**
1. (0:00–0:03, 3s) MS handheld.
2. (0:03–0:09, 6s) Same setup, slight reframe — cut on a natural head turn, not a jump.
3. (0:09–0:16, 7s) Phone screen-record of the live `/coa-library` notice, scrolling.
4. (0:16–0:23, 7s) Back to talent, vial in hand.
5. (0:23–0:30, 7s) Macro on the label, then hold on the RUO line.

**VISUAL_DIRECTION / VOICEOVER / CAPTION** As 005. Caption:
`the honest version of "we test our stuff". read the page yourself.`

**CTA** "Read the page yourself."

**CLAIMS_USED**
- "Independently third-party tested through a U.S.-based manufacturing partner" and "batch-specific COAs are currently being prepared" — both verbatim from `coa-library-notice.tsx`. **Do not paraphrase into "we publish COAs".**
- Everything else as 005.

---

## vl-ugc-007 — "the cold chain is the whole product" (product CTA)

```
CONCEPT_ID        vl-ugc-007
ARCHETYPE         problem_solution
HYPOTHESIS        Handling and cold chain is an under-used angle that names a real
                  sourcing frustration with zero claim surface. Disproved if it
                  underperforms 001 on CTR at equal spend.
ELIGIBILITY       likely_eligible for the *angle* (no health claim at all); the
                  product category still gates the account — treat as
                  needs_verification until the ruling lands.
LENGTH            18s
```

**HOOK** > "This showed up in a padded envelope in August. That's the part I actually care about."

**OPENING_FRAME** Mailer on a doorstep, hand entering frame to pick it up. Hot
daylight, visible heat in the shot if you can get it.

**SCRIPT**

| Time | Spoken | On screen |
|---|---|---|
| 0:00–0:04 | "This showed up in a padded envelope in August. That's the part I actually care about." | — |
| 0:04–0:09 | "Lyophilized powder is more forgiving than a solution. It's still not nothing." | `Lyophilized powder` |
| 0:09–0:14 | "The vial tells you the condition it wants. Two to eight degrees. Printed, not buried in an email." | `Store at 2–8C` |
| 0:14–0:18 | "Straight in the fridge. Research use only." | `For Laboratory Research Use Only` |

**SHOT_LIST**
1. (0:00–0:04, 4s) Doorstep pickup, handheld, one continuous move.
2. (0:04–0:09, 5s) Indoors, mailer opened on the counter, vial revealed.
3. (0:09–0:14, 5s) Macro on the storage line.
4. (0:14–0:18, 4s) Fridge door opens, vial placed on shelf, door closes. Cut on the close.

**VISUAL_DIRECTION** Genuinely native — doorstep, kitchen, fridge light. This is
the one concept where imperfection is the asset. No gold, no type flourish beyond
the plain white on-screen lines.

**VOICEOVER** None.

**CTA** "Vanta Labs. On the site."

**CAPTION** `august delivery. the storage condition is printed on the vial, which is the minimum.`

**LANDING_PAGE** `/products/glp-1` — catalogue-led CTA to the listing.

**CLAIMS_USED**
- "Lyophilized powder", "Store at 2–8C", RUO — supplied label artwork + catalogue copy.
- "Lyophilized powder is more forgiving than a solution" — general, true statement about the physical form; no product-specific stability claim, no shelf-life figure. Do **not** extend this into a stability duration.
- No claim about how Vanta actually ships (no cold-pack claim, no transit-time claim) — the concept only shows what arrived at this talent's door. Keep it that way unless fulfilment confirms a shipping spec in writing.

---

## vl-ugc-008 — CTA/landing variant of 007

```
CONCEPT_ID        vl-ugc-008
ARCHETYPE         problem_solution
HYPOTHESIS        A documentation-led CTA converts a handling-led ad better than a
                  catalogue-led one, because the objection it raises is trust.
                  Disproved if ATC rate is decisively below 007.
ELIGIBILITY       needs_verification
LENGTH            18s
```

Identical to **vl-ugc-007** through 0:14. Final beat and destination change:

| Time | Spoken | On screen |
|---|---|---|
| 0:14–0:18 | "Straight in the fridge. And if you want the testing documentation, their support team will send what's available before you order." | `Contact support before ordering` |

**CTA** "Ask support before you order."

**CAPTION** `august delivery. storage printed on the vial. docs on request before ordering.`

**LANDING_PAGE** `/coa-library` — one axis changed from 007: CTA and destination
move together, because a CTA that points somewhere the ad doesn't send you isn't a
test, it's a bug.

**CLAIMS_USED** As 007, plus the support/documentation line verbatim from
`coa-library-notice.tsx`.

---

## vl-ugc-009 — "the accessory nobody films"

```
CONCEPT_ID        vl-ugc-009
ARCHETYPE         comparison_generic / catalogue-led
HYPOTHESIS        A catalogue-completeness angle built on the least glamorous item
                  reads as credibility and is the lowest-claim-surface ad in the
                  set — likely the best first submission for category review.
                  Disproved if it can't clear account trailing CTR.
ELIGIBILITY       likely_eligible as an angle — sterile solution, no compound claim.
                  NEEDS_VERIFICATION on two counts: the platform ruling, and whether
                  Bacteriostatic Water is actually a live, published listing. It was
                  not found in the catalogue seed. Confirm before shooting.
LENGTH            15s
```

**HOOK** > "Nobody makes a video about this one. Which is exactly why I'm making one."

**OPENING_FRAME** The Bacteriostatic Water vial alone on a plain surface, hand
setting it down. Deadpan.

**SCRIPT**

| Time | Spoken | On screen |
|---|---|---|
| 0:00–0:04 | "Nobody makes a video about this one. Which is exactly why I'm making one." | — |
| 0:04–0:08 | "Bacteriostatic water. Ten millilitres. Sterile solution." | `Bacteriostatic Water 10mL` |
| 0:08–0:12 | "Same label discipline as everything else they list. Lot number. Storage condition. Research use only." | `Lot no.` `Store at 2–8C` |
| 0:12–0:15 | "A catalogue tells you who someone is. This is a boring, complete one." | `For Laboratory Research Use Only` |

**SHOT_LIST**
1. (0:00–0:04, 4s) MS, talent to camera, vial set down in frame.
2. (0:04–0:08, 4s) Macro label push.
3. (0:08–0:12, 4s) Two quick macro cuts: lot line, storage line.
4. (0:12–0:15, 3s) Wide-ish: all three vials on the surface together, hand withdrawing.

**VISUAL_DIRECTION** Cleanest of the ten — a plain matte surface, one soft key.
This is where the supplied white-field renders can appear as a 1s cutaway, because
the contrast against handheld footage is deliberate. Regrade toward neutral dark if
you use them for longer than a beat.

**VOICEOVER** None.

**CTA** "The full catalogue's on the site."

**CAPTION** `the least interesting product they sell. same label. research use only.`

**LANDING_PAGE** `/products` — this is the one concept that is genuinely about the
catalogue, so the catalogue is the right destination.

**CLAIMS_USED**
- "Bacteriostatic water, 10mL, sterile solution" — supplied label artwork. **Listing not confirmed live** — verify before shoot.
- Lot / storage / RUO — supplied label artwork.
- **No reconstitution, mixing, dilution or preparation content anywhere.** This is the concept most likely to drift there; it must stop at "this item exists and is labelled properly". If a talent ad-libs a mixing line, the take is unusable.
- "Same label discipline as everything else they list" — supported by the three supplied labels sharing the same required fields. Do not extend to "every product", which isn't verified.

---

## vl-ugc-010 — "what I check before I order anything"

```
CONCEPT_ID        vl-ugc-010
ARCHETYPE         ugc_talking_head / educational
HYPOTHESIS        A checklist format the viewer can apply to any seller earns saves
                  and shares, and positions Vanta as the one that survives the
                  checklist. Disproved if saves are high but CTR is decisively low —
                  which would mean it's a good post and a bad ad.
ELIGIBILITY       needs_verification
LENGTH            28s
AUDIENCE          Comparison-stage buyers who have two tabs open.
```

**HOOK** > "Three questions I ask a site before I order. Most fail on the second one."

**OPENING_FRAME** Face, tight, no product. Talking before the frame settles.

**SCRIPT**

| Time | Spoken | On screen |
|---|---|---|
| 0:00–0:04 | "Three questions I ask a site before I order. Most fail on the second one." | — |
| 0:04–0:10 | "One. Does the listing name the form and the quantity, or does it just name the compound?" | `1. Form + quantity` |
| 0:10–0:18 | "Two. If I email and ask for testing documentation, do I get an answer or do I get a brochure?" | `2. Ask for the documentation` |
| 0:18–0:24 | "Three. Does the vial that arrives carry a lot number I can quote back to them?" | `3. Lot number on the vial` |
| 0:24–0:28 | "Vanta Labs cleared all three for me. Run it on whoever you're about to buy from." | `For Laboratory Research Use Only` |

**SHOT_LIST**
1. (0:00–0:04, 4s) MCU face, handheld.
2. (0:04–0:10, 6s) Cut to laptop screen — the live `/products/glp-1` listing, real scroll.
3. (0:10–0:18, 8s) Back to face, then a phone-held insert of the real support reply. **Blur or crop any personal detail.**
4. (0:18–0:24, 6s) Macro on the printed lot line.
5. (0:24–0:28, 4s) Face, vial in hand, direct to camera.

**VISUAL_DIRECTION** Native throughout. Numbered counters in Geist Mono with the
numeral in `#c7ae5e`. No music bed under the checklist beats — let the count land dry.

**VOICEOVER** None.

**CTA** "Run it on whoever you're about to buy from."

**CAPTION** `three questions. second one filters most of them out.`

**LANDING_PAGE** `/products/glp-1` — comparison-stage traffic wants a listing to
judge, not a library.

**CLAIMS_USED**
- Q1 form + quantity — visible on the live listing.
- Q2 "do I get an answer" — **only shootable if the talent genuinely emailed and genuinely got a reply.** The screen insert must be a real reply. A recreated one is fabricated evidence.
- Q3 lot number on the vial — supplied label artwork.
- "Vanta Labs cleared all three **for me**" — first-person account of that talent's own experience, and it must be true of them. It is not a general claim and must not be rewritten into "Vanta clears all three".
- No purity, no COA-published claim, no outcome claim.

---

## Sound

No trending audio on any of these. Trending TikTok sounds are generally not
cleared for paid use. Every concept above works on sync sound alone, which is also
the more native choice. If a bed is wanted, it must be commercially licensed and
flagged for licensing review before the ad goes live.

## What to shoot first

If only three can be shot: **009** (lowest claim surface — the right first
submission for category review), **001** (cheapest read on whether the verification
angle hooks at all), **005** (tests the documentation angle, and its production
requirement — a real support reply — is a useful stress test of the funnel itself).

---

# Competitor structural read — 10 Aug 2026

Source: operator-supplied screen recording of a competitor's paid TikTok ad.
**Structure only. No asset, look, copy or claim from that ad is reused, and the
competitor is never named in any Vanta creative.**

## The structure it uses

| Beat | What it does |
|---|---|
| 0–3s | Slow forward dolly down a long lab corridor toward one small vial, far away. No face, no text, no voice. Pure curiosity open. |
| 3–6s | Cut in. Macro on the vial, label legible. |
| 6–10s | Hero: vial on a lit plinth, label fully readable, camera near-static. |
| 10–13s | Extreme macro on the label's fine print. |
| 13–15s | Pull back down the corridor. Final frame matches the first — it loops. |

Product-only. No creator, no voiceover, no talking head. All copy lives outside
the video file.

## Three things worth taking

**The RUO disclaimer is a persistent bottom strip**, not a one-frame flash. Worth
copying as practice — it is plausibly part of why that ad clears review.

**All the selling copy is platform chrome, not pixels.** The "Top-tier research
compounds. Use code…" line is the **ad caption**. The "Extra 20% off / Claim" chip
is a **TikTok coupon sticker**. Neither is rendered into the video. This is the
single most useful finding: the video stays clean and evergreen, and every claim,
price and code is editable at upload without a re-render.

**Product-only carries no testimonial risk at all.** No creator means no
first-person experience to fabricate. For a brand that cannot make outcome claims,
this is structurally the safest format available.

## Two things deliberately NOT taken

**The purity figure printed on the label artwork.** The competitor's vial reads
"99% Purity" in the render. Printing a purity number into label artwork is still
making the claim — the pixels are the claim. Vanta's ≥99% is not on a published
COA, so it goes on no label, in no render, in no caption. This is exactly the trap
in `compliance.md`.

**The cyan CGI neon look.** Glowing liquid, teal rim light, holographic plinths —
`brand.md` rules this out by name as stock-photo science, and matching a
competitor's look is borrowing an asset rather than learning a structure. The
Vanta cut of this structure is near-black neutral charcoal, cool white key light,
one champagne `#c7ae5e` edge accent at roughly 8% of frame, real macro over CGI
glow.

---

# Caption + overlay copy (platform chrome — never burned into the video)

The video files carry no text. Everything below is typed into TikTok at upload.

**Coupon sticker:** `20% off` · Code: `VANTA`
**Caption:** `Research peptides. Lot number, storage condition and research-use-only printed on every vial. Use code VANTA for 20% off.`
**Disclaimer strip (all ads, always):** `For research use only. Not for human consumption.`

Two things to settle before this posts:

1. **The `VANTA` coupon must exist and be enabled on the live store.** No coupon
   named `VANTA` is seeded anywhere in this repo — it lives in the admin DB, and
   promotions default OFF. Verify it is live, at 20%, on the day the ad goes up.
   Operator confirmed on 10 Aug 2026 that they will create it.
2. **"Leading research peptides" was requested and is not used.** "Leading" is an
   unsupported superiority claim — the same class `compliance.md` puts alongside
   invented certifications, and there is nothing on file substantiating it. The
   caption above says what is checkable instead. Because this copy is platform
   chrome, swapping the word back is a text edit at upload and costs no re-render
   — but it ships unsubstantiated, and that is the operator's call to make
   knowingly.

## Recommendation, not instruction

No campaign has been launched, no budget set, no ad submitted. These ten are drafts
in the registry. A human decides what gets shot, what gets submitted, and what gets
spend.
