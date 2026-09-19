/**
 * A deadline for a browser request that must not be able to hang for ever.
 *
 * WHY: a `fetch` whose socket is opened and then held — a carrier captive
 * portal, a proxy that never answers, a function that hangs rather than
 * erroring — neither resolves nor rejects. Every control this store disables
 * "while saving" then stays disabled for the life of the page: the wheel reads
 * "Spinning…" for ever, the invitation reads "One moment…" for ever, and the
 * customer's only way out is a reload they have no reason to expect. A refusal
 * is recoverable and a hang is not, so the hang is turned into a refusal.
 *
 * The catch blocks these calls already have are the whole handling: an abort
 * arrives there exactly as a dropped connection does.
 *
 * `AbortSignal.timeout` is Safari 16 / Chrome 103 and up. An engine older than
 * that gets `undefined`, which `fetch` ignores — the same behaviour as before,
 * never a crash on the press itself.
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") return undefined;
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

/**
 * Long enough for a slow phone on a bad connection, short enough that a
 * customer has not given up first. The spin and the dose write are both a
 * single indexed round trip behind a signed token.
 */
export const REQUEST_TIMEOUT_MS = 15_000;
