import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TWILIO_REQUEST_TIMEOUT_MS,
  checkTwilioVerification,
  lookupTwilioNumber,
  sendTwilioMessage,
} from "@/lib/sms/client";

// ---------------------------------------------------------------------------
// `safeToRetry` IS THE FIELD THIS FILE EXISTS FOR.
//
// A caller acts irreversibly on it: a retryable failure means send again, and
// sending a marketing text twice is a complaint and a carrier-filtering risk,
// not a cosmetic bug. So the rule is narrow — safeToRetry is true ONLY when we
// know Twilio did nothing — and every failure mode is pinned here.
// ---------------------------------------------------------------------------

// SID-shaped, built at runtime — see webhook-signature.test.ts for why a
// literal of this shape does not belong in a source file.
const fakeSid = (prefix: string) => prefix + "0".repeat(32);
const ACCOUNT_SID = fakeSid("AC");
const credentials = { accountSid: ACCOUNT_SID, authToken: "token" };
const SERVICE = fakeSid("MG");

afterEach(() => {
  vi.unstubAllGlobals();
});

type FetchCall = [string, RequestInit];

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn((url: string, init: RequestInit) => Promise.resolve(impl(url, init)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** The (url, init) pair of a recorded call, typed so the assertions read plainly. */
function callAt(spy: ReturnType<typeof stubFetch>, index: number): FetchCall {
  const call = spy.mock.calls[index];
  if (!call) throw new Error(`fetch was not called ${index + 1} time(s)`);
  return [call[0], call[1]];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("sendTwilioMessage — success", () => {
  it("returns the SID, status, segments and price in cents", async () => {
    stubFetch(() => json({ sid: "SM1", status: "queued", num_segments: "2", price: "-0.00830" }));
    const result = await sendTwilioMessage({ credentials, messagingServiceSid: SERVICE, to: "+18135551234", body: "hi" });
    expect(result).toEqual({ ok: true, sid: "SM1", status: "queued", segments: 2, priceCents: 1 });
  });

  it("sends through the MESSAGING SERVICE, not a From number — the service carries the A2P campaign", async () => {
    const spy = stubFetch(() => json({ sid: "SM1", status: "queued" }));
    await sendTwilioMessage({ credentials, messagingServiceSid: SERVICE, to: "+18135551234", body: "hi" });
    const [, init] = callAt(spy, 0);
    const body = String(init.body);
    expect(body).toContain(`MessagingServiceSid=${SERVICE}`);
    expect(body).not.toContain("From=");
  });

  it("carries a timeout signal on every request", async () => {
    const spy = stubFetch(() => json({ sid: "SM1", status: "queued" }));
    await sendTwilioMessage({ credentials, messagingServiceSid: SERVICE, to: "+18135551234", body: "hi" });
    expect(callAt(spy, 0)[1].signal).toBeDefined();
    expect(TWILIO_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it("treats a null price as unknown rather than zero", async () => {
    stubFetch(() => json({ sid: "SM1", status: "queued", price: null }));
    const result = await sendTwilioMessage({ credentials, messagingServiceSid: SERVICE, to: "+18135551234", body: "hi" });
    expect(result.ok && result.priceCents).toBeNull();
  });
});

describe("sendTwilioMessage — failures, and whether each may be retried", () => {
  it("a TIMEOUT is never safe to retry — the message may have gone out", async () => {
    stubFetch(() => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      return Promise.reject(error);
    });
    const result = await sendTwilioMessage({ credentials, messagingServiceSid: SERVICE, to: "+18135551234", body: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("timeout");
      expect(result.safeToRetry).toBe(false);
    }
  });

  it("a NETWORK drop is never safe to retry", async () => {
    stubFetch(() => Promise.reject(new Error("ECONNRESET")));
    const result = await sendTwilioMessage({ credentials, messagingServiceSid: SERVICE, to: "+18135551234", body: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("network");
      expect(result.safeToRetry).toBe(false);
    }
  });

  it("a 5xx is never safe to retry — it may still have landed", async () => {
    stubFetch(() => json({ code: 20500, message: "Internal error" }, 503));
    const result = await sendTwilioMessage({ credentials, messagingServiceSid: SERVICE, to: "+18135551234", body: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("server_error");
      expect(result.safeToRetry).toBe(false);
    }
  });

  it("keeps Twilio's error code so the caller can act on 21610 (unsubscribed) and 30007 (filtered)", async () => {
    stubFetch(() => json({ code: 21610, message: "Attempt to send to unsubscribed recipient" }, 400));
    const result = await sendTwilioMessage({ credentials, messagingServiceSid: SERVICE, to: "+18135551234", body: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("rejected");
      expect(result.code).toBe("21610");
    }
  });

  it("reports not_configured without calling fetch at all", async () => {
    const spy = stubFetch(() => json({}));
    const result = await sendTwilioMessage({
      credentials: { accountSid: "", authToken: "" },
      messagingServiceSid: SERVICE, to: "+18135551234", body: "hi",
    });
    expect(spy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("not_configured");
      // Safe, because nothing was sent — the fix is configuration, then retry.
      expect(result.safeToRetry).toBe(true);
    }
  });

  it("a 2xx with no SID is unexpected, not a success", async () => {
    stubFetch(() => json({ status: "queued" }));
    const result = await sendTwilioMessage({ credentials, messagingServiceSid: SERVICE, to: "+18135551234", body: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("unexpected");
  });

  it("never throws, whatever comes back", async () => {
    for (const impl of [
      () => new Response("not json", { status: 200 }),
      () => new Response("", { status: 200 }),
      () => new Response("gateway", { status: 502 }),
      () => Promise.reject(new Error("boom")),
    ]) {
      stubFetch(impl);
      await expect(
        sendTwilioMessage({ credentials, messagingServiceSid: SERVICE, to: "+18135551234", body: "hi" }),
      ).resolves.toBeDefined();
      vi.unstubAllGlobals();
    }
  });
});

describe("the token and the phone number never reach a log line", () => {
  it("masks a phone number in provider detail", async () => {
    stubFetch(() => json({ code: 21211, message: "The 'To' number +18135554417 is not a valid phone number" }, 400));
    const result = await sendTwilioMessage({ credentials, messagingServiceSid: SERVICE, to: "+18135554417", body: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).not.toContain("8135554417");
      expect(result.detail).toContain("•••");
    }
  });

  it("masks an account SID in provider detail", async () => {
    stubFetch(() => json({ code: 20003, message: `Authenticate failed for ${ACCOUNT_SID}` }, 401));
    const result = await sendTwilioMessage({ credentials, messagingServiceSid: SERVICE, to: "+18135551234", body: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).not.toContain(ACCOUNT_SID);
  });

  it("truncates long provider detail", async () => {
    stubFetch(() => json({ code: 1, message: "x".repeat(5000) }, 400));
    const result = await sendTwilioMessage({ credentials, messagingServiceSid: SERVICE, to: "+18135551234", body: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail.length).toBeLessThanOrEqual(300);
  });
});

describe("checkTwilioVerification", () => {
  it("approves only when Twilio says valid AND approved", async () => {
    stubFetch(() => json({ status: "approved", valid: true }));
    const result = await checkTwilioVerification({ credentials, verifyServiceSid: "VA1", to: "+18135551234", code: "123456" });
    expect(result).toEqual({ ok: true, approved: true, status: "approved" });
  });

  it("does not approve a pending or canceled check", async () => {
    for (const payload of [{ status: "pending", valid: false }, { status: "canceled", valid: false }, { status: "approved", valid: false }]) {
      stubFetch(() => json(payload));
      const result = await checkTwilioVerification({ credentials, verifyServiceSid: "VA1", to: "+18135551234", code: "000000" });
      expect(result.ok && result.approved).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it("treats a consumed or expired verification (404) as a failure, not a second approval", async () => {
    stubFetch(() => json({ code: 20404, message: "Not found" }, 404));
    const result = await checkTwilioVerification({ credentials, verifyServiceSid: "VA1", to: "+18135551234", code: "123456" });
    expect(result.ok).toBe(false);
  });
});

describe("lookupTwilioNumber", () => {
  it("returns line type and carrier", async () => {
    stubFetch(() => json({ valid: true, line_type_intelligence: { type: "mobile", carrier_name: "T-Mobile USA" } }));
    const result = await lookupTwilioNumber({ credentials, phone: "+18135551234" });
    expect(result).toEqual({ ok: true, valid: true, lineType: "mobile", carrier: "T-Mobile USA" });
  });

  it("returns nulls rather than throwing when Twilio omits the enrichment", async () => {
    stubFetch(() => json({ valid: true, line_type_intelligence: null }));
    const result = await lookupTwilioNumber({ credentials, phone: "+18135551234" });
    expect(result).toEqual({ ok: true, valid: true, lineType: null, carrier: null });
  });

  it("is a GET with no body", async () => {
    const spy = stubFetch(() => json({ valid: true }));
    await lookupTwilioNumber({ credentials, phone: "+18135551234" });
    const [, init] = callAt(spy, 0);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });
});
