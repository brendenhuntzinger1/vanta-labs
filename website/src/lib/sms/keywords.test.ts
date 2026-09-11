import { describe, expect, it } from "vitest";

import {
  STOP_KEYWORDS,
  classifyInbound,
  helpReply,
  stopReply,
  suppressesMarketing,
} from "@/lib/sms/keywords";

// ---------------------------------------------------------------------------
// Invariant 7. The costs here are NOT symmetric, and the tests are biased to
// match: a missed opt-out is $500-$1,500 per subsequent message, while a false
// positive loses one subscriber. So "did we catch every way a person says
// stop" gets far more attention than "did we avoid over-suppressing".
// ---------------------------------------------------------------------------

describe("per se keywords — exact matches, honoured automatically", () => {
  it.each([...STOP_KEYWORDS])("treats %s as a stop", (keyword) => {
    const result = classifyInbound(keyword);
    expect(result.intent).toBe("stop");
    expect(suppressesMarketing(result)).toBe(true);
    expect(result.needsReview).toBe(false);
  });

  it("is case-insensitive and tolerates the punctuation keyboards add", () => {
    for (const body of ["STOP", "Stop", "stop.", "STOP!", "  stop  ", "Stop,"]) {
      const result = classifyInbound(body);
      expect(result.intent, `${body} should stop`).toBe("stop");
    }
  });

  it("records the exact keyword for the consent record", () => {
    expect(classifyInbound("UNSUBSCRIBE").keyword).toBe("unsubscribe");
    expect(classifyInbound("opt out").keyword).toBe("opt out");
  });
});

describe("free-text revocation — the FCC's any-reasonable-means standard", () => {
  it.each([
    "stop texting me",
    "please stop",
    "remove me from this list",
    "take me off your list",
    "don't text me again",
    "dont message me",
    "no more texts please",
    "leave me alone",
    "quit texting me",
    "I am opting out",
    "unsubscribe me please",
  ])("suppresses %o", (body) => {
    const result = classifyInbound(body);
    expect(suppressesMarketing(result)).toBe(true);
  });

  it("suppresses AND flags for review — the regex is not a reader", () => {
    const result = classifyInbound("stop texting me");
    expect(result.intent).toBe("probable_stop");
    expect(suppressesMarketing(result)).toBe(true);
    expect(result.needsReview).toBe(true);
  });

  it("does not suppress ordinary messages that merely mention products", () => {
    for (const body of [
      "when will BPC-157 be back in stock",
      "thanks!",
      "can I change my shipping address",
      "what is the purity on this batch",
      "do you ship to Canada",
    ]) {
      const result = classifyInbound(body);
      expect(suppressesMarketing(result), `${body} should not suppress`).toBe(false);
    }
  });
});

describe("YES is ambiguous, and the message cannot resolve it", () => {
  it("confirms a pending double opt-in", () => {
    const result = classifyInbound("YES", { confirmationPending: true });
    expect(result.intent).toBe("confirm");
  });

  it("resumes when nothing is pending", () => {
    const result = classifyInbound("YES", { confirmationPending: false });
    expect(result.intent).toBe("start");
  });

  it("resolves by CONTEXT, not by the word — the same text, two intents", () => {
    // This is the whole reason `confirmationPending` is a parameter. Reading
    // YES from the text alone gets a confirmation reply recorded as a
    // resubscribe, which would then demand a fresh consent the customer has
    // already given.
    expect(classifyInbound("yes", { confirmationPending: true }).intent).toBe("confirm");
    expect(classifyInbound("yes", { confirmationPending: false }).intent).toBe("start");
  });

  it("flags JOIN with nothing pending rather than acting on it", () => {
    // Someone trying to sign up by text. There is no disclosure in a text
    // message, so this cannot be consent — a human should see it.
    const result = classifyInbound("JOIN");
    expect(result.intent).toBe("unknown");
    expect(result.needsReview).toBe(true);
  });
});

describe("START and HELP", () => {
  it.each(["START", "start", "UNSTOP"])("treats %s as a resume request", (body) => {
    expect(classifyInbound(body).intent).toBe("start");
  });

  it("does not itself resume anything — the state machine owns the cooldown", () => {
    // classifyInbound reports intent. Whether the resume is ALLOWED is
    // transition()'s decision, and it enforces the 30-day cooldown.
    expect(classifyInbound("START").intent).toBe("start");
  });

  it.each(["HELP", "help", "INFO", "info."])("treats %s as help", (body) => {
    expect(classifyInbound(body).intent).toBe("help");
  });
});

describe("unrecognised messages", () => {
  it("are never auto-replied to", () => {
    const result = classifyInbound("is this a real company");
    expect(result.intent).toBe("unknown");
    expect(result.needsReview).toBe(false);
  });

  it("handle empty and whitespace-only bodies without throwing", () => {
    for (const body of ["", "   ", "\n", "..."]) {
      expect(classifyInbound(body).intent).toBe("unknown");
    }
  });

  it("survive junk input", () => {
    expect(() => classifyInbound(undefined as unknown as string)).not.toThrow();
    expect(() => classifyInbound(null as unknown as string)).not.toThrow();
  });
});

describe("a longer message containing STOP is still a stop", () => {
  it("does not require STOP to be the whole message", () => {
    // A person writing a sentence is still revoking. The exact-match tier
    // misses this; the free-text tier is what catches it.
    const result = classifyInbound("I would like you to stop sending these");
    expect(suppressesMarketing(result)).toBe(true);
  });

  it("catches STOP inside a sentence with other words around it", () => {
    expect(suppressesMarketing(classifyInbound("hey stop"))).toBe(true);
  });
});

describe("the replies", () => {
  it("HELP fits one GSM-7 segment, so it never costs two", () => {
    const reply = helpReply({ brandName: "Vanta Labs", helpContact: "support@vantalabsresearch.com" });
    expect(reply.length).toBeLessThanOrEqual(160);
  });

  it("HELP always states how to opt out", () => {
    const reply = helpReply({ brandName: "Vanta Labs", helpContact: "support@vantalabsresearch.com" });
    expect(reply).toContain("STOP");
  });

  it("HELP works with no contact configured rather than rendering an empty gap", () => {
    const reply = helpReply({ brandName: "Vanta Labs", helpContact: "" });
    expect(reply).toContain("STOP");
    expect(reply).not.toContain("Help: ");
  });

  it("the stop confirmation states that messages have ended", () => {
    const reply = stopReply({ brandName: "Vanta Labs" });
    expect(reply.toLowerCase()).toContain("unsubscribed");
    expect(reply.length).toBeLessThanOrEqual(160);
  });

  it("falls back to the brand name rather than rendering blank", () => {
    expect(helpReply({ brandName: "", helpContact: "" })).toContain("Vanta Labs");
    expect(stopReply({ brandName: "  " })).toContain("Vanta Labs");
  });
});
