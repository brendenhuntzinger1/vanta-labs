import { describe, expect, it } from "vitest";
import { fetchConnectorSpend } from "@/lib/ads/windsor-client";
import { runSpendIngest } from "@/lib/ads/spend-ingest";

// ---------------------------------------------------------------------------
// A PLATFORM NOBODY HAS CONNECTED IS NOT A BROKEN FEED.
//
// Snapchat was detached from this store's Windsor account on 2026-09-06, and
// Windsor answers a connector with no attached account with a hard ERROR, not an
// empty result. Verified live against the API the same day:
//
//     No snapchat account for user brendenhuntzinger1vantalabsresearchcom was
//     found, add your accounts at https://onboard.windsor.ai?datasource=snapchat
//
// WINDSOR_CONNECTORS still lists snapchat on purpose — detaching a platform is
// an ordinary marketing decision, usually temporary, and reattaching it must not
// need a deploy. But left as a FAILURE it would have reported a failed connector
// on every nightly run for as long as the platform stayed off, and an operator
// learns to ignore a signal that is always red. That costs them the one signal
// that means the feed is actually down.
// ---------------------------------------------------------------------------

const WINDSOR_DETACHED_BODY =
  "No snapchat account for user brendenhuntzinger1vantalabsresearchcom was found, "
  + "add your accounts at https://onboard.windsor.ai?datasource=snapchat";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("what Windsor says about a detached platform", () => {
  it.each([
    ["a 4xx carrying the message", 400],
    ["a 200 carrying the message instead of a data array", 200],
  ])("is read as NOT CONNECTED, not as an error (%s)", async (_label, status) => {
    const outcome = await fetchConnectorSpend({
      connector: "snapchat",
      apiKey: "test-key",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-06",
      fetchImpl: async () => jsonResponse(WINDSOR_DETACHED_BODY, status),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.notConnected, "a detached platform must be distinguishable").toBe(true);
    expect(outcome.error).toContain("not connected");
    // The user's own account name was in Windsor's message. It must not travel
    // into an operator alert or a log line.
    expect(outcome.error).not.toContain("brendenhuntzinger1");
  });

  it("still reports a GENUINE failure as a failure", async () => {
    const outcome = await fetchConnectorSpend({
      connector: "facebook",
      apiKey: "test-key",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-06",
      fetchImpl: async () => jsonResponse({ error: "invalid api key" }, 401),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.notConnected ?? false, "a revoked key is not a detached account").toBe(false);
    expect(outcome.error).toContain("401");
  });
});

describe("the nightly run", () => {
  const deps = (bodyFor: (connector: string) => Response) => ({
    apiKey: "test-key",
    now: new Date("2026-09-06T12:00:00Z"),
    upsert: async () => ({ error: null }),
    fetchImpl: async (url: string | URL) => bodyFor(String(url)),
  });

  it("skips the detached platform and keeps the connected ones", async () => {
    const result = await runSpendIngest(deps((url) =>
      url.includes("/snapchat")
        ? jsonResponse(WINDSOR_DETACHED_BODY, 400)
        : jsonResponse({ data: [] })) as never);

    const bySlug = Object.fromEntries(result.connectors.map((c) => [c.connector, c.status]));
    expect(bySlug.snapchat).toBe("skipped");
    expect(bySlug.facebook).toBe("ok");
    expect(bySlug.tiktok).toBe("ok");
    expect(bySlug.reddit).toBe("ok");
  });

  it("does NOT raise an incident when every platform is merely detached", async () => {
    // A store that has stopped advertising is not having an outage, and the
    // dashboard already says the feed is empty.
    await expect(runSpendIngest(deps(() => jsonResponse(WINDSOR_DETACHED_BODY, 400)) as never))
      .resolves.toMatchObject({ ran: true });
  });

  it("still raises one when every CONNECTED platform fails", async () => {
    // The signal the skip must not swallow: three connected platforms, all
    // refusing, with the fourth detached.
    await expect(runSpendIngest(deps((url) =>
      url.includes("/snapchat")
        ? jsonResponse(WINDSOR_DETACHED_BODY, 400)
        : jsonResponse({ error: "invalid api key" }, 401)) as never))
      .rejects.toThrow(/failed on every connected platform \(3\/3\)/);
  });

  it("a quiet day on a connected platform is still a success, not a failure", async () => {
    // This is the live state of this store: three platforms connected, no spend
    // yet, and Windsor answering an empty array for each.
    const result = await runSpendIngest(deps((url) =>
      url.includes("/snapchat")
        ? jsonResponse(WINDSOR_DETACHED_BODY, 400)
        : jsonResponse({ data: [] })) as never);

    expect(result.connectors.filter((c) => c.status === "failed")).toHaveLength(0);
    expect(result.totalWritten).toBe(0);
  });
});
