// How the BUSINESS actually sent an ambassador their money.
//
// This is deliberately a superset of AMBASSADOR_PAYOUT_METHODS (partner-portal):
// that list is what an ambassador can ASK for from their dashboard, and it is
// kept short so a handle can be validated per app. The owner, on the other
// hand, pays by whatever is to hand — Zelle to a phone number, cash at the
// counter — and a payout record that says "Cash App" when the money went by
// Zelle is a record that cannot be reconciled against a bank statement.
//
// Pure: no imports, so the admin dialog (a client component) and the payout
// writer (server) read the same list.

export const PAYOUT_CHANNELS = ["paypal", "venmo", "cashapp", "zelle", "cash", "other"] as const;
export type PayoutChannel = (typeof PAYOUT_CHANNELS)[number];

export const PAYOUT_CHANNEL_LABELS: Record<PayoutChannel, string> = {
  paypal: "PayPal",
  venmo: "Venmo",
  cashapp: "Cash App",
  zelle: "Zelle",
  cash: "Cash",
  other: "Other",
};

export function isPayoutChannel(value: string): value is PayoutChannel {
  return (PAYOUT_CHANNELS as readonly string[]).includes(value);
}

/**
 * Human label for a stored payout method. Unknown values (a legacy string
 * written before the list existed) come back as typed rather than as nothing,
 * so an old record still says what it said.
 */
export function payoutChannelLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return isPayoutChannel(normalized) ? PAYOUT_CHANNEL_LABELS[normalized] : value;
}

/** "Cash App · $flavia", "Zelle", or null when nothing is on file. */
export function describePayoutDestination(method: string | null | undefined, handle: string | null | undefined): string | null {
  const label = payoutChannelLabel(method);
  if (!label) return null;
  const trimmedHandle = handle?.trim();
  return trimmedHandle ? `${label} · ${trimmedHandle}` : label;
}
