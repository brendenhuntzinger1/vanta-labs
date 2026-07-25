import { describe, it, expect } from "vitest";
import {
  normalizeReferralCode,
  referralCodeFingerprint,
  validateReferralCodeFormat,
  RESERVED_REFERRAL_CODES,
} from "@/lib/referral-code-validation";

describe("referral code normalization", () => {
  it("trims, uppercases, and drops all whitespace (whitespace tricks)", () => {
    expect(normalizeReferralCode("  vip 1 0  ")).toBe("VIP10");
    expect(normalizeReferralCode("v\ti\np")).toBe("VIP");
  });
  it("strips invalid characters, keeping only [A-Z0-9_-]", () => {
    expect(normalizeReferralCode("v!i@p#1$")).toBe("VIP1");
  });
  it("folds Unicode look-alikes to ASCII (homoglyph defense)", () => {
    expect(normalizeReferralCode("vïp")).toBe("VIP");   // ï -> I
    expect(normalizeReferralCode("ＶＩＰ")).toBe("VIP"); // fullwidth -> ASCII
  });
  it("handles null/undefined safely", () => {
    expect(normalizeReferralCode(null)).toBe("");
    expect(normalizeReferralCode(undefined)).toBe("");
  });
});

describe("look-alike fingerprint (duplicate detection)", () => {
  it("collapses hyphen/underscore variants to one key", () => {
    const fp = referralCodeFingerprint("VIP-1");
    expect(referralCodeFingerprint("VIP_1")).toBe(fp);
    expect(referralCodeFingerprint("VIP1")).toBe(fp);
    expect(fp).toBe("VIP1");
  });
});

describe("referral code format validation", () => {
  it("accepts a clean code", () => {
    const r = validateReferralCodeFormat("SUMMER-2026");
    expect(r.ok).toBe(true);
    expect(r.code).toBe("SUMMER-2026");
  });

  it("rejects invalid characters with a clear reason", () => {
    const r = validateReferralCodeFormat("vip$$$");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_chars");
    expect(r.error).toMatch(/letters, numbers/i);
  });

  it("enforces min and max length", () => {
    expect(validateReferralCodeFormat("ab").reason).toBe("too_short");
    expect(validateReferralCodeFormat("A".repeat(21)).reason).toBe("too_long");
    expect(validateReferralCodeFormat("abcd").ok).toBe(true);
    expect(validateReferralCodeFormat("ab", { minLength: 2, maxLength: 20 }).ok).toBe(true); // configurable
  });

  it("rejects leading/trailing and repeated separators", () => {
    expect(validateReferralCodeFormat("-vip1").reason).toBe("edge_separator");
    expect(validateReferralCodeFormat("vip1-").reason).toBe("edge_separator");
    expect(validateReferralCodeFormat("vip--1").reason).toBe("repeated_separator");
    expect(validateReferralCodeFormat("vip__1").reason).toBe("repeated_separator");
  });

  it("rejects reserved words, directly and via separator obfuscation", () => {
    for (const word of ["admin", "support", "login", "checkout", "vanta", "api", "partners", "account", "orders"]) {
      expect(validateReferralCodeFormat(word).reason).toBe("reserved");
    }
    expect(validateReferralCodeFormat("A-D-M-I-N").reason).toBe("reserved"); // fingerprint = ADMIN
    expect(validateReferralCodeFormat("v-a-n-t-a").reason).toBe("reserved");
  });

  it("rejects profanity", () => {
    expect(validateReferralCodeFormat("myshit99").reason).toBe("profanity");
  });

  it("every reserved word is itself rejected (self-consistency)", () => {
    for (const word of RESERVED_REFERRAL_CODES) {
      if (word.length >= 4) {
        expect(validateReferralCodeFormat(word).ok).toBe(false);
      }
    }
  });

  it("normalized output is always URL/route safe (fuzz)", () => {
    const bytes = "abcXYZ019-_ !@#$%^&*()你好ＡＢ\t\n/\\?=&";
    for (let i = 0; i < 5000; i++) {
      let s = "";
      const len = 1 + (i % 25);
      for (let j = 0; j < len; j++) s += bytes[(i * 7 + j * 13) % bytes.length];
      const code = normalizeReferralCode(s);
      expect(code).toMatch(/^[A-Z0-9_-]*$/); // never anything a URL could break on
      const r = validateReferralCodeFormat(s);
      if (r.ok) {
        expect(r.code).toMatch(/^[A-Z0-9][A-Z0-9_-]*[A-Z0-9]$/); // no edge separators
        expect(r.code.length).toBeGreaterThanOrEqual(4);
        expect(r.code.length).toBeLessThanOrEqual(20);
      }
    }
  });
});
