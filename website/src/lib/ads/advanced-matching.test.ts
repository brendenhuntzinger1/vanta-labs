import { describe, expect, it } from "vitest";
import { buildAdvancedMatching, normalizeEmail, normalizePhone } from "./advanced-matching";

describe("normalisation", () => {
  it("lowercases and trims an email", () => {
    expect(normalizeEmail("  Jo@Example.COM ")).toBe("jo@example.com");
  });

  it("rejects anything that is not an address", () => {
    for (const bad of ["", "   ", "not-an-email", "jo@", "@example.com", null, undefined]) {
      expect(normalizeEmail(bad as string | null)).toBeNull();
    }
  });

  it("strips punctuation from a phone number and bounds the length", () => {
    expect(normalizePhone("+1 (555) 010-9999")).toBe("15550109999");
    expect(normalizePhone("555")).toBeNull();
    expect(normalizePhone("1234567890123456789")).toBeNull();
  });
});

describe("buildAdvancedMatching", () => {
  it("produces a stable digest regardless of casing or padding", () => {
    const a = buildAdvancedMatching({ email: "  Jo@Example.COM " })!;
    const b = buildAdvancedMatching({ email: "jo@example.com" })!;
    expect(a.email).toBe(b.email);
    // A digest, not the address.
    expect(a.email).toMatch(/^[a-f0-9]{64}$/);
    expect(a.email).not.toContain("@");
  });

  it("distinguishes different people", () => {
    const a = buildAdvancedMatching({ email: "jo@example.com" })!;
    const b = buildAdvancedMatching({ email: "sam@example.com" })!;
    expect(a.email).not.toBe(b.email);
  });

  it("omits fields we do not actually have rather than hashing an empty string", () => {
    const only = buildAdvancedMatching({ email: "jo@example.com", phone: "", externalId: null })!;
    expect(only).toEqual({ email: expect.any(String) });
    expect(only).not.toHaveProperty("phone_number");
    expect(only).not.toHaveProperty("external_id");
  });

  it("returns null when there is nothing worth sending", () => {
    expect(buildAdvancedMatching({})).toBeNull();
    expect(buildAdvancedMatching({ email: "not-an-email", phone: "12" })).toBeNull();
  });

  it("hashes a phone and an external id when present", () => {
    const payload = buildAdvancedMatching({ phone: "+1 555 010 9999", externalId: "CUST-42" })!;
    expect(payload.phone_number).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.external_id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("matches the SHA-256 every other platform computes for the same address", async () => {
    // Independently derived with WebCrypto rather than the same helper, so a
    // change to our hashing would not silently change the expectation too.
    const bytes = new TextEncoder().encode("jo@example.com");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(buildAdvancedMatching({ email: "Jo@Example.com" })!.email).toBe(expected);
  });
});
