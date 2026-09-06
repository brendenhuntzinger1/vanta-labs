import { describe, expect, it } from "vitest";

import { isVerifiedForDocument } from "@/components/age-gate";

// ---------------------------------------------------------------------------
// THE GATE MUST NOT STAND ON THE PASSWORD-RECOVERY SURFACES.
//
// Found in production, 2026-09-06, on the affiliate applicant
// ava.mci.media@gmail.com — and on every other account that has ever needed a
// reset. The auth log tells the whole story in ninety seconds:
//
//   01:29:49  recovery requested
//   01:29:59  GET /verify -> 303, login (implicit). Session established, and
//             /account/reset-password served 200.
//   01:30:53  POST /token (password) -> 400 invalid_credentials
//   01:31:02  GET /verify (same link) -> 403 One-time token not found
//   01:33:30  signup attempt -> 422 email_exists
//
// She reached the reset page holding a live recovery session and did not set a
// password — `auth.users.updated_at` never advanced past the login, across four
// separate links over eight days. Then she tried her old password, re-clicked
// the spent link, and finally tried to register a second account.
//
// The reason is not in the reset form, which is correct: it renders "Choose a
// new password" for exactly this arrival. It is that <AgeGate /> renders from
// the root layout as `fixed inset-0 z-[100]` and this path is not exempt, so
// the overlay lands on top of the form. Reproduced in the browser against a
// real GoTrue session: `document.elementFromPoint()` at the centre of the
// "Update password" button returns the age gate, not the button. The form is
// in the DOM and cannot be reached.
//
// It is worst precisely for the people it catches. Confirmation is scoped to
// one visit in sessionStorage (deliberately — see age-gate.tsx), and a link
// clicked from a mail client opens a FRESH TAB. So an emailed recovery link is
// the first document of a new visit essentially every time, which means this
// is not an edge case: it is the default experience of resetting a password.
//
// Neither page shows a compound, a price or a batch result — the things the
// gate exists to stand in front of. /account/login is already exempt for a
// neighbouring reason, and these two were simply missed.
//
// Pinned against the exported rule rather than the component's source text,
// because the defect was never in any markup: it was in which paths the rule
// treats as exempt. A source-text assertion would have passed throughout.
// ---------------------------------------------------------------------------

/** A link opened from a mail client: new tab, nothing confirmed yet. */
const freshDocumentFromEmail = { confirmedInMemory: false, sessionConfirmed: false };

describe("the age gate never blocks a password-recovery link", () => {
  it("lets an emailed recovery link reach the password form", () => {
    expect(
      isVerifiedForDocument({ ...freshDocumentFromEmail, pathname: "/account/reset-password" }),
    ).toBe(true);
  });

  it("lets a locked-out visitor reach the request-a-link form", () => {
    expect(
      isVerifiedForDocument({ ...freshDocumentFromEmail, pathname: "/account/forgot-password" }),
    ).toBe(true);
  });

  it("covers the admin-invite arrival, which lands on the same page", () => {
    // createPartnerInvite -> inviteUserByEmail creates the account with NO
    // password, and /account/reset-password is the only surface that can give
    // an invited ambassador one. Gating it makes the whole invite path a dead
    // end, which is the shape of the ZAIN incident recorded in
    // lib/auth-link-fragment.ts.
    expect(
      isVerifiedForDocument({ ...freshDocumentFromEmail, pathname: "/account/reset-password" }),
    ).toBe(true);
  });

  it("still gates the storefront for that same fresh document", () => {
    // The exemption is these paths and nothing wider. If this ever goes green
    // for the home page or the catalog, the gate has been defeated rather than
    // corrected.
    expect(isVerifiedForDocument({ ...freshDocumentFromEmail, pathname: "/" })).toBe(false);
    expect(isVerifiedForDocument({ ...freshDocumentFromEmail, pathname: "/products" })).toBe(false);
    expect(
      isVerifiedForDocument({ ...freshDocumentFromEmail, pathname: "/products/bac-water" }),
    ).toBe(false);
    expect(isVerifiedForDocument({ ...freshDocumentFromEmail, pathname: "/cart" })).toBe(false);
  });

  it("does not exempt a path that merely starts with the same letters", () => {
    // The rule matches on an exact path or a `/`-delimited prefix, so a
    // look-alike must not slip through.
    expect(
      isVerifiedForDocument({ ...freshDocumentFromEmail, pathname: "/account/reset-password-x" }),
    ).toBe(false);
  });
});
