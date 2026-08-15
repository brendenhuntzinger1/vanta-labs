import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildRedditMatchKeys,
  canonicalizeRedditEmail,
  hashRedditEmail,
  hashRedditExternalId,
} from "@/lib/ads/reddit-matching";

// ---------------------------------------------------------------------------
// Reddit canonicalises an address differently from TikTok and Snap, and the
// difference fails SILENTLY: a digest that does not match simply never matches,
// so Advanced Matching looks installed and does nothing. Reddit's rule is
// lowercase, then strip every dot from the local part, then drop everything
// from a `+` onwards.
//
// Values, not shapes. A test that only checked "some hash is produced" would
// pass against the shared trim-and-lowercase normaliser, which is exactly the
// mistake this module exists to avoid.
// ---------------------------------------------------------------------------

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("canonicalizeRedditEmail", () => {
  it("lowercases and trims", () => {
    expect(canonicalizeRedditEmail("  Jo@Example.COM ")).toBe("jo@example.com");
  });

  it("strips dots from the local part", () => {
    expect(canonicalizeRedditEmail("jo.smith@gmail.com")).toBe("josmith@gmail.com");
  });

  it("drops everything from a plus onwards", () => {
    expect(canonicalizeRedditEmail("jo+vanta@gmail.com")).toBe("jo@gmail.com");
  });

  it("applies both rules together, in Reddit's order", () => {
    expect(canonicalizeRedditEmail("Jo.Smith+shop.now@Gmail.com")).toBe("josmith@gmail.com");
  });

  it("leaves the domain alone — dots there are part of the address", () => {
    expect(canonicalizeRedditEmail("jo@mail.example.co.uk")).toBe("jo@mail.example.co.uk");
  });

  it("handles a plus before dots without leaving a stray dot behind", () => {
    expect(canonicalizeRedditEmail("a+b.c@x.com")).toBe("a@x.com");
  });

  it("returns null for anything that is not an address", () => {
    for (const bad of ["", "   ", "not-an-email", "a@b", "a b@x.com", '"Alice" <alice@example.com>', null, undefined]) {
      expect(canonicalizeRedditEmail(bad as string | null), String(bad)).toBeNull();
    }
  });

  it("returns null when the local part is nothing but a tag", () => {
    // "+shop@x.com" canonicalises to "@x.com", which is not an identity.
    expect(canonicalizeRedditEmail("+shop@x.com")).toBeNull();
  });
});

describe("hashRedditEmail", () => {
  it("produces 64 lowercase hex digits, which is Reddit's stated format", () => {
    const digest = hashRedditEmail("jo@example.com");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the CANONICAL form, not the raw address", () => {
    // The whole point. These three are one person to Reddit.
    const expected = sha256("josmith@gmail.com");
    expect(hashRedditEmail("jo.smith@gmail.com")).toBe(expected);
    expect(hashRedditEmail("JoSmith+deals@Gmail.com")).toBe(expected);
    expect(hashRedditEmail("  jo.smith+a.b@GMAIL.COM  ")).toBe(expected);
  });

  it("differs from a naive trim-and-lowercase hash", () => {
    // Guards against someone 'simplifying' this back onto the shared
    // normaliser, which would silently halve the match rate.
    expect(hashRedditEmail("jo.smith@gmail.com")).not.toBe(sha256("jo.smith@gmail.com"));
  });

  it("returns null rather than hashing junk", () => {
    expect(hashRedditEmail("nonsense")).toBeNull();
    expect(hashRedditEmail(null)).toBeNull();
  });
});

describe("hashRedditExternalId", () => {
  it("hashes the account id case-insensitively", () => {
    const upper = hashRedditExternalId("A1B2-C3D4");
    expect(upper).toBe(sha256("a1b2-c3d4"));
    expect(hashRedditExternalId("a1b2-c3d4")).toBe(upper);
  });

  it("returns null for an absent id", () => {
    expect(hashRedditExternalId("")).toBeNull();
    expect(hashRedditExternalId(null)).toBeNull();
  });
});

describe("buildRedditMatchKeys", () => {
  it("omits keys it does not genuinely have", () => {
    // A digest of the empty string would be shared by every visitor lacking the
    // field — worse than sending nothing.
    expect(buildRedditMatchKeys({ email: null, externalId: "user-1" })).toEqual({
      externalId: sha256("user-1"),
    });
  });

  it("returns null when there is nothing to send, so a guest sends no keys", () => {
    expect(buildRedditMatchKeys({ email: null, externalId: null })).toBeNull();
    expect(buildRedditMatchKeys({ email: "junk", externalId: "" })).toBeNull();
  });

  it("never emits a raw value — every field is a digest", () => {
    const keys = buildRedditMatchKeys({ email: "jo@example.com", externalId: "user-1" });
    expect(keys).not.toBeNull();
    for (const value of Object.values(keys!)) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
      expect(value).not.toContain("@");
    }
  });
});
