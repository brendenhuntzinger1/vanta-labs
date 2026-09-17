import { describe, expect, it } from "vitest";
import {
  buildContactPayload,
  normalizeE164,
  splitName,
  type ContactFacts,
} from "@/lib/marketing/omnisend/contact-payload";

// ---------------------------------------------------------------------------
// The payload shape is the entire risk here. A wrong field name does not
// error — Omnisend answers 200 and ignores the property, or records a channel
// status we did not mean — so every name from spec §5.1 is pinned against
// fixed inputs, exactly as meta-conversions.test.ts does for Meta.
// ---------------------------------------------------------------------------

const facts: ContactFacts = {
  email: "Jane.Doe@Example.COM",
  firstName: "Jane",
  lastName: "Doe",
  phone: "(312) 555-0142",
  countryCode: "us",
  state: "IL",
  city: "Chicago",
  postalCode: "60601",
  emailConsent: { status: "subscribed", changedAt: "2026-09-01T12:00:00.000Z", source: "checkout" },
  smsConsent: { status: "subscribed", changedAt: "2026-09-02T12:00:00.000Z", source: "account-settings" },
  attested: true,
  orders: 2,
  totalSpent: 189.981,
  firstOrderAt: "2026-08-01T15:00:00.000Z",
  // 01:30Z on the 10th is 21:30 Eastern on the 9th; the date must say the 9th.
  lastOrderAt: "2026-09-10T01:30:00.000Z",
  referralCode: "JANE10",
  link: { token: "v1.1760000000000.0123456789abcdef", endsAt: "2026-10-15T12:00:00.000Z" },
  codes: { welcome: { code: "VLWELCOME-ABC234", endsAt: "2026-09-29T01:00:00.000Z" } },
};

type Identifier = Record<string, unknown>;
const payload = buildContactPayload(facts) as {
  identifiers: Identifier[];
  tags: string[];
  customProperties: Record<string, unknown>;
} & Record<string, unknown>;

describe("the contact envelope matches Omnisend's contacts reference", () => {
  it("carries exactly the top-level fields the spec names, in a fixed order", () => {
    expect(Object.keys(payload)).toEqual([
      "identifiers", "firstName", "lastName", "countryCode", "state", "city", "postalCode", "tags", "customProperties",
    ]);
    expect(payload.firstName).toBe("Jane");
    expect(payload.lastName).toBe("Doe");
    expect(payload.countryCode).toBe("US");
    expect(payload.state).toBe("IL");
    expect(payload.city).toBe("Chicago");
    expect(payload.postalCode).toBe("60601");
  });

  it("builds the email identifier with the channel status, its change time and the consent block", () => {
    expect(payload.identifiers[0]).toEqual({
      type: "email",
      id: "jane.doe@example.com",
      channels: { email: { status: "subscribed", statusChangedAt: "2026-09-01T12:00:00.000Z" } },
      consent: { source: "checkout", createdAt: "2026-09-01T12:00:00.000Z" },
      sendWelcomeMessage: false,
    });
  });

  it("lowercases the address, because Omnisend identifiers are case-sensitive and the store's are not", () => {
    expect(payload.identifiers[0].id).toBe("jane.doe@example.com");
    const spaced = buildContactPayload({ ...facts, email: "  MIXED@Case.Org " }) as { identifiers: Identifier[] };
    expect(spaced.identifiers[0].id).toBe("mixed@case.org");
  });

  it("builds the phone identifier in E.164 with the SMS channel and its consent", () => {
    expect(payload.identifiers).toHaveLength(2);
    expect(payload.identifiers[1]).toEqual({
      type: "phone",
      id: "+13125550142",
      channels: { sms: { status: "subscribed", statusChangedAt: "2026-09-02T12:00:00.000Z" } },
      consent: { source: "account-settings", createdAt: "2026-09-02T12:00:00.000Z" },
    });
  });

  it("dates a nonSubscribed status at the epoch, so a status Omnisend collected itself stands", () => {
    // TWO RULES MEET HERE, AND THE FIRST ONE IS NOT NEGOTIABLE.
    //
    //   1. Omnisend REFUSES an email identifier with no channel block. The
    //      first real contacts batch answered 400 "Provide email channel for
    //      email identifier" for the single item that omitted it.
    //   2. nonSubscribed means "we do not know", and Omnisend keeps whichever
    //      status carries the later date. Stamping ours `now` would overwrite
    //      a `subscribed` the contact gave through Omnisend's own form.
    //
    // The epoch satisfies both: the block is present, and it loses every date
    // comparison against a real consent. THIS TEST USED TO ASSERT THE
    // OMISSION, which is why the defect shipped green.
    const known = buildContactPayload({
      ...facts,
      // `now`, as collectContactFacts supplies it for an unknown status. It
      // must NOT reach the payload: it would beat everything.
      emailConsent: { status: "nonSubscribed", changedAt: "2026-09-03T00:00:00.000Z" },
      smsConsent: null,
    }) as { identifiers: Identifier[] };
    expect(known.identifiers[0]).toEqual({
      type: "email",
      id: "jane.doe@example.com",
      channels: { email: { status: "nonSubscribed", statusChangedAt: "1970-01-01T00:00:00.000Z" } },
      sendWelcomeMessage: false,
    });
    // No consent is claimed for a status nobody gave.
    expect(known.identifiers[0]).not.toHaveProperty("consent");
  });

  it("gives every email identifier a channel block, whatever the status", () => {
    // The rule the 400 above states, asserted directly rather than as a
    // side effect of one status's test: a payload Omnisend refuses is a
    // contact that silently never arrives.
    for (const status of ["subscribed", "unsubscribed", "nonSubscribed"] as const) {
      const built = buildContactPayload({
        ...facts,
        emailConsent: { status, changedAt: "2026-09-03T00:00:00.000Z", source: "checkout" },
        smsConsent: null,
      }) as { identifiers: Identifier[] };
      expect(built.identifiers[0], `${status} must carry a channel block`).toHaveProperty("channels");
    }
  });

  it("omits the consent block for unsubscribed, which has no source, but keeps the channel status", () => {
    const off = buildContactPayload({
      ...facts,
      emailConsent: { status: "unsubscribed", changedAt: "2026-09-04T09:00:00.000Z" },
    }) as { identifiers: Identifier[] };
    expect(off.identifiers[0]).toEqual({
      type: "email",
      id: "jane.doe@example.com",
      channels: { email: { status: "unsubscribed", statusChangedAt: "2026-09-04T09:00:00.000Z" } },
      sendWelcomeMessage: false,
    });
  });

  it("carries an unsubscribed status verbatim, with its change time", () => {
    const off = buildContactPayload({
      ...facts,
      emailConsent: { status: "unsubscribed", changedAt: "2026-09-04T09:00:00.000Z" },
    }) as { identifiers: Identifier[] };
    expect(off.identifiers[0].channels).toEqual({ email: { status: "unsubscribed", statusChangedAt: "2026-09-04T09:00:00.000Z" } });
  });
});

describe("the phone identifier exists only when there is a number to send and consent to send it under", () => {
  it("is omitted when the phone is absent", () => {
    for (const phone of [undefined, null, "", "   "]) {
      const built = buildContactPayload({ ...facts, phone }) as { identifiers: Identifier[] };
      expect(built.identifiers).toHaveLength(1);
      expect(built.identifiers[0].type).toBe("email");
    }
  });

  it("is omitted when the number does not normalise to E.164", () => {
    const built = buildContactPayload({ ...facts, phone: "555-0142" }) as { identifiers: Identifier[] };
    expect(built.identifiers).toHaveLength(1);
  });

  it("is omitted when there is a number but no SMS consent record (spec §9: phone only with SMS consent)", () => {
    for (const smsConsent of [undefined, null]) {
      const built = buildContactPayload({ ...facts, smsConsent }) as { identifiers: Identifier[] };
      expect(built.identifiers).toHaveLength(1);
    }
  });

  it("is sent as unsubscribed when the customer opted out, so Omnisend records the opt-out", () => {
    const built = buildContactPayload({
      ...facts,
      smsConsent: { status: "unsubscribed", changedAt: "2026-09-05T10:00:00.000Z" },
    }) as { identifiers: Identifier[] };
    expect(built.identifiers[1]).toEqual({
      type: "phone",
      id: "+13125550142",
      channels: { sms: { status: "unsubscribed", statusChangedAt: "2026-09-05T10:00:00.000Z" } },
    });
  });
});

describe("normalizeE164", () => {
  it.each([
    ["(312) 555-0142", "+13125550142"],
    ["312.555.0142", "+13125550142"],
    ["1 312 555 0142", "+13125550142"],
    ["+1 (312) 555-0142", "+13125550142"],
    ["+44 20 7946 0958", "+442079460958"],
    ["+12345678", "+12345678"],
    ["+123456789012345", "+123456789012345"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeE164(raw)).toBe(expected);
  });

  it.each([
    [null], [undefined], [""], ["   "], ["555-0142"], ["2 312 555 0142"], ["312555014"], ["+1234567"], ["+1234567890123456"], ["not a number"],
  ])("refuses %s", (raw) => {
    expect(normalizeE164(raw as string | null | undefined)).toBeNull();
  });

  it("only assumes the North American trunk for a North American default country", () => {
    expect(normalizeE164("3125550142", "CA")).toBe("+13125550142");
    expect(normalizeE164("3125550142", "ca")).toBe("+13125550142");
    expect(normalizeE164("3125550142", "GB")).toBeNull();
    // An explicit prefix is trusted regardless of the default.
    expect(normalizeE164("+442079460958", "GB")).toBe("+442079460958");
  });
});

describe("tags", () => {
  it("always carry the source, and customer / attested only when earned", () => {
    expect(payload.tags).toEqual(["source: website", "customer", "attested"]);
    const fresh = buildContactPayload({ ...facts, orders: 0, attested: false }) as { tags: string[] };
    expect(fresh.tags).toEqual(["source: website"]);
    const buyer = buildContactPayload({ ...facts, orders: 1, attested: false }) as { tags: string[] };
    expect(buyer.tags).toEqual(["source: website", "customer"]);
    const attested = buildContactPayload({ ...facts, orders: 0, attested: true }) as { tags: string[] };
    expect(attested.tags).toEqual(["source: website", "attested"]);
  });
});

describe("custom properties", () => {
  it("are exactly the vl_ set from spec §5.1, with dates as YYYY-MM-DD in the display zone", () => {
    expect(payload.customProperties).toEqual({
      vl_link: "v1.1760000000000.0123456789abcdef",
      vl_link_ends: "2026-10-15",
      vl_attested: true,
      vl_orders: 2,
      vl_total_spent: 189.98,
      vl_first_order_at: "2026-08-01",
      vl_last_order_at: "2026-09-09",
      vl_referral_code: "JANE10",
      vl_welcome_code: "VLWELCOME-ABC234",
      // 01:00Z on the 29th is 9 pm Eastern on the 28th: the code is dead
      // before the UTC date arrives, so the email must not name the 29th.
      vl_welcome_ends: "2026-09-28",
      vl_winback_code: "",
      vl_winback_ends: "",
      vl_recovery_code: "",
      vl_recovery_ends: "",
      vl_welcome_ready: "yes",
      vl_winback_ready: "no",
      vl_recovery_ready: "no",
      vl_recovery_percent: 0,
    });
  });

  it("send every absent value as the empty string, which is how Omnisend removes a property", () => {
    const bare = buildContactPayload({
      email: "someone@example.com",
      emailConsent: { status: "nonSubscribed", changedAt: "2026-09-03T00:00:00.000Z" },
      attested: false,
      orders: 0,
      totalSpent: 0,
    }) as { customProperties: Record<string, unknown> } & Record<string, unknown>;
    expect(bare.customProperties).toEqual({
      vl_link: "",
      vl_link_ends: "",
      vl_attested: false,
      vl_orders: 0,
      vl_total_spent: 0,
      vl_first_order_at: "",
      vl_last_order_at: "",
      vl_referral_code: "",
      vl_welcome_code: "",
      vl_welcome_ends: "",
      vl_winback_code: "",
      vl_winback_ends: "",
      vl_recovery_code: "",
      vl_recovery_ends: "",
      vl_welcome_ready: "no",
      vl_winback_ready: "no",
      vl_recovery_ready: "no",
      vl_recovery_percent: 0,
    });
    // Profile fields are OMITTED rather than blanked, so a value Omnisend
    // already holds from a form is not erased. The country included: a US
    // default here would overwrite a country Omnisend collected itself.
    expect(Object.keys(bare)).toEqual(["identifiers", "tags", "customProperties"]);
    expect(bare).not.toHaveProperty("countryCode");
  });

  it("send countryCode only when the store knows it, uppercased", () => {
    for (const countryCode of [undefined, null, "", "  "]) {
      const built = buildContactPayload({ ...facts, countryCode }) as Record<string, unknown>;
      expect(built).not.toHaveProperty("countryCode");
    }
    expect((buildContactPayload({ ...facts, countryCode: "ca" }) as Record<string, unknown>).countryCode).toBe("CA");
  });

  it("carry every code kind under its own pair of names", () => {
    const all = buildContactPayload({
      ...facts,
      codes: {
        welcome: { code: "VLWELCOME-AAAAAA", endsAt: "2026-09-20T12:00:00.000Z" },
        winback: { code: "VLBACK-BBBBBB", endsAt: "2026-09-21T12:00:00.000Z" },
        recovery: { code: "VLCART-CCCCCC", endsAt: "2026-09-22T12:00:00.000Z" },
      },
    }) as { customProperties: Record<string, unknown> };
    expect(all.customProperties).toMatchObject({
      vl_welcome_code: "VLWELCOME-AAAAAA",
      vl_welcome_ends: "2026-09-20",
      vl_winback_code: "VLBACK-BBBBBB",
      vl_winback_ends: "2026-09-21",
      vl_recovery_code: "VLCART-CCCCCC",
      vl_recovery_ends: "2026-09-22",
      vl_welcome_ready: "yes",
      vl_winback_ready: "yes",
      vl_recovery_ready: "yes",
    });
  });

  it("keep vl_orders an integer and vl_total_spent a number at two places, never negative or NaN", () => {
    const odd = buildContactPayload({ ...facts, orders: 2.9, totalSpent: Number.NaN }) as { customProperties: Record<string, unknown> };
    expect(odd.customProperties.vl_orders).toBe(2);
    expect(odd.customProperties.vl_total_spent).toBe(0);
    const negative = buildContactPayload({ ...facts, orders: -1, totalSpent: 10.005 }) as { customProperties: Record<string, unknown> };
    expect(negative.customProperties.vl_orders).toBe(0);
    expect(negative.customProperties.vl_total_spent).toBe(10.01);
  });

  it("send an unparseable date as the empty string rather than an Invalid Date", () => {
    const broken = buildContactPayload({ ...facts, lastOrderAt: "not a date" }) as { customProperties: Record<string, unknown> };
    expect(broken.customProperties.vl_last_order_at).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The store-minted recovery offer for Omnisend's 72-hour message: the code's
// percentage beside the code, and the gift as text, link, floor and deadline
// with its own ready flag, so the template can show the gift block, the code
// block, both or neither from properties alone.
// ---------------------------------------------------------------------------
describe("the recovery offer properties", () => {
  const gift = {
    text: "a free GHK-Cu 50mg and a free Recon Water",
    link: "https://www.vantalabsresearch.com/api/email/omnisend-link?t=v2.aa&to=%2Fapi%2Femail%2Ftrack%2Fclick",
    minCartCents: 10_000,
    // 03:00Z on the 27th is 11 pm Eastern on the 26th: the gift dies before
    // the UTC date arrives, so the email must say the 26th.
    endsAt: "2026-09-27T03:00:00.000Z",
  };

  it("carry the recovery code's percentage as an integer beside the code", () => {
    const built = buildContactPayload({
      ...facts,
      codes: { recovery: { code: "VLCART-DDDDDD", endsAt: "2026-09-22T12:00:00.000Z", percent: 15 } },
    }) as { customProperties: Record<string, unknown> };
    expect(built.customProperties).toMatchObject({
      vl_recovery_code: "VLCART-DDDDDD",
      vl_recovery_ends: "2026-09-22",
      vl_recovery_ready: "yes",
      vl_recovery_percent: 15,
    });
  });

  it("report 0 percent when there is no live recovery code, or when the code carries no percentage", () => {
    const none = buildContactPayload({ ...facts, codes: {} }) as { customProperties: Record<string, unknown> };
    expect(none.customProperties.vl_recovery_percent).toBe(0);
    const unknown = buildContactPayload({
      ...facts,
      codes: { recovery: { code: "VLCART-EEEEEE", endsAt: "2026-09-22T12:00:00.000Z" } },
    }) as { customProperties: Record<string, unknown> };
    expect(unknown.customProperties.vl_recovery_percent).toBe(0);
    const fractional = buildContactPayload({
      ...facts,
      codes: { recovery: { code: "VLCART-FFFFFF", endsAt: "2026-09-22T12:00:00.000Z", percent: 12.6 } },
    }) as { customProperties: Record<string, unknown> };
    expect(fractional.customProperties.vl_recovery_percent).toBe(13);
  });

  it("carry the gift as text, an absolute claim link, a dollar floor, a display-zone date and a ready flag", () => {
    const built = buildContactPayload({ ...facts, recoveryGift: gift }) as { customProperties: Record<string, unknown> };
    expect(built.customProperties).toMatchObject({
      vl_recovery_gift: "a free GHK-Cu 50mg and a free Recon Water",
      vl_recovery_gift_link: gift.link,
      vl_recovery_gift_min: "$100",
      vl_recovery_gift_ends: "2026-09-26",
      vl_recovery_gift_ready: "yes",
    });
  });

  it("format a floor with cents only when it has them", () => {
    const odd = buildContactPayload({ ...facts, recoveryGift: { ...gift, minCartCents: 3_550 } }) as { customProperties: Record<string, unknown> };
    expect(odd.customProperties.vl_recovery_gift_min).toBe("$35.50");
    const floor = buildContactPayload({ ...facts, recoveryGift: { ...gift, minCartCents: 3_500 } }) as { customProperties: Record<string, unknown> };
    expect(floor.customProperties.vl_recovery_gift_min).toBe("$35");
  });

  const GIFT_KEYS = ["vl_recovery_gift", "vl_recovery_gift_link", "vl_recovery_gift_min", "vl_recovery_gift_ends", "vl_recovery_gift_ready"];

  it("OMIT the five gift keys when the caller says nothing about the gift, so another upsert cannot wipe one the sweep set", () => {
    // Every contact upsert is a POST merge on the identifier. The cart-offer
    // sweep is the one caller that knows the gift; the nightly reconcile, the
    // consent hooks and the order hook do not, and each of them used to send
    // "" / "no" and clear it, so the gift template never sent.
    const { recoveryGift: _ignored, ...silent } = { ...facts, recoveryGift: gift };
    void _ignored;
    const built = buildContactPayload(silent) as { customProperties: Record<string, unknown> };
    for (const key of GIFT_KEYS) expect(built.customProperties).not.toHaveProperty(key);
    const explicit = buildContactPayload({ ...facts, recoveryGift: undefined }) as { customProperties: Record<string, unknown> };
    for (const key of GIFT_KEYS) expect(explicit.customProperties).not.toHaveProperty(key);
  });

  it("send the cleared values only when the caller passes null, or a gift with no text or link", () => {
    for (const recoveryGift of [null, { ...gift, text: "" }, { ...gift, link: "  " }]) {
      const built = buildContactPayload({ ...facts, recoveryGift }) as { customProperties: Record<string, unknown> };
      expect(built.customProperties).toMatchObject({
        vl_recovery_gift: "",
        vl_recovery_gift_link: "",
        vl_recovery_gift_min: "",
        vl_recovery_gift_ends: "",
        vl_recovery_gift_ready: "no",
      });
    }
  });

  it("keep the gift and the code independent: a gift without a code, and a code without a gift, are both complete", () => {
    const giftOnly = buildContactPayload({ ...facts, codes: {}, recoveryGift: gift }) as { customProperties: Record<string, unknown> };
    expect(giftOnly.customProperties).toMatchObject({ vl_recovery_ready: "no", vl_recovery_percent: 0, vl_recovery_gift_ready: "yes" });
    const codeOnly = buildContactPayload({
      ...facts,
      codes: { recovery: { code: "VLCART-GGGGGG", endsAt: "2026-09-22T12:00:00.000Z", percent: 10 } },
      recoveryGift: null,
    }) as { customProperties: Record<string, unknown> };
    expect(codeOnly.customProperties).toMatchObject({ vl_recovery_ready: "yes", vl_recovery_percent: 10, vl_recovery_gift_ready: "no" });
  });
});

describe("splitName", () => {
  it.each([
    ["Jane Doe", { firstName: "Jane", lastName: "Doe" }],
    ["Jane Q Doe", { firstName: "Jane", lastName: "Q Doe" }],
    ["  Jane   Doe  ", { firstName: "Jane", lastName: "Doe" }],
    ["Jane", { firstName: "Jane", lastName: null }],
    ["", { firstName: null, lastName: null }],
    ["   ", { firstName: null, lastName: null }],
    [null, { firstName: null, lastName: null }],
    [undefined, { firstName: null, lastName: null }],
  ])("%j", (full, expected) => {
    expect(splitName(full as string | null | undefined)).toEqual(expected);
  });
});

describe("the welcome gift (welcome-gift.ts) rides under vl_welcome_gift*, with the recovery gift's three meanings", () => {
  const gift = {
    text: "a free GHK-Cu",
    link: "https://vantalabsresearch.com/api/email/omnisend-link?t=v1.x.y&to=%2Fapi%2Femail%2Ftrack%2Fclick%3Furl%3D...%26o%3Dtoken",
    minCartCents: 6_000,
    endsAt: "2026-09-30T04:00:00.000Z",
  };

  it("writes the five properties for a gift, the minimum as a dollar figure and the deadline as a display-zone date", () => {
    const built = buildContactPayload({ ...facts, welcomeGift: gift }) as { customProperties: Record<string, unknown> };
    expect(built.customProperties).toMatchObject({
      vl_welcome_gift: "a free GHK-Cu",
      vl_welcome_gift_link: gift.link,
      vl_welcome_gift_min: "$60",
      vl_welcome_gift_ends: "2026-09-30",
      vl_welcome_gift_ready: "yes",
    });
  });

  it("sends none of the five when the caller says nothing, so a push about something else cannot blank a link in an inbox", () => {
    const silent = buildContactPayload(facts) as { customProperties: Record<string, unknown> };
    for (const key of ["vl_welcome_gift", "vl_welcome_gift_link", "vl_welcome_gift_min", "vl_welcome_gift_ends", "vl_welcome_gift_ready"]) {
      expect(silent.customProperties).not.toHaveProperty(key);
    }
  });

  it("clears all five on null, and on a gift with no text or no link", () => {
    for (const welcomeGift of [null, { ...gift, text: "" }, { ...gift, link: "  " }]) {
      const built = buildContactPayload({ ...facts, welcomeGift }) as { customProperties: Record<string, unknown> };
      expect(built.customProperties).toMatchObject({
        vl_welcome_gift: "",
        vl_welcome_gift_link: "",
        vl_welcome_gift_min: "",
        vl_welcome_gift_ends: "",
        vl_welcome_gift_ready: "no",
      });
    }
  });

  it("is independent of the recovery gift: each set answers only for its own caller", () => {
    const welcomeOnly = buildContactPayload({ ...facts, welcomeGift: gift }) as { customProperties: Record<string, unknown> };
    expect(welcomeOnly.customProperties).not.toHaveProperty("vl_recovery_gift_ready");
    const recoveryCleared = buildContactPayload({ ...facts, welcomeGift: gift, recoveryGift: null }) as { customProperties: Record<string, unknown> };
    expect(recoveryCleared.customProperties.vl_recovery_gift_ready).toBe("no");
    expect(recoveryCleared.customProperties.vl_welcome_gift_ready).toBe("yes");
  });
});
