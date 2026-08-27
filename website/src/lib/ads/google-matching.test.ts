import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildGoogleIdentity, normalizeGoogleEmail, normalizeGooglePhone } from "./google-matching";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("normalizeGoogleEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeGoogleEmail("  Person@Example.COM ")).toBe("person@example.com");
  });

  it("strips dots from gmail local parts, which Google treats as identical", () => {
    expect(normalizeGoogleEmail("first.last@gmail.com")).toBe("firstlast@gmail.com");
  });

  it("strips a plus suffix from gmail", () => {
    expect(normalizeGoogleEmail("person+shopping@gmail.com")).toBe("person@gmail.com");
  });

  it("treats googlemail.com the same as gmail.com", () => {
    expect(normalizeGoogleEmail("first.last@googlemail.com")).toBe("firstlast@googlemail.com");
  });

  it("does NOT strip dots from non-gmail domains, where they are significant", () => {
    expect(normalizeGoogleEmail("first.last@vantalabs.com")).toBe("first.last@vantalabs.com");
  });

  it("returns null for anything that is not an address", () => {
    expect(normalizeGoogleEmail("not-an-email")).toBeNull();
    expect(normalizeGoogleEmail("")).toBeNull();
    expect(normalizeGoogleEmail(null)).toBeNull();
  });
});

describe("normalizeGooglePhone", () => {
  it("returns E.164 WITH the leading plus, unlike the TikTok normaliser", () => {
    expect(normalizeGooglePhone("(555) 010-1234")).toBe("+5550101234");
  });

  it("does not double the plus on an already-E.164 number", () => {
    expect(normalizeGooglePhone("+15550101234")).toBe("+15550101234");
  });

  it("returns null for a number too short to be real", () => {
    expect(normalizeGooglePhone("1234")).toBeNull();
  });
});

describe("buildGoogleIdentity", () => {
  it("hashes the normalised email", () => {
    expect(buildGoogleIdentity({ email: "First.Last+promo@GMAIL.com" })).toEqual({
      hashedEmail: sha256("firstlast@gmail.com"),
    });
  });

  it("omits a field it does not genuinely have rather than hashing an empty string", () => {
    expect(buildGoogleIdentity({ email: "person@example.com", phone: "" })).toEqual({
      hashedEmail: sha256("person@example.com"),
    });
  });

  it("returns null when it has no identity at all", () => {
    expect(buildGoogleIdentity({ email: null, phone: null })).toBeNull();
  });

  it("never returns a raw address in any field", () => {
    const identity = buildGoogleIdentity({ email: "person@example.com", phone: "+15550101234" });
    expect(JSON.stringify(identity)).not.toContain("person@example.com");
    expect(JSON.stringify(identity)).not.toContain("5550101234");
  });
});
