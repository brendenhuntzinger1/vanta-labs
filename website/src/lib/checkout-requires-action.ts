/**
 * What the card lane does when the bank asks a question.
 *
 * Veyra's checkout client forwards `payment.requires_action` to the parent as
 * `{ session_id, redirect_url }`, where redirect_url is a hosted 3-D Secure page
 * when the processor has one and null when the challenge is being handled
 * inside the card iframe. Its SDK may also hand us the flat back-compat shape
 * (fields on the root, no payload wrapper), so both are read here.
 *
 * A usable redirect_url is navigated to at TOP LEVEL, exactly as the Apple Pay
 * lane already does with the same field (express-apple-pay-button.tsx). A bank
 * challenge nested two iframes deep on iOS Safari is the one place it is least
 * likely to render; the top-level page is where it reliably does. Anything else
 * means the challenge is in the form, and the shopper needs to be told to wait.
 *
 * The URL is navigated to, so it is validated here rather than trusted: https
 * only, and it must parse. The value is data from a third party, never a
 * command.
 */
export type RequiresActionDecision =
  | { kind: "navigate"; url: string }
  | { kind: "verifying" };

export function decideRequiresAction(payload: unknown): RequiresActionDecision {
  const candidate = readRedirectUrl(payload);
  if (!candidate) return { kind: "verifying" };
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") return { kind: "verifying" };
  } catch {
    return { kind: "verifying" };
  }
  return { kind: "navigate", url: candidate };
}

function readRedirectUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as { redirect_url?: unknown; payload?: unknown };
  // Wrapped shape first ({ payload: { redirect_url } }), then the flat one.
  const wrapped = root.payload && typeof root.payload === "object"
    ? (root.payload as { redirect_url?: unknown }).redirect_url
    : undefined;
  const value = wrapped ?? root.redirect_url;
  return typeof value === "string" && value.length > 0 ? value : null;
}
