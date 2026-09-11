import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE SIGN-IN PAGE MUST HYDRATE CLEANLY WHEN THE URL CARRIES A FRAGMENT.
//
// A confirmation or recovery link comes back as /account/login#access_token=…
// or #error_code=otp_expired. The form classified that fragment inside
// useState initialisers, guarded by `typeof window`, so the server rendered
// the age-gate portal and the client's first render produced the sign-in form
// with a message. React 19 reports that as a hydration mismatch (#418), throws
// the server HTML away and re-renders from scratch — which is the visible
// portal-then-form flash the initialisers were written to avoid, plus an
// error on every such page load. Production showed it on 2026-09-10 on the
// exact page the stalled signups are sent to, and Sentry filed the
// "document.currentScript" invariant from the same recovery path.
//
// The fix reads the fragment the way this file already reads the referral
// cookie: through useSyncExternalStore with an empty server snapshot, so the
// hydration render matches the server and the fragment-driven state follows
// in the next render. These assertions keep it that way.
// ---------------------------------------------------------------------------

const source = readFileSync(join(process.cwd(), "src/components/account-auth-form.tsx"), "utf8")
  .replace(/^\s*\/\/.*$/gm, "");

describe("account-auth-form hydrates the same on the server and the client", () => {
  it("reads the URL fragment through useSyncExternalStore with a server snapshot", () => {
    expect(source).toMatch(/useSyncExternalStore\(\s*subscribeNever,\s*readLocationHash,\s*getServerLocationHash,?\s*\)/);
  });

  it("no longer classifies the fragment inside a useState initialiser", () => {
    expect(source).not.toContain("useState<OAuthCallbackReturn>(() =>");
    expect(source).not.toContain("Boolean(window.location.hash)");
  });

  it("no longer branches initial state on typeof window", () => {
    // Every remaining `typeof window` guard would be a render that differs
    // between server and client. The one legitimate use — building an absolute
    // URL for an email redirect — is not a render branch.
    const initialisers = source.match(/useState[^;]*?\(\(\) =>[\s\S]*?\}\)/g) ?? [];
    for (const initialiser of initialisers) {
      expect(initialiser).not.toContain("typeof window");
    }
  });
});
