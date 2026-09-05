// ---------------------------------------------------------------------------
// THE SHAPE OF A PAYOUT DESTINATION, CHECKED ON THE SERVER.
//
// updatePartnerPayoutMethod accepted any non-empty string as the handle, so a
// PayPal destination of "not-an-email" was saved as success, the ambassador
// read "Saved. We'll pay you here on the next cycle.", and the next payout run
// had nowhere real to send the money. The dashboard hints already say what each
// method wants ("PayPal email", "@username", "$cashtag"); this holds the same
// line where it cannot be bypassed.
//
// Deliberately LOOSE inside each shape. The point is to refuse a handle of the
// wrong kind — an email in the Venmo field, a username in the PayPal field,
// spaces anywhere — not to re-implement each platform's username rules and
// reject a real handle on a detail this file remembered wrong.
//
// Pure and dependency-free so the same check can run in a form later.
// ---------------------------------------------------------------------------

export type PayoutHandleCheck = { ok: true; handle: string } | { ok: false; error: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Venmo: optional leading @, then letters, digits, "-", "_" or "."; no spaces, no @ inside. */
const VENMO_USERNAME = /^@?[A-Za-z0-9_.-]{2,30}$/;
/** Cash App: optional leading $, then a letter, then letters, digits, "-", "_" or "."; no spaces. */
const CASHTAG = /^\$?[A-Za-z][A-Za-z0-9_.-]{0,29}$/;

export function validatePayoutHandle(method: string, handle: string): PayoutHandleCheck {
  const trimmed = String(handle ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: "Enter your payout username, email, or handle." };
  }
  switch (method) {
    case "paypal":
      return EMAIL.test(trimmed)
        ? { ok: true, handle: trimmed }
        : { ok: false, error: "Enter the email address on your PayPal account (like name@example.com)." };
    case "venmo":
      return VENMO_USERNAME.test(trimmed)
        ? { ok: true, handle: trimmed }
        : { ok: false, error: "Enter your Venmo username (like @username) — letters, numbers, hyphens, underscores and periods only, no spaces." };
    case "cashapp":
      return CASHTAG.test(trimmed)
        ? { ok: true, handle: trimmed }
        : { ok: false, error: "Enter your $cashtag (like $username) — it starts with a letter and has no spaces." };
    default:
      return { ok: false, error: "Choose a valid payout method: PayPal, Venmo, or Cash App." };
  }
}
