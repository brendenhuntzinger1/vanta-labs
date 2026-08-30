import { describe, expect, it } from "vitest";

import { detectRoleFromUser, hasPartnerRoleHint } from "@/lib/auth-role";

// ---------------------------------------------------------------------------
// AN AMBASSADOR IS A CUSTOMER, AND THE PRODUCT HAS TO AGREE.
//
// inviteUserByEmail writes `role: "partner"` into user_metadata. Every account
// surface gates on `detectRoleFromUser(user) !== "customer"`, so that one string
// used to exclude the account from /account and all of its children,
// /api/account/*, checkout as a signed-in customer, membership, and the
// signup/referral point awards — including their OWN ambassador dashboard,
// which lives inside the layout that rejected them.
//
// That made a closed loop: /partner/dashboard redirects to /account/ambassador,
// the layout bounces to /account/login, and /account/login only forwards a
// signed-in visitor onward when the role is "customer". An invited ambassador
// signed in and landed back on the sign-in form, forever.
//
// These tests pin the resolution, and pin that fixing it did not widen "admin".
// ---------------------------------------------------------------------------

const asUser = (meta: Record<string, unknown>, app: Record<string, unknown> = {}) =>
  ({ user_metadata: meta, app_metadata: app });

describe("detectRoleFromUser", () => {
  it("resolves an invited ambassador to customer, so their portal is reachable", () => {
    // The exact metadata createPartnerInvite writes.
    expect(detectRoleFromUser(asUser({ role: "partner", invited_by: null }))).toBe("customer");
  });

  it("resolves the ambassador spelling too", () => {
    expect(detectRoleFromUser(asUser({ role: "ambassador" }))).toBe("customer");
  });

  it("resolves a plain signup to customer", () => {
    expect(detectRoleFromUser(asUser({ role: "customer" }))).toBe("customer");
  });

  it("resolves a role-less account to customer", () => {
    // Legacy, admin-created and phone-OTP accounts carry no role string and
    // must still reach their account rather than an infinite sign-in loop.
    expect(detectRoleFromUser(asUser({}))).toBe("customer");
  });

  it("still honours admin, and ONLY from app_metadata", () => {
    // The security-relevant branch, untouched. user_metadata is writable by the
    // account holder, so an admin role claimed there must not be honoured.
    expect(detectRoleFromUser(asUser({}, { role: "admin" }))).toBe("admin");
    expect(detectRoleFromUser(asUser({ role: "admin" }))).toBe("customer");
  });

  it("grants nothing new to someone who self-sets partner", () => {
    // Before this change the string only ever excluded; a customer who writes
    // it into their own metadata is exactly as privileged as any customer.
    expect(detectRoleFromUser(asUser({ role: "partner" })))
      .toBe(detectRoleFromUser(asUser({ role: "customer" })));
  });
});

describe("hasPartnerRoleHint", () => {
  it("still reports the hint for navigation cosmetics", () => {
    expect(hasPartnerRoleHint(asUser({ role: "partner" }))).toBe(true);
    expect(hasPartnerRoleHint(asUser({ role: "ambassador" }))).toBe(true);
    expect(hasPartnerRoleHint(asUser({ role: "customer" }))).toBe(false);
  });

  it("is never the thing that authorises an ambassador surface", () => {
    // The real check is the ambassadors table, status = 'approved', read
    // server-side. Pinned as a statement of intent.
    expect(hasPartnerRoleHint(asUser({ role: "partner" }))).toBe(true);
    expect(detectRoleFromUser(asUser({ role: "partner" }))).toBe("customer");
  });
});
