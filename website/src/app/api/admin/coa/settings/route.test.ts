import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE SETTINGS ROUTE PATCHES, IT DOES NOT REPLACE.
//
// Two switches share this endpoint. The hidden-product list is saved from one
// panel and the pending-products checkbox from another, and neither panel
// knows the other's current value — so a body that carries only one of them
// must leave the other exactly as it was. The first version of this route
// read a missing `showPendingProducts` as `true`, which would have flipped the
// pending switch back on every time the owner hid a product.
// ---------------------------------------------------------------------------

const writes = vi.hoisted(() => ({
  pending: [] as boolean[],
  hidden: [] as string[][],
}));

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromRequest: async () => ({ username: "owner", role: "super_admin" }),
}));

vi.mock("@/lib/admin-coa", () => ({
  // admin-coa-http.ts resolves this class to tell an operator's mistake from a
  // server fault, so the stub has to ship one.
  CoaValidationError: class CoaValidationError extends Error {},
  setCoaShowPendingProducts: async (input: { showPendingProducts: boolean }) => {
    writes.pending.push(input.showPendingProducts);
  },
  setCoaHiddenProductSlugs: async (input: { hiddenProductSlugs: string[] }) => {
    writes.hidden.push(input.hiddenProductSlugs);
  },
}));

vi.mock("@/lib/coa", () => ({
  getCoaLibrarySettings: async () => ({ showPendingProducts: true, hiddenProductSlugs: ["hcg"] }),
}));

const { PUT } = await import("@/app/api/admin/coa/settings/route");

const put = (body: unknown) =>
  PUT(
    new Request("http://localhost/api/admin/coa/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  writes.pending.length = 0;
  writes.hidden.length = 0;
});

describe("PUT /api/admin/coa/settings", () => {
  it("saves the hidden list without touching the pending switch", async () => {
    const response = await put({ hiddenProductSlugs: ["HCG", "hgh-gh-191", "hcg"] });
    expect(response.status).toBe(200);
    expect(writes.hidden).toEqual([["hcg", "hgh-gh-191"]]);
    expect(writes.pending).toEqual([]);
  });

  it("saves the pending switch without touching the hidden list", async () => {
    await put({ showPendingProducts: false });
    expect(writes.pending).toEqual([false]);
    expect(writes.hidden).toEqual([]);
  });

  it("accepts an empty hidden list as 'hide nothing'", async () => {
    await put({ hiddenProductSlugs: [] });
    expect(writes.hidden).toEqual([[]]);
  });

  it("rejects a hidden list that is not a list", async () => {
    const response = await put({ hiddenProductSlugs: "hcg" });
    expect(response.status).toBe(400);
    expect(writes.hidden).toEqual([]);
  });

  it("answers with the settings as they now stand", async () => {
    const response = await put({ hiddenProductSlugs: ["hcg"] });
    const json = (await response.json()) as { success: boolean; settings: { hiddenProductSlugs: string[] } };
    expect(json.success).toBe(true);
    expect(json.settings.hiddenProductSlugs).toEqual(["hcg"]);
  });
});
