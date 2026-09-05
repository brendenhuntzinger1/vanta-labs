import { describe, expect, it } from "vitest";

import { validatePayoutHandle } from "@/lib/payout-handle-validation";

// ---------------------------------------------------------------------------
// A PAYOUT DESTINATION IS CHECKED FOR SHAPE BEFORE IT IS SAVED.
//
// updatePartnerPayoutMethod accepted any non-empty string, so a PayPal
// destination of "not-an-email" was saved as success and the next payout
// cycle had nowhere real to send the money. (AA-4)
// ---------------------------------------------------------------------------

describe("validatePayoutHandle", () => {
  it("PayPal needs an email address", () => {
    expect(validatePayoutHandle("paypal", "not-an-email")).toMatchObject({ ok: false });
    expect(validatePayoutHandle("paypal", "  pay@example.com ")).toEqual({ ok: true, handle: "pay@example.com" });
  });

  it("Venmo takes a username with or without the @", () => {
    expect(validatePayoutHandle("venmo", "@Jane_Doe-1")).toMatchObject({ ok: true });
    expect(validatePayoutHandle("venmo", "jane doe")).toMatchObject({ ok: false });
  });

  it("Cash App takes a $cashtag that starts with a letter", () => {
    expect(validatePayoutHandle("cashapp", "$janedoe")).toMatchObject({ ok: true });
    expect(validatePayoutHandle("cashapp", "$1234")).toMatchObject({ ok: false });
  });

  it("refuses an empty handle and an unknown method", () => {
    expect(validatePayoutHandle("paypal", "   ")).toMatchObject({ ok: false });
    expect(validatePayoutHandle("wire", "anything")).toMatchObject({ ok: false });
  });
});
