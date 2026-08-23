import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FULFILLMENT_STATUS_SOURCES } from "@/lib/order-pipeline";

// ---------------------------------------------------------------------------
// THE OWNER UI MAY NOT OFFER AN ACTION THE SERVER CATEGORICALLY REFUSES.
//
// /admin/fulfillment used to show a "Mark Delivered" button. Pressing it POSTed
// { action: "update_status", fulfillmentStatus: "delivered" } to
// /api/admin/orders/[orderId], which routes through setOrderFulfillmentStatus
// with source "admin" — and order-pipeline.ts lists "shippo" as the ONLY source
// permitted to write `delivered`. So the button could never once do what it
// said, for any order, in any state: it answered 400 every time.
//
// This file pins the rule in the direction that matters. It reads the actual
// admin components and asserts that every fulfillment status they ask the
// server to write is one an "admin" source is allowed to write at all. Adding
// a control for a carrier-owned status turns this red.
// ---------------------------------------------------------------------------

const COMPONENTS = path.join(process.cwd(), "src", "components");

// Comments are stripped before scanning: these files EXPLAIN in prose why the
// delivered control is gone, and a prose mention is not a button.
function source(file: string) {
  return readFileSync(path.join(COMPONENTS, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const ADMIN_WRITABLE = new Set(
  Object.entries(FULFILLMENT_STATUS_SOURCES)
    .filter(([, sources]) => sources.includes("admin"))
    .map(([status]) => status),
);

const CARRIER_ONLY = Object.entries(FULFILLMENT_STATUS_SOURCES)
  .filter(([, sources]) => !sources.includes("admin"))
  .map(([status]) => status);

describe("the statuses the pipeline reserves for the carrier", () => {
  it("still includes delivered — the premise of this whole file", () => {
    // If delivery ever becomes admin-writable this test must be revisited
    // rather than silently passing because the rule dissolved.
    expect(CARRIER_ONLY).toContain("delivered");
    expect(ADMIN_WRITABLE.has("delivered")).toBe(false);
  });

  it("still lets an admin record a hand-carried shipment", () => {
    // The deliberate courier escape hatch. Removing "Mark Shipped" along with
    // "Mark Delivered" would have broken a path the architecture requires.
    expect(ADMIN_WRITABLE.has("shipped")).toBe(true);
  });
});

describe("admin-fulfillment-client offers only actions the server can perform", () => {
  const text = source("admin-fulfillment-client.tsx");

  // Every status this component asks the server to write, e.g. save("shipped").
  const requested = [...text.matchAll(/save\(\s*"([a-z_]+)"/g)].map((m) => m[1]);

  it("asks the server to write at least one status (the scan is not vacuous)", () => {
    expect(requested.length).toBeGreaterThan(0);
  });

  for (const status of new Set(requested)) {
    it(`only offers "${status}" because an admin is permitted to write it`, () => {
      expect(ADMIN_WRITABLE.has(status)).toBe(true);
    });
  }

  it("offers no carrier-owned status at all", () => {
    expect(requested.filter((s) => !ADMIN_WRITABLE.has(s))).toEqual([]);
  });

  it("shows no Mark Delivered control", () => {
    expect(text).not.toMatch(/Mark Delivered/i);
  });

  it("still shows the Mark Shipped escape hatch", () => {
    expect(text).toMatch(/Mark Shipped/);
  });
});

describe("no admin surface offers a manual Delivered control", () => {
  const files = [
    "admin-fulfillment-client.tsx",
    "admin-orders-client.tsx",
    "admin-order-fulfillment-card.tsx",
    "fulfillment-workstation.tsx",
  ];

  for (const file of files) {
    it(`${file} has no Mark Delivered / Mark Fulfilled button`, () => {
      expect(source(file)).not.toMatch(/Mark (Delivered|Fulfilled)/i);
    });
  }

  it("the bulk action list contains no delivered action", () => {
    const text = source("admin-orders-client.tsx");
    const actions = [...text.matchAll(/action:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions).toContain("mark_shipped");
    expect(actions.some((a) => a.includes("deliver"))).toBe(false);
  });

  it("the order-detail fulfillment dropdown cannot submit a carrier-owned status", () => {
    // Scoped to the FULFILLMENT select: the payment-status select above it
    // shares value names ("paid") that mean something else entirely.
    const whole = source("admin-order-actions.tsx");
    const block = whole.slice(whole.indexOf("Fulfillment status"));
    const text = block.slice(0, block.indexOf("</select>"));
    expect(text).toMatch(/<option value="shipped"/);
    // Options exist for display (a select whose value is absent shows the wrong
    // row), so the rule is that every carrier-owned option is disabled.
    for (const status of CARRIER_ONLY) {
      const option = new RegExp(`<option value="${status}"([^>]*)>`);
      const match = text.match(option);
      if (!match) continue;
      expect(match[1]).toContain("disabled");
    }
  });

  it("finds the delivered option at all, so the check above is not vacuous", () => {
    expect(source("admin-order-actions.tsx")).toMatch(/<option value="delivered"/);
  });
});
