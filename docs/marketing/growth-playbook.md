# Vanta Labs — Growth Playbook

**Fifty marketing tactics, ranked by expected impact at the stage this store is actually at.**

Compiled 30 August 2026. Every figure below was read from the live production database, the live
Meta ad library, and the Rebbel account state. Nothing is estimated. Where a number is zero, it is
zero in the source.

Published as an artifact: https://claude.ai/code/artifact/108971e6-5bf8-43b7-91ec-32e473d44a81

---

## Baseline (measured, not assumed)

| Metric | Value | Source |
|---|---|---|
| Live products | 38 (35 in stock) | `products` |
| Paid orders, all time | 8 | `orders` |
| Unique customers | 3 | `orders` |
| Average order value | $57.34 | `orders` |
| Total revenue | $458.74 | `orders` |
| Visitors, all time | 364 | `website_analytics_events` |
| Page views carrying a UTM source | 3 of 5,839 | `website_analytics_events` |
| **Published COA records** | **0** | `coa_records` |
| Live products with a `coa_url` | 1 | `products` |
| Coupons currently live | 0 of 368 | `coupons` |
| Email subscribers | 5 | `marketing_subscribers` |
| Ambassador/partner clicks | 131 | `partner_clicks` |
| Referral orders / commissions paid | 0 / 0 | `referral_orders`, `commissions` |
| Membership tiers / members | 5 (Essential inactive) / 2 | `membership_tiers` |
| Connected social channels | 0 | Rebbel |

Category depth: Growth Hormone 7 live SKUs, Longevity 5, Specialty 5, Cognitive 5,
Repair & Recovery 5, GLP 4, Metabolic 4, Blends 2, Solvents 1.

---

## The two findings that reorder everything

**1. The differentiator is not substantiated.** `coa_records` is empty. One of 38 live products
carries a COA URL. The saved brand description leads with "third-party batch testing and transparent
COA documentation" — a claim with no published source behind it today. This is both the compliance
problem and the competitive one: the entire point is that a customer can go and check.

**2. The direct category shows no evidence of running paid social.** A live ad-library check on
30 August found four direct peptide sellers — Precision Peptide Sciences, ProvenPeptides,
Amino Asylum, Science.bio — with **zero** active Meta ads. The brands advertising in the broadened
niche (Seed, Thesis, Huel) sell a legally different product. Absence of competitors here is a signal
about category eligibility, not an opening. Paid media therefore ranks #47–50, not #1.

---

## Phase one — unblock the funnel (01–06)

These are not growth tactics; they are why growth tactics currently have a low ceiling.

1. **Publish the COA library.** File real batch reports for the highest-volume SKUs. Unlocks the
   documentation archetype — the strongest and most ad-review-survivable angle available — and
   retroactively substantiates claims already live on the site. Highest return on this list.
2. **Resolve the coupon table.** 368 coupons, 335 flagged active, **0 currently live** (all end dates
   in the past). Any "use code" creative would break at checkout. Pick one evergreen code or none.
3. **Filter admin traffic out of analytics.** `/vault` (321 views) and `/admin/*` share the storefront
   analytics stream. 337 add-to-carts against 8 purchases is contaminated data, not a checkout crisis.
4. **Tag outbound links with UTMs.** 5,836 of 5,839 page views carry no source. `ttclid` capture
   already works; the gap is entirely outbound.
5. **Connect at least one publishing channel.** Rebbel has the brand and zero connections — there is
   currently no surface to publish organic content to.
6. **Get a written platform category ruling.** Submit the domain and a product page to TikTok and Meta
   category review. Everything in the paid section is provisional until this returns.

## Phase two — the COA moat (07–13)

7. **Make `/coa-library` searchable by lot number.** It already draws 142 views / 30 uniques with
   nothing in it.
8. **Link the batch report from every product page.** `batch_number`, `purity_result`, `testing_date`
   and `lab_name` exist on the product record and are empty on every live SKU.
9. **Run a batch-drop cadence.** Each batch produces one post, one email, one PDP update — operations
   generating marketing.
10. **Put the batch number in product photography.** Monospace, small, in-frame, dark field.
11. **QR the vial label to its own report.** Physical-to-digital proof loop.
12. **Publish the testing policy.** Which lab, which assay, what threshold, and what happens on a fail.
    Stating the failure path is the part competitors omit.
13. **Make documentation-led creative the default archetype.** Report → batch line → vial → "search
    your lot number". Zero outcome language.

## Phase two — organic short-form (14–21)

Paid eligibility is unresolved; organic is unaffected by that ruling.

14. **Post organically before paying for anything.** No eligibility gate, cheapest creative testing.
15. **Cinematic product macro series.** Dark field, backlit, slow push, no copy.
16. **Cold chain, packing and handling footage.** Claim-free, answers "are these people real?"
17. **Educational: what a purity assay measures.** HPLC/mass spec, truthfully, no outcome reference.
18. **Catalogue tours by research category.** Growth Hormone is the deepest shelf at 7 SKUs.
19. **Comparison against the unnamed category norm.** Never a named competitor, never their assets.
20. **Test hooks, not concepts.** Same body, five different opening two seconds. One axis at a time.
21. **Reframe winners across platforms rather than reshooting.** 9:16 and 4:5 from one shoot.

## Phase three — search & content (22–29)

The only channel here that cannot be switched off by someone else's policy update.

22. **Own "[compound] certificate of analysis" queries.** Low competition, high intent, maps onto #1.
23. **Expand the research library past four articles.** Current four are correctly framed; `/research`
    already draws 108 views.
24. **Fill the technical product fields.** `cas_number`, `molecular_formula`, `molecular_weight`,
    `peptide_sequence`, `storage_recommendation` all exist and are unused.
25. **Write every SEO title and description.** 38 live SKUs is 38 entry points.
26. **Write the supplier-vetting guide.** An honest checklist that happens to describe what you do.
27. **Ship Product and Offer structured data.**
28. **Mine real forum questions for article topics.**
29. **Check Shopping-feed eligibility before building a feed.** Merchant Center restricts this category.

## Phase three — email & lifecycle (30–36)

Three customers have placed eight orders. Repeat purchase is already the strength; the list is 5 wide.

30. **Build the list around the report library, not a discount.** "Get each new batch report as it is
    published" — claim-free, and it self-selects for the documentation-minded buyer.
31. **Send the batch report after purchase.** Reinforces the differentiator at the moment trust forms.
32. **Surface back-in-stock capture.** Three live SKUs are out of stock and the feature has captured
    **zero** requests — either invisible or broken.
33. **Measure the abandoned-cart flow you already run.** 9 carts, 29 emails, no recovery figure.
34. **Activate subscribe-and-save.** `product_subscriptions` holds zero rows.
35. **Decide what the membership programme is for.** 5 tiers, Essential inactive, 2 members against 51
    unique visitors to the page. Never quote a tier price or benefit without re-verifying it live.
36. **Win back the customers you have.** At three customers, one recovery is a third of the base.

## Phase three — community & credibility (37–41)

37. **Show up where the category discusses sourcing.** Documents, not pitches.
38. **Collect real reviews with permission — never invent one.** You have three customers. Ask them.
39. **Put a named person behind the standards.** Anonymous vendors are the category norm.
40. **Publish a batch and testing changelog.**
41. **Brief creators on structure, never on claims.** A creator's outcome claim carries your exposure.

## Phase three — partners & referral (42–46)

Fully built, producing nothing: 10 ambassadors, 10 partners, 131 clicks, 0 orders, 0 commissions.
This is a conversion problem, not a recruitment problem.

42. **Diagnose why 131 clicks produced no orders.** Do not recruit into a broken funnel.
43. **Verify referral attribution end to end.** Place a test order through a real ambassador link and
    confirm rows land in `referral_orders` and `commissions`. Both are empty — genuine zero, or silent
    failure?
44. **Recruit ambassadors from customers, not strangers.** Cold recruits reach for outcome claims.
45. **Build a funnel behind `/wholesale`.** 55 views, 9 uniques, no follow-up path. Bulk buyers need no
    ad platform's permission.
46. **Turn on tiered commissions once the base flow converts.** 3 rules configured, 0 paid.

## Phase four — paid media (47–50)

Last on purpose: eligibility unverified, no retargeting pool, strongest angle not yet substantiated.

47. **Treat Meta as closed until proven otherwise.** See finding 2 above.
48. **Branded search first, if the category clears.** Cheapest, lowest-risk paid placement.
49. **Small documentation-led TikTok test, once #6 returns.** Click-ID tracking already flows into
    attribution, so a test will be measurable.
50. **Retarget only when there is a pool worth retargeting.** 364 lifetime visitors cannot support one.

---

## Execution order

| When | Do |
|---|---|
| Week 1 | #1–#5 — COAs, coupons, analytics filtering, UTMs, connect a channel. No budget required. |
| Week 1 | #6 and #43 — platform category review, and one test order through an ambassador link. Both are questions that cannot be answered by reasoning. |
| Weeks 2–3 | #7, #8, #24, #25 — wire reports into PDPs, fill technical and SEO fields. Compounding work against a schema that already exists. |
| Weeks 3–4 | #13–#20 — first creative batch, post organically, test hooks one axis at a time. |
| Ongoing | #9, #30, #31 — the batch-drop loop: report → post → email. |
| Only after | #47–#50 — gated on the category ruling and on the COA library existing. |

---

## Compliance constraints applied throughout

Products are laboratory research materials, research use only. No tactic in this document implies
human use, dosing, reconstitution, or any medical, therapeutic, performance or body-composition
outcome. No fabricated testimonials, reviews, COAs, purity figures, lab names or testing dates. No
named competitor comparisons and no use of competitor assets. Prices, tiers, discounts and stock
status must be re-verified against the live store before appearing in any creative — at time of
writing, no coupon is live.

This document recommends. It does not launch campaigns, set budgets, or spend money.
