import { describe, expect, it } from "vitest";
import {
  latestUpdatedAt,
  parseOmnisendContacts,
  parseOmnisendPaging,
  planWriteBack,
  type OmnisendContactRead,
} from "@/lib/marketing/omnisend/reconcile-plan";

// ---------------------------------------------------------------------------
// The write-back is the one place Omnisend's view of a person can change the
// store's consent record, so the rule is pinned against fixed inputs. The
// invariant every case below serves: the record may shrink, or gain a consent
// the store never heard about, but a closed consent is never re-opened.
// ---------------------------------------------------------------------------

function contact(overrides: Partial<OmnisendContactRead>): OmnisendContactRead {
  return { email: null, phone: null, emailStatus: null, smsStatus: null, updatedAt: null, ...overrides };
}

function known() {
  return {
    suppressed: new Set(["gone@example.com"]),
    subscribers: new Set(["in@example.com"]),
    smsOptedOut: new Set(["stopped@example.com"]),
  };
}

describe("planWriteBack: unsubscribes become suppressions", () => {
  it("suppresses an Omnisend unsubscribe the store does not know about", () => {
    const plan = planWriteBack([contact({ email: "left@example.com", emailStatus: "unsubscribed" })], known());
    expect(plan).toEqual({ suppress: ["left@example.com"], smsOptOut: [], newSubscribers: [] });
  });

  it("does nothing for an unsubscribe already on the suppression list", () => {
    const plan = planWriteBack([contact({ email: "gone@example.com", emailStatus: "unsubscribed" })], known());
    expect(plan).toEqual({ suppress: [], smsOptOut: [], newSubscribers: [] });
  });

  it("suppresses a subscriber the store still holds as active, because the person said stop", () => {
    const plan = planWriteBack([contact({ email: "in@example.com", emailStatus: "unsubscribed" })], known());
    expect(plan.suppress).toEqual(["in@example.com"]);
  });
});

describe("planWriteBack: form sign-ups become subscribers, never widening", () => {
  it("records a subscribed contact absent from both consent stores as a new subscriber", () => {
    const plan = planWriteBack([contact({ email: "form@example.com", emailStatus: "subscribed" })], known());
    expect(plan).toEqual({ suppress: [], smsOptOut: [], newSubscribers: ["form@example.com"] });
  });

  it("does not re-record a subscriber the store already has", () => {
    const plan = planWriteBack([contact({ email: "in@example.com", emailStatus: "subscribed" })], known());
    expect(plan.newSubscribers).toEqual([]);
  });

  it("never re-subscribes a suppressed address on the strength of an Omnisend status", () => {
    const plan = planWriteBack([contact({ email: "gone@example.com", emailStatus: "subscribed" })], known());
    expect(plan).toEqual({ suppress: [], smsOptOut: [], newSubscribers: [] });
  });

  it("plans nothing for nonSubscribed or unknown email statuses", () => {
    const plan = planWriteBack(
      [
        contact({ email: "known@example.com", emailStatus: "nonSubscribed" }),
        contact({ email: "blank@example.com", emailStatus: null }),
      ],
      known(),
    );
    expect(plan).toEqual({ suppress: [], smsOptOut: [], newSubscribers: [] });
  });
});

describe("planWriteBack: SMS opt-outs", () => {
  it("records an SMS opt-out for an address not yet stamped", () => {
    const plan = planWriteBack(
      [contact({ email: "texts@example.com", phone: "+13125550142", emailStatus: "subscribed", smsStatus: "unsubscribed" })],
      { ...known(), subscribers: new Set(["texts@example.com"]) },
    );
    expect(plan).toEqual({ suppress: [], smsOptOut: ["texts@example.com"], newSubscribers: [] });
  });

  it("does nothing for an opt-out the account already carries", () => {
    const plan = planWriteBack([contact({ email: "stopped@example.com", smsStatus: "unsubscribed" })], known());
    expect(plan.smsOptOut).toEqual([]);
  });

  it("plans nothing for an SMS subscribe: SMS consent is only ever granted in account settings", () => {
    const plan = planWriteBack([contact({ email: "texts@example.com", phone: "+13125550142", smsStatus: "subscribed" })], known());
    expect(plan).toEqual({ suppress: [], smsOptOut: [], newSubscribers: [] });
  });

  it("can plan an email suppression and an SMS opt-out for the same contact", () => {
    const plan = planWriteBack(
      [contact({ email: "both@example.com", phone: "+13125550142", emailStatus: "unsubscribed", smsStatus: "unsubscribed" })],
      known(),
    );
    expect(plan).toEqual({ suppress: ["both@example.com"], smsOptOut: ["both@example.com"], newSubscribers: [] });
  });

  it("skips a phone-only contact: there is no address to key a store record on", () => {
    const plan = planWriteBack([contact({ phone: "+13125550142", smsStatus: "unsubscribed" })], known());
    expect(plan).toEqual({ suppress: [], smsOptOut: [], newSubscribers: [] });
  });
});

describe("planWriteBack: hygiene", () => {
  it("lowercases addresses so the store's case-insensitive keys match", () => {
    const plan = planWriteBack([contact({ email: "  Left@Example.COM ", emailStatus: "unsubscribed" })], known());
    expect(plan.suppress).toEqual(["left@example.com"]);
  });

  it("treats a suppression held in any case as known", () => {
    const plan = planWriteBack([contact({ email: "GONE@example.com", emailStatus: "unsubscribed" })], known());
    expect(plan.suppress).toEqual([]);
  });

  it("de-duplicates an address that appears on more than one contact", () => {
    const plan = planWriteBack(
      [
        contact({ email: "twice@example.com", emailStatus: "unsubscribed" }),
        contact({ email: "Twice@example.com", emailStatus: "unsubscribed" }),
      ],
      known(),
    );
    expect(plan.suppress).toEqual(["twice@example.com"]);
  });

  it("skips null and malformed emails", () => {
    const plan = planWriteBack(
      [
        contact({ email: null, emailStatus: "unsubscribed" }),
        contact({ email: "not-an-address", emailStatus: "unsubscribed" }),
        contact({ email: "", emailStatus: "subscribed" }),
      ],
      known(),
    );
    expect(plan).toEqual({ suppress: [], smsOptOut: [], newSubscribers: [] });
  });

  it("returns an empty plan for no contacts", () => {
    expect(planWriteBack([], known())).toEqual({ suppress: [], smsOptOut: [], newSubscribers: [] });
  });
});

// ---------------------------------------------------------------------------
// The GET /contacts envelope, as the 2026-03-15 API returns it.
// ---------------------------------------------------------------------------

const envelope = {
  contacts: [
    {
      contactID: "abc",
      identifiers: [
        {
          type: "email",
          id: "Jane.Doe@Example.com",
          channels: { email: { status: "unsubscribed", statusChangedAt: "2026-09-14T10:00:00Z" } },
        },
        {
          type: "phone",
          id: "+13125550142",
          channels: { sms: { status: "subscribed", statusChangedAt: "2026-09-01T10:00:00Z" } },
        },
      ],
      updatedAt: "2026-09-14T10:00:00Z",
    },
    {
      identifiers: [{ type: "email", id: "form@example.com", channels: { email: { status: "subscribed" } } }],
      updatedAt: "2026-09-13T08:00:00Z",
    },
  ],
  paging: { cursors: { after: "cursor-2", before: null }, hasMore: true, limit: 250 },
};

describe("parseOmnisendContacts reads the GET /contacts envelope", () => {
  it("maps the first email and phone identifiers to their channel statuses", () => {
    expect(parseOmnisendContacts(envelope)).toEqual([
      {
        email: "jane.doe@example.com",
        phone: "+13125550142",
        emailStatus: "unsubscribed",
        smsStatus: "subscribed",
        updatedAt: "2026-09-14T10:00:00Z",
      },
      { email: "form@example.com", phone: null, emailStatus: "subscribed", smsStatus: null, updatedAt: "2026-09-13T08:00:00Z" },
    ]);
  });

  it("reads a missing channel, an unknown status or a junk identifier as null, never as a status", () => {
    const parsed = parseOmnisendContacts({
      contacts: [
        { identifiers: [{ type: "email", id: "a@example.com" }] },
        { identifiers: [{ type: "email", id: "b@example.com", channels: { email: { status: "SUBSCRIBED" } } }] },
        { identifiers: [{ type: "email", id: "c@example.com", channels: "nope" }, 42, null] },
        { identifiers: [{ type: "phone", id: "+13125550142", channels: { sms: { status: "unsubscribed" } } }] },
      ],
    });
    expect(parsed).toEqual([
      { email: "a@example.com", phone: null, emailStatus: null, smsStatus: null, updatedAt: null },
      { email: "b@example.com", phone: null, emailStatus: null, smsStatus: null, updatedAt: null },
      { email: "c@example.com", phone: null, emailStatus: null, smsStatus: null, updatedAt: null },
      { email: null, phone: "+13125550142", emailStatus: null, smsStatus: "unsubscribed", updatedAt: null },
    ]);
  });

  it("drops a contact with neither an email nor a phone identifier", () => {
    expect(parseOmnisendContacts({ contacts: [{ identifiers: [] }, { identifiers: "x" }, {}, null] })).toEqual([]);
  });

  it("returns nothing for a body that is not the envelope", () => {
    for (const body of [null, undefined, "", 7, [], {}, { contacts: "x" }, { contacts: null }]) {
      expect(parseOmnisendContacts(body)).toEqual([]);
    }
  });
});

describe("parseOmnisendPaging follows paging.cursors.after only while hasMore", () => {
  it("returns the cursor when there is another page", () => {
    expect(parseOmnisendPaging(envelope)).toEqual({ after: "cursor-2", hasMore: true });
  });

  it("stops on the last page, whichever way Omnisend says so", () => {
    expect(parseOmnisendPaging({ paging: { cursors: { after: null, before: null }, hasMore: false, limit: 1 } }))
      .toEqual({ after: null, hasMore: false });
    expect(parseOmnisendPaging({ paging: { cursors: { after: "x" }, hasMore: false } })).toEqual({ after: "x", hasMore: false });
    expect(parseOmnisendPaging({ paging: { cursors: {}, hasMore: true } })).toEqual({ after: null, hasMore: false });
    expect(parseOmnisendPaging({})).toEqual({ after: null, hasMore: false });
    expect(parseOmnisendPaging(null)).toEqual({ after: null, hasMore: false });
  });
});

describe("latestUpdatedAt picks the newest instant for the next watermark", () => {
  it("compares as instants, not strings", () => {
    const contacts = parseOmnisendContacts(envelope);
    expect(latestUpdatedAt(contacts)).toBe("2026-09-14T10:00:00Z");
    expect(latestUpdatedAt([
      contact({ updatedAt: "2026-09-14T12:00:00+02:00" }),
      contact({ updatedAt: "2026-09-14T10:30:00Z" }),
    ])).toBe("2026-09-14T10:30:00Z");
  });

  it("ignores blanks and unparseable values, and is null for none", () => {
    expect(latestUpdatedAt([contact({ updatedAt: null }), contact({ updatedAt: "yesterday" }), contact({})])).toBeNull();
    expect(latestUpdatedAt([])).toBeNull();
  });
});
