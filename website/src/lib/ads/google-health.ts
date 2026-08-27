import type { HealthCheck } from "./tracking-health";
import { isConfiguredGoogleAdsId } from "./google-conversion-id";

/**
 * Google's rows on the tracking health board.
 *
 * The board's discipline holds: a CODE row proves only what the repository
 * proves, and nothing is marked PLATFORM-verified without a response from
 * Google in hand. Six states, because "not working" collapses distinctions an
 * operator needs — an unconfigured account, a half-set credential list and a
 * deliberate environment suppression call for three different actions, and
 * exactly one of them is a bug.
 *
 * The server leg needs SIX credentials (see `google-conversions.ts`'s
 * `REQUIRED_ENV`) — GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CUSTOMER_ID,
 * GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN and
 * GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID — not five. The sixth,
 * GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID, is the numeric REST-API
 * conversion action id and is NOT the same value as the gtag purchase label
 * used by the browser tag.
 */
export type GoogleHealthInput = {
  conversionId: string;
  credentials: { configured: boolean; missing: string[] };
  environmentAllowed: boolean;
  /**
   * `null` means nothing has been sent yet. When present, `attempted` is the
   * load-bearing field: `sendGoogleConversion` can return `attempted: false`
   * (the OAuth refresh itself timed out or failed, or credentials were
   * incomplete) or `message: "timed out"` with `attempted: true` (the upload
   * call was aborted before Google answered). Neither of those is a rejection
   * — Google never actually looked at the conversion — so only
   * `attempted && delivered !== undefined && message !== "timed out"` may be
   * read as an answer FROM Google.
   */
  lastSend: { attempted: boolean; delivered: boolean; code: number | null; message: string | null } | null;
};

const REQUIRED_ENV_COUNT = 6;

export function buildGoogleHealth(input: GoogleHealthInput): HealthCheck[] {
  const browserConfigured = isConfiguredGoogleAdsId(input.conversionId);

  if (!browserConfigured) {
    return [
      {
        id: "google-browser",
        label: "Google Ads tag",
        tier: "CODE",
        status: "NOT_AVAILABLE",
        detail: "Not configured — NEXT_PUBLIC_GOOGLE_ADS_ID is unset, so the tag renders nothing.",
        action: "Set NEXT_PUBLIC_GOOGLE_ADS_ID once the Google Ads account and conversion action exist.",
      },
    ];
  }

  const rows: HealthCheck[] = [
    {
      id: "google-browser",
      label: "Google Ads tag",
      tier: "CODE",
      status: "PASS",
      detail: `Configured as ${input.conversionId}. Loads only after consent, and only in production.`,
    },
  ];

  if (!input.credentials.configured) {
    rows.push({
      id: "google-server",
      label: "Enhanced Conversions (server)",
      tier: "CODE",
      status: "NOT_AVAILABLE",
      detail:
        input.credentials.missing.length === REQUIRED_ENV_COUNT
          ? "Server credentials not set. The browser tag reports on its own; the server leg is dark."
          : `Server credentials incomplete — missing ${input.credentials.missing.join(", ")}. Fails closed: nothing is sent.`,
      action:
        input.credentials.missing.length === REQUIRED_ENV_COUNT
          ? "Apply for a Google Ads API developer token, then set the six GOOGLE_ADS_* variables."
          : `Set ${input.credentials.missing.join(", ")} in the production environment.`,
    });
    return rows;
  }

  if (!input.environmentAllowed) {
    rows.push({
      id: "google-server",
      label: "Enhanced Conversions (server)",
      tier: "CODE",
      status: "NOT_AVAILABLE",
      detail: "Fully credentialed, but reporting is suppressed by the environment guard. This is working as designed.",
      action: "No action. Only a production deployment reports.",
    });
    return rows;
  }

  if (!input.lastSend) {
    rows.push({
      id: "google-server",
      label: "Enhanced Conversions (server)",
      tier: "CODE",
      status: "NOT_TESTED",
      detail: "Credentialed and in production, but no conversion has been sent yet.",
      action: "Inspect a real paid order with ?inspect=1 to see the payload without sending it.",
    });
    return rows;
  }

  const send = input.lastSend;

  // Never reached Google at all — nothing to hold against the account. Also
  // catches a timed-out OAuth refresh, which reports `attempted: false`.
  if (!send.attempted) {
    rows.push({
      id: "google-server",
      label: "Enhanced Conversions (server)",
      tier: "CODE",
      status: "NOT_TESTED",
      detail: `The last send never reached Google: ${send.message ?? "not attempted"}. Not counted as a rejection — nothing was sent.`,
      action: "Retry on the next paid order. If this repeats, check network egress to oauth2.googleapis.com.",
    });
    return rows;
  }

  // The upload call was aborted before Google responded. This is silence, not
  // an answer — a timeout must never read as "Google said no".
  if (send.message === "timed out") {
    rows.push({
      id: "google-server",
      label: "Enhanced Conversions (server)",
      tier: "CODE",
      status: "NOT_TESTED",
      detail: "The last send timed out waiting for Google. Not counted as a rejection — no answer was received.",
      action: "Check whether googleads.googleapis.com is reachable from this deployment; retry on the next paid order.",
    });
    return rows;
  }

  rows.push(
    send.delivered
      ? {
          id: "google-server",
          label: "Enhanced Conversions (server)",
          tier: "PRODUCTION",
          status: "PASS",
          detail: `Last send delivered (HTTP ${send.code ?? "no status"}).`,
        }
      : {
          id: "google-server",
          label: "Enhanced Conversions (server)",
          tier: "PRODUCTION",
          status: "FAIL",
          detail: `Google rejected the last send: HTTP ${send.code ?? "no status"}${send.message ? ` ${send.message}` : ""}.`,
          action: "Check the developer token's access level and the conversion action id.",
        },
  );

  return rows;
}
