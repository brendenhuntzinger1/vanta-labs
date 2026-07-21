import { describe, expect, it } from "vitest";
import { detectRoleFromUser } from "@/lib/auth-role";

describe("detectRoleFromUser", () => {
  it("returns admin when app metadata role is admin", () => {
    expect(detectRoleFromUser({ app_metadata: { role: "admin" }, user_metadata: {} })).toBe("admin");
  });

  it("returns partner when user metadata role is partner", () => {
    expect(detectRoleFromUser({ app_metadata: {}, user_metadata: { role: "partner" } })).toBe("partner");
  });

  it("returns unknown when role is missing", () => {
    expect(detectRoleFromUser({ app_metadata: {}, user_metadata: {} })).toBe("customer");
  });
});
