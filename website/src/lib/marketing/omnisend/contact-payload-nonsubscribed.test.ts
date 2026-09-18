import { describe, expect, it } from "vitest";

import { buildContactPayload } from "@/lib/marketing/omnisend/contact-payload";

// ---------------------------------------------------------------------------
// THE NUMBER TRAVELS; THE PERMISSION DOES NOT.
//
// A held-but-unconsented number used to be indistinguishable from no number at
// all — both left the phone identifier off the contact entirely. So a number
// the store had collected never reached Omnisend, and the day an explicit tick
// arrived it had to be sent as a brand-new identifier.
//
// Sending it as `nonSubscribed` is what lets the consent box activate SMS
// later without anything upstream being redesigned: the identifier is already
// there, and a tick changes its STATUS.
// ---------------------------------------------------------------------------

type Identifier = { type: string; id: string; channels?: { sms?: { status: string } } };

const facts = {
  email: "shopper@example.test",
  firstName: "Sam",
  lastName: null,
  phone: "+15125550100",
  countryCode: "US",
  state: null,
  city: null,
  postalCode: null,
  emailConsent: { status: "subscribed" as const, changedAt: "2026-09-01T00:00:00.000Z" },
  smsConsent: null,
  attested: true,
  orders: 0,
  totalSpent: 0,
  firstOrderAt: null,
  lastOrderAt: null,
  referralCode: null,
  link: null,
  codes: {},
};

const phoneOf = (built: unknown) =>
  ((built as { identifiers: Identifier[] }).identifiers).find((i) => i.type === "phone") ?? null;

describe("a number held without permission", () => {
  it("reaches Omnisend, marked as not subscribed", () => {
    const built = buildContactPayload({
      ...facts,
      smsConsent: { status: "nonSubscribed", changedAt: "2026-09-18T00:00:00.000Z" },
    });
    expect(phoneOf(built)?.id).toBe("+15125550100");
    expect(phoneOf(built)?.channels?.sms?.status).toBe("nonSubscribed");
  });

  it("carries no consent block, because there is no consent to describe", () => {
    const built = buildContactPayload({
      ...facts,
      smsConsent: { status: "nonSubscribed", changedAt: "2026-09-18T00:00:00.000Z" },
    }) as { identifiers: Array<Record<string, unknown>> };
    const phone = built.identifiers.find((i) => i.type === "phone") as Record<string, unknown>;
    expect(phone).not.toHaveProperty("consent");
  });

  it("becomes subscribed on the SAME identifier once somebody ticks the box", () => {
    // This is the requirement the whole shape exists for: the number does not
    // have to be collected again, and Omnisend sees a status change rather
    // than a new contact.
    const held = phoneOf(buildContactPayload({
      ...facts,
      smsConsent: { status: "nonSubscribed", changedAt: "2026-09-18T00:00:00.000Z" },
    }));
    const consented = phoneOf(buildContactPayload({
      ...facts,
      smsConsent: { status: "subscribed", changedAt: "2026-09-20T00:00:00.000Z", source: "storefront" },
    }));
    expect(consented?.id).toBe(held?.id);
    expect(consented?.channels?.sms?.status).toBe("subscribed");
  });
});

describe("what still sends no number at all", () => {
  it("a contact the store holds no number for", () => {
    expect(phoneOf(buildContactPayload({ ...facts, phone: null, smsConsent: null }))).toBeNull();
  });

  it("a number that cannot be normalised", () => {
    expect(phoneOf(buildContactPayload({
      ...facts,
      phone: "not a number",
      smsConsent: { status: "nonSubscribed", changedAt: "2026-09-18T00:00:00.000Z" },
    }))).toBeNull();
  });
});
