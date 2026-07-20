export type AdminRole = "staff" | "manager" | "super_admin";

const ADMIN_ROLES: AdminRole[] = ["staff", "manager", "super_admin"];

export function normalizeAdminRole(value: unknown): AdminRole {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (ADMIN_ROLES as string[]).includes(candidate) ? (candidate as AdminRole) : "staff";
}

export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  staff: "Staff",
  manager: "Manager",
  super_admin: "Super Admin",
};

// Sensitive, harder-to-reverse actions (refunds move real money once a
// payment processor is connected; coupons/inventory affect storefront
// pricing and stock for every shopper) are gated to manager and above.
// Team/role management is gated to super_admin only, since it can grant any
// of the permissions below.
export function canManageRefunds(role: AdminRole) {
  return role === "manager" || role === "super_admin";
}

export function canManageCoupons(role: AdminRole) {
  return role === "manager" || role === "super_admin";
}

export function canManageInventory(role: AdminRole) {
  return role === "manager" || role === "super_admin";
}

export function canViewAuditLog(role: AdminRole) {
  return role === "manager" || role === "super_admin";
}

export function canManageTeam(role: AdminRole) {
  return role === "super_admin";
}

export function canManageMembership(role: AdminRole) {
  return role === "manager" || role === "super_admin";
}

export function canManageCartRecovery(role: AdminRole) {
  return role === "manager" || role === "super_admin";
}
