import { describe, expect, it } from "vitest";

import {
  parseFormParams,
  signTwilioRequest,
  signedUrlFor,
  twilioSignatureBase,
  verifyTwilioSignature,
} from "@/lib/sms/webhook-signature";

// ---------------------------------------------------------------------------
// Invariant 43: an unsigned webhook is rejected, and an unconfigured secret
// answers 503 rather than accepting or permanently refusing.
//
// The tests SIGN THEIR OWN PAYLOADS rather than asserting against a pasted
// fixture signature. A fixture would still pass if `twilioSignatureBase` and
// `verifyTwilioSignature` drifted together in the same wrong direction, which
// is the failure that actually happens — both are written from the same
// misunderstanding on the same afternoon.
// ---------------------------------------------------------------------------

const TOKEN = "test_auth_token_do_not_use";

// SID-SHAPED, BUILT AT RUNTIME. A 34-character "AC"+hex literal in source is
// what Twilio's real account identifiers look like, so GitHub's push
// protection flags it — correctly, since it cannot tell a fixture from a leak.
// Concatenating keeps the fixture realistic without putting that shape in the
// file.
const fakeSid = (prefix: string) => prefix + "0".repeat(32);
const URL_ = "https://vantalabsresearch.com/api/webhooks/twilio";

const STATUS_CALLBACK = {
  MessageSid: fakeSid("SM"),
  MessageStatus: "delivered",
  To: "+18135551234",
  From: "+18135559876",
  AccountSid: fakeSid("AC"),
};

describe("twilioSignatureBase — key-sorted concatenation", () => {
  it("sorts by key, not by insertion order", () => {
    const a = twilioSignatureBase(URL_, { b: "2", a: "1", c: "3" });
    const b = twilioSignatureBase(URL_, { c: "3", a: "1", b: "2" });
    expect(a).toBe(b);
    expect(a).toBe(`${URL_}a1b2c3`);
  });

  it("puts the URL first", () => {
    expect(twilioSignatureBase(URL_, { a: "1" }).startsWith(URL_)).toBe(true);
  });

  it("is the URL alone when there are no parameters", () => {
    expect(twilioSignatureBase(URL_, {})).toBe(URL_);
  });
});

describe("verifyTwilioSignature", () => {
  it("accepts a correctly signed request", () => {
    const signature = signTwilioRequest(TOKEN, URL_, STATUS_CALLBACK);
    expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params: STATUS_CALLBACK, signature }))
      .toEqual({ valid: true });
  });

  it("accepts regardless of the order the parameters were parsed in", () => {
    const signature = signTwilioRequest(TOKEN, URL_, STATUS_CALLBACK);
    const reordered = Object.fromEntries(Object.entries(STATUS_CALLBACK).reverse());
    expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params: reordered, signature }).valid)
      .toBe(true);
  });

  it("rejects a tampered parameter value", () => {
    const signature = signTwilioRequest(TOKEN, URL_, STATUS_CALLBACK);
    const tampered = { ...STATUS_CALLBACK, MessageStatus: "failed" };
    expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params: tampered, signature }))
      .toEqual({ valid: false, reason: "mismatch" });
  });

  it("rejects an ADDED parameter — the signature covers the whole set, not a subset", () => {
    const signature = signTwilioRequest(TOKEN, URL_, STATUS_CALLBACK);
    const extra = { ...STATUS_CALLBACK, ErrorCode: "30007" };
    expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params: extra, signature }).valid)
      .toBe(false);
  });

  it("rejects a REMOVED parameter", () => {
    const signature = signTwilioRequest(TOKEN, URL_, STATUS_CALLBACK);
    const fewer = { ...STATUS_CALLBACK };
    delete (fewer as Partial<typeof STATUS_CALLBACK>).MessageStatus;
    expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params: fewer, signature }).valid)
      .toBe(false);
  });

  it("rejects a signature computed for a different URL", () => {
    const signature = signTwilioRequest(TOKEN, "https://evil.example.com/api/webhooks/twilio", STATUS_CALLBACK);
    expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params: STATUS_CALLBACK, signature }).valid)
      .toBe(false);
  });

  it("rejects a signature computed with a different token", () => {
    const signature = signTwilioRequest("some_other_token", URL_, STATUS_CALLBACK);
    expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params: STATUS_CALLBACK, signature }).valid)
      .toBe(false);
  });

  it("rejects a missing signature header", () => {
    for (const signature of [null, undefined, ""]) {
      expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params: STATUS_CALLBACK, signature }))
        .toEqual({ valid: false, reason: "missing_signature" });
    }
  });

  it("reports not_configured when there is no auth token — the caller must 503, not 403", () => {
    // The distinction is the whole retry story. A 403 tells Twilio the event was
    // refused and it stops; a 503 tells it we could not answer and it retries,
    // so a misconfigured deploy loses no delivery receipts.
    expect(verifyTwilioSignature({ authToken: "", url: URL_, params: STATUS_CALLBACK, signature: "x" }))
      .toEqual({ valid: false, reason: "not_configured" });
  });

  it("does not throw on a wrong-length signature", () => {
    // timingSafeEqual throws on a length mismatch, so the length is checked
    // first. A short signature is a mismatch, not a 500.
    expect(() =>
      verifyTwilioSignature({ authToken: TOKEN, url: URL_, params: STATUS_CALLBACK, signature: "short" }),
    ).not.toThrow();
    expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params: STATUS_CALLBACK, signature: "short" }))
      .toEqual({ valid: false, reason: "mismatch" });
  });
});

describe("signedUrlFor — the proxy problem", () => {
  it("prefers the configured public URL over the request's internal one", () => {
    // This is the case that makes a correct implementation reject every real
    // request: on Vercel the function sees an internal host over http.
    expect(signedUrlFor(URL_, "http://10.0.0.7:3000/api/webhooks/twilio")).toBe(URL_);
  });

  it("carries the request's query string onto the configured URL", () => {
    expect(signedUrlFor(URL_, "http://10.0.0.7:3000/api/webhooks/twilio?x=1"))
      .toBe(`${URL_}?x=1`);
  });

  it("does not override a configured URL that already has a query string", () => {
    const configured = `${URL_}?env=prod`;
    expect(signedUrlFor(configured, "http://10.0.0.7:3000/api/webhooks/twilio?x=1"))
      .toBe(configured);
  });

  it("falls back to the request URL when nothing is configured", () => {
    expect(signedUrlFor("", URL_)).toBe(URL_);
    expect(signedUrlFor("   ", URL_)).toBe(URL_);
  });

  it("survives an unparseable request URL", () => {
    expect(signedUrlFor(URL_, "not a url")).toBe(URL_);
  });

  it("round-trips: a request signed for the public URL verifies after rebuilding", () => {
    const signature = signTwilioRequest(TOKEN, URL_, STATUS_CALLBACK);
    const rebuilt = signedUrlFor(URL_, "http://10.0.0.7:3000/api/webhooks/twilio");
    expect(verifyTwilioSignature({ authToken: TOKEN, url: rebuilt, params: STATUS_CALLBACK, signature }).valid)
      .toBe(true);
  });
});

describe("parseFormParams", () => {
  it("parses urlencoded bodies and decodes values", () => {
    expect(parseFormParams("MessageSid=SM123&To=%2B18135551234"))
      .toEqual({ MessageSid: "SM123", To: "+18135551234" });
  });

  it("takes the LAST value for a repeated key, matching Twilio's own libraries", () => {
    expect(parseFormParams("a=1&a=2")).toEqual({ a: "2" });
  });

  it("returns an empty map for an empty body", () => {
    expect(parseFormParams("")).toEqual({});
  });

  it("round-trips a real urlencoded body through signing and verification", () => {
    const body = "MessageSid=SM1&MessageStatus=delivered&To=%2B18135551234";
    const params = parseFormParams(body);
    const signature = signTwilioRequest(TOKEN, URL_, params);
    expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params, signature }).valid).toBe(true);
  });
});
