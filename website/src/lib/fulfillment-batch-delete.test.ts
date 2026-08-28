import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// DELETING A BATCH MUST NOT TOUCH AN ORDER.
//
// The property being defended is the one the batch design rests on: a batch is
// an operational grouping and nothing else, so discarding one may remove the
// grouping and MUST leave payment, inventory, fulfillment and shipping state
// untouched. Source assertions, for the same reason fulfillment-labels.test.ts
// uses them — these are wiring properties between modules, and the edit that
// breaks them is one that looks locally reasonable ("while we're deleting the
// batch, mark its orders back to ready").
// ---------------------------------------------------------------------------

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const batches = stripComments(readFileSync("src/lib/fulfillment-batches.ts", "utf8"));
const route = stripComments(readFileSync("src/app/api/admin/fulfillment/batches/route.ts", "utf8"));
const workstation = readFileSync("src/components/fulfillment-workstation.tsx", "utf8");

/** The body of deleteBatch, up to the next top-level export. */
function deleteBatchBody(): string {
  const start = batches.indexOf("export async function deleteBatch");
  expect(start).toBeGreaterThan(-1);
  const next = batches.indexOf("\nexport ", start + 1);
  return batches.slice(start, next === -1 ? undefined : next);
}

describe("deleteBatch stays inside the batch tables", () => {
  const body = deleteBatchBody();

  it("never writes to `orders`", () => {
    // THE DEFECT: releasing orders by rewriting fulfillment_status. They are
    // already correct — batch membership never changed them, so nothing needs
    // undoing. A write here would move an order through no pipeline transition.
    expect(body).not.toMatch(/from\("orders"\)/);
  });

  it("touches no other domain table", () => {
    for (const table of ["order_items", "inventory", "product_doses", "order_shipments", "products"]) {
      expect(body).not.toContain(`"${table}"`);
    }
  });

  it("never calls Shippo — deleting a batch is not a void", () => {
    expect(body.toLowerCase()).not.toContain("shippo");
  });

  it("reads membership before the delete, since the cascade destroys it", () => {
    // THE DEFECT: auditing after the delete, which records an empty batch and
    // loses the only remaining answer to 'what was in it'.
    const readMembers = body.indexOf("fulfillment_batch_orders");
    const del = body.indexOf(".delete()");
    expect(readMembers).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(-1);
    expect(readMembers).toBeLessThan(del);
  });

  it("returns the deleted membership so the caller can audit it", () => {
    expect(body).toContain("orderIds");
  });
});

describe("the delete route", () => {
  it("requires an admin session", () => {
    const del = route.slice(route.indexOf("export async function DELETE"));
    expect(del).toContain("verifyAdminSessionFromRequest");
    expect(del).toContain("unauthorized()");
  });

  it("audits the delete with the orders that were in the batch", () => {
    const del = route.slice(route.indexOf("export async function DELETE"));
    expect(del).toContain("fulfillment_batch_delete");
    expect(del).toContain("admin_audit_logs");
    expect(del).toContain("orderIds");
  });

  it("rejects a call with no batchId rather than deleting broadly", () => {
    const del = route.slice(route.indexOf("export async function DELETE"));
    expect(del).toContain("batchId is required.");
  });
});

describe("the workstation control", () => {
  it("confirms before deleting", () => {
    // THE DEFECT: a bare Delete button beside 'Start packing'. The grouping is
    // the one thing on that screen that cannot be reconstructed.
    const handler = workstation.slice(workstation.indexOf("const discardBatch"));
    expect(handler).toContain("window.confirm");
  });

  it("uses the DELETE method, not a repurposed PATCH action", () => {
    const handler = workstation.slice(workstation.indexOf("const discardBatch"));
    expect(handler).toContain('method: "DELETE"');
  });

  it("clears any view of a batch it just deleted", () => {
    // THE DEFECT: a pick list or packing bench left on screen for a batch that
    // no longer exists, whose buttons then 404.
    const handler = workstation.slice(
      workstation.indexOf("const discardBatch"),
      workstation.indexOf("const verifyAndAdvance"),
    );
    expect(handler).toContain("setPickList(null)");
    expect(handler).toContain("setPacking(null)");
    expect(handler).toContain("setReview(null)");
  });
});
