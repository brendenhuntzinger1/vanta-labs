import { describe, expect, it } from "vitest";
import {
  canManageCoupons,
  canManageInventory,
  canManageRefunds,
  canManageTeam,
  canViewAuditLog,
  normalizeAdminRole,
} from "@/lib/admin-roles";

describe("admin-roles", () => {
  it("normalizes unknown or missing roles to staff", () => {
    expect(normalizeAdminRole(undefined)).toBe("staff");
    expect(normalizeAdminRole("owner")).toBe("staff");
    expect(normalizeAdminRole("  Manager ")).toBe("manager");
  });

  it("gates manager-level actions to manager and super_admin only", () => {
    for (const check of [canManageRefunds, canManageCoupons, canManageInventory, canViewAuditLog]) {
      expect(check("staff")).toBe(false);
      expect(check("manager")).toBe(true);
      expect(check("super_admin")).toBe(true);
    }
  });

  it("gates team management to super_admin only", () => {
    expect(canManageTeam("staff")).toBe(false);
    expect(canManageTeam("manager")).toBe(false);
    expect(canManageTeam("super_admin")).toBe(true);
  });
});
