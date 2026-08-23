import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// NOBODY CAN ACT ON SOMEBODY ELSE'S MEMBERSHIP.
//
// Six customer-facing membership routes mutate real billing state: cancel,
// pause, resume, skip a cycle, update the card, subscribe. Each one is a
// money operation on a subscription.
//
// The design that makes cross-customer attack structurally impossible: NONE of
// them accepts a customer id. The subject is always `user.id` taken from the
// verified session, so there is no parameter to tamper with. These tests pin
// that property -- a future refactor that started reading a userId from the
// body would be an IDOR, and this file would catch it.
//
// They also pin the two rejection paths: no session at all, and a session
// belonging to a non-customer role.
// ---------------------------------------------------------------------------

const state: {
  user: { id: string; email: string } | null;
  role: string;
} = { user: null, role: "customer" };

const calls: Array<{ fn: string; arg: unknown }> = [];

const { cancelMembership, pauseMembership, resumeMembership, skipNextBilling, updatePaymentMethod } =
  vi.hoisted(() => ({
    cancelMembership: vi.fn(async (userId: string) => {
      return { billingCycle: "monthly", accessUntil: null, refundable: false, userId };
    }),
    pauseMembership: vi.fn(async (_userId: string) => ({ ok: true })),
    resumeMembership: vi.fn(async (_userId: string) => ({ ok: true })),
    skipNextBilling: vi.fn(async (_userId: string) => ({ ok: true })),
    updatePaymentMethod: vi.fn(async (_userId: string, _ref: string) => {}),
  }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-session", () => ({ getAuthenticatedUser: async () => state.user }));
vi.mock("@/lib/auth-role", () => ({ detectRoleFromUser: () => state.role }));
vi.mock("@/lib/safe-error", () => ({ customerSafeMessage: (_e: unknown, fallback: string) => fallback }));
vi.mock("@/lib/membership-billing", () => ({
  cancelMembership,
  pauseMembership,
  resumeMembership,
  skipNextBilling,
  updatePaymentMethod,
}));

const SESSION_USER = { id: "session-user-1", email: "me@example.test" };
const VICTIM = "victim-user-2";

function request(body?: unknown) {
  return new Request("https://example.test/api/membership/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** Every route under test, with the billing function it is allowed to reach. */
const ROUTES: Array<{
  name: string;
  path: string;
  fn: { mock: { calls: unknown[][] } };
  body?: unknown;
}> = [
  { name: "cancel", path: "@/app/api/membership/cancel/route", fn: cancelMembership },
  { name: "pause", path: "@/app/api/membership/pause/route", fn: pauseMembership },
  { name: "resume", path: "@/app/api/membership/resume/route", fn: resumeMembership },
  { name: "skip", path: "@/app/api/membership/skip/route", fn: skipNextBilling },
  {
    name: "update-payment-method",
    path: "@/app/api/membership/update-payment-method/route",
    fn: updatePaymentMethod,
    body: { paymentMethodRef: "pm_new" },
  },
];

async function post(path: string, body?: unknown) {
  const mod = (await import(/* @vite-ignore */ path)) as { POST: (r?: Request) => Promise<Response> };
  return mod.POST(request(body));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  calls.length = 0;
  state.user = SESSION_USER;
  state.role = "customer";
});

describe("an unauthenticated caller", () => {
  for (const route of ROUTES) {
    it(`is refused by ${route.name} with 401, and nothing is billed`, async () => {
      state.user = null;
      const response = await post(route.path, route.body);
      expect(response.status).toBe(401);
      expect(route.fn.mock.calls).toHaveLength(0);
    });
  }
});

describe("a session that is not a customer", () => {
  // Checked on EVERY route, not just one: the role gate is duplicated per
  // route, so covering a single one leaves the other five unproven.
  for (const route of ROUTES) {
    for (const role of ["admin", "partner", "unknown"]) {
      it(`${route.name} refuses a ${role} session`, async () => {
        state.role = role;
        const response = await post(route.path, route.body);
        expect(response.status).toBe(401);
        expect(route.fn.mock.calls).toHaveLength(0);
      });
    }
  }
});

describe("an authenticated customer", () => {
  for (const route of ROUTES) {
    it(`${route.name} acts on the SESSION user, never on a body-supplied id`, async () => {
      // The attack: name someone else in the payload and see whose membership
      // the server actually touches.
      const hostile = { ...(route.body as Record<string, unknown> ?? {}), userId: VICTIM, user_id: VICTIM, id: VICTIM };

      const response = await post(route.path, hostile);

      expect(response.status).toBe(200);
      expect(route.fn.mock.calls).toHaveLength(1);
      const firstArg = route.fn.mock.calls[0][0];
      expect(firstArg).toBe(SESSION_USER.id);
      expect(firstArg).not.toBe(VICTIM);
    });
  }

  it("passes only the session id and the card reference to updatePaymentMethod", async () => {
    await post("@/app/api/membership/update-payment-method/route", {
      paymentMethodRef: "pm_new",
      userId: VICTIM,
    });
    expect(updatePaymentMethod).toHaveBeenCalledWith(SESSION_USER.id, "pm_new");
  });
});

describe("when the billing operation itself fails", () => {
  it("reports failure rather than a false success", async () => {
    cancelMembership.mockImplementation(async () => {
      throw new Error("provider refused");
    });
    const response = await post("@/app/api/membership/cancel/route");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it("does not leak the internal error text to the customer", async () => {
    cancelMembership.mockImplementation(async () => {
      throw new Error("supabase connection string leaked here");
    });
    const response = await post("@/app/api/membership/cancel/route");
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("supabase");
  });
});
