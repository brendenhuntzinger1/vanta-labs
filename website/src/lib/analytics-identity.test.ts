import { describe, expect, it } from "vitest";
import { resolveAnalyticsUserId } from "./analytics-identity";

// ---------------------------------------------------------------------------
// NEVER TRUST CLIENT-SUPPLIED IDENTITY. This function only ever sees a
// server-verified GoTrue user object (resolved from the session cookie by
// the caller) — nothing here reads anything the request body claims. The
// role check is what keeps an admin/staff account from being "named" as a
// storefront visitor when they browse it signed in.
// ---------------------------------------------------------------------------

describe("resolveAnalyticsUserId", () => {
  it("returns the id for a customer", () => {
    expect(resolveAnalyticsUserId({ id: "cust-1" }, "customer")).toBe("cust-1");
  });

  it("returns the id for a partner/ambassador (a partner is a customer for this purpose)", () => {
    expect(resolveAnalyticsUserId({ id: "amb-1" }, "partner")).toBe("amb-1");
  });

  it("returns null for admin/staff — never named as a storefront visitor", () => {
    expect(resolveAnalyticsUserId({ id: "admin-1" }, "admin")).toBeNull();
  });

  it("returns null for an unrecognized role", () => {
    expect(resolveAnalyticsUserId({ id: "x" }, "unknown")).toBeNull();
  });

  it("returns null when there is no signed-in user at all", () => {
    expect(resolveAnalyticsUserId(null, "unknown")).toBeNull();
  });
});
