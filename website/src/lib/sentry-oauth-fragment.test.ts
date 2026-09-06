import { describe, expect, it } from "vitest";
import { scrubUrl, scrubEvent, scrubBreadcrumb } from "@/lib/sentry-privacy";

// §53 — DOES A SESSION TOKEN REACH TELEMETRY?
//
// The OAuth callback lands with BOTH tokens in the URL fragment. Fragments never
// reach a server, but the browser SDK reports window.location.href, and a
// breadcrumb records every navigation — so the question is whether the scrubber
// is what stands between an access token and an error report. Answered by
// running the repo's own scrubber against the exact URL the provider produces.
const ACCESS = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhYmMiLCJleHAiOjk5OTk5OTk5OTl9.s1gn4tur3";
const REFRESH = "v1-refresh-Z9x8c7v6b5n4m3";
const CALLBACK = `https://www.vantalabsresearch.com/account/auth/callback?next=%2Faccount#access_token=${ACCESS}&refresh_token=${REFRESH}&token_type=bearer&expires_in=3600`;

describe("the OAuth callback URL never carries tokens into telemetry", () => {
  it("scrubs the access token out of the URL", () => {
    const scrubbed = scrubUrl(CALLBACK);
    expect(scrubbed).not.toContain(ACCESS);
    expect(scrubbed).not.toContain(ACCESS.split(".")[1]);
  });

  it("scrubs the refresh token too", () => {
    expect(scrubUrl(CALLBACK)).not.toContain(REFRESH);
  });

  it("keeps enough of the URL to be useful", () => {
    // A scrubber that returned "" would pass the two tests above and make every
    // report useless. The path has to survive.
    expect(scrubUrl(CALLBACK)).toContain("/account/auth/callback");
  });

  it("scrubs it inside a whole event, not just when handed the bare string", () => {
    const event = scrubEvent({
      request: { url: CALLBACK },
      message: `failed at ${CALLBACK}`,
    } as never) as { request?: { url?: string }; message?: string };
    expect(JSON.stringify(event)).not.toContain(ACCESS);
    expect(JSON.stringify(event)).not.toContain(REFRESH);
  });

  it("scrubs it inside a navigation breadcrumb", () => {
    const crumb = scrubBreadcrumb({
      category: "navigation",
      data: { from: "/account/login", to: CALLBACK },
    } as never);
    expect(JSON.stringify(crumb)).not.toContain(ACCESS);
    expect(JSON.stringify(crumb)).not.toContain(REFRESH);
  });

  it("scrubs the session cookie's own envelope shape", () => {
    // What the cookie holds, in case it is ever read into a report.
    const envelope = "v2.eyJhIjoiZXlKaGJHY2lPaUpJVXpJMU5pSjkuYWJjLmRlZiIsInIiOiJyZWZyZXNoIiwibSI6MX0";
    const event = scrubEvent({ message: `cookie=${envelope}` } as never) as { message?: string };
    expect(String(event.message)).not.toContain(envelope);
  });
});
