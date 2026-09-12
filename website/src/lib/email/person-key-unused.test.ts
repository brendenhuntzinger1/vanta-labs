import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// M3 INVARIANT 5: no current flow becomes person-level unless explicitly
// configured later.
//
// `claimMarketingSend` now accepts an optional `personKey`, and the database
// defaults the lock key to the email when it is absent. That default is what
// makes M3 invisible — but only for as long as nothing passes the argument.
// The day something does, the lock key changes for that flow, and it should be
// a deliberate act with a test of its own rather than something that arrived
// with an unrelated change.
//
// So this file asserts the ABSENCE of callers, in two independent ways: over
// the source text, and over the wire shape the RPC actually receives.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("nothing in production passes a person key yet", () => {
  it("no source file outside frequency.ts mentions personKey or p_person_key", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      // frequency.ts DEFINES it; this test and the SQL suite discuss it.
      if (file.endsWith("email/frequency.ts")) continue;
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const source = readFileSync(file, "utf8");
      if (/\bpersonKey\b|\bp_person_key\b/.test(source)) {
        offenders.push(file.replace(`${process.cwd()}/`, ""));
      }
    }
    expect(
      offenders,
      `These files pass a person key. That changes the advisory-lock key for those sends, ` +
        `which is a deliberate cross-channel decision and needs its own test — see M8 in ` +
        `docs/SMS-IMPLEMENTATION-BLUEPRINT.md. If this is intended, update this test in the same commit.`,
    ).toEqual([]);
  });
});

describe("the RPC wire shape is unchanged when no person key is given", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("omits p_person_key entirely rather than sending it as null", async () => {
    // Sending the argument as null is a different shape for PostgREST to
    // resolve than not sending it at all. "No caller passes it yet" should be
    // true on the wire, not only in the type.
    const calls: Array<Record<string, unknown>> = [];
    vi.doMock("@/lib/supabase-server", () => ({
      supabaseAdmin: {
        rpc: async (_name: string, args: Record<string, unknown>) => {
          calls.push(args);
          return { data: [{ outcome: "claimed", log_id: "00000000-0000-0000-0000-000000000001" }], error: null };
        },
      },
    }));

    const { claimMarketingSend } = await import("@/lib/email/frequency");
    await claimMarketingSend({ email: "Buyer@Example.test", campaignType: "campaign" });

    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!).sort()).toEqual([
      "p_campaign_type", "p_email", "p_exempt_family", "p_quiet_seconds", "p_reference_id", "p_template_key",
    ]);
    expect("p_person_key" in calls[0]!).toBe(false);
  });

  it("sends it, normalised, when a caller explicitly supplies one", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.doMock("@/lib/supabase-server", () => ({
      supabaseAdmin: {
        rpc: async (_name: string, args: Record<string, unknown>) => {
          calls.push(args);
          return { data: [{ outcome: "claimed", log_id: "00000000-0000-0000-0000-000000000001" }], error: null };
        },
      },
    }));

    const { claimMarketingSend } = await import("@/lib/email/frequency");
    await claimMarketingSend({ email: "buyer@example.test", campaignType: "campaign", personKey: "  USER-42 " });

    expect(calls[0]!.p_person_key).toBe("user-42");
  });

  it("treats an empty or whitespace person key as absent", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.doMock("@/lib/supabase-server", () => ({
      supabaseAdmin: {
        rpc: async (_name: string, args: Record<string, unknown>) => {
          calls.push(args);
          return { data: [{ outcome: "claimed", log_id: "00000000-0000-0000-0000-000000000001" }], error: null };
        },
      },
    }));

    const { claimMarketingSend } = await import("@/lib/email/frequency");
    for (const personKey of ["", "   ", null, undefined]) {
      await claimMarketingSend({ email: "buyer@example.test", campaignType: "campaign", personKey });
    }
    for (const args of calls) {
      expect("p_person_key" in args, `${JSON.stringify(args)} should omit the key`).toBe(false);
    }
  });
});
