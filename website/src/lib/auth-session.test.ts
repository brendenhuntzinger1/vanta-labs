import { describe, expect, it } from "vitest";
import { detectRoleFromUser } from "@/lib/auth-role";

describe("detectRoleFromUser", () => {
  it("returns admin when app metadata role is admin", () => {
    expect(detectRoleFromUser({ app_metadata: { role: "admin" }, user_metadata: {} })).toBe("admin");
  });

  it("returns partner when user metadata role is partner (legit invite path)", () => {
    expect(detectRoleFromUser({ app_metadata: {}, user_metadata: { role: "partner" } })).toBe("partner");
  });

  it("returns partner when app metadata role is partner", () => {
    expect(detectRoleFromUser({ app_metadata: { role: "partner" }, user_metadata: {} })).toBe("partner");
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
