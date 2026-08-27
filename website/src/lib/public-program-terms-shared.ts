/**
 * The programme-terms SHAPE and its formatters, with no `server-only` import.
 *
 * Split from public-program-terms.ts for exactly the reason admin-control.ts
 * documents at its own re-export: `import "server-only"` poisons the whole
 * module for any Client Component that imports from it, and Next hard-errors at
 * build time even for an otherwise-pure, dependency-free export. Both landing
 * pages render their numbers inside Client Components, so the type they receive
 * as a prop and the formatters they call have to live on this side of the line.
 *
 * The server reader lives in public-program-terms.ts and re-exports these, so
 * server callers still have one import.
 */
export interface PublicProgramTerms {
  /** What an ambassador earns per qualifying order, before any tier or override. */
  commissionPercent: number;
  /** What a shopper saves using an ambassador's code. */
  customerDiscountPercent: number;
  /** What an approved ambassador saves on their OWN orders. */
  personalDiscountPercent: number;
  /** Days a commission is held after the order before it becomes payable. */
  commissionHoldDays: number;
  /** Minimum order subtotal that earns a commission at all. */
  minimumQualifyingOrder: number;
  /** Cleared balance an ambassador must reach before a payout. */
  minimumPayoutThreshold: number;
}

/**
 * "15%", "12.5%" — never "15.00%" and never a float artefact.
 *
 * Tier rates are numeric(5,2) in the database, so half a point is a value an
 * owner can genuinely set and the page must be able to say.
 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${Number(value.toFixed(2))}%`;
}

/** "$100" for the thresholds, "$99.50" if one is ever set to part of a dollar. */
export function formatThreshold(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

/**
 * "30-day hold" / "held for 30 days", with the singular that a 1-day hold
 * deserves. partner-dashboard-client.tsx already carries this pair of shapes
 * for the same setting; the landing pages need the label form.
 */
export function holdLabel(days: number): string {
  if (!Number.isFinite(days) || days < 0) return "Hold period";
  return `${days}-day hold`;
}

export function holdDuration(days: number): string {
  if (!Number.isFinite(days) || days < 0) return "a holding period";
  return days === 1 ? "1 day" : `${days} days`;
}
