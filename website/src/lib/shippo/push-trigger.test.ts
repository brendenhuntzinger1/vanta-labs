import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// WHERE THE PUSH COMES FROM.
//
// The whole fulfillment design rests on one property: a paid order reaches
// Shippo without anyone opening its admin page. Break that and the owner is
// back to visiting one page per order to make it ship -- which is the exact
// workflow this was built to remove, and it fails silently, because a page
// that pushes on render looks perfect to whoever is looking at it.
//
// These read the source rather than execute it. That is the point: the property
// is "this module does not call that function", and the honest way to check it
// is to look at every call site.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), "src");

function read(relative: string): string {
  return readFileSync(join(SRC, relative), "utf8");
}

/** Source with comments stripped, so a mention in prose is not a call. */
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("what triggers the push to Shippo", () => {
  it("is the payment webhook, once the order is paid", () => {
    const webhook = code("lib/payment-webhook.ts");

    expect(webhook).toContain("scheduleShippoSync");
    expect(webhook).toContain("syncOrderToShippo");
  });

  // after() runs the work once the response is flushed. Awaiting it inline is
  // what previously pushed the webhook response past the payment provider's
  // timeout and left shoppers on "Processing…" for an order that had been paid.
  it("runs after the payment response is flushed, never inside it", () => {
    const webhook = code("lib/payment-webhook.ts");

    expect(webhook).toMatch(/after\(run\)/);

    // The sole call must sit inside scheduleShippoSync, whose body is what
    // after() defers. An await ANYWHERE else in this file is on the critical
    // path, however harmless it looks.
    const calls = webhook.match(/syncOrderToShippo\(/g) ?? [];
    expect(calls).toHaveLength(1);

    const start = webhook.indexOf("function scheduleShippoSync");
    const end = webhook.indexOf("\n}", start);
    expect(start).toBeGreaterThan(-1);
    expect(webhook.indexOf("syncOrderToShippo(")).toBeGreaterThan(start);
    expect(webhook.indexOf("syncOrderToShippo(")).toBeLessThan(end);
  });

  it("has the cron sweep as its safety net", () => {
    const sweep = code("app/api/cron/sweep/route.ts");

    expect(sweep).toContain("sweepUnsyncedOrders");
  });

  // The one that matters most.
  it("is NOT the admin order page — opening an order pushes nothing", () => {
    const page = code("app/admin/orders/[orderId]/page.tsx");

    expect(page).not.toContain("syncOrderToShippo");
    expect(page).not.toContain("scheduleShippoSync");
    expect(page).not.toContain("backfillOrderShipment");
  });

  // buildOrderParcel is pure weight math against the database. It is fine on a
  // page render precisely because it talks to nobody.
  it("computes the parcel on render without contacting Shippo", () => {
    const page = code("app/admin/orders/[orderId]/page.tsx");

    expect(page).toContain("buildOrderParcel");
    expect(page).not.toContain("createShippoOrder");
    expect(page).not.toContain("createShipmentWithRates");
  });
});

describe("the admin order page after the cleanup", () => {
  const page = code("app/admin/orders/[orderId]/page.tsx");
  const card = code("components/admin-order-fulfillment-card.tsx");

  // Each of these was a control that duplicated Shippo. Hiding them would leave
  // the endpoints reachable and the page heavy; they are gone.
  it.each([
    ["rate quoting", "shipping/rates"],
    ["label purchase", "shipping/label"],
    ["package preset list", "listPackagePresets"],
  ])("no longer offers %s", (_label, needle) => {
    expect(page).not.toContain(needle);
    expect(card).not.toContain(needle);
  });

  it("no longer dumps the raw order row onto the page", () => {
    expect(page).not.toContain("JSON.stringify(data");
  });

  // Retry is the one fulfillment action left, and it must stay rare: a healthy
  // order should give the owner no reason to touch this page at all.
  it("keeps exactly one write action, the sync retry", () => {
    expect(card).toContain("shipping/sync");
    expect(card.match(/fetch\(/g) ?? []).toHaveLength(1);
  });

  it("cannot spend money — no purchase endpoint is reachable from the card", () => {
    expect(card).not.toContain("method: \"POST\"\n" + " ".repeat(6) + "}, \"buy\"");
    expect(card).not.toMatch(/buyLabel|purchaseLabel/);
  });
});
