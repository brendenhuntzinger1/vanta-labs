import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A COA UPLOADED THROUGH THE LIBRARY LIGHTS UP THE CATALOGUE CARD.
//
// The cards read only the legacy products.coa_url / product_doses.coa_url
// columns. The COA library — where new certificates are uploaded — writes
// coa_records and never those columns, so an uploaded COA left the card
// without its "COA verified" pill and "View COA" link. The catalogue now
// batches the newest published record per product and the card falls back to
// it when the legacy link is absent.
// ---------------------------------------------------------------------------

let coaRows: Array<Record<string, unknown>> = [];
let coaError: Error | null = null;

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => {
  const builder = () => {
    const b: Record<string, unknown> = {};
    for (const op of ["select", "in", "eq"]) b[op] = () => b;
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: coaError ? null : coaRows, error: coaError }).then(resolve);
    return b;
  };
  return { supabaseAdmin: { from: () => builder(), storage: { from: () => ({}) } } };
});

import { getPublishedCoaHrefsByProduct } from "@/lib/coa";

const record = (id: string, productId: string, extra: Record<string, unknown> = {}) => ({
  id,
  product_id: productId,
  product_dose_id: null,
  batch_number: `LOT-${id}`,
  test_date: "2026-09-01",
  lab_name: "Lab",
  purity_result: "99.1%",
  status: "published",
  file_path: `coa/${id}.pdf`,
  file_kind: "pdf",
  external_url: null,
  strength_label: "10mg",
  published_at: "2026-09-02T00:00:00Z",
  created_at: "2026-09-02T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
  ...extra,
});

beforeEach(() => {
  coaRows = [];
  coaError = null;
});

describe("getPublishedCoaHrefsByProduct", () => {
  it("returns the public file route of a published record per product", async () => {
    coaRows = [record("r1", "p1")];
    const hrefs = await getPublishedCoaHrefsByProduct(["p1", "p2"]);
    expect(hrefs.get("p1")).toBe("/api/coa/r1/file");
    expect(hrefs.has("p2")).toBe(false);
  });

  it("skips a record with no file behind it", async () => {
    coaRows = [record("r-nofile", "p1", { file_path: null, external_url: null })];
    const hrefs = await getPublishedCoaHrefsByProduct(["p1"]);
    expect(hrefs.size).toBe(0);
  });

  it("asks for nothing when there are no products, and survives a read failure", async () => {
    expect((await getPublishedCoaHrefsByProduct([])).size).toBe(0);
    coaError = new Error("relation coa_records does not exist");
    expect((await getPublishedCoaHrefsByProduct(["p1"])).size).toBe(0);
  });
});

describe("the card and the catalogue claim use the record when the legacy link is absent", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("product-card.tsx renders the pill and the link from coaHref", () => {
    const card = read("src/components/product-card.tsx");
    expect(card).toContain("const coaHref = hasCoa(product.coaUrl) ? product.coaUrl : product.coaRecordUrl;");
    expect(card).toContain("{coaHref ? (");
    expect(card).toContain("href={coaHref}");
    expect(card).not.toContain("{product.coaUrl ? (");
  });

  it("the catalogue-wide COA claim counts a library record as coverage", () => {
    const client = read("src/app/products/products-client.tsx");
    expect(client).toContain("(hasCoa(product.coaUrl) || Boolean(product.coaRecordUrl))");
    expect(client).not.toMatch(/every\(\(product\) => hasCoa\(product\.coaUrl\)\)/);
  });

  it("catalog.ts threads the record href into every mapped product", () => {
    const catalog = read("src/lib/catalog.ts");
    expect(catalog).toContain("getPublishedCoaHrefsByProduct(productIds)");
    expect(catalog).toContain("coaRecordUrl: coaRecordUrl || undefined,");
    expect((catalog.match(/coaRecordUrlByProductId\.get\(productId\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
