import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// resumeVeyraMembership IS WRITTEN TO BE HONEST, NOT OPTIMISTIC.
//
// The request shape of Veyra's `retention` endpoint is not verified against
// its source. What the wrapper promises regardless of that shape:
//
//   * a non-2xx is a refusal;
//   * a 2xx whose body still says cancel_at_period_end=true, or reports a
//     cancelled status, is ALSO a refusal — the processor did not un-cancel,
//     so the caller must not tell the member their renewal is restored;
//   * a 2xx that reports the subscription renewing is a success, and the next
//     charge date it carries is handed back for the local row.
// ---------------------------------------------------------------------------

vi.mock("@/lib/env", () => ({
  getRequiredEnv: (name: string) => (name === "VEYRA_API_BASE" ? "https://processor.test/" : ""),
}));

const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("VEYRA_SECRET_KEY", "sk_test_veyra");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function resume(id = "vm_123") {
  const { resumeVeyraMembership } = await import("@/lib/veyra-membership");
  return resumeVeyraMembership(id);
}

describe("resumeVeyraMembership", () => {
  it("posts to the membership's retention endpoint", async () => {
    fetchMock.mockResolvedValue(reply(200, { status: "active", cancel_at_period_end: false }));

    await resume("vm 1/2");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://processor.test/api/v1/membership/vm%201%2F2/retention");
    expect(init?.method).toBe("POST");
  });

  it("reports success, with the next charge date, when the subscription is renewing again", async () => {
    fetchMock.mockResolvedValue(reply(200, { status: "active", cancel_at_period_end: false, next_renewal_at: "2026-10-05T00:00:00.000Z" }));

    const result = await resume();

    expect(result.ok).toBe(true);
    expect(result.ok && result.nextRenewalAt).toBe("2026-10-05T00:00:00.000Z");
  });

  it("treats a 2xx that still ends at period end as a refusal", async () => {
    fetchMock.mockResolvedValue(reply(200, { status: "active", cancel_at_period_end: true }));

    const result = await resume();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/did not restore/i);
  });

  it("treats a 2xx with a cancelled status as a refusal", async () => {
    fetchMock.mockResolvedValue(reply(200, { status: "canceled" }));

    expect((await resume()).ok).toBe(false);
  });

  it("treats any non-2xx as a refusal and carries the provider's message", async () => {
    fetchMock.mockResolvedValue(reply(409, { message: "membership already ended" }));

    const result = await resume();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toBe("membership already ended");
  });

  it("treats a transport failure as a refusal rather than throwing", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));

    const result = await resume();

    expect(result.ok).toBe(false);
  });
});
