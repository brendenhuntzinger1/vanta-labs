import { describe, expect, it } from "vitest";

import {
  DELIVERY_FAILED_EVENT,
  DELIVERY_FAILURE_RUN_LIMIT,
  SPAM_EVENT,
  failureIsPermanent,
  nextEventCursor,
  parseContactEvents,
  verdictForContact,
  verdictShouldBeWritten,
  type OmnisendContactEvent,
} from "@/lib/marketing/omnisend/provider-verdicts-plan";

// ---------------------------------------------------------------------------
// THE ONE DIRECTION THE WRITE-BACK COULD NOT COVER.
//
// Omnisend's contacts API has three channel statuses and no bounce field, so
// the nightly write-back can mirror an unsubscribe and nothing else. After
// cutover that leaves hard bounces and spam complaints — the two facts that
// actually damage a sending domain — reaching the store not at all, on the
// domain that also carries every receipt.
//
// These are the rules that turn the events feed into suppressions. They are
// asymmetric on purpose and the asymmetry is the whole point, so it is tested
// rather than described.
// ---------------------------------------------------------------------------

const at = (iso: string) => iso;
const spam = (iso: string): OmnisendContactEvent => ({ contactID: "c1", eventName: SPAM_EVENT, eventOccurredAt: at(iso) });
const failed = (iso: string, properties?: Record<string, unknown>): OmnisendContactEvent => ({
  contactID: "c1",
  eventName: DELIVERY_FAILED_EVENT,
  eventOccurredAt: at(iso),
  properties: properties ?? null,
});

describe("a spam complaint is certain, so one is enough", () => {
  it("suppresses as complained, which the customer cannot lift", () => {
    const verdict = verdictForContact({ email: "a@example.com", events: [spam("2026-09-10T10:00:00Z")] });
    expect(verdict).toEqual({
      email: "a@example.com",
      reason: "complained",
      at: "2026-09-10T10:00:00Z",
      evidence: SPAM_EVENT,
    });
  });

  it("dates the suppression when the mailbox said so, not now", () => {
    // The row must carry the moment the person acted. Stamping it `now` makes
    // every replay look like fresh news and re-alerts on an old fact.
    const verdict = verdictForContact({ email: "a@example.com", events: [spam("2026-08-01T00:00:00Z")] });
    expect(verdict?.at).toBe("2026-08-01T00:00:00Z");
  });

  it("takes the newest complaint, however the page was ordered", () => {
    // Omnisend groups per contact and per origin rather than sorting globally,
    // so "the last one in the array" is not "the most recent".
    const verdict = verdictForContact({
      email: "a@example.com",
      events: [spam("2026-09-10T10:00:00Z"), spam("2026-09-14T10:00:00Z"), spam("2026-09-02T10:00:00Z")],
    });
    expect(verdict?.at).toBe("2026-09-14T10:00:00Z");
  });

  it("outranks delivery failures in the same batch", () => {
    const verdict = verdictForContact({
      email: "a@example.com",
      events: [failed("2026-09-01T00:00:00Z"), spam("2026-09-02T00:00:00Z"), failed("2026-09-03T00:00:00Z")],
    });
    expect(verdict?.reason).toBe("complained");
  });
});

describe("a delivery failure does not say whether it is permanent", () => {
  it("one transient failure suppresses nobody", () => {
    // A full mailbox and a mailbox that never existed produce the same event
    // name. Retiring a real customer over one bad afternoon is the expensive
    // direction of that mistake.
    expect(verdictForContact({ email: "a@example.com", events: [failed("2026-09-10T10:00:00Z")] })).toBeNull();
  });

  it("a run below the limit still suppresses nobody", () => {
    const events = Array.from({ length: DELIVERY_FAILURE_RUN_LIMIT - 1 }, (_, i) => failed(`2026-09-0${i + 1}T10:00:00Z`));
    expect(verdictForContact({ email: "a@example.com", events })).toBeNull();
  });

  it("a long enough run escalates, and does so REVERSIBLY", () => {
    const events = Array.from({ length: DELIVERY_FAILURE_RUN_LIMIT }, (_, i) => failed(`2026-09-0${i + 1}T10:00:00Z`));
    const verdict = verdictForContact({ email: "a@example.com", events });
    // soft_bounce_run, not bounced: this is the store's inference, and
    // suppression-reasons.ts lets the customer undo an inference.
    expect(verdict?.reason).toBe("soft_bounce_run");
    expect(verdict?.evidence).toContain(`x${DELIVERY_FAILURE_RUN_LIMIT}`);
  });

  it("one failure that SAYS it is permanent suppresses immediately", () => {
    const verdict = verdictForContact({
      email: "a@example.com",
      events: [failed("2026-09-10T10:00:00Z", { bounceType: "hard" })],
    });
    expect(verdict?.reason).toBe("bounced");
  });

  it("reads permanence out of whichever key the origin used", () => {
    for (const properties of [
      { bounceType: "Hard" },
      { bounce_type: "permanent" },
      { reason: "no such user" },
      { status: "5.1.1" },
      { category: "invalid recipient" },
      { type: "nonexistent mailbox" },
    ]) {
      expect(failureIsPermanent(properties), JSON.stringify(properties)).toBe(true);
    }
  });

  it("treats anything it does not recognise as NOT permanent", () => {
    // The unrecognised case must fall through to the reversible escalation.
    for (const properties of [
      null,
      undefined,
      {},
      { bounceType: "soft" },
      { reason: "mailbox full" },
      { status: "4.2.2" },
      { reason: "greylisted, try again" },
      { bounceType: 42 },
    ]) {
      expect(failureIsPermanent(properties as Record<string, unknown> | null), JSON.stringify(properties)).toBe(false);
    }
  });
});

describe("a newer opt-out is never reversed by an older verdict", () => {
  const complaint = { email: "a@example.com", reason: "complained" as const, at: "2026-09-10T00:00:00Z", evidence: SPAM_EVENT };

  it("writes when the address is not suppressed at all", () => {
    expect(verdictShouldBeWritten({ verdict: complaint, existing: null })).toBe(true);
  });

  it("upgrades a weaker reason", () => {
    expect(verdictShouldBeWritten({
      verdict: complaint,
      existing: { reason: "soft_bounce_run", created_at: "2026-09-01T00:00:00Z" },
    })).toBe(true);
  });

  it("never downgrades a stronger one", () => {
    // A delivery-failure run must not overwrite a complaint: the customer
    // could then lift a suppression the mailbox provider imposed.
    expect(verdictShouldBeWritten({
      verdict: { ...complaint, reason: "soft_bounce_run" },
      existing: { reason: "complained", created_at: "2026-09-01T00:00:00Z" },
    })).toBe(false);
  });

  it("never rewrites the same strength, which would only move the date", () => {
    expect(verdictShouldBeWritten({
      verdict: complaint,
      existing: { reason: "complained", created_at: "2026-09-01T00:00:00Z" },
    })).toBe(false);
  });

  it("refuses a stronger verdict that is OLDER than the row it would replace", () => {
    // THE STALE-IMPORT RULE. A complaint from August arriving after a
    // September unsubscribe is still true, but re-dating the row backwards
    // would make a newer opt-out look older than it is.
    expect(verdictShouldBeWritten({
      verdict: { ...complaint, at: "2026-08-01T00:00:00Z" },
      existing: { reason: "unsubscribed", created_at: "2026-09-05T00:00:00Z" },
    })).toBe(false);
  });

  it("accepts a stronger verdict that is newer", () => {
    expect(verdictShouldBeWritten({
      verdict: complaint,
      existing: { reason: "unsubscribed", created_at: "2026-09-05T00:00:00Z" },
    })).toBe(true);
  });
});

describe("reading the events envelope", () => {
  it("parses the documented shape", () => {
    const events = parseContactEvents({
      events: [
        { contactID: "c1", eventName: SPAM_EVENT, eventOccurredAt: "2026-09-10T10:00:00Z", properties: { a: 1 } },
        { contactID: "c2", eventName: DELIVERY_FAILED_EVENT, eventOccurredAt: "2026-09-11T10:00:00Z" },
      ],
    });
    expect(events).toHaveLength(2);
    expect(events[0].properties).toEqual({ a: 1 });
    expect(events[1].properties).toBeNull();
  });

  it("drops anything missing a field a verdict depends on", () => {
    // A malformed event that became a verdict would suppress a real customer.
    expect(parseContactEvents({
      events: [
        { eventName: SPAM_EVENT, eventOccurredAt: "2026-09-10T10:00:00Z" },
        { contactID: "c1", eventOccurredAt: "2026-09-10T10:00:00Z" },
        { contactID: "c1", eventName: SPAM_EVENT },
        null,
        "nonsense",
      ],
    })).toEqual([]);
  });

  it("yields nothing for a body it does not understand", () => {
    for (const body of [null, undefined, {}, [], "", { events: "no" }]) {
      expect(parseContactEvents(body)).toEqual([]);
    }
  });

  it("reads the forward-only cursor, and null on the last page", () => {
    expect(nextEventCursor({ paging: { cursors: { after: "abc" }, hasMore: true } })).toBe("abc");
    expect(nextEventCursor({ paging: { cursors: { after: null }, hasMore: false } })).toBeNull();
    expect(nextEventCursor({})).toBeNull();
  });
});
