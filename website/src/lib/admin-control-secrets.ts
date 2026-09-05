// ---------------------------------------------------------------------------
// SECRETS THAT LIVE IN AN OTHERWISE NON-SECRET CONTROL SECTION.
//
// SECRET_SECTIONS in the control route hides a whole section — right for
// `email`, `payment_processor` and `fulfillment`, which are nothing but
// credentials. `notifications` is not like that: the alert email and the fact
// that a webhook exists are ordinary settings the panel has to render, while
// the Pushover token and user key are credentials. Anyone holding the pair can
// push whatever they like to the owner's phone.
//
// So the granularity here is the KEY, and the rule is the one the email
// settings already follow: report a secret as set or not set, never in
// plaintext, and write it only when somebody types a new one.
//
// Dependency-free on purpose, like admin-control-updates: the same list has to
// be readable by the route that hides the value and by the client that renders
// "stored".
// ---------------------------------------------------------------------------

export const SECRET_CONTROL_KEYS: ReadonlySet<string> = new Set([
  "notifications.pushover_token",
  "notifications.pushover_user_key",
  // Credentials the Settings page writes. They were stored in clear in the
  // append-only control rows; listing them here seals them at rest (see
  // control-secret-sealing.ts) and keeps them out of any snapshot a browser
  // receives.
  "email.smtp_password",
  "email.resend_api_key",
  "email.sendgrid_api_key",
  "payment_processor.secret_key",
  "payment_processor.webhook_secret",
]);

export function isSecretControlKey(section: string, key: string): boolean {
  return SECRET_CONTROL_KEYS.has(`${section}.${key}`);
}

/**
 * Replace every secret value in a snapshot with "", and say which ones were
 * actually set.
 *
 * Mutating would be cheaper and is exactly the kind of shortcut that later
 * leaks a token into a log line somewhere upstream, so this copies.
 */
export function redactControlSnapshot(
  snapshot: Record<string, Record<string, unknown>>,
): { snapshot: Record<string, Record<string, unknown>>; secretsSet: Record<string, boolean> } {
  const out: Record<string, Record<string, unknown>> = {};
  const secretsSet: Record<string, boolean> = {};

  for (const [section, values] of Object.entries(snapshot ?? {})) {
    if (!values || typeof values !== "object") {
      out[section] = values;
      continue;
    }
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (isSecretControlKey(section, key)) {
        secretsSet[`${section}.${key}`] = String(value ?? "").trim() !== "";
        copy[key] = "";
        continue;
      }
      copy[key] = value;
    }
    out[section] = copy;
  }

  // A key that has never been written has no row at all, so the absence has to
  // be reported too — otherwise the panel cannot tell "no token" from "a
  // section that was never loaded".
  for (const path of SECRET_CONTROL_KEYS) {
    if (!(path in secretsSet)) {
      const [section] = path.split(".");
      if (section in out) secretsSet[path] = false;
    }
  }

  return { snapshot: out, secretsSet };
}
