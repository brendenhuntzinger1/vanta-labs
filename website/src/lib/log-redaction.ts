// ---------------------------------------------------------------------------
// EMAIL ADDRESSES IN LOG LINES.
//
// Sentry events pass through sentry-privacy.ts, which replaces every address
// with "[email]". Vercel runtime logs (and any log drain behind them) have no
// such scrubber, so an address interpolated into console output sits in the
// platform log store, in clear, for its retention period — outside the
// privacy posture the rest of the codebase establishes.
//
// This keeps enough to tell two lines about the same customer apart (first
// character + domain) and nothing that identifies a person on its own. Use it
// for every address that reaches console.*; ids are better still.
// ---------------------------------------------------------------------------

export function redactEmailForLog(email: string | null | undefined): string {
  const value = String(email ?? "").trim();
  if (!value) return "(no email)";
  const at = value.lastIndexOf("@");
  if (at <= 0) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 1)}***@${value.slice(at + 1)}`;
}
