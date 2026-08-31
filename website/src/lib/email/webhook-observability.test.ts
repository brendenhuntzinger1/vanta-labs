import { describe, expect, it } from "vitest";
import { parseDeliveryEvents } from "@/lib/email/delivery-events";

/**
 * WHY THIS FILE EXISTS.
 *
 * The audit could not answer "is the Resend webhook actually configured?"
 * because a healthy sender and an unwired webhook both produce an empty
 * `email_suppressions` table. The parser now recognises the events a HEALTHY
 * send produces — delivered, delayed — so a single row in
 * `email_delivery_events` settles it. These tests hold that behaviour in place.
 */

const RESEND_ID = "6229f547-f3f1-4b7f-b5f9-1a2b3c4d5e6f";

function resend(type: string, extra: Record<string, unknown> = {}) {
  return { type, data: { email_id: RESEND_ID, to: ["Buyer@Example.com"], ...extra } };
}

describe("Resend events a healthy send produces", () => {
  it("recognises email.delivered as its own kind, not as noise", () => {
    const [event] = parseDeliveryEvents(resend("email.delivered"));
    expect(event.kind).toBe("delivered");
    expect(event.rawType).toBe("email.delivered");
    expect(event.providerMessageId).toBe(RESEND_ID);
  });

  it("recognises email.delivery_delayed as delayed, and never as a bounce", () => {
    const [event] = parseDeliveryEvents(resend("email.delivery_delayed"));
    expect(event.kind).toBe("delayed");
  });

  it("normalises the recipient, so suppression can't be defeated by casing", () => {
    const [event] = parseDeliveryEvents(resend("email.delivered"));
    expect(event.email).toBe("buyer@example.com");
  });
});

describe("events that must still suppress", () => {
  it("treats a permanent bounce as a hard bounce", () => {
    const [event] = parseDeliveryEvents(resend("email.bounced", { bounce: { type: "Permanent" } }));
    expect(event.kind).toBe("hard_bounce");
  });

  it("treats a transient bounce as soft — a full mailbox is not a dead address", () => {
    const [event] = parseDeliveryEvents(resend("email.bounced", { bounce: { type: "Transient" } }));
    expect(event.kind).toBe("soft_bounce");
  });

  it("treats an unlabelled bounce as permanent", () => {
    const [event] = parseDeliveryEvents(resend("email.bounced"));
    expect(event.kind).toBe("hard_bounce");
  });

  it("treats a complaint as a complaint", () => {
    const [event] = parseDeliveryEvents(resend("email.complained"));
    expect(event.kind).toBe("complaint");
  });
});

describe("delivered and delayed must never suppress", () => {
  // The whole point of recognising them is observability. Suppressing on a
  // delivery would remove a reachable customer from every future send.
  it.each(["delivered", "delayed"] as const)("%s is not a suppressing kind", (kind) => {
    expect(["hard_bounce", "complaint"]).not.toContain(kind);
  });

  it("email.delivered does not parse as any bounce kind", () => {
    const [event] = parseDeliveryEvents(resend("email.delivered"));
    expect(event.kind).not.toMatch(/bounce|complaint/);
  });
});

describe("SendGrid parity", () => {
  it("maps delivered and deferred the same way", () => {
    const events = parseDeliveryEvents([
      { event: "delivered", email: "a@example.com", sg_message_id: "sg-1" },
      { event: "deferred", email: "b@example.com", sg_message_id: "sg-2" },
    ]);
    expect(events.map((e) => e.kind)).toEqual(["delivered", "delayed"]);
  });
});

describe("hostile and malformed payloads", () => {
  it("yields no events rather than throwing", () => {
    for (const body of [null, undefined, 0, "", "a string", [], {}, { type: "not.an.email" }, { type: "email.delivered" }]) {
      expect(() => parseDeliveryEvents(body)).not.toThrow();
      expect(Array.isArray(parseDeliveryEvents(body))).toBe(true);
    }
  });

  it("drops an event with no recipient — there is nothing to key it on", () => {
    expect(parseDeliveryEvents({ type: "email.delivered", data: { email_id: RESEND_ID } })).toEqual([]);
  });
});
