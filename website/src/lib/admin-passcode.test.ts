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
