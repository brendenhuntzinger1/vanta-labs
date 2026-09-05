import { beforeEach, describe, expect, it } from "vitest";

import {
  isSealedControlValue,
  resetControlSecretWarningsForTests,
  sealControlSecret,
  sealingAvailable,
  unsealControlSecret,
  unsealControlSecretDetailed,
} from "@/lib/control-secret-sealing";

// ---------------------------------------------------------------------------
// CONTROL-STORE SECRETS ARE SEALED AT REST.
//
// The SMTP password, provider API keys, processor secrets and Pushover keys
// were written into admin_audit_logs in clear. With ADMIN_CONTROL_SECRET_KEY
// set, what lands in the row is AES-256-GCM ciphertext that only the server
// environment can open; without the key nothing changes, so an environment
// that has not been given the key keeps working exactly as before.
// ---------------------------------------------------------------------------

const KEY_HEX = "a".repeat(64);
const KEY_B64 = Buffer.from("b".repeat(32)).toString("base64");

beforeEach(() => resetControlSecretWarningsForTests());

describe("sealing", () => {
  it("round-trips a secret under a hex key and never stores it in clear", () => {
    const env = { ADMIN_CONTROL_SECRET_KEY: KEY_HEX };
    const sealed = sealControlSecret("re_live_abc123", env);
    expect(isSealedControlValue(sealed)).toBe(true);
    expect(String(sealed)).not.toContain("re_live_abc123");
    expect(unsealControlSecret(sealed, env)).toBe("re_live_abc123");
  });

  it("accepts a base64 key too", () => {
    const env = { ADMIN_CONTROL_SECRET_KEY: KEY_B64 };
    expect(unsealControlSecret(sealControlSecret("smtp-pass", env), env)).toBe("smtp-pass");
  });

  it("produces a different ciphertext each time (fresh IV), all of which open", () => {
    const env = { ADMIN_CONTROL_SECRET_KEY: KEY_HEX };
    const a = sealControlSecret("same", env);
    const b = sealControlSecret("same", env);
    expect(a).not.toBe(b);
    expect(unsealControlSecret(a, env)).toBe("same");
    expect(unsealControlSecret(b, env)).toBe("same");
  });

  it("passes empty strings, non-strings and already-sealed values through", () => {
    const env = { ADMIN_CONTROL_SECRET_KEY: KEY_HEX };
    expect(sealControlSecret("", env)).toBe("");
    expect(sealControlSecret(true, env)).toBe(true);
    expect(sealControlSecret(null, env)).toBe(null);
    const once = sealControlSecret("x", env);
    expect(sealControlSecret(once, env)).toBe(once);
  });
});

describe("without a key", () => {
  it("stores and reads in clear, exactly as before, and reports availability", () => {
    const env = {};
    expect(sealingAvailable(env)).toBe(false);
    expect(sealControlSecret("clear-text", env)).toBe("clear-text");
    expect(unsealControlSecret("clear-text", env)).toBe("clear-text");
  });

  it("treats a malformed key as no key", () => {
    const env = { ADMIN_CONTROL_SECRET_KEY: "too-short" };
    expect(sealingAvailable(env)).toBe(false);
    expect(sealControlSecret("clear-text", env)).toBe("clear-text");
  });

  it("refuses to hand ciphertext to a reader that has lost the key", () => {
    const sealed = sealControlSecret("secret", { ADMIN_CONTROL_SECRET_KEY: KEY_HEX });
    const outcome = unsealControlSecretDetailed(sealed, {});
    expect(outcome).toEqual({ ok: false, value: "", reason: "no_key" });
    expect(unsealControlSecret(sealed, {})).toBe("");
  });
});

describe("tampering", () => {
  it("a value sealed under another key, or altered, opens to nothing", () => {
    const sealed = String(sealControlSecret("secret", { ADMIN_CONTROL_SECRET_KEY: KEY_HEX }));
    expect(unsealControlSecretDetailed(sealed, { ADMIN_CONTROL_SECRET_KEY: KEY_B64 })).toMatchObject({ ok: false, reason: "corrupt" });
    const flipped = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(unsealControlSecretDetailed(flipped, { ADMIN_CONTROL_SECRET_KEY: KEY_HEX })).toMatchObject({ ok: false, reason: "corrupt" });
  });
});
