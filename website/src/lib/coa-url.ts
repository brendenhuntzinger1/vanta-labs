// ---------------------------------------------------------------------------
// One place that decides whether a stored COA value is a link.
//
// The field is free text typed into admin, and the UI branches on plain
// truthiness -- `coaUrl ? <a href={coaUrl}> : "COA coming soon"`. So a value of
// " " counts as a COA: the row advertises an "Open / Download COA" button that
// navigates nowhere. That is worse than admitting the document is not ready,
// because a shopper checking third-party testing gets a dead link instead of an
// honest answer. This had actually happened to one product.
//
// Requiring http(s) also closes a smaller hole: the value is rendered straight
// into href, so a `javascript:` URL would execute on click. Admin-entered and
// therefore low risk, but there is no reason for this field to accept a scheme
// that isn't a link to a document.
// ---------------------------------------------------------------------------

/** The stored value if it is genuinely a web link, otherwise "". */
export function sanitizeCoaUrl(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";

  // Placeholders operators type when a COA is outstanding. They are a promise
  // that it is coming, not a document, and must not render as one.
  if (/^(n\/?a|none|pending|tbd|coming soon|-+)$/i.test(value)) return "";

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : "";
}

/** Whether a product should show a COA link at all. */
export function hasCoa(raw: unknown): boolean {
  return sanitizeCoaUrl(raw).length > 0;
}
