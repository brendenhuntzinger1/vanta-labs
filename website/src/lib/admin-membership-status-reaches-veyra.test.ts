import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// AN ADMIN CANCEL OR PAUSE HAS TO REACH THE PROCESSOR.
//
// setMembershipStatus wrote customer_memberships.status and nothing else. For
// a Veyra-billed member that stops nothing: Veyra keeps charging, and the next
// membership.renewed webhook flips the row back to active. The customer's own
// cancel and pause paths (membership-billing.ts) already talk to Veyra first
// and abort if it refuses; the admin path is held to the same rule.
// ---------------------------------------------------------------------------

const state = {
  row: null as null | { user_id: string; status: string; veyra_membership_id: string | null },
  updates: [] as Array<Record<string, unknown>>,
};
const veyra = vi.hoisted(() => ({
  cancel: vi.fn<(id: string, atPeriodEnd?: boolean) => Promise<{ ok: boolean; message?: string }>>(async () => ({ ok: true })),
  skip: vi.fn<(id: string, reason?: string) => Promise<{ ok: boolean; message?: string; nextRenewalAt?: string | null }>>(async () => ({ ok: true, nextRenewalAt: "2026-10-05T00:00:00.000Z" })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/veyra-membership", () => ({
  cancelVeyraMembership: (id: string, atPeriodEnd?: boolean) => veyra.cancel(id, atPeriodEnd),
  skipVeyraMembershipCycle: (id: string, reason?: string) => veyra.skip(id, reason),
}));
vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table !== "customer_memberships") throw new Error(`unexpected table ${table}`);
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: state.row, error: null }),
      update: (patch: Record<string, unknown>) => ({
        eq: async () => { state.updates.push(patch); return { error: null }; },
      }),
    };
    return chain;
  };
  return { supabaseAdmin: { from } };
});

async function setStatus(status: "active" | "paused" | "cancelled") {
  const { setMembershipStatus } = await import("@/lib/admin-membership");
  return setMembershipStatus("user-1", status);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.updates = [];
  state.row = { user_id: "user-1", status: "active", veyra_membership_id: "veyra_sub_1" };
  veyra.cancel.mockResolvedValue({ ok: true });
  veyra.skip.mockResolvedValue({ ok: true, nextRenewalAt: "2026-10-05T00:00:00.000Z" });
});

describe("admin setMembershipStatus on a Veyra-billed member", () => {
  it("cancels at Veyra (immediately) before recording the local cancel", async () => {
    await setStatus("cancelled");
    expect(veyra.cancel).toHaveBeenCalledWith("veyra_sub_1", false);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]?.status).toBe("cancelled");
  });

  it("skips a billing cycle at Veyra on pause, and adopts Veyra's next charge date", async () => {
    await setStatus("paused");
    expect(veyra.skip).toHaveBeenCalledWith("veyra_sub_1", expect.any(String));
    expect(state.updates[0]?.status).toBe("paused");
    expect(state.updates[0]?.next_billing_at).toBe("2026-10-05T00:00:00.000Z");
  });

  it("changes nothing locally when Veyra refuses the cancel", async () => {
    veyra.cancel.mockResolvedValue({ ok: false, message: "provider unavailable" });
    await expect(setStatus("cancelled")).rejects.toThrow(/provider/i);
    expect(state.updates).toHaveLength(0);
  });

  it("changes nothing locally when Veyra refuses the pause", async () => {
    veyra.skip.mockResolvedValue({ ok: false, message: "provider unavailable" });
    await expect(setStatus("paused")).rejects.toThrow(/provider/i);
    expect(state.updates).toHaveLength(0);
  });

  it("still works for a member with no processor subscription", async () => {
    state.row = { user_id: "user-1", status: "active", veyra_membership_id: null };
    await setStatus("cancelled");
    expect(veyra.cancel).not.toHaveBeenCalled();
    expect(state.updates[0]?.status).toBe("cancelled");
  });
});
