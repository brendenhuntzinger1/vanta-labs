import { describe, expect, it } from "vitest";
import {
  MAX_BATCH_RECORDS,
  applyBatchRead,
  batchNotes,
  batchUnfinished,
  countContactsOnPage,
  defaultSnapshotLabel,
  emptyReconcileReport,
  isLaterInstant,
  isValidSnapshotLabel,
  latestUpdatedAt,
  mergeBatchRecords,
  orderPushTargets,
  parseBatchRecords,
  parseBatchStatus,
  parseBatchSubmission,
  parseOmnisendContacts,
  parseOmnisendPaging,
  planWriteBack,
  rememberBatches,
  stampFor,
  writeBackStamps,
  type BatchRecord,
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
  it("maps the first email and phone identifiers to their channel statuses and the instants they changed", () => {
    // statusChangedAt is when the PERSON acted; the write-back stamps the
    // store with it rather than with the reconcile's run time.
    expect(parseOmnisendContacts(envelope)).toEqual([
      {
        email: "jane.doe@example.com",
        phone: "+13125550142",
        emailStatus: "unsubscribed",
        emailStatusChangedAt: "2026-09-14T10:00:00Z",
        smsStatus: "subscribed",
        smsStatusChangedAt: "2026-09-01T10:00:00Z",
        updatedAt: "2026-09-14T10:00:00Z",
      },
      {
        email: "form@example.com",
        phone: null,
        emailStatus: "subscribed",
        emailStatusChangedAt: null,
        smsStatus: null,
        smsStatusChangedAt: null,
        updatedAt: "2026-09-13T08:00:00Z",
      },
    ]);
  });

  it("reads a junk or missing statusChangedAt as null, never as an instant", () => {
    const parsed = parseOmnisendContacts({
      contacts: [
        { identifiers: [{ type: "email", id: "a@example.com", channels: { email: { status: "unsubscribed", statusChangedAt: 42 } } }] },
        { identifiers: [{ type: "email", id: "b@example.com", channels: { email: { status: "unsubscribed", statusChangedAt: "  " } } }] },
      ],
    });
    expect(parsed.map((entry) => entry.emailStatusChangedAt)).toEqual([null, null]);
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
    const blank = { emailStatusChangedAt: null, smsStatusChangedAt: null, updatedAt: null };
    expect(parsed).toEqual([
      { email: "a@example.com", phone: null, emailStatus: null, smsStatus: null, ...blank },
      { email: "b@example.com", phone: null, emailStatus: null, smsStatus: null, ...blank },
      { email: "c@example.com", phone: null, emailStatus: null, smsStatus: null, ...blank },
      { email: null, phone: "+13125550142", emailStatus: null, smsStatus: "unsubscribed", ...blank },
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

// ---------------------------------------------------------------------------
// The write-back stamps the store with WHEN THE PERSON ACTED — Omnisend's
// statusChangedAt — not with the reconcile's run time, and never with an
// instant later than now. Suppressions, SMS opt-out stamps and form sign-ups
// are all dated this way, which is what lets applyFormSubscriber tell a
// re-subscribe through the form from a stale `subscribed` that predates the
// site's own opt-out.
// ---------------------------------------------------------------------------

describe("writeBackStamps: each address's channel instants, keyed the way the plan is", () => {
  it("maps the lowercased address to its email and sms statusChangedAt", () => {
    const stamps = writeBackStamps(parseOmnisendContacts(envelope));
    expect(stamps.get("jane.doe@example.com")).toEqual({ email: "2026-09-14T10:00:00Z", sms: "2026-09-01T10:00:00Z" });
    expect(stamps.get("form@example.com")).toEqual({ email: null, sms: null });
  });

  it("keeps the newest instant when an address appears on more than one contact, and skips contacts without an address", () => {
    const stamps = writeBackStamps([
      contact({ email: "Twice@example.com", emailStatus: "unsubscribed", emailStatusChangedAt: "2026-09-10T00:00:00Z" }),
      contact({ email: "twice@example.com", emailStatus: "unsubscribed", emailStatusChangedAt: "2026-09-12T00:00:00Z" }),
      contact({ email: "twice@example.com", emailStatus: "unsubscribed", emailStatusChangedAt: "2026-09-11T00:00:00Z" }),
      contact({ phone: "+13125550142", smsStatus: "unsubscribed", smsStatusChangedAt: "2026-09-12T00:00:00Z" }),
    ]);
    expect([...stamps.keys()]).toEqual(["twice@example.com"]);
    expect(stamps.get("twice@example.com")).toEqual({ email: "2026-09-12T00:00:00Z", sms: null });
  });
});

describe("stampFor: the instant to write, never later than now", () => {
  const now = "2026-09-16T03:00:00.000Z";

  it("uses Omnisend's instant when it is present and not in the future", () => {
    expect(stampFor("2026-09-14T10:00:00Z", now)).toBe("2026-09-14T10:00:00Z");
    expect(stampFor(now, now)).toBe(now);
  });

  it("falls back to now when the instant is absent, unparseable or later than now", () => {
    for (const at of [null, undefined, "", "yesterday", "2026-09-16T03:00:01.000Z", "2030-01-01T00:00:00Z"]) {
      expect(stampFor(at, now), String(at)).toBe(now);
    }
  });
});

describe("isLaterInstant: a form re-subscribe only re-opens a site opt-out it postdates", () => {
  it("is true only when the first instant parses and is strictly after the second", () => {
    expect(isLaterInstant("2026-09-15T00:00:00Z", "2026-09-14T00:00:00Z")).toBe(true);
    expect(isLaterInstant("2026-09-14T00:00:00Z", "2026-09-14T00:00:00Z")).toBe(false);
    expect(isLaterInstant("2026-09-13T00:00:00Z", "2026-09-14T00:00:00Z")).toBe(false);
    expect(isLaterInstant(null, "2026-09-14T00:00:00Z")).toBe(false);
    expect(isLaterInstant("junk", "2026-09-14T00:00:00Z")).toBe(false);
    // An unparseable store instant cannot be postdated: the record stays closed.
    expect(isLaterInstant("2026-09-15T00:00:00Z", "junk")).toBe(false);
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

// ---------------------------------------------------------------------------
// Batches are asynchronous: POST /batches answers { batchID, totalCount } and
// GET /batches/{batchID} reports { status, totalCount, finishedCount,
// errorsCount, ... } with status pending → inProgress → finished | stopped.
// The reconcile remembers what it submitted and folds what it learns on the
// next run into the report; the bookkeeping is pure and pinned here.
// ---------------------------------------------------------------------------

describe("parseBatchSubmission reads the POST /batches answer", () => {
  it("returns the batch id and the item count", () => {
    expect(parseBatchSubmission({ batchID: "5f92cbf10cf217478ba93561", totalCount: 2 }))
      .toEqual({ id: "5f92cbf10cf217478ba93561", totalCount: 2 });
  });

  it("tolerates a missing count and refuses a missing id", () => {
    expect(parseBatchSubmission({ batchID: "abc" })).toEqual({ id: "abc", totalCount: null });
    expect(parseBatchSubmission({ batchID: "abc", totalCount: "two" })).toEqual({ id: "abc", totalCount: null });
    for (const body of [null, undefined, "", 7, [], {}, { batchID: "" }, { batchID: 12 }, { totalCount: 2 }]) {
      expect(parseBatchSubmission(body)).toBeNull();
    }
  });
});

describe("parseBatchStatus reads the GET /batches/{batchID} answer", () => {
  it("maps the documented fields and nothing else", () => {
    expect(parseBatchStatus({
      batchID: "5f92cbf10cf217478ba93561",
      status: "finished",
      endpoint: "contacts",
      method: "POST",
      totalCount: 2,
      finishedCount: 2,
      errorsCount: 0,
      createdAt: "2021-01-01T00:00:00Z",
      startedAt: "2021-01-01T00:00:01Z",
      endedAt: "2021-01-01T00:00:05Z",
    })).toEqual({
      id: "5f92cbf10cf217478ba93561",
      status: "finished",
      totalCount: 2,
      finishedCount: 2,
      errorsCount: 0,
      endedAt: "2021-01-01T00:00:05Z",
    });
  });

  it("reads every lifecycle status and nothing outside it", () => {
    for (const status of ["pending", "inProgress", "finished", "stopped"]) {
      expect(parseBatchStatus({ batchID: "x", status }).status).toBe(status);
    }
    expect(parseBatchStatus({ batchID: "x", status: "FINISHED" }).status).toBeNull();
    expect(parseBatchStatus({ batchID: "x", status: "done" }).status).toBeNull();
    expect(parseBatchStatus({ batchID: "x" }).status).toBeNull();
  });

  it("reads junk as nulls, never as counts", () => {
    expect(parseBatchStatus({ batchID: "x", totalCount: "2", finishedCount: -1, errorsCount: 1.5, endedAt: 3 }))
      .toEqual({ id: "x", status: null, totalCount: null, finishedCount: null, errorsCount: null, endedAt: null });
    for (const body of [null, undefined, "", 7, [], {}]) {
      expect(parseBatchStatus(body)).toEqual({ id: null, status: null, totalCount: null, finishedCount: null, errorsCount: null, endedAt: null });
    }
  });
});

function record(overrides: Partial<BatchRecord>): BatchRecord {
  return {
    id: "b1",
    submittedAt: "2026-09-16T01:00:00Z",
    status: "unknown",
    totalCount: 100,
    finishedCount: null,
    errorsCount: null,
    checkedAt: null,
    ...overrides,
  };
}

describe("rememberBatches keeps the last fifty submissions", () => {
  it("appends a submission as unknown until it is polled", () => {
    const records = rememberBatches([], [{ id: "b1", totalCount: 100 }], "2026-09-16T01:00:00Z");
    expect(records).toEqual([record({ id: "b1" })]);
  });

  it("does not duplicate an id already remembered", () => {
    const existing = [record({ id: "b1", status: "finished", finishedCount: 100, errorsCount: 0, checkedAt: "2026-09-16T02:00:00Z" })];
    const records = rememberBatches(existing, [{ id: "b1", totalCount: 100 }, { id: "b2", totalCount: 7 }], "2026-09-17T01:00:00Z");
    expect(records.map((entry) => entry.id)).toEqual(["b1", "b2"]);
    expect(records[0]).toEqual(existing[0]);
    expect(records[1]).toEqual(record({ id: "b2", totalCount: 7, submittedAt: "2026-09-17T01:00:00Z" }));
  });

  it("drops the oldest submissions past the bound, newest kept", () => {
    expect(MAX_BATCH_RECORDS).toBe(50);
    const existing = Array.from({ length: 50 }, (_, index) =>
      record({ id: `old-${index}`, submittedAt: `2026-09-01T00:00:${String(index).padStart(2, "0")}Z` }));
    const records = rememberBatches(existing, [{ id: "new-1", totalCount: 1 }, { id: "new-2", totalCount: 1 }], "2026-09-16T01:00:00Z");
    expect(records).toHaveLength(50);
    expect(records[0].id).toBe("old-2");
    expect(records[49].id).toBe("new-2");
  });

  it("orders by submission instant, not by array position", () => {
    const existing = [
      record({ id: "later", submittedAt: "2026-09-16T05:00:00Z" }),
      record({ id: "earlier", submittedAt: "2026-09-16T01:00:00Z" }),
    ];
    const records = rememberBatches(existing, [], "2026-09-16T06:00:00Z");
    expect(records.map((entry) => entry.id)).toEqual(["earlier", "later"]);
  });
});

describe("mergeBatchRecords folds this run's polls onto a FRESH read of the batches row", () => {
  // The row is read at run start and again at write time. Between the two,
  // another run may have added ids or a poll may have failed to write; the
  // fresh read is the truth for WHICH batches exist, and this run's polls
  // are the truth for what Omnisend said about each, if newer.
  it("keeps every record the fresh read holds, taking this run's poll where it is newer", () => {
    const fresh = [
      record({ id: "b1", status: "pending", checkedAt: "2026-09-15T02:00:00Z" }),
      record({ id: "b2", status: "unknown" }),
      record({ id: "b3", status: "finished", finishedCount: 100, errorsCount: 0, checkedAt: "2026-09-16T02:00:00Z" }),
    ];
    const polled = [
      record({ id: "b1", status: "finished", finishedCount: 100, errorsCount: 1, checkedAt: "2026-09-16T01:00:00Z" }),
      record({ id: "b2", status: "inProgress", checkedAt: "2026-09-16T01:00:00Z" }),
      record({ id: "b3", status: "inProgress", checkedAt: "2026-09-16T01:00:00Z" }),
      record({ id: "gone", status: "finished", checkedAt: "2026-09-16T01:00:00Z" }),
    ];
    expect(mergeBatchRecords(fresh, polled)).toEqual([polled[0], polled[1], fresh[2]]);
  });

  it("is the fresh read itself when nothing was polled", () => {
    const fresh = [record({ id: "b1" })];
    expect(mergeBatchRecords(fresh, [])).toEqual(fresh);
    expect(mergeBatchRecords(fresh, [record({ id: "b1" })])).toEqual(fresh);
  });
});

describe("parseBatchRecords reads the omnisend_sync_state row defensively", () => {
  it("round-trips what rememberBatches wrote", () => {
    const records = rememberBatches([], [{ id: "b1", totalCount: 3 }], "2026-09-16T01:00:00Z");
    expect(parseBatchRecords({ batches: JSON.parse(JSON.stringify(records)) })).toEqual(records);
  });

  it("drops entries without an id or a submission instant, and normalises the rest", () => {
    expect(parseBatchRecords({
      batches: [
        {
          id: "ok",
          submittedAt: "2026-09-16T01:00:00Z",
          status: "finished",
          totalCount: 1,
          finishedCount: 1,
          errorsCount: 0,
          checkedAt: "2026-09-16T02:00:00Z",
        },
        { id: "odd", submittedAt: "2026-09-16T01:00:00Z", status: "weird", totalCount: "1" },
        { submittedAt: "2026-09-16T01:00:00Z" },
        { id: "no-time" },
        null,
        "x",
      ],
    })).toEqual([
      record({ id: "ok", status: "finished", totalCount: 1, finishedCount: 1, errorsCount: 0, checkedAt: "2026-09-16T02:00:00Z" }),
      record({ id: "odd", status: "unknown", totalCount: null }),
    ]);
  });

  it("is empty for anything that is not the row", () => {
    for (const value of [null, undefined, "", 7, [], {}, { batches: "x" }, { batches: null }]) {
      expect(parseBatchRecords(value)).toEqual([]);
    }
  });
});

describe("applyBatchRead folds a poll into the record", () => {
  it("records the status and counts with the instant they were read", () => {
    const read = parseBatchStatus({ batchID: "b1", status: "stopped", totalCount: 100, finishedCount: 40, errorsCount: 3 });
    expect(applyBatchRead(record({ id: "b1" }), read, "2026-09-16T03:00:00Z")).toEqual(
      record({ id: "b1", status: "stopped", totalCount: 100, finishedCount: 40, errorsCount: 3, checkedAt: "2026-09-16T03:00:00Z" }),
    );
  });

  it("keeps what it knew when the poll answered without a status or count", () => {
    const known = record({ id: "b1", status: "inProgress", totalCount: 100, finishedCount: 10, errorsCount: 0 });
    const read = parseBatchStatus({ batchID: "b1" });
    expect(applyBatchRead(known, read, "2026-09-16T03:00:00Z")).toEqual({ ...known, checkedAt: "2026-09-16T03:00:00Z" });
  });
});

describe("batchUnfinished says which records still need a poll", () => {
  it("is true for unknown, pending and inProgress, false once finished or stopped", () => {
    expect(batchUnfinished(record({ status: "unknown" }))).toBe(true);
    expect(batchUnfinished(record({ status: "pending" }))).toBe(true);
    expect(batchUnfinished(record({ status: "inProgress" }))).toBe(true);
    expect(batchUnfinished(record({ status: "finished" }))).toBe(false);
    expect(batchUnfinished(record({ status: "stopped" }))).toBe(false);
  });
});

describe("batchNotes names what did not resolve, by batch id and count only", () => {
  it("is silent for a finished batch without errors", () => {
    expect(batchNotes([record({ status: "finished", finishedCount: 100, errorsCount: 0 })])).toEqual([]);
  });

  it("reports item errors on a finished batch", () => {
    expect(batchNotes([record({ id: "b1", status: "finished", totalCount: 100, finishedCount: 100, errorsCount: 2 })]))
      .toEqual(["batch b1 finished with 2 item error(s) of 100"]);
  });

  it("reports a stopped batch with what it managed", () => {
    expect(batchNotes([record({ id: "b2", status: "stopped", totalCount: 100, finishedCount: 40, errorsCount: 1 })]))
      .toEqual(["batch b2 stopped after 40 of 100 items, 1 item error(s)"]);
    expect(batchNotes([record({ id: "b3", status: "stopped" })]))
      .toEqual(["batch b3 stopped after ? of 100 items, ? item error(s)"]);
  });

  it("reports a batch Omnisend has not finished yet", () => {
    expect(batchNotes([
      record({ id: "b4", status: "pending" }),
      record({ id: "b5", status: "inProgress" }),
      record({ id: "b6", status: "unknown" }),
    ])).toEqual(["batch b4 not finished (pending)", "batch b5 not finished (inProgress)", "batch b6 not finished (unknown)"]);
  });
});

describe("countContactsOnPage counts a GET /contacts page without reading it", () => {
  it("counts every entry in the contacts array, identifiers or not", () => {
    expect(countContactsOnPage(envelope)).toBe(2);
    expect(countContactsOnPage({ contacts: [{}, null, { identifiers: [] }] })).toBe(3);
  });

  it("is zero for anything that is not the envelope", () => {
    for (const body of [null, undefined, "", 7, [], {}, { contacts: "x" }, { contacts: null }]) {
      expect(countContactsOnPage(body)).toBe(0);
    }
  });
});

describe("orderPushTargets puts the consented audience first, then buyers without consent", () => {
  it("sorts each set and never lists an address twice", () => {
    const targets = orderPushTargets(new Set(["b@example.com", "a@example.com"]), new Set(["c@example.com", "a@example.com"]));
    expect(targets).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
  });

  it("is empty for empty sets", () => {
    expect(orderPushTargets(new Set(), new Set())).toEqual([]);
  });
});

describe("snapshot labels", () => {
  it("defaults to pre-migration-<UTC date>", () => {
    expect(defaultSnapshotLabel(Date.parse("2026-09-16T23:59:59Z"))).toBe("pre-migration-2026-09-16");
    expect(defaultSnapshotLabel(Date.parse("2026-09-17T00:00:00Z"))).toBe("pre-migration-2026-09-17");
  });

  it("accepts a short slug and refuses anything that is not one", () => {
    for (const label of ["pre-migration-2026-09-16", "post-cutover-1", "A", "x".repeat(64)]) {
      expect(isValidSnapshotLabel(label), label).toBe(true);
    }
    for (const label of ["", " ", "-leading", "has space", "has/slash", "x".repeat(65), "tab\t", "émigré"]) {
      expect(isValidSnapshotLabel(label), JSON.stringify(label)).toBe(false);
    }
  });
});

describe("emptyReconcileReport is every counter at zero and nothing unresolved", () => {
  it("has the documented shape", () => {
    expect(emptyReconcileReport()).toEqual({
      store: { consented: 0, buyersWithoutConsent: 0, suppressed: 0, smsConsented: 0, nonMailable: 0 },
      omnisend: { contactsBefore: 0, contactsAfter: 0, capped: false },
      push: { submitted: 0, batches: 0, batchIds: [], failedBatches: 0 },
      writeBack: { suppressed: 0, smsOptOuts: 0, formSubscribers: 0 },
      unresolved: [],
    });
  });
});
