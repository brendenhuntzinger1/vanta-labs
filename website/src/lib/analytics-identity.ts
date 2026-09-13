import type { PortalRole } from "@/lib/auth-role";

/**
 * Which internal user id, if any, an analytics event should be attributed
 * to — from a SERVER-VERIFIED user, never from the request body.
 *
 * Callers resolve `user` via getAuthenticatedUser() (the same GoTrue-backed
 * session cookie /account already trusts) before this is ever called; this
 * function takes no request input, so there is nothing here for a client to
 * spoof. Only "customer" and "partner" (an ambassador is a customer —
 * auth-role.ts) are named on the live visitor dashboard. "admin" and
 * "unknown" resolve to null so admin/staff browsing the storefront signed
 * in is never mistaken for a storefront visitor.
 */
export function resolveAnalyticsUserId(user: { id: string } | null, role: PortalRole): string | null {
  if (!user) {
    return null;
  }
  if (role === "customer" || role === "partner") {
    return user.id;
  }
  return null;
}
