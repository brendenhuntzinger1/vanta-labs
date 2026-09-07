import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { marketingIdempotencyKey } from "@/lib/email/marketing";
import { ResendEmailProvider } from "@/lib/email/providers/resend";

// ---------------------------------------------------------------------------
// THE ONE GUARD THAT SURVIVES OUR OWN PROCESS DYING.
//
// A campaign recipient is claimed, handed to Resend, Resend accepts it, and the
// worker dies before writing 'sent'. Ten minutes later the stale-claim reaper
// returns the row to 'pending' and someone sends it again. Nothing in our own
// database can close that window, because the fact we need — "Resend already
// has this message" — only ever existed in a reply we did not live to read.
//
// The Idempotency-Key is what closes it, and these are the two behaviours that
// have to hold at once. They pull in opposite directions, which is the whole
// reason this is worth a test rather than a line of code:
//
//   SAME message, sent again  → same key  → Resend collapses it.
//   DIFFERENT message, same recipient and reference → different key → it sends.
//
// Get the second one wrong and the fix is worse than the bug: an automation
// carrying a gift re-renders with a fresh one-time token after a failure, and
// under a key that ignored the body it would collide with its own earlier
// attempt, draw a 409, and drop that customer out of the sequence for good.
// ---------------------------------------------------------------------------

const base = {
  campaignType: "campaign",
  referenceId: "11111111-2222-3333-4444-555555555555",
  to: "buyer@example.test",
  subject: "Ready to restock?",
  html: "<p>hello</p>",
};

describe("the marketing idempotency key", () => {
  it("is stable for the same message to the same person", () => {
    // The crash case: identical re-render after the process died. Resend must
    // recognise it and not send a second copy.
    expect(marketingIdempotencyKey(base)).toBe(marketingIdempotencyKey({ ...base }));
  });

  it("ignores casing and surrounding space in the address", () => {
    // The reclaimed row carries whatever the audience wrote; the first send may
    // have lowercased. Same person, same message, same key.
    expect(marketingIdempotencyKey({ ...base, to: "  BUYER@Example.test " })).toBe(marketingIdempotencyKey(base));
  });

  it("CHANGES when the body changes, so a legitimate retry is not swallowed", () => {
    // An automation that carries a gift mints a new token every render. This is
    // the assertion that stops the fix from silently dropping those customers.
    const first = marketingIdempotencyKey({ ...base, html: "<p>your code: AAAA-1111</p>" });
    const second = marketingIdempotencyKey({ ...base, html: "<p>your code: BBBB-2222</p>" });
    expect(first).not.toBe(second);
  });

  it("changes when the subject changes", () => {
    expect(marketingIdempotencyKey({ ...base, subject: "Something else" })).not.toBe(marketingIdempotencyKey(base));
  });

  it("differs per recipient, so one person's send cannot suppress another's", () => {
    // Campaigns pass the CAMPAIGN id as referenceId — the same value for every
    // recipient. Without the address in the key, the first recipient's send
    // would collapse the entire campaign into one email.
    expect(marketingIdempotencyKey({ ...base, to: "other@example.test" })).not.toBe(marketingIdempotencyKey(base));
  });

  it("differs per automation, so two flows to one address do not collide", () => {
    expect(marketingIdempotencyKey({ ...base, campaignType: "automation:winback_30" }))
      .not.toBe(marketingIdempotencyKey({ ...base, campaignType: "automation:winback_60" }));
  });

  it("treats a missing reference as its own value rather than throwing", () => {
    expect(marketingIdempotencyKey({ ...base, referenceId: null })).toEqual(expect.any(String));
    expect(marketingIdempotencyKey({ ...base, referenceId: null })).not.toBe(marketingIdempotencyKey(base));
  });

  it("fits inside Resend's 256-character limit", () => {
    const long = marketingIdempotencyKey({
      ...base,
      to: `${"a".repeat(240)}@example.test`,
      html: "x".repeat(500_000),
    });
    expect(long.length).toBeLessThanOrEqual(256);
    // And is not accidentally constant for long inputs.
    expect(long).not.toBe(marketingIdempotencyKey(base));
  });

  it("cannot be confused by moving a delimiter between fields", () => {
    // A naive join on a common separator lets ("a","b") and ("a b","") collide.
    expect(marketingIdempotencyKey({ ...base, campaignType: "campaign x", referenceId: "y" }))
      .not.toBe(marketingIdempotencyKey({ ...base, campaignType: "campaign", referenceId: "x y" }));
  });
});

// ---------------------------------------------------------------------------
// AND IT HAS TO REACH THE WIRE. A key computed and not sent is decoration.
// ---------------------------------------------------------------------------
describe("the key reaches Resend as a header", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  async function capture(idempotencyKey?: string) {
    let seen: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = (init.headers ?? {}) as Record<string, string>;
      return { ok: true, status: 200, json: async () => ({ id: "msg_1" }), text: async () => "{}" } as Response;
    }) as unknown as typeof fetch;

    await new ResendEmailProvider({ apiKey: "re_test", from: "Vanta <news@mail.example.test>" }).send({
      to: base.to,
      subject: base.subject,
      html: base.html,
      text: "hello",
      idempotencyKey,
    } as Parameters<ResendEmailProvider["send"]>[0]);

    return seen;
  }

  it("sends Idempotency-Key when one is supplied", async () => {
    const key = marketingIdempotencyKey(base);
    const headers = await capture(key);
    expect(headers["Idempotency-Key"]).toBe(key);
  });

  it("omits the header entirely when there is no key", async () => {
    // Transactional mail without a key must not send an empty one — Resend
    // would treat "" as a real key and collapse unrelated messages.
    const headers = await capture(undefined);
    expect("Idempotency-Key" in headers).toBe(false);
  });
});
