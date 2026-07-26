# Vanta Labs — Legal / Regulatory Review Packet

**Purpose:** This document lists every customer-facing claim and compliance item
that an automated pre-launch audit flagged as potentially risky, so a qualified
attorney can review and decide. **This is NOT legal advice.** Nothing here
approves any claim — every item marked ⚠️ needs sign-off by counsel and, where
relevant, your payment processor and 3PL.

**Business context:** research-only peptide e-commerce (not for human/animal use).
Prepared for pre-launch review. File locations reference the codebase so changes
can be made precisely once you decide.

---

## 0. Confirmed CLEAN (no action needed)
- **Prohibited drug names** — `retatrutide`, `tirzepatide`, `semaglutide` do **not**
  appear anywhere customer-facing. Products are branded generically (GLP-1/2/3).
  *Verified in code and the live product database (0 rows).*
- **Research-use-only disclaimer** — present, conservative, and well-drafted
  (not-for-human/animal-use, no dosing, no diagnose/treat/cure, 21+).
- **Age gate** — present (21+), applied site-wide. *Note: it is a client-side
  attestation, not verified age verification (industry-typical; see item 9).*

---

## 1. ⚠️ Universal purity / testing / COA claim — HIGHEST PRIORITY
**Claim (asserted for EVERY product):** *"Every batch is independently third-party
tested and ships with a Certificate of Analysis confirming ≥99% purity, with the
lot number matched to its report."*
**Where:** product descriptions (all SKUs); homepage; product-page badges; footer.
**Risk:** A specific, universal, quantitative purity + testing guarantee. Under
FTC substantiation principles a claim like this generally must be backed by a
real, per-batch COA on file **before** the claim is shown. If any lot lacks a
matching COA, the statement is unsubstantiated. The RUO disclaimer does not cure
a false factual claim.
**Decision needed:** Do you hold a genuine third-party COA + measured purity for
**every** SKU/lot you will sell?
- **If yes for all:** the claim may be defensible — keep, but have counsel confirm.
- **If partial / no:** remove the blanket "≥99% / third-party tested / ships with
  a COA" language and state only what documentation backs (see safer wording).
**Safer wording (if not fully substantiated):** *"Batches are tested by an
independent laboratory; where a Certificate of Analysis is available it is
published in our COA Library and reports the measured purity for that specific
lot."* (Remove the fixed "≥99%" and the "every batch" universal.)
> A code change was already applied so on-page purity/"third-party tested"
> **badges render only when a real purity value + COA exist** for that product.
> The description/homepage *copy* above is your marketing to decide with counsel.

## 2. ⚠️ COA authenticity — verify before launch
**Issue:** Seed/placeholder data set `coa_url` values pointing to `example.com`,
and `coa_url` is a free-text admin field with no validation. If placeholder data
reaches production, "Download COA" links resolve to non-existent PDFs while the
copy asserts published proof. A named lab ("Janoshik Analytical" in seed data) is
itself a factual claim.
**Action:** Before launch, confirm **every live `coa_url` resolves to a genuine,
batch-matched COA**; remove/placeholder any product without a real COA on file
rather than showing testing badges for it.

## 3. ⚠️ "USA Sourced" / origin claim
**Where:** homepage; product detail.
**Risk:** Country-of-origin claims are governed by the FTC Made-in-USA / "USA-
sourced" standard and require documented proof of the actual supply chain
(research peptides are frequently imported).
**Safer wording:** if origin isn't documented, use a shipping fact instead —
*"U.S.-based fulfillment"* — rather than an origin claim.

## 4. ⚠️ "Among the purest sources available"
**Where:** product detail.
**Risk:** Unsubstantiated comparative/superlative. **Recommend: delete outright.**

## 5. ⚠️ "as defined by FDA"
**Where:** signup checkbox — *"…intended for research use only, as defined by FDA."*
**Risk:** Implies the FDA defines/endorses this product category or your status.
**Safer wording:** *"…intended strictly for laboratory research use only, and not
for human or animal consumption."* (Remove "as defined by FDA.")

## 6. ⚠️ "Verified" / "Lab-Verified" assurance badges
**Where:** homepage ("Third-Party Batch Verified"), footer ("Lab-Verified"),
product detail ("COA Verified", "Purity Verified").
**Risk:** Same universal-substantiation issue as item 1 — "Verified" is a strong
assurance word that must be true for every unit it appears on.
**Action:** gate "Verified" language on the presence of an actual COA (partly done
in code for the PDP badges); soften homepage/footer to documented, per-batch
language.

## 7. ⚠️ SEO / structured-data propagation
**Where:** site metadata + product JSON-LD echo the item-1 claims ("third-party
batch-tested to ≥99% purity") into Google results.
**Action:** resolves automatically once item 1's copy is finalized.

## 8. MEDIUM wording items
- **"discipline of a clinical laboratory"** (homepage) — implies clinical/medical
  grade; prefer *"analytical laboratory."*
- **"within one business day"** (PDP) — a near-guarantee; prefer *"typically ships
  within one business day."*
- **"Healing" product category** (staging seed only, e.g. BPC-157/TB-500) — an
  implied therapeutic benefit; ensure it never reaches production (prod uses
  neutral "Research Peptides").

## 9. LOW / structural
- **Age gate** is client-side attestation only (no server enforcement) — common
  for RUO stores, but confirm it meets your obligations.
- **RUO disclaimer as a "fig leaf":** the disclaimer is genuine, but it sits
  alongside the unhedged purity/testing/origin claims above. Counsel should
  confirm the overall presentation isn't using the disclaimer to offset otherwise
  unsupported claims.

---

## Questions for counsel
1. Given RUO positioning, which quality/testing claims are permissible, and what
   documentation must be on file before each is displayed?
2. Are the origin ("USA Sourced") and superlative claims defensible, or remove?
3. Is the age-gate attestation sufficient, or is verified age verification needed?
4. Any state/jurisdictional restrictions on sale/shipment to confirm?
5. Confirm payment-processor and 3PL policies permit this product category.

## Recommended immediate changes (risk-reducing regardless of counsel's opinion)
These can be applied now on request; they only *reduce* claims, never add:
- Remove "as defined by FDA" (item 5).
- Delete "Among the purest sources available" (item 4).
- Soften "USA Sourced" → "U.S.-based fulfillment" (item 3).
- Soften "within one business day" → "typically ships within one business day" (8).
- Gate all remaining "Verified" badges on a real COA (item 6).

*Everything marked ⚠️ requires qualified legal/regulatory review before launch.*
