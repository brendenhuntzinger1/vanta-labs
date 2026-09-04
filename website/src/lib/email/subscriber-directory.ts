// No `server-only` on the pure part: the merge is a function over plain rows so
// it can be tested without a database, and the client component imports only
// the types. The loader below is what touches Supabase and is server-only by
// virtue of importing supabaseAdmin.

/**
 * WHO IS ON THE LIST, AND WHY — one row per address.
 *
 * Consent lives in two places (an account preference, or an email-keyed
 * opt-in from checkout or signup) and leaving lives in a third
 * (email_suppressions, written by the unsubscribe link, the account toggle
 * and the provider's bounce/complaint webhook). Every audience in the app
 * already reconciles those three; this reconciles them for a person reading a
 * list, so "why is this address here" and "why did it stop getting mail" have
 * one answer each.
 */

export type SubscriberStatus = "subscribed" | "unsubscribed" | "bounced" | "complained";

export type SubscriberRow = {
  email: string;
  /** Where the consent came from: 'account', 'checkout', 'signup', or another recorded source. */
  source: string;
  /** ISO time the person opted in, or the account was created. */
  since: string | null;
  status: SubscriberStatus;
  /** Which message carried the unsubscribe link they used, when recorded. */
  unsubscribedFrom: string | null;
  /** ISO time of the suppression, if any. */
  leftAt: string | null;
};

export type SubscriberDirectory = {
  rows: SubscriberRow[];
  counts: Record<SubscriberStatus, number>;
  /** True when a read hit its ceiling and the list is not the whole picture. */
  truncated: boolean;
};

const SOURCE_LABELS: Record<string, string> = {
  account: "Account preference",
  checkout: "Checkout opt-in",
  signup: "Signup opt-in",
  // Never subscribed: reached only by cart recovery (an existing-customer
  // message), then opted out of that. Named so the owner does not read an
  // "Unknown" as a data problem.
  cart_recovery: "Cart recovery only",
};

export function describeSubscriberSource(source: string): string {
  return SOURCE_LABELS[source] ?? (source ? source.replace(/_/g, " ") : "Unknown");
}

function normalize(email: unknown): string {
  return String(email ?? "").trim().toLowerCase();
}

function statusFromReason(reason: string): SubscriberStatus {
  const value = reason.toLowerCase();
  if (value === "complained") return "complained";
  if (value === "bounced" || value.startsWith("soft_bounce")) return "bounced";
  return "unsubscribed";
}

/**
 * Pure merge, exported for tests.
 *
 * Rules, in order:
 *   * a suppression row wins over any consent row — the person left, and the
 *     list must say so whatever the consent stores still hold;
 *   * a guest opt-in that later became an account keeps the EARLIER of the two
 *     "since" dates and the source that came first;
 *   * addresses that only ever appear as suppressed (a bounce on a receipt,
 *     say) are listed too, because the owner asked who is NOT getting mail as
 *     much as who is.
 */
export function mergeSubscriberDirectory(input: {
  accounts: Array<{ email: string; createdAt: string | null }>;
  subscribers: Array<{ email: string; source: string | null; optedInAt: string | null; unsubscribedAt: string | null }>;
  suppressions: Array<{ email: string; reason: string | null; source: string | null; createdAt: string | null }>;
  truncated?: boolean;
}): SubscriberDirectory {
  const rows = new Map<string, SubscriberRow>();

  const consent = (email: string, source: string, since: string | null) => {
    if (!email) return;
    const existing = rows.get(email);
    if (!existing) {
      rows.set(email, { email, source, since, status: "subscribed", unsubscribedFrom: null, leftAt: null });
      return;
    }
    // Keep whichever consent came first: that is when the relationship began.
    if (since && (!existing.since || since < existing.since)) {
      existing.since = since;
      existing.source = source;
    }
  };

  for (const account of input.accounts) consent(normalize(account.email), "account", account.createdAt);
  for (const subscriber of input.subscribers) {
    const email = normalize(subscriber.email);
    // A guest row with unsubscribed_at set is an older way of leaving;
    // email_suppressions is authoritative, but honour this too.
    if (subscriber.unsubscribedAt) {
      const existing = rows.get(email);
      if (!existing) {
        rows.set(email, { email, source: subscriber.source ?? "checkout", since: subscriber.optedInAt, status: "unsubscribed", unsubscribedFrom: null, leftAt: subscriber.unsubscribedAt });
      }
      continue;
    }
    consent(email, subscriber.source ?? "checkout", subscriber.optedInAt);
  }

  for (const suppression of input.suppressions) {
    const email = normalize(suppression.email);
    if (!email) continue;
    const status = statusFromReason(String(suppression.reason ?? ""));
    const existing = rows.get(email);
    if (existing) {
      existing.status = status;
      existing.unsubscribedFrom = suppression.source ?? null;
      existing.leftAt = suppression.createdAt;
    } else {
      const from = String(suppression.source ?? "");
      rows.set(email, {
        email,
        source: from.startsWith("cart_recovery") ? "cart_recovery" : "",
        since: null,
        status,
        unsubscribedFrom: suppression.source ?? null,
        leftAt: suppression.createdAt,
      });
    }
  }

  const list = [...rows.values()].sort((a, b) => {
    // Newest relationship first; addresses with no date sink to the bottom.
    const left = a.since ?? a.leftAt ?? "";
    const right = b.since ?? b.leftAt ?? "";
    return right.localeCompare(left) || a.email.localeCompare(b.email);
  });

  const counts: Record<SubscriberStatus, number> = { subscribed: 0, unsubscribed: 0, bounced: 0, complained: 0 };
  for (const row of list) counts[row.status] += 1;

  return { rows: list, counts, truncated: Boolean(input.truncated) };
}
