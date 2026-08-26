// Client-safe slice of admin-control.ts.
//
// admin-control.ts starts with `import "server-only"`, so ANY import from
// it — even a single pure, dependency-free named export — poisons the whole
// module graph and Next.js hard-errors at build time if a Client Component
// pulls it in ("This module cannot be imported from a Client Component
// module"). `describeEffectiveRate` has zero server dependencies (no
// Supabase, no secrets), so it lives here instead, and admin-control.ts
// re-exports it so server-side callers can still reach it at
// `@/lib/admin-control` as usual. Client Components (e.g.
// admin-control-center-client.tsx) must import from THIS file directly.

/** The coded default processing-fee percent, single-sourced for both admin-control.ts and any client UI. */
export const PROCESSING_FEE_DEFAULT_PERCENT = 8;

/**
 * What rate is ACTUALLY in effect, for display beside an admin input.
 *
 * A blank stored value is not "0%" — it means the coded default applies. An
 * explicit "0", on the other hand, is a real choice (fee-free processing) and
 * must never be mistaken for "unset". The two are indistinguishable in an
 * empty text box, which is why the effective processing fee was invisible
 * even though the field had always been editable.
 */
export function describeEffectiveRate(stored: string, fallback: number): string {
  return stored.trim() === "" ? `Using the ${fallback}% default` : `${Number(stored)}% in effect`;
}
