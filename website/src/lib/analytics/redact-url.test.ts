import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { redactUrlSecrets } from "@/lib/analytics/redact-url";

// ---------------------------------------------------------------------------
// A BEARER CREDENTIAL MUST NOT SURVIVE IN THE EVENT LOG.
//
// FOUND IN PRODUCTION, not supposed: three live `/spin?t=…` tokens stored
// verbatim in website_analytics_events.page_url, two of them against prizes
// that were unredeemed at the time of reading. The tracker sends
// window.location.href with every page view and the wheel is reached by a
// signed link, so this was every emailed winner, not an edge case.
// ---------------------------------------------------------------------------

const SPIN_LINK =
  "https://www.vantalabsresearch.com/spin?t=v1.YnV5ZXJAZXhhbXBsZS50ZXN0.d2lubmJhY2s.1792367457196.deadbeefdeadbeefdeadbeefdeadbeef";

describe("what is taken out", () => {
  it("the spin link's token", () => {
    const redacted = redactUrlSecrets(SPIN_LINK);
    expect(redacted).not.toContain("deadbeef");
    expect(redacted).not.toContain("YnV5ZXJAZXhhbXBsZS50ZXN0");
    expect(redacted).toContain("t=REDACTED");
  });

  it("a tracked email click's signature and recipient, keeping the campaign", () => {
    const redacted = redactUrlSecrets("https://vantalabsresearch.com/api/email/click?c=camp-1&e=buyer%40x.test&s=abc123&l=2");
    expect(redacted).toContain("c=camp-1");
    expect(redacted).toContain("l=2");
    expect(redacted).toContain("e=REDACTED");
    expect(redacted).toContain("s=REDACTED");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("buyer");
  });

  it("the same parameters on a relative path, which is not a parseable URL", () => {
    const redacted = redactUrlSecrets("/spin?t=v1.abc.def.123.feedface&utm_source=email");
    expect(redacted).toBe("/spin?t=REDACTED&utm_source=email");
  });

  it("a token however it is capitalised", () => {
    expect(redactUrlSecrets("https://x.test/spin?T=secret")).toContain("T=REDACTED");
  });
});

describe("what is left exactly as it was", () => {
  it("every utm parameter, which is the whole point of storing the URL", () => {
    const url = "https://vantalabsresearch.com/products?utm_source=omnisend&utm_medium=email&utm_campaign=winback&utm_content=hero";
    expect(redactUrlSecrets(url)).toBe(url);
  });

  it("a plain page view with no query at all", () => {
    expect(redactUrlSecrets("https://vantalabsresearch.com/products/glp-1")).toBe("https://vantalabsresearch.com/products/glp-1");
  });

  it("an empty or missing value, rather than throwing a page view away", () => {
    expect(redactUrlSecrets("")).toBe("");
    expect(redactUrlSecrets(null)).toBe("");
    expect(redactUrlSecrets(undefined)).toBe("");
  });

  it("something that is not a URL", () => {
    expect(redactUrlSecrets("not a url at all")).toBe("not a url at all");
  });
});

describe("the writer actually uses it", () => {
  // The redactor is worthless if the one place that stores these strings does
  // not call it, and a unit test of a pure function cannot see that. Asserted
  // on the route because the CLIENT cannot be trusted to redact: an older
  // cached bundle, a replayed request or a hand-made POST all reach the same
  // endpoint, and the server is the only place every one of them passes.
  const route = readFileSync(join(process.cwd(), "src", "app", "api", "analytics", "track", "route.ts"), "utf8");

  it("redacts the page URL before it is stored", () => {
    expect(route).toContain("redactUrlSecrets(body.pageUrl)");
  });

  it("redacts the referrer too, which is where a spin link lands next", () => {
    // The page a winner reaches FROM /spin?t=… carries that whole URL as its
    // referrer, so redacting only page_url would move the leak one row down.
    expect(route).toContain("redactUrlSecrets(body.referrer)");
  });
});

describe("a secret wrapped inside another parameter", () => {
  // THE ACCESS WALL IS THE COMMON WAY IN. A signed-out winner opening their
  // emailed link is sent to /account/login?next=<the whole spin URL, encoded>,
  // so the token arrives inside a parameter a name-based rule cannot see.
  it("the spin token nested in the access wall's next=", () => {
    const inner = encodeURIComponent("/spin?t=v1.abc.def.1792367457196.deadbeef&utm_source=email");
    const redacted = redactUrlSecrets(`https://vantalabsresearch.com/account/login?next=${inner}`);
    expect(redacted).not.toContain("deadbeef");
    expect(redacted).not.toContain(encodeURIComponent("deadbeef"));
  });

  it("keeps WHERE they were going, which is the useful half", () => {
    const inner = encodeURIComponent("/spin?t=v1.abc.def.1792367457196.deadbeef");
    const redacted = redactUrlSecrets(`https://vantalabsresearch.com/account/login?next=${inner}`);
    expect(decodeURIComponent(redacted)).toContain("/spin?t=REDACTED");
  });

  it("the same, on a relative path", () => {
    const redacted = redactUrlSecrets(`/account/login?next=${encodeURIComponent("/spin?t=secret")}`);
    expect(redacted).not.toContain("secret");
    expect(decodeURIComponent(redacted)).toContain("t=REDACTED");
  });
});

describe("what an admin screen puts in the log", () => {
  it("a customer's address typed into the orders search box", () => {
    expect(redactUrlSecrets("https://vantalabsresearch.com/admin/orders?search=buyer%40x.test&status=paid"))
      .toBe("https://vantalabsresearch.com/admin/orders?search=REDACTED&status=paid");
  });

  it("a full name typed into the partner form", () => {
    expect(redactUrlSecrets("/partners/apply?name=Jane%20Doe&step=2")).toBe("/partners/apply?name=REDACTED&step=2");
  });
});
