export type PortalRole = "admin" | "partner" | "customer" | "unknown";

export function detectRoleFromUser(user: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> }): PortalRole {
  const appRole = (typeof user.app_metadata?.role === "string" ? user.app_metadata.role : "").toLowerCase();
  const userRole = (typeof user.user_metadata?.role === "string" ? user.user_metadata.role : "").toLowerCase();

  // SECURITY: `app_metadata` is service-role-only; `user_metadata` is writable
  // by the account holder via supabase.auth.updateUser({ data: { role } }). So
  // the elevated "admin" role is honored ONLY from app_metadata — a customer
  // can never mint themselves an admin routing role by editing their own
  // metadata. (Admin surfaces are additionally gated by the separate
  // admin_sessions token, so this is defense in depth, not the only guard.)
  if (appRole === "admin") {
    return "admin";
  }

  // "partner"/"ambassador" is a NON-privileged routing hint: it grants no data
  // access on its own — every partner/ambassador surface re-checks the
  // ambassadors table (status = 'approved') server-side. Legit partners are
  // provisioned via inviteUserByEmail, which writes the role into
  // user_metadata, so both metadata sources are accepted here. The worst a
  // customer can do by self-setting this is lock themselves out of the
  // customer dashboard (all account routes require role === "customer").
  if (appRole === "partner" || appRole === "ambassador" || userRole === "partner" || userRole === "ambassador") {
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
