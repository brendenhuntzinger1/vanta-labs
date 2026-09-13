import { describe, expect, it } from "vitest";
import { browserClassFromUserAgent } from "./browser-class";

describe("browserClassFromUserAgent", () => {
  it("recognizes the common desktop/mobile browsers", () => {
    expect(
      browserClassFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome");
    expect(
      browserClassFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      ),
    ).toBe("Safari");
    expect(browserClassFromUserAgent("Mozilla/5.0 (Windows NT 10.0; rv:129.0) Gecko/20100101 Firefox/129.0")).toBe(
      "Firefox",
    );
    expect(
      browserClassFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
      ),
    ).toBe("Edge");
  });

  it("does not misclassify Edge or Chrome as Safari, even though both mention Safari/", () => {
    // Chrome and Edge UAs always include "Safari/" for legacy compatibility.
    // Order of checks matters — this pins it.
    expect(
      browserClassFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      ),
    ).not.toBe("Safari");
  });

  it("falls back to Other for anything unrecognized, empty, or missing", () => {
    expect(browserClassFromUserAgent("SomeCustomClient/1.0")).toBe("Other");
    expect(browserClassFromUserAgent("")).toBe("Other");
    expect(browserClassFromUserAgent(null)).toBe("Other");
    expect(browserClassFromUserAgent(undefined)).toBe("Other");
  });
});
