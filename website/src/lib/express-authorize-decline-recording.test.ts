import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// The Apple Pay lane records WHY Veyra said no.
//
// /api/checkout/express/authorize has no route-level test: its POST wires
// twelve server modules together and chargeViaVeyra is module-private. The
// two helpers it now calls — describeExpressDecline and the columns it writes —
// are unit-tested in payment-failure.test.ts, but nothing proved the route
// actually hands the result to the row, or that the guard it gained matches the
// status the row was inserted with. This pins both the same way
// bxgy-single-implementation.test.ts pins this file's redemption claim: by
// reading the source. Crude, and honest about what it can and cannot prove.
//
// The one thing that must NEVER change is also pinned: the shopper's response
// carries the same generic sentence it always did. A fraud "blocked" verdict
// is recorded for the admin and never echoed to the person it blocked.
// ---------------------------------------------------------------------------

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const ROUTE = "src/app/api/checkout/express/authorize/route.ts";

function answeredNoBlock(source: string): string {
  const start = source.indexOf('if (outcome === "answered_no") {');
  const end = source.indexOf('if (outcome === "duplicate") {', start);
  expect(start, "answered_no branch must exist").toBeGreaterThan(-1);
  expect(end, "duplicate branch must follow answered_no").toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("express authorize: a decline is recorded with its reason", () => {
  const source = read(ROUTE);

  it("threads Veyra's verdict from chargeViaVeyra into the order update", () => {
    // chargeViaVeyra returns the verdict on the answered_no path…
    expect(source).toContain('return { outcome: "answered_no", redirectUrl: null, failure: describeExpressDecline(payload, response.status) };');
    // …and the POST reads it off the result.
    expect(source).toContain("const { outcome, redirectUrl, failure } = await chargeViaVeyra({");

    const block = answeredNoBlock(source);
    expect(block).toContain("const declined = failure ?? describeExpressDecline(null, 0);");
    expect(block).toContain('payment_status: "payment_failed"');
    expect(block).toContain("payment_failure_kind: declined.kind");
    expect(block).toContain("payment_failure_code: declined.code");
    expect(block).toContain("payment_failure_reason: declined.reason");
    expect(block).toContain("payment_failed_at: declinedAt");
  });

  it("guards the update on the status the row was inserted with", () => {
    const block = answeredNoBlock(source);
    expect(block).toContain('.eq("order_id", claimed.order_id)');
    expect(block).toContain('.eq("payment_status", "pending_payment")');
    // The guard is only sound if the row really is pending_payment at that
    // point. buildOrderRow is what inserted it, moments earlier in this request.
    expect(source).toContain("const orderRow = buildOrderRow({");
    expect(read("src/lib/quote-order.ts")).toContain('payment_status: "pending_payment"');
  });

  it("still returns the stock and the shopper's credit after recording the decline", () => {
    const block = answeredNoBlock(source);
    const updateAt = block.indexOf('.from("orders")');
    const releaseAt = block.indexOf("await releaseInventoryForOrder(claimed.order_id);");
    const tenderAt = block.indexOf("await releaseOrderTender(claimed.order_id)");
    expect(updateAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(updateAt);
    expect(tenderAt).toBeGreaterThan(releaseAt);
  });

  it("never echoes the processor's reason to the shopper", () => {
    const block = answeredNoBlock(source);
    // The response the browser receives is built from a fixed sentence…
    expect(block).toContain('message: "Your bank declined that payment. Please try another card."');
    // …and carries nothing from `declined`: not the code, not the reason, not
    // the object. `declined.` may only appear inside the database update.
    const resultAt = block.indexOf("const result: AuthorizeResult = {");
    expect(resultAt).toBeGreaterThan(-1);
    // The fixed sentence itself contains the word "declined"; strip it, then
    // no identifier from the recording may remain in what is returned.
    const afterResult = block
      .slice(resultAt)
      .replace('"Your bank declined that payment. Please try another card."', '""');
    expect(afterResult).not.toMatch(/\bdeclined\b/);
    expect(afterResult).not.toMatch(/\bfailure\b/);
  });
});
