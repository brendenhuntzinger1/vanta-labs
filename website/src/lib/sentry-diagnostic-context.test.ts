import { describe, expect, it } from "vitest";

import { scrubEvent, scrubValue } from "@/lib/sentry-privacy";

// ---------------------------------------------------------------------------
// KEEP THE BROWSER, LOSE THE CUSTOMER.
//
// "name" is a sensitive key fragment because real payloads carry customerName,
// recipient_name and billing_full_name, and substring matching is what catches
// them. The cost was that Sentry's own standard contexts went with them:
// browser.name arrived as "[redacted]", so every event described an unknown
// browser on an unknown OS.
//
// That is the exact context a checkout bug needs. Both real production
// purchases failed the same way — the provider's onSuccess callback never
// fired — and "which browsers does this happen in" is unanswerable when every
// event says [redacted]. The information was being destroyed at the moment it
// mattered most.
//
// The fix is an allowlist of EXACT PATHS, not a weaker rule. Loosening "name"
// to a whole-key match would let customer_name through the day someone names a
// field that way. An exact path cannot widen by accident.
// ---------------------------------------------------------------------------

const CUSTOMER = {
  name: "Dana Buyer",
  email: "dana@example.com",
  phone: "3035550111",
};

function eventWith(contexts: Record<string, unknown>) {
  return scrubEvent({ contexts } as Parameters<typeof scrubEvent>[0]) as {
    contexts: Record<string, Record<string, unknown>>;
  };
}

describe("diagnostic context survives", () => {
  it("keeps browser, OS and runtime names", () => {
    const out = eventWith({
      browser: { name: "Mobile Safari", version: "17.5" },
      os: { name: "iOS", version: "17.5" },
      runtime: { name: "node", version: "24.0.0" },
    });

    expect(out.contexts.browser.name).toBe("Mobile Safari");
    expect(out.contexts.browser.version).toBe("17.5");
    expect(out.contexts.os.name).toBe("iOS");
    expect(out.contexts.runtime.name).toBe("node");
  });

  it("keeps the device MODEL, which is hardware, not a person", () => {
    const out = eventWith({ device: { family: "iPhone", model: "iPhone14,2", brand: "Apple" } });
    expect(out.contexts.device.family).toBe("iPhone");
    expect(out.contexts.device.model).toBe("iPhone14,2");
    expect(out.contexts.device.brand).toBe("Apple");
  });
});

describe("and PII still does not", () => {
  /**
   * The one that decides whether the allowlist was written carefully. A device
   * NAME is whatever the owner typed, and on iOS that is routinely a real
   * person's first name. It must NOT be allowlisted alongside its siblings.
   */
  it("REDACTS device.name — it is whatever the owner typed", () => {
    const out = eventWith({ device: { family: "iPhone", name: "Brenden's iPhone" } });
    expect(out.contexts.device.family).toBe("iPhone");
    expect(out.contexts.device.name).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("Brenden");
  });

  it("redacts a customer name that happens to sit under contexts", () => {
    const out = eventWith({ order: { customerName: CUSTOMER.name, customer_email: CUSTOMER.email } });
    expect(out.contexts.order.customerName).toBe("[redacted]");
    expect(out.contexts.order.customer_email).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("Dana Buyer");
  });

  /**
   * The allowlist is rooted at "contexts". A field with the same trailing shape
   * somewhere else must not inherit the exemption.
   */
  it("does not exempt a lookalike path outside contexts", () => {
    const out = scrubValue({ browser: { name: CUSTOMER.name } }, 0, "extra") as {
      browser: Record<string, unknown>;
    };
    expect(out.browser.name).toBe("[redacted]");
  });

  it("does not exempt a deeper path that merely ends the same way", () => {
    const out = eventWith({ nested: { browser: { name: CUSTOMER.name } } });
    expect((out.contexts.nested as Record<string, Record<string, unknown>>).browser.name).toBe("[redacted]");
  });

  it("still redacts everything sensitive beside an allowlisted sibling", () => {
    const out = eventWith({
      browser: { name: "Mobile Safari" },
      shipping: { address: "42 Test Ave", postal_code: "80202", phone: CUSTOMER.phone },
    });
    expect(out.contexts.browser.name).toBe("Mobile Safari");
    expect(out.contexts.shipping.address).toBe("[redacted]");
    expect(out.contexts.shipping.phone).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("42 Test Ave");
    expect(JSON.stringify(out)).not.toContain(CUSTOMER.phone);
  });
});
