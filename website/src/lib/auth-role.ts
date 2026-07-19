export type PortalRole = "admin" | "partner" | "unknown";

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

  return "unknown";
}
