import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { notificationFor } from "./service";

/**
 * One shipping email, one delivery email, per order.
 *
 * A carrier emits many scans for one journey — accepted, in transit at each
 * facility, out for delivery, delivered. Each is a legitimate, distinct event
 * that the webhook dedupe is right to let through, so "don't send duplicates"
 * cannot be expressed as deduplication. It has to be expressed as: which MOVE
 * is worth telling a customer about.
 */
describe("which transition earns an email", () => {
  it("tells the customer once, when the parcel enters the carrier network", () => {
    expect(notificationFor("label_purchased", "shipped")).toBe("shipped");
    expect(notificationFor("label_purchased", "in_transit")).toBe("shipped");
    expect(notificationFor("packed", "shipped")).toBe("shipped");
  });

  it("says nothing more while the parcel moves through that network", () => {
    // These are real status changes. They are just not news.
    expect(notificationFor("shipped", "in_transit")).toBeNull();
    expect(notificationFor("in_transit", "out_for_delivery")).toBeNull();
    expect(notificationFor("shipped", "out_for_delivery")).toBeNull();
  });

  it("treats delivery as its own single message", () => {
    expect(notificationFor("out_for_delivery", "delivered")).toBe("delivered");
    expect(notificationFor("in_transit", "delivered")).toBe("delivered");
  });

  it("sends only the delivery email when a parcel is never seen in transit", () => {
    // Being told it shipped after it arrived helps nobody.
    expect(notificationFor("label_purchased", "delivered")).toBe("delivered");
  });

  it("never emails for a printed label", () => {
    // A label can exist for days before the parcel leaves the bench. "Your
    // order is on its way" then is the message customers write in about.
    expect(notificationFor("paid", "label_purchased")).toBeNull();
    expect(notificationFor("awaiting_fulfillment", "label_purchased" as never)).toBeNull();
    expect(notificationFor("label_purchased", "label_purchased")).toBeNull();
  });

  it("never emails for packing or fulfilment bookkeeping", () => {
    expect(notificationFor("paid", "packed")).toBeNull();
    expect(notificationFor("pending", "awaiting_fulfillment" as never)).toBeNull();
  });

  it("handles an unknown or absent previous status without inventing an email", () => {
    // A first-ever scan on an order whose status was never set still counts as
    // entering the network; nonsense in the `from` slot must not suppress it.
    expect(notificationFor(null, "shipped")).toBe("shipped");
    expect(notificationFor("", "in_transit")).toBe("shipped");
    expect(notificationFor("something_unexpected", "delivered")).toBe("delivered");
  });

  it("a whole four-scan journey produces exactly two notifications", () => {
    const journey: [string, string][] = [
      ["label_purchased", "shipped"],
      ["shipped", "in_transit"],
      ["in_transit", "out_for_delivery"],
      ["out_for_delivery", "delivered"],
    ];
    const sent = journey.map(([from, to]) => notificationFor(from, to as never)).filter(Boolean);
    expect(sent).toEqual(["shipped", "delivered"]);
  });
});

/**
 * No customer email may carry a previous fulfilment provider's identity.
 *
 * Names in historical comments and tests are fine — this checks what can
 * actually reach a customer, which is the template layer and the senders.
 */
describe("no legacy fulfilment provider can reach a customer", () => {
  const SRC = join(process.cwd(), "src");

  function sources(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) sources(path, found);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(path);
    }
    return found;
  }

  it("the email templates name no other fulfilment brand", () => {
    const templates = readFileSync(join(SRC, "lib/email/templates.ts"), "utf8");
    expect(templates).not.toMatch(/evo\s*labs/i);
    expect(templates).not.toContain("goshippo.com");
  });

  it("nothing that can send mail references a legacy provider", () => {
    const senders = sources(SRC).filter((path) => readFileSync(path, "utf8").includes("sendEmail("));
    for (const path of senders) {
      expect(readFileSync(path, "utf8"), `${path} references a legacy fulfilment provider`).not.toMatch(/evo\s*labs/i);
    }
  });
});
