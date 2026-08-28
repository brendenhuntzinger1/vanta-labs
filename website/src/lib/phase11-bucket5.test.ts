import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { computeOrderProfit } from "@/lib/order-profit";

// ---------------------------------------------------------------------------
// PHASE 11, BUCKET 5.
//
// Six unrelated polish defects, held here so none of them can come back:
//
//   ADM-07  deleting a product left no audit row, and the confirm dialog did
//           not say the delete cascades.
//   ADM-08  the drag-to-reorder save was fire-and-forget, so a staff user's
//           403 looked exactly like a successful save until the next reload.
//   E-06    the wholesale form claimed a confirmation email that the route
//           never checks was delivered.
//   F-06    the harness revoked current_auth_email from anon, contradicting
//           production's own recorded ACL and the RLS policies that call it.
//   M-10    the per-dose margin preview carried a private copy of the 8%
//           processing fee and did not disclose commission.
//   M-11    the order profit panel printed the WHOLE refund beside a net
//           profit computed from a smaller reversal.
//   SQL-13  six harness columns were nullable where their owning migration
//           declares them NOT NULL.
//
// The UI-copy and SQL items are asserted at source, the way
// handoff-invariants.test.ts does: neither a window.confirm string nor an
// `alter table` is reachable from a unit test, and "it is still worded/declared
// this way" is the whole of what needs to hold.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(process.cwd(), "src");

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

// ---------------------------------------------------------------------------
// ADM-07 — the delete leaves a trace.
// ---------------------------------------------------------------------------

const auditRows = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const deleted = vi.hoisted(() => [] as string[]);
const product = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromRequest: async () => ({ username: "owner", role: "super_admin" }),
  getRequestIpAddress: () => "203.0.113.9",
  getRequestUserAgent: () => "vitest",
}));

vi.mock("@/lib/admin-products", () => ({
  deleteAdminProduct: async (id: string) => {
    deleted.push(id);
  },
  getAdminProductById: async () => {
    if (!product.value) throw new Error("Product not found");
    return product.value;
  },
  reorderProductImages: async () => undefined,
  replaceProductDoses: async () => undefined,
  setPrimaryProductImage: async () => undefined,
  updateAdminProduct: async () => undefined,
  uploadProductImageToStorage: async () => undefined,
  addProductImageFromUrl: async () => undefined,
  deleteProductImage: async () => undefined,
}));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        auditRows.push({ table, ...row });
        return { error: null };
      },
    }),
  },
}));

const { DELETE } = await import("@/app/api/admin/products/[productId]/route");

const deleteRequest = () => new Request("http://localhost/api/admin/products/p-1", { method: "DELETE" });
const params = { params: Promise.resolve({ productId: "p-1" }) };

beforeEach(() => {
  auditRows.length = 0;
  deleted.length = 0;
  product.value = { name: "Retatrutide", slug: "retatrutide" };
});

describe("ADM-07 — deleting a product is audited", () => {
  it("writes an admin_audit_logs row naming the product, the actor and the address", async () => {
    const response = await DELETE(deleteRequest(), params);
    expect(response.status).toBe(200);
    expect(deleted).toEqual(["p-1"]);

    expect(auditRows).toHaveLength(1);
    const row = auditRows[0] as Record<string, unknown>;
    expect(row.table).toBe("admin_audit_logs");
    expect(row.action).toBe("product_delete");
    expect(row.target_table).toBe("products");
    expect(row.target_id).toBe("p-1");
    // The name and slug are the point: once the rows are gone, an opaque uuid
    // cannot answer "which product was this?".
    expect(row.metadata).toMatchObject({
      name: "Retatrutide",
      slug: "retatrutide",
      performedBy: "owner",
      ipAddress: "203.0.113.9",
      userAgent: "vitest",
    });
  });

  it("still deletes, and still logs, when the product cannot be read first", async () => {
    product.value = null;
    const response = await DELETE(deleteRequest(), params);

    expect(response.status).toBe(200);
    expect(deleted).toEqual(["p-1"]);
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0] as { metadata: { name: unknown } }).metadata.name).toBeNull();
  });

  it("names the cascade in the confirm dialog", () => {
    const source = read("app/admin/products/page.tsx");
    // `[^)]` already spans newlines, so no dotAll flag is needed (and the
    // tsconfig target predates it).
    const confirm = /window\.confirm\(\s*"?([^)]*?)"?,?\s*\)/.exec(source)?.[0] ?? "";
    expect(confirm).toMatch(/images/i);
    expect(confirm).toMatch(/dose/i);
    expect(confirm).toMatch(/Certificates of Analysis/i);
    expect(confirm).toMatch(/cannot be undone/i);
  });
});

// ---------------------------------------------------------------------------
// ADM-08 — a rejected reorder is not silently kept on screen.
// ---------------------------------------------------------------------------

describe("ADM-08 — the drag-to-reorder save is checked", () => {
  const source = read("app/admin/products/page.tsx");
  const body = source.slice(source.indexOf("const reorderProducts"), source.indexOf("return (\n    <div className=\"min-h-screen"));

  it("reads the response instead of firing and forgetting", () => {
    expect(body).toContain("/api/admin/products/reorder");
    expect(body).toMatch(/if \(!res\.ok \|\| !json\.success\)/);
  });

  it("restores the previous order and says so when the save is refused", () => {
    // /reorder is manager+ only and this page has no client-side role gate, so
    // the rollback is the ONLY thing that stops a staff user's 403 reading as a
    // saved reorder until the next page load.
    expect(body).toMatch(/const previous = products;/);
    expect((body.match(/setProducts\(previous\)/g) ?? []).length).toBe(2); // failure branch + catch
    expect(body).toContain("Unable to save the new order.");
  });
});

// ---------------------------------------------------------------------------
// E-06 — the wholesale form claims only what the route guarantees.
// ---------------------------------------------------------------------------

describe("E-06 — the wholesale confirmation copy", () => {
  it("does not assert an email the route never confirmed was delivered", () => {
    const source = read("components/wholesale-form.tsx");
    const panel = source.slice(source.indexOf('status.kind === "sent"'));
    // The route returns success on the INTERNAL notification alone; the
    // customer auto-reply is sent best-effort with its result discarded.
    expect(panel).not.toMatch(/sent a confirmation to your email/i);
    expect(panel).toMatch(/got your details/i);
  });

  it("is still the only thing gating that panel — success means the lead landed", () => {
    const route = readFileSync(path.join(ROOT, "app/api/wholesale/route.ts"), "utf8");
    // If this ever starts reporting the auto-reply's outcome, the copy above can
    // become specific again. Until then it must not.
    expect(route).toMatch(/return NextResponse\.json\(\{ success: true \}\);/);
  });
});

// ---------------------------------------------------------------------------
// F-06 — the harness ACL matches production's recorded one.
// ---------------------------------------------------------------------------

describe("F-06 — current_auth_email stays callable in the harness", () => {
  const parity = read("lib/sql/harness-prod-parity-functions.sql");

  it("does not revoke the three SECURITY INVOKER JWT helpers", () => {
    // rpc-exposure-drift-check.sql records production as `f | t | t` for all
    // three, and customer-accounts.sql's RLS policies call them AS THE CALLER —
    // revoking from anon locks those policies out of the harness only, which is
    // the definition of the harness testing a different system.
    for (const fn of ["current_auth_email", "current_auth_role", "current_auth_uid"]) {
      expect(parity).not.toMatch(new RegExp(`revoke\\s+.*on function public\\.${fn}\\(`, "i"));
    }
  });

  it("still revokes the SECURITY DEFINER function in the same file", () => {
    // The negative control. Without this, deleting the whole lockdown block
    // would pass the assertion above.
    expect(parity).toMatch(/revoke all on function public\.admin_points_outstanding\(\) from public, anon, authenticated/i);
  });
});

// ---------------------------------------------------------------------------
// M-10 — one processing-fee rate, and a caption that names what is excluded.
// ---------------------------------------------------------------------------

describe("M-10 — the per-dose margin preview", () => {
  const source = read("app/admin/products/page.tsx");

  it("uses the single-sourced default rate, not a private copy", () => {
    expect(source).toContain('import { PROCESSING_FEE_DEFAULT_PERCENT } from "@/lib/admin-control-shared";');
    expect(source).toContain("priceCents * (PROCESSING_FEE_DEFAULT_PERCENT / 100)");
    expect(source).not.toMatch(/const PROCESSOR_FEE_PERCENT\s*=/);
  });

  it("discloses that commission and shipping are not in the figure", () => {
    const caption = source.slice(source.indexOf("before per-order shipping") - 200, source.indexOf("before per-order shipping") + 60);
    expect(caption).toMatch(/ambassador commission/i);
    expect(caption).toMatch(/default \{PROCESSING_FEE_DEFAULT_PERCENT\}% processing fee/);
  });
});

// ---------------------------------------------------------------------------
// M-11 — the printed refund is the reversal the engine applied.
// ---------------------------------------------------------------------------

describe("M-11 — revenueRefund is the figure the total was computed from", () => {
  // A $100 order + $8 tax, fully refunded, with tax treated as a pass-through.
  const passThrough = () =>
    computeOrderProfit({
      netMerchandiseRevenue: 100,
      shippingRevenue: 0,
      shippingCost: 0,
      taxCollected: 8,
      countTaxAsProfit: false,
      lines: [],
      commission: 0,
      processingFee: 0,
      refund: 108,
      refundedTax: 8,
    });

  it("excludes returned tax that was never counted as revenue", () => {
    const result = passThrough();
    expect(result.refund).toBe(108);
    expect(result.revenueRefund).toBe(100);
    // The visible lines must add up: grossRevenue − revenueRefund − expenses.
    expect(result.grossRevenue - result.revenueRefund - result.totalExpenses).toBeCloseTo(result.profit, 2);
    // And the whole refund does NOT.
    expect(result.grossRevenue - result.refund - result.totalExpenses).not.toBeCloseTo(result.profit, 2);
  });

  it("equals the whole refund when tax counts as profit", () => {
    const result = computeOrderProfit({
      netMerchandiseRevenue: 100,
      shippingRevenue: 0,
      shippingCost: 0,
      taxCollected: 8,
      countTaxAsProfit: true,
      lines: [],
      commission: 0,
      processingFee: 0,
      refund: 108,
      refundedTax: 8,
    });
    expect(result.revenueRefund).toBe(108);
    expect(result.profit).toBe(0);
  });

  it("is what the admin panel renders, labelled when it differs from the refund", () => {
    const panel = read("components/admin-order-profit-panel.tsx");
    expect(panel).toContain("const revenueRefund = profit.revenueRefund ?? profit.refund;");
    expect(panel).toContain('revenueRefund < profit.refund ? "Refunds (excl. tax returned)" : "Refunds"');
    expect(panel).not.toMatch(/ExpenseRow label="Refunds" amount=\{profit\.refund\}/);
  });
});

// ---------------------------------------------------------------------------
// SQL-13 — the harness creates these columns as their migrations declare them.
// ---------------------------------------------------------------------------

describe("SQL-13 — parity columns keep the NOT NULL the dump could not record", () => {
  const columns = read("lib/sql/harness-prod-parity-columns.sql");

  const CASES: Array<[string, string]> = [
    ["coupons", "member_scope"],
    ["orders", "shippo_sync_attempts"],
    ["product_doses", "incoming_quantity"],
    ["products", "incoming_quantity"],
    ["products", "requires_reconstitution"],
    ["shippo_webhook_events", "retry_count"],
  ];

  for (const [table, column] of CASES) {
    it(`${table}.${column} is not null`, () => {
      const line = columns
        .split("\n")
        .find((l) => l.startsWith(`alter table public.${table} add column if not exists ${column} `));
      expect(line, `no declaration for ${table}.${column}`).toBeTruthy();
      expect(line).toMatch(/\bnot null\b/);
      // Safe only because each carries a DEFAULT — Postgres fills existing rows.
      expect(line).toMatch(/\bdefault\b/);
    });
  }
});
