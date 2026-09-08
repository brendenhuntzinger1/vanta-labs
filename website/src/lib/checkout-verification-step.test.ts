import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { classifyDeadSession, describePaymentStatus } from "@/lib/payment-failure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PAY_PAGE = "src/app/checkout/pay/[orderId]/VeyraCheckout.tsx";

// ---------------------------------------------------------------------------
// THE VERIFICATION STEP — the one the card lane never handled.
//
// On 2026-09-08 two shoppers lost five orders between them (~$620) to the same
// wall. A customer described it exactly: the form said "additional verification
// needed" and there was nothing to do. That is 3-D Secure, and Veyra announces
// it — the card lane simply never listened.
//
// Veyra's checkout.js v1.2.0 documents its callbacks in its own header:
//
//     onReady, onResize, onSuccess, onFailure, onRequiresAction, onCancel
//
// and dispatches them from `data.type`:
//
//     payment.succeeded       -> opts.onSuccess
//     payment.failed          -> opts.onFailure
//     payment.requires_action -> opts.onRequiresAction   // "3DS started (v1.1)"
//     cancel                  -> opts.onCancel
//
// `onError` is not among them and appears nowhere in the SDK. We passed it
// anyway, so the decline banner it guarded had never once fired: every real
// failure fell through to the 30-minute reconcile sweep, which recorded it as
// "Declined by bank / processor" — a bank that was never asked.
//
// These tests pin the contract against the SDK rather than against our
// assumptions about it. Anything not on SDK_CALLBACKS is a callback that will
// be silently ignored at the moment of payment.
// ---------------------------------------------------------------------------

/** Every callback veyragate.com/v1/checkout.js v1.2.0 will actually invoke. */
const SDK_CALLBACKS = [
  "onReady",
  "onResize",
  "onSuccess",
  "onFailure",
  "onRequiresAction",
  "onCancel",
] as const;

const page = read(PAY_PAGE);

/** The options object literal handed to Veyra.mount, and nothing else. */
const mountOptions = (() => {
  const start = page.indexOf("Veyra.mount(");
  expect(start).toBeGreaterThan(-1);
  const end = page.indexOf("\n        });", start);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
})();

/** Callback keys we actually register on the mount call. */
const registered = [...mountOptions.matchAll(/^\s{10}(on[A-Z][A-Za-z]*)\s*:/gm)].map((m) => m[1]);

describe("the mount call speaks the SDK's actual vocabulary", () => {
  it("registers only callbacks the SDK will really invoke", () => {
    // The whole defect in one assertion: `onError` is not an SDK callback, so
    // passing it is the same as passing nothing at all.
    for (const name of registered) {
      expect(SDK_CALLBACKS).toContain(name);
    }
  });

  it("never registers the phantom onError", () => {
    expect(registered).not.toContain("onError");
    expect(mountOptions).not.toMatch(/\bonError\s*:/);
  });

  it("handles the verification step the shopper actually hit", () => {
    expect(registered).toContain("onRequiresAction");
  });

  it("handles a real payment failure at the moment it happens", () => {
    // Without this the only failure signal is the reconcile sweep, up to half
    // an hour later, by which time the shopper has long gone.
    expect(registered).toContain("onFailure");
  });

  it("handles the shopper cancelling", () => {
    expect(registered).toContain("onCancel");
  });

  it("declares the same set in its TypeScript type, so a typo cannot compile", () => {
    const typeStart = page.indexOf("type VeyraGlobal");
    // \b matters: without it `sessionId:` yields a phantom "onId".
    const declared = [...page.slice(typeStart, page.indexOf("function loadScript")).matchAll(/\b(on[A-Z][A-Za-z]*)\??\s*:/g)]
      .map((m) => m[1]);
    for (const name of declared) {
      expect(SDK_CALLBACKS).toContain(name);
    }
    // Every callback we register must be declared, or TS would reject it.
    for (const name of registered) {
      expect(declared).toContain(name);
    }
  });
});

describe("what the shopper is told while their bank is asking", () => {
  const branchStart = mountOptions.indexOf("onRequiresAction");
  const branch = branchStart === -1 ? "" : mountOptions.slice(branchStart);
  // The constant is a `+`-concatenated literal across several lines, so join
  // every segment — reading only the first would let half the instruction go
  // missing while these assertions still passed.
  const copy = (() => {
    const start = page.indexOf("const VERIFICATION_MESSAGE");
    if (start === -1) return "";
    const decl = page.slice(start, page.indexOf(";\n", start));
    return [...decl.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
  })();

  it("puts the page into an explicit verifying state", () => {
    expect(branch).toMatch(/setVerifying\(true\)/);
  });

  it("is a real sentence, not an empty match", () => {
    expect(copy.length).toBeGreaterThan(40);
  });

  it("tells them a verification step is what is being asked of them", () => {
    expect(copy).toMatch(/verif|confirm/i);
  });

  it("tells them not to close or refresh mid-verification", () => {
    // The one instruction that saves the order: refreshing kills the challenge.
    expect(copy).toMatch(/close|refresh|leave/i);
  });

  it("never names the payment processor to the shopper", () => {
    expect(copy).not.toMatch(/veyra/i);
  });

  it("never tells them to pay again while a charge may be in flight", () => {
    expect(copy).not.toMatch(/try again|pay again|resubmit/i);
  });

  it("renders ABOVE the card form, where the shopper is already looking", () => {
    // At 390x844 the card container's 420px minimum pushed this off the bottom
    // of the screen, so the instruction had to be scrolled to — which is the
    // dead end being fixed, not a fix for it. The decline banner was already
    // above the form; this now matches it.
    const banner = page.indexOf("{verifying && status !==");
    const form = page.indexOf('id="secure-card-entry"');
    expect(banner).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(-1);
    expect(banner).toBeLessThan(form);
  });

  it("points at the form in the direction it is actually in", () => {
    expect(copy).toMatch(/form below/i);
    expect(copy).not.toMatch(/form above/i);
  });

  it("does not promise a verification step that may never appear", () => {
    // A real shopper's screenshot: the iframe printed "Additional verification
    // is required for this payment", greyed out its own pay button, and offered
    // no code field, no bank app and no redirect. Copy that instructs him to
    // finish a step he cannot see reads as his mistake rather than ours.
    expect(copy).toMatch(/\bif\b/i);
    expect(copy).not.toMatch(/finish the verification step in the form/i);
  });

  it("tells them what to do when nothing appears", () => {
    expect(copy).toMatch(/nothing appears|does not appear|doesn't appear/i);
    expect(copy).toMatch(/different card|contact/i);
  });
});

describe("the loading line cannot outlive the form it describes", () => {
  it("does not hang the loading state on onReady alone", () => {
    // That screenshot also showed "Loading secure card entry…" still on the
    // page while the card form beneath it was rendered and typed into. Only
    // onReady clears it, so on that session no iframe message reached the page
    // at all. The channel is Veyra's to explain; the page claiming to be
    // loading a form the customer is using is ours.
    expect(page).toMatch(/READY_FALLBACK_MS/);
    expect(page).toMatch(/setTimeout\(\s*\(\)\s*=>\s*\{[^}]*current === "loading"/);
  });

  it("the fallback only ever promotes loading, never paints over an error", () => {
    const guard = page.slice(page.indexOf("readyFallback = window.setTimeout"));
    expect(guard.slice(0, 300)).toMatch(/current === "loading" \? "ready" : current/);
  });

  it("clears the fallback timer on unmount", () => {
    expect(page).toMatch(/window\.clearTimeout\(readyFallback\)/);
  });
});

describe("a stalled verification is never reported to the shopper as a bank decline", () => {
  it("keeps the processor's own words when it actually sent some", () => {
    const detail = classifyDeadSession("failed", {
      status: "failed",
      last_error: { code: "do_not_honor", message: "Do not honor" },
    });
    expect(detail.kind).toBe("processor_declined");
    expect(detail.code).toBe("do_not_honor");
  });

  it("does NOT claim the bank declined when the session carries no decline at all", () => {
    // The exact shape of Andrew's and David's five orders. Veyra's SDK states
    // outright that it "intentionally does not expose decline_code", and a
    // shopper who abandons a 3DS challenge lands here too — so a bare `failed`
    // is not evidence that any bank refused anything.
    const detail = classifyDeadSession("failed", { status: "failed" });
    expect(detail.kind).not.toBe("processor_declined");
    expect(describePaymentStatus("payment_failed", detail.kind).label).not.toMatch(/declined by bank/i);
  });

  it("says plainly that the reason is unknown rather than inventing one", () => {
    const detail = classifyDeadSession("failed", { status: "failed" });
    expect(detail.reason).toMatch(/not complet|did not complete|no reason|unknown|not recorded/i);
    expect(detail.reason).not.toMatch(/\bbank (declined|refused|said no)\b/i);
  });

  it("still records that the attempt failed, so the order is retired either way", () => {
    const detail = classifyDeadSession("failed", { status: "failed" });
    expect(detail.code).toBe("failed");
    expect(detail.reason).toBeTruthy();
  });
});
