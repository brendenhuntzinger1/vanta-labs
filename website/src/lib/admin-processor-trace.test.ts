import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeProcessorTrace, type ProcessorTrace } from "@/lib/admin-processor-trace";

// ---------------------------------------------------------------------------
// THE TWO QUESTIONS NO ADMIN SCREEN COULD ANSWER.
//
// On 2026-09-08 five high-value orders died on a 3-D Secure challenge, and
// settling what had actually happened needed exactly two facts: which processor
// session the attempt used, and whether any webhook had ever arrived for it.
// Both were already in the database and neither was readable from any admin
// page, so the conversation with the processor ran on screenshots until a
// hand-written query against payment_events showed two of those orders with ZERO
// rows — proof the charge had never reached the issuer.
//
// "No webhook was ever received" is a claim an operator will take to their
// processor. These tests exist mostly to make sure it is never made by a read
// that simply failed.
// ---------------------------------------------------------------------------

const trace = (overrides: Partial<ProcessorTrace> = {}): ProcessorTrace => ({
  sessionId: "vs_7c1f",
  settlingEventId: null,
  events: [],
  eventsUnavailable: false,
  ...overrides,
});

describe("an order the processor never spoke about", () => {
  it("says so plainly, and points at the session id to look up", () => {
    const line = describeProcessorTrace(trace(), "payment_failed");
    expect(line).toMatch(/No webhook has ever been received/i);
    expect(line).toMatch(/session id/i);
  });

  it("distinguishes 'no session was ever opened' — the card was never submitted", () => {
    const line = describeProcessorTrace(trace({ sessionId: null }), "payment_failed");
    expect(line).toMatch(/never submitted/i);
  });
});

describe("a read that failed is never reported as silence", () => {
  it("refuses to assert anything about the payment", () => {
    const line = describeProcessorTrace(trace({ eventsUnavailable: true }), "payment_failed");
    expect(line).toMatch(/could not be read/i);
    expect(line).toMatch(/not evidence/i);
    expect(line).not.toMatch(/No webhook has ever been received/i);
  });

  it("holds even when rows happen to be present alongside the failure flag", () => {
    const line = describeProcessorTrace(
      trace({ eventsUnavailable: true, events: [{ eventId: "evt-1", status: "paid", claimedAt: "x", processedAt: "y" }] }),
      "paid",
    );
    expect(line).toMatch(/could not be read/i);
  });
});

describe("an order that did settle from a real event", () => {
  it("says the order settled from a processor event", () => {
    const line = describeProcessorTrace(
      trace({ events: [{ eventId: "evt-1", status: "paid", claimedAt: "t1", processedAt: "t2" }] }),
      "paid",
    );
    expect(line).toMatch(/1 webhook received and processed/i);
    expect(line).toMatch(/settled from a real processor event/i);
  });

  it("counts more than one correctly, without saying '1 webhooks'", () => {
    const line = describeProcessorTrace(
      trace({
        events: [
          { eventId: "evt-1", status: "paid", claimedAt: "t1", processedAt: "t2" },
          { eventId: "evt-2", status: "paid", claimedAt: "t3", processedAt: "t4" },
        ],
      }),
      "paid",
    );
    expect(line).toMatch(/2 webhooks/);
    expect(line).not.toMatch(/1 webhooks/);
  });
});

describe("events arrived but the order is not paid", () => {
  it("says the processor reported something other than a successful charge", () => {
    const line = describeProcessorTrace(
      trace({ events: [{ eventId: "evt-1", status: "payment_failed", claimedAt: "t1", processedAt: "t2" }] }),
      "payment_failed",
    );
    expect(line).toMatch(/other than a successful charge/i);
    expect(line).not.toMatch(/No webhook has ever/i);
  });
});

describe("a delivery that never finished", () => {
  it("is called out, because the sweep will retry it and the page is about to change", () => {
    const line = describeProcessorTrace(
      trace({
        events: [
          { eventId: "evt-1", status: "paid", claimedAt: "t1", processedAt: null },
          { eventId: "evt-2", status: "paid", claimedAt: "t0", processedAt: "t2" },
        ],
      }),
      "pending_payment",
    );
    expect(line).toMatch(/never finished processing/i);
    expect(line).toMatch(/check this order again/i);
  });
});

// ---------------------------------------------------------------------------
// AND IT HAS TO BE ON THE PAGE.
//
// Verified in the browser against the local harness on 2026-09-10, at 1280x900
// and at 390x844, on three real orders:
//
//   VL-61B3EBDF  paid, 4 events   "4 webhooks received and processed. This order
//                                  settled from a real processor event."
//   VL-09980F05  pending, 0       "No webhook has ever been received... look it
//                                  up by the session id above."
//   VL-A21F74CD  canceled, 0      "...and no payment session was ever opened, so
//                                  the card was never submitted."
//
// Neither line could be obtained from any screen before this.
// ---------------------------------------------------------------------------
describe("the admin order page shows the trace", () => {
  const page = () =>
    readFileSync(join(process.cwd(), "src/app/admin/orders/[orderId]/page.tsx"), "utf8");

  it("reads the trace for every order, not only a failed one", () => {
    const source = page();
    expect(source).toContain("const processorTrace = await getProcessorTrace(data);");
    // Outside the isFailed branch: a paid order's webhook history is worth as
    // much as a failed one's silence.
    expect(source.indexOf("const processorTrace")).toBeLessThan(source.indexOf("data-processor-trace"));
  });

  it("renders the verdict, the session id and the event list", () => {
    const source = page();
    expect(source).toContain("data-processor-trace");
    expect(source).toMatch(/describeProcessorTrace\(processorTrace, paymentStatus\)/);
    expect(source).toMatch(/processorTrace\.sessionId/);
    expect(source).toMatch(/processorTrace\.events\.map/);
  });

  it("makes the ids copyable and unable to widen the page on a phone", () => {
    // A session id is only useful if it can be pasted into the processor's
    // dashboard, and a 40-character monospace string with no break rule is how
    // an admin page starts scrolling sideways at 390px.
    const panel = page().slice(page().indexOf("data-processor-trace"), page().indexOf("{/* Customer and address"));
    expect(panel).toMatch(/select-all/);
    expect(panel).toMatch(/break-all/);
  });

  it("marks an unfinished delivery differently from a processed one", () => {
    const panel = page().slice(page().indexOf("data-processor-trace"), page().indexOf("{/* Customer and address"));
    expect(panel).toMatch(/never finished/);
    expect(panel).toMatch(/processed/);
  });
});
