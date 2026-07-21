export type PortalRole = "admin" | "partner" | "customer" | "unknown";

export function detectRoleFromUser(user: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> }): PortalRole {
  const appRole = typeof user.app_metadata?.role === "string" ? user.app_metadata.role : "";
  const userRole = typeof user.user_metadata?.role === "string" ? user.user_metadata.role : "";
  const role = (appRole || userRole).toLowerCase();

  if (role === "admin") {
    return "admin";
  }

  if (role === "partner" || role === "ambassador") {
    return "partner";
  }

  // Any authenticated user who is not an explicit admin or partner is treated
  // as a customer. This is deliberate: accounts created outside the signup
  // form (legacy, admin/SQL-created, phone-OTP logins) have no role string,
  // and must still reach their account instead of being bounced into an
  // infinite sign-in loop. The admin/partner portals gate on the explicit
  // "admin"/"partner" strings above, so this default never grants elevated
  // access.
  return "customer";
}
