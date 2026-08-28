import "server-only";

/**
 * Render an unknown thrown value as something an operator can act on.
 *
 * `String(error)` is the obvious thing and it is wrong for the errors this
 * codebase actually throws. A Supabase/PostgREST failure is a PLAIN OBJECT —
 * `{ code, message, details, hint }`, not an Error — and `String()` on a plain
 * object is the literal text "[object Object]". Every field is discarded.
 *
 * That is not hypothetical. The scheduled sweep alerted on 2026-08-28 with
 *
 *     context: { "commission_accrual_repair": "[object Object]" }
 *
 * on a job that touches the affiliate money path, and there was no other trace:
 * the route still returned 200, so nothing reached the runtime error log
 * either. The alert exists precisely because "a rejected sweep only appeared in
 * the HTTP response body that nobody reads" — and it then threw away the one
 * thing that made it worth reading.
 *
 * Lifted from commission-accrual-repair.ts, which got this right locally, so
 * there is one implementation rather than one per caller.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
    const parts = [e.code, e.message, e.details, e.hint]
      .filter((value) => value != null && String(value) !== "")
      .map(String);
    if (parts.length > 0) return parts.join(" | ");
    try {
      return JSON.stringify(error);
    } catch {
      // Circular, or a BigInt/Symbol JSON refuses. Better than nothing.
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}
