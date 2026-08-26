import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// I-10. The login route goes out of its way to prevent username enumeration
// (route.ts:14-17):
//
//   "A single generic message for every credential/passcode failure so an
//    attacker can't tell which of the three factors (username, password,
//    passcode) was correct."
//
// validateAdminCredentials undercut that. It returned early when no row
// matched, BEFORE verifyPassword, so a nonexistent username skipped the scrypt
// derivation entirely while a real one paid for it. scrypt is deliberately
// slow -- that is its whole purpose -- so "did the response come back fast?"
// answers the question the generic message refuses to.
//
// Asserted on scrypt CALL COUNT rather than wall-clock, so the test is
// deterministic rather than flaky.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const scryptCalls: Array<{ password: string; salt: string }> = [];

vi.mock("crypto", async () => {
  const actual = await vi.importActual<typeof import("crypto")>("crypto");
  return {
    ...actual,
    default: actual,
    scryptSync: (password: string, salt: string, keylen: number) => {
      scryptCalls.push({ password: String(password), salt: String(salt) });
      return actual.scryptSync(password, salt, keylen);
    },
  };
});

const state: { row: Record<string, unknown> | null } = { row: null };

vi.mock("@/lib/supabase-server", () => {
  const from = () => {
    const b: Record<string, unknown> = {
      select() { return b; },
      eq() { return b; },
      not() { return b; },
      maybeSingle: async () => ({ data: state.row, error: null }),
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});

async function validate() {
  return (await import("@/lib/admin-auth")).validateAdminCredentials;
}

/** A real stored credential, so the "user exists" path does genuine work. */
async function realRow() {
  const actual = await vi.importActual<typeof import("crypto")>("crypto");
  const salt = "0123456789abcdef";
  const hash = actual.scryptSync("correct horse battery", salt, 64).toString("hex");
  return {
    username: "owner",
    password_salt: salt,
    password_hash: hash,
    is_active: true,
    role: "super_admin",
    passcode_salt: null,
    passcode_hash: null,
  };
}

beforeEach(() => {
  scryptCalls.length = 0;
  state.row = null;
});

describe("I-10 — a nonexistent admin username must cost the same as a real one", () => {
  it("derives a key even when no account matches", async () => {
    state.row = null;
    const run = await validate();
    const result = await run("no-such-admin", "whatever");

    expect(result).toBeNull();
    expect(scryptCalls.length).toBeGreaterThan(0);
  });

  it("performs the same number of derivations as a wrong password on a real account", async () => {
    state.row = await realRow();
    const run = await validate();
    await run("owner", "wrong password");
    const realAccountCalls = scryptCalls.length;

    scryptCalls.length = 0;
    state.row = null;
    await run("no-such-admin", "wrong password");
    const missingAccountCalls = scryptCalls.length;

    expect(missingAccountCalls).toBe(realAccountCalls);
  });

  it("still authenticates a correct credential", async () => {
    state.row = await realRow();
    const run = await validate();
    const result = await run("owner", "correct horse battery");

    expect(result).not.toBeNull();
    expect(result?.username).toBe("owner");
    expect(result?.role).toBe("super_admin");
  });

  it("still rejects a wrong password", async () => {
    state.row = await realRow();
    const run = await validate();

    expect(await run("owner", "wrong password")).toBeNull();
  });

  it("never derives against the real stored salt for an account that does not exist", async () => {
    // The dummy work must not become an oracle of its own.
    state.row = null;
    const run = await validate();
    await run("no-such-admin", "whatever");

    expect(scryptCalls.every((call) => call.salt !== "0123456789abcdef")).toBe(true);
  });
});
