import { describe, expect, it } from "vitest";
import { hasCoa, sanitizeCoaUrl } from "@/lib/coa-url";

// The UI branches on plain truthiness -- `coaUrl ? <a href> : "COA coming soon"`
// -- so anything non-empty renders as a working document link. These are the
// values that must NOT survive that test.
describe("sanitizeCoaUrl", () => {
  // The one that actually shipped: a product whose coa_url was a single space
  // rendered an "Open / Download COA" button that navigated nowhere. A dead link
  // is worse than an honest "coming soon" for the claim it is backing.
  it("treats a whitespace-only value as no COA", () => {
    expect(sanitizeCoaUrl(" ")).toBe("");
    expect(sanitizeCoaUrl("\t\n  ")).toBe("");
    expect(hasCoa(" ")).toBe(false);
  });

  it("treats an empty or missing value as no COA", () => {
    expect(sanitizeCoaUrl("")).toBe("");
    expect(sanitizeCoaUrl(null)).toBe("");
    expect(sanitizeCoaUrl(undefined)).toBe("");
  });

  // Notes an operator types while a document is outstanding. They are a promise,
  // not a PDF.
  it.each(["N/A", "n/a", "none", "pending", "TBD", "coming soon", "--"])(
    "treats %s as no COA",
    (value) => {
      expect(sanitizeCoaUrl(value)).toBe("");
    },
  );

  it("keeps a real document link", () => {
    const url = "https://cdn.vantalabsresearch.com/coa/bpc-157-2407.pdf";
    expect(sanitizeCoaUrl(url)).toBe(url);
    expect(hasCoa(url)).toBe(true);
  });

  it("trims padding rather than rejecting an otherwise valid link", () => {
    expect(sanitizeCoaUrl("  https://example.org/coa.pdf  ")).toBe("https://example.org/coa.pdf");
  });

  it("rejects a bare filename or path, which cannot be opened", () => {
    expect(sanitizeCoaUrl("coa.pdf")).toBe("");
    expect(sanitizeCoaUrl("/files/coa.pdf")).toBe("");
  });

  // The value is written straight into href, so a scheme that executes has no
  // business being accepted on a field that means "link to a document".
  it("rejects schemes that are not http(s)", () => {
    expect(sanitizeCoaUrl("javascript:alert(1)")).toBe("");
    expect(sanitizeCoaUrl("JavaScript:alert(1)")).toBe("");
    expect(sanitizeCoaUrl("data:text/html,<script>alert(1)</script>")).toBe("");
    expect(sanitizeCoaUrl("file:///etc/passwd")).toBe("");
  });

  it("accepts http as well as https", () => {
    expect(sanitizeCoaUrl("http://example.org/coa.pdf")).toBe("http://example.org/coa.pdf");
  });
});
