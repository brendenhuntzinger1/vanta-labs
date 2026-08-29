import { describe, expect, it } from "vitest";

import {
  isActionablePasswordSetupLink,
  isPasswordSetupLink,
  passwordSetupLinkType,
} from "@/lib/auth-link-fragment";

// ---------------------------------------------------------------------------
// The predicate that decides whether someone may set a password without
// knowing the current one. It has to accept exactly two link types and no
// others: too narrow locks out invited ambassadors, too wide re-opens audit E2.
// ---------------------------------------------------------------------------

describe("passwordSetupLinkType", () => {
  it("accepts a recovery fragment", () => {
    expect(passwordSetupLinkType("#access_token=abc&refresh_token=def&type=recovery")).toBe("recovery");
  });

  it("accepts an invite fragment", () => {
    // The shape GoTrue redirects with after auth.admin.inviteUserByEmail. This
    // is the case that had nowhere to land: the invited user has NO password,
    // so refusing this fragment refuses them the portal entirely.
    expect(passwordSetupLinkType("#access_token=abc&refresh_token=def&type=invite")).toBe("invite");
  });

  it("rejects a signup-confirmation fragment", () => {
    // Carries an access_token exactly like the other two. Accepting it would
    // hand a no-current-password form to anyone who just confirmed an email.
    expect(passwordSetupLinkType("#access_token=abc&refresh_token=def&type=signup")).toBeNull();
  });

  it("rejects a magic-link fragment", () => {
    expect(passwordSetupLinkType("#access_token=abc&type=magiclink")).toBeNull();
  });

  it("rejects a bare access_token with no type at all", () => {
    expect(passwordSetupLinkType("#access_token=abc")).toBeNull();
  });

  it("rejects an empty fragment", () => {
    expect(passwordSetupLinkType("")).toBeNull();
    expect(passwordSetupLinkType("#")).toBeNull();
  });

  it("is not fooled by the type appearing inside another value", () => {
    // A substring test would pass all of these; the parsed check does not.
    expect(passwordSetupLinkType("#access_token=abc&type=magiclink&next=/recovery")).toBeNull();
    expect(passwordSetupLinkType("#type=not-recovery")).toBeNull();
    expect(passwordSetupLinkType("#access_token=abc&next=/invite")).toBeNull();
  });

  it("reads the fragment with or without its leading hash", () => {
    expect(passwordSetupLinkType("type=invite")).toBe("invite");
    expect(passwordSetupLinkType("#type=invite")).toBe("invite");
  });
});

describe("isPasswordSetupLink", () => {
  it("is true for both accepted types and false otherwise", () => {
    expect(isPasswordSetupLink("#type=recovery")).toBe(true);
    expect(isPasswordSetupLink("#type=invite")).toBe(true);
    expect(isPasswordSetupLink("#type=signup")).toBe(false);
  });
});

describe("isActionablePasswordSetupLink", () => {
  it("requires a token as well as the right type", () => {
    // A `type=` marker with no token is nothing to forward; following it would
    // land someone on a form that cannot do anything for them.
    expect(isActionablePasswordSetupLink("#type=recovery")).toBe(false);
    expect(isActionablePasswordSetupLink("#type=invite")).toBe(false);
  });

  it("accepts a recovery or invite fragment carrying a token", () => {
    expect(isActionablePasswordSetupLink("#access_token=abc&type=recovery")).toBe(true);
    expect(isActionablePasswordSetupLink("#access_token=abc&type=invite")).toBe(true);
  });

  it("still refuses a signup fragment that carries a token", () => {
    expect(isActionablePasswordSetupLink("#access_token=abc&type=signup")).toBe(false);
  });
});
