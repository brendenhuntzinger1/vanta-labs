import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// ONE ORDER, ONE LIVE CARD FORM.
//
// resumeExistingOrder mints a BRAND NEW processor session every time an
// unpaid order is resumed, and repoints orders.payment_id at it. Nothing on our
// side voids the session it replaced, and whether the processor does is not
// something we can see from here.
//
// The pay page checked only whether the order was already CAPTURED. It never
// compared the `cs` in the URL against the session the order is actually on. So
// a tab still holding the superseded link — a second tab, a back button, a
// restored session, an older email — kept a fully working card form for an
// unpaid order, alongside the new one. Two live forms, one order, and the only
// thing standing between that and two real charges was the customer not paying
// twice.
//
// The audit's duplicate-capture alert catches that AFTER the money has moved.
// This stops it happening: a superseded session is sent to the order's current
// one, so however many tabs a shopper has open they all collapse onto a single
// session. A processor refuses a second capture on one session; it cannot
// refuse two captures on two sessions, because that is two legitimate payments
// as far as it can tell.
//
// THE GUARD MUST STAY NARROW. A shopper with a real payment to make has to
// reach the form. It refuses only when the order positively names a DIFFERENT
// live session; a missing payment_id, or a read that failed, still renders.
// ---------------------------------------------------------------------------

const PAGE = readFileSync(join(process.cwd(), "src/app/checkout/pay/[orderId]/page.tsx"), "utf8");
const code = PAGE.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");

describe("the pay page serves one live session per order", () => {
  it("reads the order's current session, not just its status", () => {
    expect(code).toMatch(/select\("payment_status, payment_id"\)/);
  });

  it("sends a superseded session to the order's current one", () => {
    expect(code).toMatch(/currentSessionId/);
    expect(code).toMatch(/redirect\(\s*`\/checkout\/pay\/\$\{encodeURIComponent\(orderId\)\}\?cs=\$\{encodeURIComponent\(currentSessionId\)\}`/);
  });

  it("only refuses when the order positively names a different session", () => {
    // Never on a missing payment_id, and never on a read that failed — either
    // would strand a shopper who genuinely has a payment to make.
    expect(code).toMatch(/currentSessionId && currentSessionId !== cs/);
  });

  it("checks captured FIRST, so a paid order still goes to its receipt", () => {
    // Order matters: a paid order's payment_id is the session that paid, so the
    // superseded check would otherwise bounce it around instead of showing the
    // receipt.
    expect(code.indexOf("alreadyCaptured")).toBeLessThan(code.indexOf("currentSessionId !== cs"));
  });

  it("keeps both redirects OUTSIDE the try, because redirect signals by throwing", () => {
    // The existing comment in this file explains it: a redirect inside the try
    // is swallowed by its own catch and the page falls through to rendering the
    // card form — the exact bug, hidden behind error handling that looks careful.
    const tryBlock = code.slice(code.indexOf("try {"), code.indexOf("if (alreadyCaptured)"));
    expect(tryBlock).not.toMatch(/redirect\(/);
  });

  it("still renders the form for the session the order is actually on", () => {
    expect(code).toMatch(/<VeyraCheckout sessionId=\{cs\} orderId=\{orderId\} \/>/);
  });
});

describe("the thing that makes this necessary is still true", () => {
  it("resumeExistingOrder mints a fresh session and repoints the order at it", () => {
    const service = readFileSync(join(process.cwd(), "src/lib/payment-service.ts"), "utf8");
    expect(service).toMatch(/const resumed = await provider\.createCheckoutSession\(/);
    expect(service).toMatch(/payment_id: resumed\.paymentId/);
  });
});
