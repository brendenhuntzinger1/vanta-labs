import { describe, expect, it } from "vitest";
import {
  constantTimeEqualString,
  generatePasscodeSalt,
  hashPasscode,
  isValidPasscodeFormat,
  normalizePasscode,
  resolvePasscodeCheck,
  verifyPasscodeHash,
} from "./admin-passcode";

describe("normalizePasscode", () => {
  it("strips non-digits", () => {
    expect(normalizePasscode(" 12-34 56 ")).toBe("123456");
    expect(normalizePasscode("abc123def456")).toBe("123456");
  });
  it("handles null/undefined", () => {
    expect(normalizePasscode(null)).toBe("");
    expect(normalizePasscode(undefined)).toBe("");
  });
});

describe("isValidPasscodeFormat", () => {
  it("accepts exactly 6 digits", () => {
    expect(isValidPasscodeFormat("000000")).toBe(true);
    expect(isValidPasscodeFormat("948217")).toBe(true);
  });
  it("rejects wrong length or non-numeric", () => {
    expect(isValidPasscodeFormat("12345")).toBe(false);
    expect(isValidPasscodeFormat("1234567")).toBe(false);
    expect(isValidPasscodeFormat("12345a")).toBe(false);
    expect(isValidPasscodeFormat("")).toBe(false);
  });
});

describe("hashPasscode / verifyPasscodeHash", () => {
  it("round-trips a correct passcode", () => {
    const salt = generatePasscodeSalt();
    const hash = hashPasscode("482913", salt);
    expect(verifyPasscodeHash("482913", salt, hash)).toBe(true);
  });
  it("rejects a wrong passcode", () => {
    const salt = generatePasscodeSalt();
    const hash = hashPasscode("482913", salt);
    expect(verifyPasscodeHash("482914", salt, hash)).toBe(false);
  });
  it("rejects a malformed stored hash without throwing", () => {
    const salt = generatePasscodeSalt();
    expect(verifyPasscodeHash("482913", salt, "not-hex-zz")).toBe(false);
  });
  it("uses a unique salt per call so hashes differ", () => {
    const a = generatePasscodeSalt();
    const b = generatePasscodeSalt();
    expect(a).not.toBe(b);
    expect(hashPasscode("111111", a)).not.toBe(hashPasscode("111111", b));
  });
});

describe("constantTimeEqualString", () => {
  it("matches identical strings and rejects differing ones", () => {
    expect(constantTimeEqualString("123456", "123456")).toBe(true);
    expect(constantTimeEqualString("123456", "123457")).toBe(false);
    expect(constantTimeEqualString("123456", "12345")).toBe(false);
  });
});

describe("resolvePasscodeCheck", () => {
  const salt = generatePasscodeSalt();
  const hash = hashPasscode("246810", salt);

  it("verifies against a per-account passcode", () => {
    expect(
      resolvePasscodeCheck({ passcodeRaw: "246810", accountSalt: salt, accountHash: hash, envAccessCode: null }),
    ).toBe("ok");
    expect(
      resolvePasscodeCheck({ passcodeRaw: "000000", accountSalt: salt, accountHash: hash, envAccessCode: null }),
    ).toBe("invalid");
  });

  it("prefers the per-account passcode over the env fallback", () => {
    expect(
      resolvePasscodeCheck({ passcodeRaw: "999999", accountSalt: salt, accountHash: hash, envAccessCode: "999999" }),
    ).toBe("invalid");
  });

  it("falls back to the env access code when no account passcode is set", () => {
    expect(
      resolvePasscodeCheck({ passcodeRaw: "135790", accountSalt: null, accountHash: null, envAccessCode: "135790" }),
    ).toBe("ok");
    expect(
      resolvePasscodeCheck({ passcodeRaw: "135791", accountSalt: null, accountHash: null, envAccessCode: "135790" }),
    ).toBe("invalid");
  });

  it("reports not_configured when neither factor is provisioned", () => {
    expect(
      resolvePasscodeCheck({ passcodeRaw: "123456", accountSalt: null, accountHash: null, envAccessCode: null }),
    ).toBe("not_configured");
    expect(
      resolvePasscodeCheck({ passcodeRaw: "", accountSalt: null, accountHash: null, envAccessCode: "  " }),
    ).toBe("not_configured");
  });

  it("treats a malformed env access code as not configured", () => {
    expect(
      resolvePasscodeCheck({ passcodeRaw: "123456", accountSalt: null, accountHash: null, envAccessCode: "12ab" }),
    ).toBe("not_configured");
  });

  it("rejects a malformed submitted passcode when a factor is configured", () => {
    expect(
      resolvePasscodeCheck({ passcodeRaw: "12", accountSalt: salt, accountHash: hash, envAccessCode: null }),
    ).toBe("invalid");
  });
});

// SECURITY INVARIANTS — these lock in the login guarantees. If a future change
// breaks any of them, these tests fail. Do not weaken them without intent.
describe("security invariants (must never regress)", () => {
  const salt = generatePasscodeSalt();
  const correct = "222198";
  const hash = hashPasscode(correct, salt);
  const configured = { accountSalt: salt, accountHash: hash };

  it("ONCE A CODE IS SET, the correct code always unlocks and nothing else does", () => {
    expect(resolvePasscodeCheck({ passcodeRaw: correct, ...configured, envAccessCode: null })).toBe("ok");
    // Every one of these is genuinely wrong (none reduce to 222198 after digit
    // normalization): empty, blank, wrong digits, too short, too long, letters.
    for (const wrong of ["", " ", "000000", "222199", "22219", "2221988", "abcdef", "111111"]) {
      expect(
        resolvePasscodeCheck({ passcodeRaw: wrong, ...configured, envAccessCode: null }),
        `wrong input ${JSON.stringify(wrong)} must not unlock`,
      ).not.toBe("ok");
    }
  });

  it("ONCE A CODE IS SET, login can never fall back to password-only (never 'not_configured')", () => {
    for (const env of [null, undefined, "", "999999", "123456"]) {
      expect(
        resolvePasscodeCheck({ passcodeRaw: "", ...configured, envAccessCode: env }),
      ).not.toBe("not_configured");
    }
  });

  it("an account code always overrides the environment code", () => {
    // Even if the env code is 999999, only the account's own code works.
    expect(resolvePasscodeCheck({ passcodeRaw: "999999", ...configured, envAccessCode: "999999" })).toBe("invalid");
    expect(resolvePasscodeCheck({ passcodeRaw: correct, ...configured, envAccessCode: "999999" })).toBe("ok");
  });

  it("the same code + same salt always produces the same hash (stable, deterministic)", () => {
    expect(hashPasscode(correct, salt)).toBe(hash);
    expect(hashPasscode(correct, salt)).toBe(hashPasscode(correct, salt));
  });

  it("normalizes spaces/dashes so a correct code entered with formatting still works", () => {
    expect(resolvePasscodeCheck({ passcodeRaw: "22-21-98", ...configured, envAccessCode: null })).toBe("ok");
    expect(resolvePasscodeCheck({ passcodeRaw: " 222198 ", ...configured, envAccessCode: null })).toBe("ok");
  });
});
