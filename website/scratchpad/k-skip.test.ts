import { describe, it, expect } from "vitest";

// membership-billing.ts:1027 guard + :1046-1053 advance, transcribed verbatim.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function skip(nowMs: number, nextBillingAt: number | null): number {
  if (nextBillingAt !== null && nextBillingAt > nowMs + 33 * ONE_DAY_MS) {
    throw new Error("You've already skipped a charge this cycle — your next billing is already deferred.");
  }
  const base = nextBillingAt !== null ? nextBillingAt : nowMs;      // :1046
  const from = base <= nowMs ? nowMs : base;                        // :1047
  return from + 30 * ONE_DAY_MS;                                    // :1053
}

function howManySkips(nowMs: number, start: number | null): number {
  let n = 0, cur = start;
  for (;;) {
    try { cur = skip(nowMs, cur); n += 1; } catch { return n; }
    if (n > 10) return n;
  }
}

describe("skipNextBilling cap (membership-billing.ts:1023-1027 says ONE skip per paid period)", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");
  const d = (n: number) => new Date(now + n * ONE_DAY_MS).toISOString();

  it("allows TWO skips when the renewal is inside the 3-day reminder window", () => {
    for (const days of [0, 1, 2, 3]) {
      const n = howManySkips(now, now + days * ONE_DAY_MS);
      console.log(`  next_billing_at = now + ${String(days).padStart(2)}d (${d(days)}) -> ${n} skips accepted`);
      expect(n).toBe(2);
    }
  });

  it("allows only ONE skip once the renewal is 4+ days out — the cap working as designed", () => {
    for (const days of [4, 7, 10, 29]) {
      const n = howManySkips(now, now + days * ONE_DAY_MS);
      console.log(`  next_billing_at = now + ${String(days).padStart(2)}d -> ${n} skip accepted`);
      expect(n).toBe(1);
    }
  });

  it("the exploitable window is exactly the window the reminder email targets", () => {
    // runMembershipBillingSweep:1243  const in3Days = new Date(now.getTime() + 3 * ONE_DAY_MS);
    const reminderWindowEnd = now + 3 * ONE_DAY_MS;
    const largestDoubleSkip = now + 3 * ONE_DAY_MS;   // base + 30d <= now + 33d  =>  base <= now + 3d
    console.log(`  Step 4 emails 'renewal in 3 days' for next_billing_at <= ${new Date(reminderWindowEnd).toISOString()}`);
    console.log(`  double-skip is possible for       next_billing_at <= ${new Date(largestDoubleSkip).toISOString()}`);
    expect(largestDoubleSkip).toBe(reminderWindowEnd);
  });

  it("shows the resulting free period", () => {
    const start = now + 3 * ONE_DAY_MS;
    const a = skip(now, start), b = skip(now, a);
    console.log(`  paid period ended        ${new Date(start).toISOString()}`);
    console.log(`  after skip #1            ${new Date(a).toISOString()}  (+${(a - now) / ONE_DAY_MS}d from now)`);
    console.log(`  after skip #2            ${new Date(b).toISOString()}  (+${(b - now) / ONE_DAY_MS}d from now)`);
    console.log(`  perks retained for       ${(b - start) / ONE_DAY_MS} days beyond the paid period, on one charge`);
    expect((b - start) / ONE_DAY_MS).toBe(60);
  });
});
