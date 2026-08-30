import { describe, expect, it } from "vitest";

import {
  membershipRemainderReceiptTemplate,
  membershipRenewalReceiptTemplate,
  membershipSignupReceiptTemplate,
} from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// "Receipt: $29.00 charged" — CHARGED FOR WHAT?
//
// Two of the three membership receipts carried a subject that was a sum of
// money and nothing else. The third, sitting directly beneath them in the same
// file, already said "Receipt: $29.00 — Elite membership". Same event class,
// two different answers to the only question the customer has.
//
// It matters more than tidiness. This is the email someone opens BECAUSE an
// unexplained charge showed up on their statement, so the subject is doing the
// work of telling them it was expected. And a bare amount with no context is a
// well-known spam signal — which is not hypothetical here: the incident that
// started this whole pass was a Vanta Labs email being filed as spam and having
// its links stripped.
//
// These assert the subject line specifically, because that is the part that has
// to survive being the only thing a customer reads.
// ---------------------------------------------------------------------------

const NEXT = "March 3, 2026";

describe("the renewal receipt subject", () => {
  it("says what the money bought, not just how much", () => {
    const { subject } = membershipRenewalReceiptTemplate({
      name: "Ada", monthlyPriceCents: 2900, nextBillingDate: NEXT,
    });
    expect(subject).toContain("$29.00");
    expect(subject).toMatch(/membership renewal/i);
  });

  it("names the tier when the caller knows it", () => {
    const { subject } = membershipRenewalReceiptTemplate({
      name: "Ada", monthlyPriceCents: 2900, nextBillingDate: NEXT, tierName: "Elite",
    });
    expect(subject).toBe("Receipt: $29.00 — Elite membership renewal");
  });

  it("degrades to a useful subject when the tier name is not to hand", () => {
    // The Veyra webhook lane holds a tier_id and no name; it must not fall back
    // to a bare amount.
    const { subject } = membershipRenewalReceiptTemplate({
      name: "Ada", monthlyPriceCents: 2900, nextBillingDate: NEXT,
    });
    expect(subject).toBe("Receipt: $29.00 — membership renewal");
  });

  it("still tells them when the next charge lands", () => {
    const email = membershipRenewalReceiptTemplate({
      name: "Ada", monthlyPriceCents: 2900, nextBillingDate: NEXT,
    });
    expect(email.html).toContain(NEXT);
    expect(email.text).toContain(NEXT);
  });
});

describe("the first-month remainder receipt subject", () => {
  it("says what the money bought", () => {
    const { subject } = membershipRemainderReceiptTemplate({
      name: "Ada", remainderCents: 2800, monthlyPriceCents: 2900, nextBillingDate: NEXT,
    });
    expect(subject).toContain("$28.00");
    expect(subject).toMatch(/membership/i);
  });
});

describe("all three membership receipts", () => {
  const subjects = [
    membershipRenewalReceiptTemplate({ name: "Ada", monthlyPriceCents: 2900, nextBillingDate: NEXT }).subject,
    membershipRemainderReceiptTemplate({ name: "Ada", remainderCents: 2800, monthlyPriceCents: 2900, nextBillingDate: NEXT }).subject,
    membershipSignupReceiptTemplate({
      name: "Ada", tierName: "Elite", amountCents: 2900, billingCycle: "monthly",
      nextBillingDate: NEXT, autoRenews: true,
    }).subject,
  ];

  it("none of them is a bare amount", () => {
    for (const subject of subjects) {
      expect(subject, subject).not.toMatch(/^Receipt: \$[\d,.]+ charged$/);
      expect(subject, subject).toMatch(/membership/i);
    }
  });
});
