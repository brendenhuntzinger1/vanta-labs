import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// ONE SALE, ONE CONVERSION — GUARDED BY A CLAIM, NOT BY A READ.
//
// /api/ads/purchase-event/[orderId] is not a read. Being asked is what sends the
// server-side TikTok and Reddit conversions. It gated those sends on a SELECT of
// ad_purchase_events_sent, which is check-then-act: two requests that arrive
// together both see an empty ledger, both send, and both then write the row —
// leaving a ledger that looks exactly as if everything had worked.
//
// Two asks are the normal shape of a card order, not an edge case. The
// confirmation page asks on mount and asks again when the payment poll announces
// the order paid. On the second real production order the two landed 27 seconds
// apart (03:36:16 and 03:36:43) and only TikTok's own 48-hour dedup on the shared
// event id absorbed it; a link reopened a week later would not be absorbed, and
// Reddit has no such window.
//
// The table is PRIMARY KEY (order_id, platform), so an INSERT is the claim:
// exactly one caller creates the row, the loser gets 23505 and sends nothing.
//
// The browser side had the mirror-image hole: its in-flight guard was a ref set
// AFTER the response came back, so an announcement arriving while the first
// request was still open started a second one.
// ---------------------------------------------------------------------------

const ROUTE = readFileSync(join(process.cwd(), "src/app/api/ads/purchase-event/[orderId]/route.ts"), "utf8");
const COMPONENT = readFileSync(join(process.cwd(), "src/components/tiktok-purchase-event.tsx"), "utf8");

describe("the server claims the send before making it", () => {
  it("inserts the ledger row as the claim, rather than upserting after the fact", () => {
    expect(ROUTE).toMatch(/const claimSend = async/);
    expect(ROUTE).toMatch(/from\("ad_purchase_events_sent"\)\.insert\(/);
  });

  it("treats a unique violation as 'someone else has it', not as an error", () => {
    expect(ROUTE).toMatch(/=== "23505"\) return false/);
  });

  it("gates BOTH platforms on the claim, not on the earlier read alone", () => {
    expect(ROUTE).toMatch(/await claimSend\("reddit"/);
    expect(ROUTE).toMatch(/await claimSend\("tiktok"/);
  });

  it("hands the claim back when the send never happened", () => {
    // Otherwise a thrown send leaves a permanent delivered:false row and the
    // conversion is lost forever — a duplicate traded for a disappearance.
    expect(ROUTE).toMatch(/const releaseSend = async/);
    expect(ROUTE).toMatch(/await releaseSend\("reddit"\)/);
    expect(ROUTE).toMatch(/await releaseSend\("tiktok"\)/);
    // Only an undelivered claim may be released — never a recorded success.
    const release = ROUTE.slice(ROUTE.indexOf("const releaseSend = async"), ROUTE.indexOf("};", ROUTE.indexOf("const releaseSend = async")));
    expect(release).toMatch(/\.eq\("delivered", false\)/);
  });

  it("fails OPEN on a ledger it cannot write", () => {
    // The ledger is not the source of truth for anything. Losing a real
    // conversion to protect against a duplicate is the wrong way round.
    const claim = ROUTE.slice(ROUTE.indexOf("const claimSend = async"), ROUTE.indexOf("const releaseSend = async"));
    expect(claim).toMatch(/catch \{\s*return true;/);
  });

  it("still records the outcome, so a rejected send is distinguishable later", () => {
    expect(ROUTE).toMatch(/await recordSend\("tiktok", event\.eventId, outcome\.delivered/);
    expect(ROUTE).toMatch(/await recordSend\("reddit", redditEventId, redditOutcome\.delivered/);
  });

  it("never sends on ?inspect=1, which must not change what it measures", () => {
    // The inspect branch returns before either send block.
    expect(ROUTE.indexOf("if (inspect)")).toBeLessThan(ROUTE.indexOf('await claimSend("reddit"'));
  });
});

describe("the browser holds an in-flight guard, not a post-response one", () => {
  it("refuses an overlapping attempt", () => {
    expect(COMPONENT).toMatch(/const inFlight = useRef\(false\)/);
    expect(COMPONENT).toMatch(/if \(settled\.current \|\| inFlight\.current \|\| !orderId\) return;/);
  });

  it("claims it BEFORE the request", () => {
    const claimAt = COMPONENT.indexOf("inFlight.current = true");
    const fetchAt = COMPONENT.indexOf("await fetch(`/api/ads/purchase-event/");
    expect(claimAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(fetchAt);
  });

  it("releases it afterwards, so an UNPAID order stays askable", () => {
    // The confirmation page opens while the webhook is still landing. A guard
    // that stuck on a "not yet" would suppress the conversion for a purchase
    // that settles a second later.
    expect(COMPONENT).toMatch(/finally \{\s*inFlight\.current = false;/);
  });

  it("keeps the localStorage key as the durable guard across mounts", () => {
    expect(COMPONENT).toMatch(/purchase-request:\$\{orderId\}/);
    expect(COMPONENT).toMatch(/store\.mark\(requestKey\)/);
  });
});
