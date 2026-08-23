import { describe, expect, it } from "vitest";
import * as roles from "@/lib/admin-roles";
import { normalizeAdminRole, type AdminRole } from "@/lib/admin-roles";

// ---------------------------------------------------------------------------
// THE PERMISSION MATRIX, WRITTEN DOWN AND ENFORCED.
//
// Three roles exist: staff, manager, super_admin. Twelve capability gates
// decide what each may do. This file states the whole matrix explicitly, so
// widening a gate is a visible, deliberate edit to a table rather than a
// one-character change nothing notices.
//
// The rule the matrix encodes:
//
//   staff        day-to-day operations only
//   manager      + money, stock, catalog, settings, customer comms, profit
//   super_admin  + the team itself (it can grant every other permission)
//
// The final test is the one that matters most: it enumerates EVERY exported
// capability function and fails if a new one is added without being placed in
// this table. A new gate that nobody classified is a gate nobody has thought
// about.
// ---------------------------------------------------------------------------

const ALL_ROLES: AdminRole[] = ["staff", "manager", "super_admin"];

/** capability -> the exact set of roles allowed to use it. */
const MATRIX: Record<string, AdminRole[]> = {
  // Money and things that move money.
  canManageRefunds: ["manager", "super_admin"],
  canManageCoupons: ["manager", "super_admin"],
  canViewProfit: ["manager", "super_admin"],

  // Stock and catalogue: changes what every shopper sees and can buy.
  canManageInventory: ["manager", "super_admin"],
  canManageProducts: ["manager", "super_admin"],
  canManageCoa: ["manager", "super_admin"],

  // Business configuration and customer communication.
  canManageSettings: ["manager", "super_admin"],
  canManageMembership: ["manager", "super_admin"],
  canManageCartRecovery: ["manager", "super_admin"],
  canManageEmailCampaigns: ["manager", "super_admin"],
  canViewAuditLog: ["manager", "super_admin"],

  // The team itself. Restricted to super_admin BECAUSE it can grant every
  // permission above -- a manager who could edit roles would effectively hold
  // all of them.
  canManageTeam: ["super_admin"],
};

type CapabilityFn = (role: AdminRole) => boolean;

function capability(name: string): CapabilityFn {
  const fn = (roles as unknown as Record<string, unknown>)[name];
  if (typeof fn !== "function") throw new Error(`${name} is not exported from admin-roles`);
  return fn as CapabilityFn;
}

describe("the permission matrix", () => {
  for (const [name, allowed] of Object.entries(MATRIX)) {
    describe(name, () => {
      for (const role of ALL_ROLES) {
        const shouldAllow = allowed.includes(role);
        it(`${shouldAllow ? "allows" : "REFUSES"} ${role}`, () => {
          expect(capability(name)(role)).toBe(shouldAllow);
        });
      }
    });
  }
});

describe("staff is the least-privileged role", () => {
  it("holds none of the twelve gated capabilities", () => {
    // Stated as a single blunt property so nobody can quietly promote staff
    // by editing one gate.
    for (const name of Object.keys(MATRIX)) {
      expect(capability(name)("staff"), `${name} must refuse staff`).toBe(false);
    }
  });
});

describe("super_admin is a strict superset of manager", () => {
  it("can do everything a manager can, and at least one thing more", () => {
    for (const name of Object.keys(MATRIX)) {
      if (capability(name)("manager")) {
        expect(capability(name)("super_admin"), `${name} must allow super_admin`).toBe(true);
      }
    }
    // The "at least one thing more" half, so this cannot pass by the two roles
    // becoming identical.
    expect(capability("canManageTeam")("manager")).toBe(false);
    expect(capability("canManageTeam")("super_admin")).toBe(true);
  });
});

describe("an unrecognised role gets nothing", () => {
  // Deliberately excludes padded/odd-cased REAL roles -- those are trimmed and
  // lowercased into valid roles, which is asserted separately below.
  const bogus = ["owner", "admin", "root", "", "wizard", "null", "super admin"];

  for (const value of bogus) {
    it(`normalises ${JSON.stringify(value)} to staff`, () => {
      expect(normalizeAdminRole(value)).toBe("staff");
    });
  }

  it("normalises non-string values to staff", () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(normalizeAdminRole(value)).toBe("staff");
    }
  });

  it("means a typo in the database grants no capability at all", () => {
    const role = normalizeAdminRole("supper_admin");
    for (const name of Object.keys(MATRIX)) {
      expect(capability(name)(role), `${name} must refuse a typo'd role`).toBe(false);
    }
  });

  it("still accepts the three real roles, including odd casing and padding", () => {
    expect(normalizeAdminRole("SUPER_ADMIN")).toBe("super_admin");
    expect(normalizeAdminRole("  Manager  ")).toBe("manager");
    expect(normalizeAdminRole("staff")).toBe("staff");
  });
});

describe("the matrix covers every capability that exists", () => {
  it("has no unclassified capability function", () => {
    // THE POINT OF THIS FILE. A new gate added to admin-roles without a row
    // here is a permission nobody has decided the policy for, and it would
    // otherwise ship unnoticed.
    const exported = Object.keys(roles).filter(
      (key) =>
        typeof (roles as unknown as Record<string, unknown>)[key] === "function" &&
        (key.startsWith("canManage") || key.startsWith("canView")),
    );

    const missing = exported.filter((key) => !(key in MATRIX));
    expect(missing, `unclassified capabilities: ${missing.join(", ")}`).toEqual([]);
  });

  it("names no capability that no longer exists", () => {
    const stale = Object.keys(MATRIX).filter(
      (key) => typeof (roles as unknown as Record<string, unknown>)[key] !== "function",
    );
    expect(stale, `stale matrix rows: ${stale.join(", ")}`).toEqual([]);
  });
});
