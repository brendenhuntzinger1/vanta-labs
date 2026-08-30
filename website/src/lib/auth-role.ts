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

  // AN AMBASSADOR IS A CUSTOMER. This used to return "partner" here, and that
  // one line locked every invited ambassador out of the entire product.
  //
  // inviteUserByEmail (and now generateLink for invites) writes
  // `role: "partner"` into user_metadata. Every account surface gates on
  // `detectRoleFromUser(user) !== "customer"`, so that string excluded the
  // account from /account and all of its children, /api/account/*, checkout as
  // a signed-in customer, membership, and the signup/referral point awards in
  // /api/auth/session.
  //
  // Including — and this is the part that made it a closed loop — their OWN
  // ambassador dashboard, which lives at /account/(dashboard)/ambassador,
  // inside the layout that rejected them. /partner/dashboard redirects there,
  // and /account/login only forwards a signed-in visitor onward when the role
  // is "customer", so an invited ambassador signed in, bounced back to the
  // sign-in form, and had no exit. The old comment claimed "partners have their
  // own portals"; they do not. Theirs is a tab inside the customer one.
  //
  // Ambassador ZAIN was invited on 2026-08-23. The unbranded invite email is
  // why he never got a password — this is what would have happened next if he
  // had.
  //
  // Nothing ever GRANTED access on "partner": every consumer only excluded on
  // it, and every ambassador surface separately re-checks the ambassadors table
  // for status = 'approved' server-side, which is the real authorisation. So
  // resolving these accounts to "customer" removes a self-inflicted lockout and
  // grants nothing new — a customer who self-sets this string in their own
  // user_metadata is exactly as privileged as they were before.
  //
  // "admin" above is untouched and still honoured from app_metadata only.
  if (appRole === "partner" || appRole === "ambassador" || userRole === "partner" || userRole === "ambassador") {
    return "customer";
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

/**
 * Whether this account carries the ambassador routing HINT.
 *
 * Never an authorisation check — `user_metadata` is writable by the account
 * holder. Every ambassador surface re-reads the ambassadors table for
 * status = 'approved'. This exists only for navigation cosmetics.
 */
export function hasPartnerRoleHint(user: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> }): boolean {
  const appRole = (typeof user.app_metadata?.role === "string" ? user.app_metadata.role : "").toLowerCase();
  const userRole = (typeof user.user_metadata?.role === "string" ? user.user_metadata.role : "").toLowerCase();
  return appRole === "partner" || appRole === "ambassador" || userRole === "partner" || userRole === "ambassador";
}
