# Stripe & "Research Use Only" — what the policy actually says

**Date:** 2026-09-09 · **Status:** research finding, no code change
**Question asked:** "I heard Stripe allows research-use-only companies as long
as they're compliant."

**Short answer: no.** There is no research-use-only carve-out in Stripe's
policy. The claim is a garbled version of one real bullet that does not mean
what it is being read to mean, and Vanta Labs fails a *different* Stripe rule
regardless of how that bullet is read.

This is an engineering/compliance research note, **not legal advice.**

---

## 1. Where the rumour comes from

Stripe's [Restricted Businesses list](https://stripe.com/legal/restricted-businesses)
mentions research chemicals exactly once, in the **Prohibited** section under
*"Illegal weapons, explosives, and dangerous materials"*:

> "Incorrectly labeled research chemicals"

That word *"incorrectly"* is the whole basis of the rumour. Read backwards, it
sounds like "correctly labeled research chemicals are fine — so label
everything RUO and you're compliant." Merchant-account resellers repeat this
because they are selling high-risk onboarding services.

It does not work as a permission:

- The bullet says what is **banned**. It does not grant anything. Stripe's list
  is explicitly non-exhaustive, and the Services Agreement lets Stripe
  terminate any account at its discretion.
- Correct labelling only clears *that one bullet*. Every other bullet still
  applies independently, and one of them is fatal here (§2).
- Underwriting keys on **what is in the vial**, not what the label says. The
  RUO designation is a labelling convention, not a product classification that
  a processor recognises as changing the risk.

Searched the current policy document directly for "research use only", "RUO",
and every exception-shaped phrase. There is no carve-out, exception, or
conditional allowance anywhere in it.

---

## 2. The bullet that actually decides it

Also on the same page, under **Restricted businesses → Pharmaceuticals,
medical devices, and telemedicine**:

> "Card-not-present prescription-only products and pharmaceuticals"

Vanta Labs' catalogue includes three GLP-1-class SKUs (see
`src/lib/sql/scrub-glp-naming.sql`):

| Storefront name | Actual compound | Regulatory status (US) |
|---|---|---|
| GLP-1 | Semaglutide | FDA-approved, **prescription-only** |
| GLP-2 | Tirzepatide | FDA-approved, **prescription-only** |
| GLP-3 | Retatrutide | **Unapproved** — investigational, still in trials |

A card-not-present storefront selling semaglutide and tirzepatide is a direct,
unambiguous hit on that restricted bullet. Retatrutide is worse in a different
direction: it is an unapproved new drug, which is also the FDA's most common
warning-letter trigger for peptide sellers.

A secondary exposure sits under **Prohibited → Nutraceuticals and
pseudo-pharmaceuticals**:

> "Pseudo-pharmaceuticals or nutraceuticals that are not safe or make harmful claims"

The site's RUO disclaimers are consistent and well-drafted (verified across
`product-detail-client.tsx`, `account-auth-form.tsx`, invoice route, footer,
research pages), which helps on *this* bullet. It does nothing for the
prescription-only one.

**So even granting the most generous possible reading of "incorrectly
labeled", the GLP line puts this account inside Stripe's restricted list on
its own.**

---

## 3. Stripe is not the top of the stack

Worth understanding because it changes the strategy: even a sympathetic Stripe
underwriter cannot approve what the card networks prohibit.

- **Visa / Mastercard rules bind Stripe.** Mastercard's BRAM (Business Risk
  Assessment and Mitigation) programme covers unapproved pharmaceuticals and
  fines acquirers for merchants in the category.
- **Acquirers use automated merchant monitoring** — LegitScript, Austreme, G2
  and similar vendors crawl storefronts and match them against network rules.
  This is why accounts in this category typically process fine for weeks and
  are then closed after a review, rather than being declined at signup.
- **Termination is not the worst outcome.** The usual pattern is account
  closure, a 90–180 day reserve on funds in flight, and possible MATCH-list
  placement, which blocks new merchant applications industry-wide for five
  years.

*Caveat on sourcing:* several vendor blogs cite a specific 2026 BRAM bulletin
("GLB 11691.1") as having tightened peptide enforcement. That specific
identifier could **not** be verified against Mastercard's own published
material and should be treated as unconfirmed. The general point — that BRAM
covers this category and that acquirer appetite has narrowed — is well
established; the bulletin number is not.

---

## 4. The GLP rename is a liability, not a shield

`src/lib/sql/scrub-glp-naming.sql` renames Semaglutide → GLP-1, Tirzepatide →
GLP-2, Retatrutide → GLP-3 across product names, URL slugs and marketing copy,
and rewrites `order_items.product_name` on **past orders**.

If the intent was to reduce processor or regulatory risk, it does the
opposite. Flagging this because it is the highest-risk item found:

1. **It does not defeat monitoring.** The scrubbed descriptions still read
   "a GLP-1 receptor agonist peptide", "a dual GIP and GLP-1 receptor agonist
   peptide", and "a GIP, GLP-1 and glucagon receptor triagonist peptide" —
   those name semaglutide, tirzepatide and retatrutide unambiguously to anyone
   in the field, including a monitoring analyst. The 5/10/20/30 mg dose ladder
   and price points are also category-identifying, and COAs in the COA library
   will carry the real compound name.

2. **It converts a policy problem into a misrepresentation problem.** A
   processor that terminates a merchant for selling a restricted product
   closes the account. A processor that concludes the merchant *obscured* what
   it sells during underwriting has a fraud/misrepresentation finding — that is
   the difference between a closed account and a MATCH listing plus a held
   reserve.

3. **Rewriting historical order lines is independently risky.** Customers hold
   invoices and confirmation emails showing the original names. If a past order
   is disputed, the merchant's own record no longer matches the customer's
   copy, which is a bad position in a chargeback and looks like record
   tampering in any audit.

4. **It arguably weakens the RUO defence.** The legitimacy of an RUO sale rests
   on the buyer being a researcher who knows what they are buying. A product
   name that tells a genuine researcher *less* about the compound is hard to
   square with that, and easy for a regulator to read the other way.

**Recommendation:** have counsel look specifically at this migration before it
is relied on for anything. If the GLP line stays, the defensible version is
accurate compound names with rigorous RUO framing and buyer controls — not
obscured names.

---

## 5. Where the code currently stands (this part is healthy)

Nothing needs unwinding, which is the good news:

- `src/lib/payment-provider.ts` — card checkout goes through a
  provider-agnostic `PaymentProvider` interface. The `live` provider is
  **intentionally inert** and never invents a paid state, so production cannot
  take an unbacked card order.
- `src/lib/payment-processor-config.ts` — processor credentials are
  admin-editable placeholders (`"stripe"`, `"square"`, `"custom"`). Entering
  keys does not by itself start charging cards.
- Live payments today are the manual methods (Cash App / Zelle / PayPal) with
  an optional card option behind that inert seam.

**There is no Stripe integration to remove.** Adding one is a config change,
which means the decision is still fully open — the cheapest possible position.

---

## 6. Practical options

| Option | Assessment |
|---|---|
| Onboard to Stripe as-is | Don't. Fails §2 on the GLP line. Expect closure, reserve, possible MATCH. |
| Onboard to Stripe with the products described vaguely | Worse than the above — see §4.2. Not a route worth taking. |
| PayPal / Square / Shopify Payments | Same aggregator model, same prohibitions, same outcome. |
| **High-risk acquirer, accurately disclosed** | The only stable card path. 3.5–6% plus rolling reserve, but the acquirer knows the category and priced it, so it does not evaporate on review. |
| **Drop the GLP-1/2/3 SKUs** | Materially changes the picture. BPC-157, TB-500, GHK-Cu, CJC-1295, Ipamorelin and NAD+ are not approved drugs and are far easier to underwrite. The GLP line is what makes the account unplaceable at a mainstream processor. |
| solRUO / similar RUO Connect platforms | Compliance tooling on top of Stripe, ~6% all-in. Contractually guarantees nothing, and its own AUP excludes the GLP line. See §7. |
| Stay on manual methods | What is running now. No network rules apply, but no buyer protection either, and P2P accounts carry their own freeze risk (already noted in `COMPLIANCE.md`). |

Strengthening a genuine B2B research posture helps with a high-risk acquirer
and costs little — the catalogue is already behind an account and a
`/wholesale` page exists, which is the right direction. Institutional buyer
verification and a recorded intended-use attestation would be the next steps.

---

## 7. Evaluated: solRUO (solruo.com)

Looked at on request. **It does not solve Vanta Labs' problem, and its own
rules appear to exclude the GLP line.** Some of the thinking is sound; the
payment claim is where the risk sits.

### What it actually is

Not a processor. Their own disclaimer:

> "SolRUO is compliance infrastructure software — not a bank, processor, MSB,
> law firm, or regulatory authority."

The model is **Stripe Connect**: they onboard merchants as connected accounts
under their platform. Funds settle directly to the merchant's bank (genuinely
better than an aggregator holding them). Pricing is "as low as 6%" all-in
under $50K/month. Founder is Ronan Kalkan (LA), who also runs PepPal.io.

### The claim vs. the contract

Marketing says merchants "get approved for live B2B payment processing", with
"Stripe-reviewed compliance infrastructure" and a "compliance score Stripe risk
teams actually recognize." Their scanner site goes further: "Stripe has
reviewed and approved solRUO's compliance auditing methods."

Their Terms of Service say the opposite:

> "SolRUO expressly disclaims any warranty that (a) your processor will
> approve, maintain, or continue your account, (b) payouts will occur on any
> particular schedule"

> "SolRUO is not liable, financially or otherwise, for any of the following,
> under any theory of liability, ever: Any suspension, restriction,
> limitation, deactivation, revocation, offboarding, or shutdown of your
> connected merchant account"

> "All fees are non-refundable."

Liability is capped at three months of fees; Delaware law, binding arbitration
in Wilmington.

Note also that the homepage's own wording is the weaker, self-descriptive
form — compliance framework "built and reviewed **to** Stripe's standards" —
which means "we read the policy and built to it," not "Stripe approved us."
The stronger approval claim appears only on the scanner site and could not be
corroborated on Stripe's side (no partner-directory listing found, no Stripe
statement). Treat it as unverified.

**Net:** every risk in §3 — termination, reserve, MATCH — stays entirely with
the merchant, and the fees are non-refundable when it happens. That is not
necessarily bad faith (nobody can guarantee a third party's underwriting
decision, and these are ordinary SaaS disclaimers), but it reframes the
product: this is compliance tooling that may improve the odds, not a payment
solution. At 6% all-in, that distinction is worth being clear-eyed about — a
real high-risk acquirer charges a similar rate *because it is absorbing the
risk*. Here, nobody is.

### Why it does not fit this catalogue

Their Acceptable Use policy prohibits:

> "Selling controlled substances, scheduled compounds, or any product whose
> distribution requires a license you do not hold."

Semaglutide and tirzepatide are prescription-only. Their distribution requires
a license Vanta Labs does not hold. **The GLP line appears to breach solRUO's
own acceptable-use policy**, which is consistent with §2 — the problem is the
products, and changing payment vendors does not change the products.

Their qualified-buyer definition is a real institutional gate:

> "licensed researchers, clinical laboratories, contract research
> organizations, and credentialed institutional buyers"

Vanta Labs today sells DTC behind a 21+ age gate and a checkbox. That is not
the same thing and is not close. Meeting this bar means rebuilding the
customer model — which would remove most of the current customer base, not
add a compliance layer on top of it.

### What their scanner would likely flag here

It audits against 21 CFR §201.128, which determines intended use from the
**objective circumstances of distribution**, not the label. On that standard
this storefront has problems beyond the GLP names:

- **Bacteriostatic water offered on every published product**
  (`bac-water-upsell.tsx`, deliberately un-gated per `bac-water-gating.test.ts`).
  Bacteriostatic water exists to reconstitute lyophilized powder for
  **injection**. Offering it with every peptide, DTC, is strong objective
  evidence of intended human use.
- **Consumer dose ladders and price points** — 5/10/20/30 mg at $49.99–$149.99.
- **A 21+ age gate rather than a credentialing gate** — age is a consumer-retail
  control. Researchers are credentialed, not carded.
- **The GLP rename** (§4), which under a §201.128 analysis does not create
  research intent and may read as concealment.

The RUO disclaimer wording itself is strong and would likely pass. The
disclaimers are not what a §201.128 analysis turns on.

### One thing to be aware of

The same founder operates PepPal.io, whose "Cycle Analyzer" invites users to
paste "their full protocol of peptides, prescriptions, and supplements" for
synergy and conflict analysis — a human-dosing tool. Running that alongside a
business selling *not-for-human-consumption* attestation infrastructure is a
tension worth understanding before relying on their compliance judgement.
Noted neutrally; draw your own conclusion.

### Verdict

The compliance *methodology* — verified counterparties, signed intended-use
attestations, tamper-evident audit records — is genuinely the right model, and
matches what makes an RUO position defensible to both a processor and the FDA.
If Vanta Labs ever moves to a real institutional B2B model, that architecture
is worth building regardless of vendor.

But as a way to keep selling the current catalogue to the current customers
via Stripe, it does not work, and their own acceptable-use policy says so.
**If contacted, ask one question first: "do you onboard semaglutide,
tirzepatide and retatrutide?"** A "yes" contradicts their own AUP and Stripe's
restricted list, and is itself the answer about their judgement.

---

## Sources

- [solRUO](https://solruo.com/) and [solRUO Compliance Scanner](https://solruocomply.com/) — claims and terms quoted in §7

- [Stripe — Restricted Businesses](https://stripe.com/legal/restricted-businesses) — primary, quoted above
- [Ballerine — What Is Mastercard BRAM?](https://ballerine.com/glossary/mastercard-bram-business-risk-assessment-and-mitigation-program)
- [Austreme — Mastercard BRAM programme updates (AN4175)](https://www.austreme.com/en/mastercard-updates-for-bram-program-an4175-en/)

Treat merchant-account-reseller blogs (akord.io, complyruo.com,
rawpayments.com, vectorpayments.com, inclusivepay.com and similar) as
marketing. Several assert an RUO "conditional allowance" at Stripe that does
not appear in Stripe's own policy; they are selling the onboarding service
that the claim creates demand for.

## Related

- `website/COMPLIANCE.md` — open legal decisions, incl. card processor and
  peptide-regulation items this note informs
- `src/lib/sql/scrub-glp-naming.sql` — the migration discussed in §4
