import { describe, expect, it } from "vitest";
import { detectRoleFromUser } from "@/lib/auth-role";

describe("detectRoleFromUser", () => {
  it("returns admin when app metadata role is admin", () => {
    expect(detectRoleFromUser({ app_metadata: { role: "admin" }, user_metadata: {} })).toBe("admin");
  });

  // These two used to expect "partner", and that expectation was pinning a bug
  // rather than a behaviour. Nothing in the app ever GRANTED access on
  // "partner"; ~30 gates only ever excluded on it — including the layout
  // wrapping the ambassador dashboard itself. So an invited ambassador was
  // locked out of their own portal, with /account/login declining to forward
  // them onward: a closed loop with no exit. See auth-role.ts and
  // ambassador-portal-access.test.ts for the full account.
  it("resolves an invited ambassador to customer, so their portal is reachable", () => {
    expect(detectRoleFromUser({ app_metadata: {}, user_metadata: { role: "partner" } })).toBe("customer");
  });

  it("resolves an app_metadata partner to customer for the same reason", () => {
    expect(detectRoleFromUser({ app_metadata: { role: "partner" }, user_metadata: {} })).toBe("customer");
  });

  it("SECURITY: ignores a self-set user_metadata admin role", () => {
    // A customer can write user_metadata but never app_metadata. A self-set
    // admin role must NOT elevate them — they stay a customer for routing.
    expect(detectRoleFromUser({ app_metadata: {}, user_metadata: { role: "admin" } })).toBe("customer");
  });

  it("app_metadata admin still wins even if user_metadata says customer", () => {
    expect(detectRoleFromUser({ app_metadata: { role: "admin" }, user_metadata: { role: "customer" } })).toBe("admin");
  });

  it("returns customer when role is missing", () => {
    expect(detectRoleFromUser({ app_metadata: {}, user_metadata: {} })).toBe("customer");
  });
});
