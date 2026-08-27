import { beforeEach, describe, expect, it, vi } from "vitest";

import { harness, seedStore } from "@/lib/e2e/journey.harness";

// ---------------------------------------------------------------------------
// THE OWNER'S PRE-LAUNCH READ-OUT.
//
// /admin/status already answered "is each integration wired up?". These checks
// answer the other half — "is the DATA the store will trade on correct?" —
// which is where the expensive day-one mistakes live: a published product with
// no price, stock nobody is counting, a missing return address.
//
// Two rules this file exists to hold:
//   * NO SECRET VALUE is ever printed. Credentials report CONFIGURED / MISSING.
//   * NO ADDRESS is ever printed. The private ship-from origin reports
//     CONFIGURED / INCOMPLETE and names missing FIELDS, never their contents.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return harness.db.client; },
  createServerClient: () => harness.db.client,
}));
vi.unmock("@/lib/admin-control");

const ORIGIN_SENTINEL = "1 Synthetic Origin Way";
const RETURN_SENTINEL = "2 Synthetic Return Road";
const SECRET_SENTINEL = "super-secret-value-nobody-should-see";

async function status() {
  const { getSystemStatus } = await import("@/lib/system-status");
  return getSystemStatus();
}

function check(rows: Awaited<ReturnType<typeof status>>, key: string) {
  const found = rows.find((row) => row.key === key);
  expect(found, `expected a "${key}" check`).toBeDefined();
  return found!;
}

beforeEach(() => {
  harness.reset();
  seedStore(harness.db, [
    { slug: "priced", name: "Priced Peptide", priceCents: 4499, inventory: 10, unitCostCents: 1200, weightOz: 0.4 },
  ]);
  // Published, so the data checks have something to look at.
  for (const row of harness.db.table("products")) row.is_published = true;

  process.env.SHIPPO_WEBHOOK_SECRET = SECRET_SENTINEL;
  process.env.MARKETING_POSTAL_ADDRESS = "PO Box 000, Testville";
});

describe("published product data", () => {
  it("passes when every published product is priced", async () => {
    const rows = await status();
    expect(check(rows, "product_prices").level).toBe("ok");
  });

  it("FAILS, and blocks launch, when a published product has no price", async () => {
    harness.db.seed("products", [{
      id: "p-bad", slug: "unpriced", name: "Unpriced Peptide", price_cents: 0,
      product_cost_cents: 0, track_inventory: true, inventory_quantity: 5,
      is_published: true, is_enabled: true, is_archived: false,
    }]);

    const row = check(await status(), "product_prices");
    expect(row.level).toBe("error");
    expect(row.blocksLaunch).toBe(true);
    // Names it, so the owner can go and fix that one.
    expect(row.detail).toContain("Unpriced Peptide");
  });

  it("warns about a published product nobody is counting stock for", async () => {
    harness.db.seed("products", [{
      id: "p-untracked", slug: "untracked", name: "Untracked Peptide", price_cents: 4499,
      product_cost_cents: 1200, track_inventory: false, inventory_quantity: null,
      is_published: true, is_enabled: true, is_archived: false,
    }]);

    const row = check(await status(), "product_inventory_data");
    expect(row.level).toBe("warn");
    expect(row.detail).toContain("Untracked Peptide");
  });

  it("does NOT warn about a product whose stock lives on its DOSES", async () => {
    // Anything sold by dose carries stock on the dose rows, so the parent
    // legitimately has none of its own. Reading only the parent reported
    // eighteen correctly-protected products as able to oversell.
    harness.db.seed("products", [{
      id: "p-dosed", slug: "dosed", name: "Dosed Peptide", price_cents: 4499,
      product_cost_cents: 1200, track_inventory: false, inventory_quantity: null,
      is_published: true, is_enabled: true, is_archived: false,
    }]);
    // is_enabled mirrors the column's NOT NULL DEFAULT TRUE: the status screen
    // reads the doses a customer can actually buy, exactly as the storefront
    // does, so a dose row must say whether it is one of them.
    harness.db.seed("product_doses", [
      { id: "d-1", product_id: "p-dosed", label: "5mg", is_enabled: true, track_inventory: true, inventory_quantity: 12 },
      { id: "d-2", product_id: "p-dosed", label: "10mg", is_enabled: true, track_inventory: true, inventory_quantity: 4 },
    ]);

    const row = check(await status(), "product_inventory_data");
    expect(row.level).toBe("ok");
    expect(row.detail).not.toContain("Dosed Peptide");
  });

  it("does NOT warn about a row carrying real stock with the flag off", async () => {
    // reserve_inventory() enforces on `track_inventory = true OR
    // inventory_quantity > 0`, so positive stock is protected either way.
    harness.db.seed("products", [{
      id: "p-flagless", slug: "flagless", name: "Flagless Peptide", price_cents: 4499,
      product_cost_cents: 1200, track_inventory: false, inventory_quantity: 25,
      is_published: true, is_enabled: true, is_archived: false,
    }]);

    const row = check(await status(), "product_inventory_data");
    expect(row.level).toBe("ok");
  });

  it("DOES warn when every dose of a product is unprotected", async () => {
    harness.db.seed("products", [{
      id: "p-loose", slug: "loose", name: "Loose Peptide", price_cents: 4499,
      product_cost_cents: 1200, track_inventory: false, inventory_quantity: null,
      is_published: true, is_enabled: true, is_archived: false,
    }]);
    harness.db.seed("product_doses", [
      { id: "d-3", product_id: "p-loose", label: "5mg", is_enabled: true, track_inventory: false, inventory_quantity: 0 },
    ]);

    const row = check(await status(), "product_inventory_data");
    expect(row.level).toBe("warn");
    expect(row.detail).toContain("Loose Peptide");
  });

  it("warns about a published product with no unit cost, so profit is a guess", async () => {
    harness.db.seed("products", [{
      id: "p-nocost", slug: "nocost", name: "Costless Peptide", price_cents: 4499,
      product_cost_cents: 0, track_inventory: true, inventory_quantity: 5,
      is_published: true, is_enabled: true, is_archived: false,
    }]);

    const row = check(await status(), "product_cogs");
    expect(row.level).toBe("warn");
    expect(row.blocksLaunch).toBe(false);
    expect(row.detail).toContain("Costless Peptide");
  });

  it("ignores drafts and archived products", async () => {
    harness.db.seed("products", [
      { id: "p-draft", slug: "draft", name: "Draft", price_cents: 0, is_published: false, is_archived: false },
      { id: "p-arch", slug: "arch", name: "Archived", price_cents: 0, is_published: true, is_archived: true },
    ]);
    expect(check(await status(), "product_prices").level).toBe("ok");
  });
});

describe("shipping identity", () => {
  it("reports both addresses as CONFIGURED without printing either", async () => {
    const rows = await status();
    const origin = check(rows, "shipping_origin");
    const returnAddress = check(rows, "return_address");

    expect(origin.level).toBe("ok");
    expect(origin.detail).toBe("CONFIGURED");
    expect(returnAddress.level).toBe("ok");

    // THE RULE: this screen never echoes an address.
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(ORIGIN_SENTINEL);
    expect(everything).not.toContain(RETURN_SENTINEL);
  });

  it("blocks launch when the customer-facing return address is missing", async () => {
    harness.db.tables.set(
      "admin_audit_logs",
      harness.db.table("admin_audit_logs").filter((row) => row.target_table !== "shipping_return_address"),
    );

    const row = check(await status(), "return_address");
    expect(row.level).toBe("error");
    expect(row.blocksLaunch).toBe(true);
  });

  it("names the MISSING FIELDS of an incomplete origin, never their values", async () => {
    harness.db.tables.set(
      "admin_audit_logs",
      harness.db.table("admin_audit_logs").filter((row) => row.target_id !== "zip"),
    );

    const row = check(await status(), "shipping_origin");
    expect(row.level).toBe("error");
    expect(row.detail).toContain("zip");
    expect(row.detail).not.toContain(ORIGIN_SENTINEL);
  });
});

describe("credentials", () => {
  it("reports the Shippo webhook secret as CONFIGURED and never prints it", async () => {
    const rows = await status();
    const row = check(rows, "shippo_webhook");

    expect(row.level).toBe("ok");
    expect(row.detail).toContain("CONFIGURED");
    expect(JSON.stringify(rows)).not.toContain(SECRET_SENTINEL);
  });

  it("blocks launch when the Shippo webhook secret is missing", async () => {
    delete process.env.SHIPPO_WEBHOOK_SECRET;
    const row = check(await status(), "shippo_webhook");
    expect(row.level).toBe("error");
    expect(row.blocksLaunch).toBe(true);
    expect(row.detail).toContain("MISSING");
  });

  it("reports the marketing postal address as CONFIGURED / MISSING", async () => {
    expect(check(await status(), "marketing_postal").detail).toContain("CONFIGURED");
    delete process.env.MARKETING_POSTAL_ADDRESS;
    expect(check(await status(), "marketing_postal").detail).toContain("MISSING");
  });
});

describe("ambassador rates", () => {
  it("shows all three rates in force, and says which are stored", async () => {
    harness.db.seed("admin_audit_logs", [{
      id: "amb-1", action: "admin_control_upsert", target_table: "referral",
      target_id: "personal_discount_percent", metadata: { value: 20 },
      created_at: new Date().toISOString(),
    }]);

    const row = check(await status(), "ambassador_rates");
    expect(row.detail).toContain("Personal discount 20% (saved)");
    // The other two fall back to the code defaults, and say so.
    expect(row.detail).toContain("customer referral discount 10% (default)");
    expect(row.detail).toContain("base commission 10% (default)");
  });

  it("shows the code default as 20% when nothing is stored, and labels it", async () => {
    const row = check(await status(), "ambassador_rates");
    expect(row.detail).toContain("Personal discount 20% (default)");
  });

  it("surfaces a stored override that differs from the default", async () => {
    // The case the owner most needs to see: the number in force is NOT the one
    // the code ships with, because someone saved a different value.
    harness.db.seed("admin_audit_logs", [{
      id: "amb-override", action: "admin_control_upsert", target_table: "referral",
      target_id: "personal_discount_percent", metadata: { value: 15 },
      created_at: new Date().toISOString(),
    }]);

    const row = check(await status(), "ambassador_rates");
    expect(row.detail).toContain("Personal discount 15% (saved)");
  });
});

describe("settings resolver", () => {
  it("reports the view as active once the migration is applied", async () => {
    harness.db.seed("admin_audit_logs", [{
      id: "any", action: "admin_control_upsert", target_table: "referral",
      target_id: "discount_percent", metadata: { value: 10 },
      created_at: new Date().toISOString(),
    }]);
    expect(check(await status(), "control_settings_view").level).toBe("ok");
  });

  it("tells the owner to apply the migration when the view is absent", async () => {
    harness.db.controlViewMissing = true;
    const row = check(await status(), "control_settings_view");
    expect(row.level).toBe("warn");
    expect(row.detail).toContain("admin-control-current-view.sql");
  });
});
