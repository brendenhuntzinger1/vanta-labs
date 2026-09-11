import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Invariants 2, 6 and the one this milestone turns on:
//
//   phone on file          = YES
//   SMS marketing consent  = NO
//
// Both are true of every number in this database today. This file proves that
// pre-filling a number the store already holds saves the customer typing and
// grants nothing — no verification, no consent, no lifted suppression.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const state = {
  subscribers: new Map<string, Row>(),
  consentEvents: [] as Row[],
  suppressions: new Map<string, Row>(),
  readError: null as Error | null,
  eventInsertError: null as Error | null,
  updateError: null as Error | null,
};

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "sms_subscribers") {
      let key: string | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (_col: string, value: string) => { key = value; return chain; },
        maybeSingle: async () => {
          if (state.readError) return { data: null, error: state.readError };
          return { data: key ? (state.subscribers.get(key) ?? null) : null, error: null };
        },
        upsert: async (row: Row) => {
          const phone = String(row.phone_e164);
          const existing = state.subscribers.get(phone);
          // Mirrors Postgres: an upsert merges the supplied columns and leaves
          // the rest, and `status` has a default that only applies on insert.
          state.subscribers.set(phone, { status: "pending", ...existing, ...row });
          return { error: null };
        },
        update: (patch: Row) => ({
          eq: async (_col: string, value: string) => {
            if (state.updateError) return { error: state.updateError };
            const existing = state.subscribers.get(value) ?? {};
            state.subscribers.set(value, { ...existing, ...patch });
            return { error: null };
          },
        }),
      };
      return chain;
    }
    if (table === "sms_consent_events") {
      return {
        insert: (row: Row) => ({
          select: () => ({
            single: async () => {
              if (state.eventInsertError) return { data: null, error: state.eventInsertError };
              state.consentEvents.push(row);
              return { data: { id: `evt_${state.consentEvents.length}` }, error: null };
            },
          }),
        }),
      };
    }
    if (table === "sms_suppressions") {
      let key: string | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (_col: string, value: string) => { key = value; return chain; },
        maybeSingle: async () => {
          if (state.readError) return { data: null, error: state.readError };
          return { data: key ? (state.suppressions.get(key) ?? null) : null, error: null };
        },
        upsert: async (row: Row) => {
          state.suppressions.set(String(row.phone_e164), row);
          return { error: null };
        },
        delete: () => ({ eq: async (_c: string, v: string) => { state.suppressions.delete(v); return { error: null }; } }),
      };
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  };
  return { supabaseAdmin: { from } };
});

const { applyConsentEvent, beginConsentForPhoneOnFile, loadSubscriber, recordConsentEvent } =
  await import("@/lib/sms/consent");
const { isSmsSuppressed } = await import("@/lib/sms/suppression");
const { canSendMarketing } = await import("@/lib/sms/state");

const PHONE_ON_FILE = "(813) 555-4417";
const E164 = "+18135554417";

const EVIDENCE = {
  exactCopyShown:
    "By joining Vanta Texts you agree to receive recurring marketing texts (~4/month) at this number. Consent is not a condition of purchase. Msg & data rates may apply. Reply STOP to opt out, HELP for help.",
  disclosureVersion: "sms-disclosure-v1",
  source: "checkout" as const,
  sourceUrl: "https://vantalabsresearch.com/checkout",
  ip: "203.0.113.10",
  userAgent: "Mozilla/5.0",
  userId: "user-123",
};

beforeEach(() => {
  state.subscribers.clear();
  state.consentEvents.length = 0;
  state.suppressions.clear();
  state.readError = null;
  state.eventInsertError = null;
  state.updateError = null;
});

describe("a number already on file grants nothing by existing", () => {
  it("normalises the stored spelling to one canonical key", async () => {
    const result = await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.phoneE164).toBe(E164);
  });

  it("does NOT verify the number, even though it came off their own order", async () => {
    await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    const row = state.subscribers.get(E164)!;
    expect(row.status).toBe("pending");
    expect(row.verified_at ?? null).toBeNull();
  });

  it("does NOT set marketing consent", async () => {
    await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    const row = state.subscribers.get(E164)!;
    expect(row.marketing_consent ?? false).toBeFalsy();
  });

  it("asks for verification as the next step", async () => {
    const result = await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    expect(result.ok && result.nextStep).toBe("verify");
  });

  it("records the EXACT disclosure text, not just a version pointer", async () => {
    await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    const event = state.consentEvents.at(-1)!;
    expect(event.event).toBe("disclosure_shown");
    expect(event.exact_copy_shown).toBe(EVIDENCE.exactCopyShown);
    expect(event.disclosure_version).toBe("sms-disclosure-v1");
    expect(event.ip).toBe("203.0.113.10");
    expect(event.source_url).toContain("/checkout");
    expect(event.user_id).toBe("user-123");
  });

  it("notes that the number was pre-filled, so the record says so", async () => {
    await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    expect(state.consentEvents.at(-1)!.detail).toEqual({ prefilledFromFile: true });
  });

  it("refuses without the disclosure copy — no evidence, no flow", async () => {
    const result = await beginConsentForPhoneOnFile({
      phoneOnFile: PHONE_ON_FILE,
      evidence: { ...EVIDENCE, exactCopyShown: "   " },
    });
    expect(result.ok).toBe(false);
    expect(state.subscribers.size).toBe(0);
    expect(state.consentEvents).toHaveLength(0);
  });

  it("refuses a stored number it cannot parse rather than coercing it", async () => {
    // Two such numbers exist in production today (11 digits, not starting 1).
    const result = await beginConsentForPhoneOnFile({ phoneOnFile: "81355512345", evidence: EVIDENCE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_nanp");
    expect(state.subscribers.size).toBe(0);
  });

  it("does not demote an already-verified number back to pending", async () => {
    state.subscribers.set(E164, {
      phone_e164: E164, status: "verified", verified_at: "2026-09-01T00:00:00Z",
      marketing_consent: false, double_optin_confirmed_at: null, resubscribe_count: 0,
    });
    await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    expect(state.subscribers.get(E164)!.status).toBe("verified");
  });

  it("does NOT lift a suppression — a suppressed number stays suppressed", async () => {
    state.suppressions.set(E164, { phone_e164: E164, scope: "marketing", reason: "pre_consent_migration" });
    const result = await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    expect(result.ok).toBe(true);
    const verdict = await isSmsSuppressed(E164, "marketing");
    expect(verdict.suppressed).toBe(true);
  });
});

describe("the full opt-in path from a number on file", () => {
  it("reaches ACTIVE only after verify, grant AND confirm", async () => {
    await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });

    const verified = await applyConsentEvent({ phoneE164: E164, event: "verified", eventName: "verified", evidence: EVIDENCE });
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.marketingActive).toBe(false);

    const granted = await applyConsentEvent({ phoneE164: E164, event: "marketing_granted", eventName: "marketing_granted", evidence: EVIDENCE });
    expect(granted.ok).toBe(true);
    expect(granted.ok && granted.marketingActive).toBe(false);

    const confirmed = await applyConsentEvent({ phoneE164: E164, event: "double_optin_confirmed", eventName: "double_optin_confirmed" });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.ok && confirmed.marketingActive).toBe(true);
  });

  it("leaves an audit trail of every step in order", async () => {
    await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    await applyConsentEvent({ phoneE164: E164, event: "verified", eventName: "verified" });
    await applyConsentEvent({ phoneE164: E164, event: "marketing_granted", eventName: "marketing_granted" });
    await applyConsentEvent({ phoneE164: E164, event: "double_optin_confirmed", eventName: "double_optin_confirmed" });

    expect(state.consentEvents.map((e) => e.event)).toEqual([
      "disclosure_shown", "verified", "marketing_granted", "double_optin_confirmed",
    ]);
  });

  it("refuses a grant before verification", async () => {
    await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    const result = await applyConsentEvent({ phoneE164: E164, event: "marketing_granted", eventName: "marketing_granted" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refused).toContain("verified");
  });
});

describe("evidence and state changes stay together", () => {
  it("does not change state when the evidence cannot be recorded", async () => {
    await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    await applyConsentEvent({ phoneE164: E164, event: "verified", eventName: "verified" });

    state.eventInsertError = new Error("audit table unavailable");
    const result = await applyConsentEvent({ phoneE164: E164, event: "marketing_granted", eventName: "marketing_granted" });
    expect(result.ok).toBe(false);
    expect(state.subscribers.get(E164)!.marketing_consent ?? false).toBeFalsy();
  });

  it("STILL REVOKES when the evidence cannot be recorded — the one exception", async () => {
    // Refusing to honour STOP because an audit row would not write is
    // indefensible. The customer said stop.
    await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    await applyConsentEvent({ phoneE164: E164, event: "verified", eventName: "verified" });
    await applyConsentEvent({ phoneE164: E164, event: "marketing_granted", eventName: "marketing_granted" });
    await applyConsentEvent({ phoneE164: E164, event: "double_optin_confirmed", eventName: "double_optin_confirmed" });

    state.eventInsertError = new Error("audit table unavailable");
    const result = await applyConsentEvent({ phoneE164: E164, event: "marketing_revoked", eventName: "marketing_revoked" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.marketingActive).toBe(false);
    expect(state.subscribers.get(E164)!.status).toBe("opted_out");
  });
});

describe("reads fail closed", () => {
  it("reports an unreadable subscriber as an error, never as 'no record'", async () => {
    state.readError = new Error("connection reset");
    const result = await loadSubscriber(E164);
    expect(result.ok).toBe(false);
  });

  it("refuses to begin an opt-in when the subscriber cannot be read", async () => {
    state.readError = new Error("connection reset");
    const result = await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    expect(result.ok).toBe(false);
  });

  it("treats an unreadable suppression list as SUPPRESSED", async () => {
    state.readError = new Error("connection reset");
    const verdict = await isSmsSuppressed(E164, "marketing");
    expect(verdict.suppressed).toBe(true);
    if (verdict.suppressed) {
      expect(verdict.scope).toBe("unknown");
      expect(verdict.reason).toContain("could not be verified");
    }
  });
});

describe("suppression scope keeps order notifications alive", () => {
  it("a marketing suppression blocks marketing and allows transactional", async () => {
    state.suppressions.set(E164, { phone_e164: E164, scope: "marketing", reason: "stop" });
    expect((await isSmsSuppressed(E164, "marketing")).suppressed).toBe(true);
    expect((await isSmsSuppressed(E164, "transactional")).suppressed).toBe(false);
  });

  it("an 'all' suppression blocks both", async () => {
    state.suppressions.set(E164, { phone_e164: E164, scope: "all", reason: "hard_bounce" });
    expect((await isSmsSuppressed(E164, "marketing")).suppressed).toBe(true);
    expect((await isSmsSuppressed(E164, "transactional")).suppressed).toBe(true);
  });

  it("an unsuppressed number is clear on both channels", async () => {
    expect((await isSmsSuppressed(E164, "marketing")).suppressed).toBe(false);
    expect((await isSmsSuppressed(E164, "transactional")).suppressed).toBe(false);
  });
});

describe("recordConsentEvent never throws", () => {
  it("reports a failure instead of raising", async () => {
    state.eventInsertError = new Error("nope");
    const result = await recordConsentEvent({ phoneE164: E164, event: "verified" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("the end state is what canSendMarketing says it is", () => {
  it("agrees with the persisted row", async () => {
    await beginConsentForPhoneOnFile({ phoneOnFile: PHONE_ON_FILE, evidence: EVIDENCE });
    await applyConsentEvent({ phoneE164: E164, event: "verified", eventName: "verified" });
    await applyConsentEvent({ phoneE164: E164, event: "marketing_granted", eventName: "marketing_granted" });
    const final = await applyConsentEvent({ phoneE164: E164, event: "double_optin_confirmed", eventName: "double_optin_confirmed" });
    expect(final.ok).toBe(true);
    if (final.ok) expect(canSendMarketing(final.state)).toBe(true);
  });
});
