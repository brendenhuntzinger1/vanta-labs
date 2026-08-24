import { createHash } from "crypto";

// -------------------------------------------------------------------------
// Pure wallet-lane math and rules, deliberately free of any server/DB import
// (same reasoning as shipping.ts / bundle-pricing.ts: ONE formula, not two
// hand-synced copies). The express endpoints all go through these, and so do
// the unit tests — the anti-tamper argument for this lane is only as good as
// these functions, so they are exercised directly.
// -------------------------------------------------------------------------

/**
 * The wallet lane's shipping method id that must NEVER be honoured.
 *
 * The processor's wallet rate lookup FAILS OPEN: when its callback to us
 * errors, times out, or returns something its validator rejects, it substitutes
 * a $0 shipping / $0 tax method under this id and returns 200. Critically, the
 * fail-open branches SKIP its cache write, so its locked-rates cache still
 * holds the PREVIOUS address's numbers — accepting this id would charge one
 * address's tax against another's, or no shipping and no tax at all. It is
 * refused twice: client-side before the row can render in the Apple sheet, and
 * server-side at authorize.
 */
export const VEYRA_FALLBACK_SHIPPING_METHOD_ID = "veyra_fallback_free";

/** The processor rejects a whole rates response whose tax exceeds this. */
export const MAX_TAX_AMOUNT_CENTS = 100_000;

/** The processor's floor for `amount_cents`. Reachable here via store credit. */
export const MIN_SESSION_AMOUNT_CENTS = 50;

/** Wallet sessions are short-lived; the sheet is re-armed if one goes stale. */
export const EXPRESS_SESSION_MINUTES = 15;

/**
 * Bumped whenever the acknowledgement wording changes, so a stored consent
 * stays attributable to the exact text the shopper was shown.
 *
 * 2026-08-25 consolidated the three research/compliance statements into ONE
 * and made both remaining boxes start ticked. A consent stamped with an
 * earlier version was agreed under different wording AND under a different
 * default, so the version is what distinguishes them — never assume an older
 * record means the same thing this one does.
 */
export const COMPLIANCE_COPY_VERSION = "2026-08-25";

/**
 * The two statements a purchase requires. Their wording, and the fact that
 * they render pre-ticked, live in @/lib/checkout-confirmations — this is the
 * shape the server validates.
 */
export interface ComplianceAcknowledgements {
  /**
   * Research & Compliance — 21+, legally permitted, laboratory research only,
   * NOT for human or veterinary use, and the Research Disclaimer incorporated
   * by reference. Consolidated from three separate statements.
   */
  researchCompliance: boolean;
  /**
   * Return & Reimbursement Policy — the 14-day window, the intact factory
   * seal, and the requirement to contact support BEFORE sending anything back.
   * Recorded because a return dispute turns on what the shopper agreed to at
   * the moment of purchase.
   */
  returnsPolicy: boolean;
}

// Strictly `true`, never merely truthy: this is a legal consent record, and a
// "1" or "yes" arriving from a crafted request must not stand in for a tick.
//
// This matters MORE now that the boxes render pre-ticked, not less. The
// default lives in the UI; it grants the server nothing. A shopper who unticks
// a box submits `false` and is refused here, so the control the shopper is
// offered is real rather than decorative.
export function hasAllAcknowledgements(value: unknown): value is ComplianceAcknowledgements {
  if (!value || typeof value !== "object") return false;
  const ack = value as Record<string, unknown>;
  return ack.researchCompliance === true && ack.returnsPolicy === true;
}

/** The partial contact Apple exposes BEFORE authorization (address redacted). */
export interface WalletPartialContact {
  country?: string | null;
  state?: string | null;
  city?: string | null;
  postal_code?: string | null;
}

/** The full contact Apple hands over WITH the authorization. */
export interface WalletContact extends WalletPartialContact {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address1?: string | null;
  address2?: string | null;
}

// Computed identically at callback time (partial redacted contact) and at
// authorize time (full wallet contact). ONLY the four fields Apple surfaces in
// BOTH phases may participate — address lines are redacted pre-auth, so folding
// them in would make the two fingerprints disagree for the same address and
// refuse every legitimate charge.
// Postal is normalised to 5 alphanumerics because Apple may return ZIP+4 in the
// final contact and ZIP5 in the redacted one; CA "K1A 0B1" -> "K1A0B".
export function addressFingerprint(c: WalletPartialContact): string {
  const norm = [
    (c.country ?? "").toUpperCase().trim(),
    (c.state ?? "").toUpperCase().trim(),
    (c.city ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
    (c.postal_code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5),
  ].join("|");
  return createHash("sha256").update(norm).digest("hex");
}

/**
 * The shipping method id offered to the wallet, BOUND to the address.
 *
 * The processor's wallet anti-tamper compares only the method id and the
 * reported shipping amount — nothing compares tax. Its rates cache is a
 * read-modify-write of a whole JSONB blob with no optimistic concurrency, and
 * Apple fires the address handler on every edit, so with a constant id two
 * out-of-order commits both pass anti-tamper while charging address A's sales
 * tax against address B. US rates run 0–11.5%. Binding the id to the address
 * turns that race into a hard refusal on both sides instead of a silent
 * mischarge.
 *
 * `vl_std_` + 12 hex = 19 chars, well inside the processor's 80-char /
 * [A-Za-z0-9_-] id rules.
 */
export function shippingMethodId(fingerprint: string): string {
  return `vl_std_${fingerprint.slice(0, 12)}`;
}

/** The fingerprint prefix embedded in one of our ids, or null if not ours. */
export function fingerprintFromShippingMethodId(id: string): string | null {
  const match = /^vl_std_([0-9a-f]{12})$/.exec(id);
  return match ? match[1] : null;
}

/** Constant-time secret compare that tolerates unequal lengths. */
export function secretsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aHash = createHash("sha256").update(a).digest();
  const bHash = createHash("sha256").update(b).digest();
  let diff = 0;
  for (let i = 0; i < aHash.length; i += 1) {
    diff |= aHash[i] ^ bHash[i];
  }
  return diff === 0;
}

/**
 * Cardholder name, recovered across every source Apple might have populated.
 *
 * Apple returns an empty family name on a meaningful share of orders (the bank
 * didn't push billing identity during card provisioning). Ported from the
 * reference wallet implementation: billing contact, then shipping contact, then
 * a whitespace split of a single-field name, then a conservative
 * `firstname.lastname@` email heuristic. Never substitutes a placeholder — an
 * unresolved name is refused at validateCustomer rather than invented.
 */
export function resolveWalletName(input: {
  billing?: { firstName?: string | null; lastName?: string | null } | null;
  shipping?: { firstName?: string | null; lastName?: string | null } | null;
  email?: string | null;
}): { firstName: string; lastName: string } {
  const trim = (s: string | null | undefined) => String(s ?? "").trim();
  const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : "");

  let firstName = trim(input.billing?.firstName) || trim(input.shipping?.firstName);
  let lastName = trim(input.billing?.lastName) || trim(input.shipping?.lastName);

  // Some banks put "John Smith" in givenName and leave familyName empty.
  if (firstName && !lastName && /\s/.test(firstName)) {
    const parts = firstName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      firstName = parts[0];
      lastName = parts.slice(1).join(" ");
    }
  }

  // Last resort: a dot-separated email local part. Conservative on purpose —
  // it only fires when the local part is unambiguous.
  const email = trim(input.email);
  if (firstName && !lastName && email.includes("@")) {
    const local = email.split("@")[0] ?? "";
    if (local.includes(".")) {
      const parts = local.toLowerCase().split(".");
      const firstIndex = parts.findIndex((p) => p === firstName.toLowerCase());
      const candidate = firstIndex !== -1 ? parts[firstIndex + 1] : parts.length === 2 ? parts[1] : undefined;
      const cleaned = (candidate ?? "").replace(/\d+$/, "");
      if (cleaned.length >= 2) {
        lastName = cap(cleaned);
      }
    }
  }

  return { firstName, lastName };
}
