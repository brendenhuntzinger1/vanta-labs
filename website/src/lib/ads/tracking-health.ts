/**
 * The tracking health board.
 *
 * One question runs through this file: *who* established the fact? "The code
 * looks right" and "TikTok accepted it" are different claims, and collapsing
 * them is how integrations get declared finished while receiving nothing. So
 * every row carries the tier of evidence behind it:
 *
 *   CODE        — provable by reading this repository or running its tests.
 *   PRODUCTION  — observed on the live deployment (its env, its bundle, its
 *                 browser session), not inferred from source.
 *   PLATFORM    — the ad platform itself accepted or reported it; which one
 *                 is named in the row's detail.
 *
 * A CODE row can be green while the funnel is dead; that is not a flaw in the
 * row, it is the row doing its job. The board is deliberately unable to mark
 * anything PLATFORM-verified without a response from the platform in hand.
 *
 * Pure by construction: every input is passed in, so the whole board is
 * testable without a network, a browser or a database, and the same builder
 * runs on the server and in the admin's browser.
 */

import type { GoogleHealthInput } from "./google-health";

export type HealthTier = "CODE" | "PRODUCTION" | "PLATFORM";

export type HealthStatus =
  | "PASS"
  | "FAIL"
  | "NOT_TESTED"
  | "AVAILABLE"
  | "NOT_AVAILABLE"
  | "VERIFIED"
  | "NOT_VERIFIED";

export type HealthCheck = {
  id: string;
  label: string;
  tier: HealthTier;
  status: HealthStatus;
  /** What was actually observed. Never a restatement of the label. */
  detail: string;
  /** The single next thing a human would do about a non-green row. */
  action?: string;
};

export type ProbeResult = {
  attempted: boolean;
  delivered: boolean;
  code: number | null;
  message: string | null;
  requestId: string | null;
  transportError: string | null;
};

export type ServerHealthInput = {
  pixelId: string;
  eventsApiTokenPresent: boolean;
  /**
   * Environment keys that would ship a secret to the browser. Any entry here
   * is a hard failure — the check is the presence of the list, not its
   * contents, and the values are never read.
   */
  clientExposedSecretKeys: string[];
  deployment: { env: string | null; url: string | null; commit: string | null };
  /** Ads Management + Reporting are a different credential from Events API. */
  ads: { advertiserId: boolean; managementToken: boolean };
  /** Result of a live call to TikTok, when one was made. */
  probe: ProbeResult | null;
  /** The server-side Purchase ledger, when its table exists. */
  purchaseLedger: { available: boolean; total: number; delivered: number } | null;
  /**
   * Optional so every existing `ServerHealthInput` literal (including every
   * one in tracking-health.test.ts) keeps compiling unchanged. Absent means
   * "not computed for this call", not "Google is unconfigured" — the caller
   * decides whether to include it.
   */
  google?: GoogleHealthInput | null;
};

export type BrowserHealthInput = {
  /** False when the board is rendered server-side and nothing has reported in. */
  available: boolean;
  consent: "accepted" | "declined" | "unset";
  pixelLoaded: boolean;
  /** Every pixel id initialised in the page. More than one means a duplicate. */
  loadedPixelIds: string[];
  pageViewObserved: boolean;
  /**
   * Results of exercising the real dispatch paths with the outgoing call
   * intercepted. They prove the deployed bundle maps a site action to the right
   * TikTok event; nothing reaches TikTok, so they can never inflate reporting.
   */
  probes: { viewContent: boolean; addToCart: boolean; initiateCheckout: boolean };
};

export const UNTESTED_BROWSER: BrowserHealthInput = {
  available: false,
  consent: "unset",
  pixelLoaded: false,
  loadedPixelIds: [],
  pageViewObserved: false,
  probes: { viewContent: false, addToCart: false, initiateCheckout: false },
};

const ACCEPT_COOKIES_ACTION =
  "Open the live site in a normal window and accept the cookie banner. The pixel is not loaded before that, by design.";

/**
 * TikTok auth failures are their own class of problem — a wrong, expired or
 * wrong-account token — and they need a different action from a malformed
 * payload. Their 401xx family covers permission and identity.
 */
function isAuthFailure(code: number | null): boolean {
  return code !== null && code >= 40100 && code < 40200;
}

function browserRow(
  id: string,
  label: string,
  observed: boolean,
  browser: BrowserHealthInput,
  detailWhenTrue: string,
  detailWhenFalse: string,
): HealthCheck {
  if (!browser.available) {
    return {
      id,
      label,
      tier: "PRODUCTION",
      status: "NOT_TESTED",
      detail: "No browser has reported in. This row is filled in by the admin page itself, in the page you are reading.",
    };
  }
  if (browser.consent !== "accepted") {
    return {
      id,
      label,
      tier: "PRODUCTION",
      status: "NOT_TESTED",
      detail: `Cookie consent in this browser is "${browser.consent}", so the pixel is intentionally absent and nothing can be observed.`,
      action: ACCEPT_COOKIES_ACTION,
    };
  }
  return {
    id,
    label,
    tier: "PRODUCTION",
    status: observed ? "PASS" : "FAIL",
    detail: observed ? detailWhenTrue : detailWhenFalse,
  };
}

export function buildHealthReport(server: ServerHealthInput, browser: BrowserHealthInput): HealthCheck[] {
  const probe = server.probe;
  const duplicatePixels = browser.loadedPixelIds.filter((id) => id !== server.pixelId);

  const checks: HealthCheck[] = [];

  // --- TikTok connection -------------------------------------------------
  checks.push(
    !probe || !probe.attempted
      ? {
          id: "tiktok-connection",
          label: "TikTok connection",
          tier: "PLATFORM",
          status: "NOT_TESTED",
          detail: "No call has been made to TikTok in this run.",
          action: "Enter a Test Events code below and run the live check.",
        }
      : probe.delivered
        ? {
            id: "tiktok-connection",
            label: "TikTok connection",
            tier: "PLATFORM",
            status: "PASS",
            detail: `TikTok accepted the call: code 0, request ${probe.requestId ?? "?"}.`,
          }
        : {
            id: "tiktok-connection",
            label: "TikTok connection",
            tier: "PLATFORM",
            status: "FAIL",
            detail: probe.transportError
              ? `Never reached TikTok — ${probe.transportError}.`
              : `TikTok rejected the call: code ${probe.code ?? "?"}, "${probe.message ?? "no message"}".`,
          },
  );

  // --- Pixel identity ----------------------------------------------------
  checks.push({
    id: "pixel-single-source",
    label: "Existing Pixel detected",
    tier: browser.available && browser.pixelLoaded ? "PRODUCTION" : "CODE",
    status: duplicatePixels.length > 0 ? "FAIL" : "PASS",
    detail:
      duplicatePixels.length > 0
        ? `More than one TikTok data source is initialised in the page: ${browser.loadedPixelIds.join(", ")}. Only ${server.pixelId} should be.`
        : browser.available && browser.pixelLoaded
          ? `${server.pixelId} is the only data source initialised in the live page, and the server reports events to the same id.`
          : `${server.pixelId} is the only data source referenced anywhere in the codebase, and the browser and server both use it.`,
  });

  checks.push(
    browserRow(
      "pixel-init",
      "Pixel initialization",
      browser.pixelLoaded,
      browser,
      "The pixel object exists in the live page and is accepting calls.",
      "Consent is accepted but the pixel object is absent — the script was blocked (ad blocker, extension, or a network failure fetching analytics.tiktok.com).",
    ),
  );

  // --- Funnel ------------------------------------------------------------
  checks.push(
    browserRow(
      "pageview",
      "PageView",
      browser.pageViewObserved,
      browser,
      "The pixel fired its page view on load and re-fires on client-side navigation.",
      "The pixel is loaded but no page view was recorded on it.",
    ),
  );

  const funnel: [string, string, boolean, string][] = [
    ["viewcontent", "ViewContent", browser.probes.viewContent, "a product page view"],
    ["addtocart", "AddToCart", browser.probes.addToCart, "an add to cart"],
    ["initiatecheckout", "InitiateCheckout", browser.probes.initiateCheckout, "starting checkout"],
  ];
  for (const [id, label, observed, action] of funnel) {
    checks.push(
      browserRow(
        id,
        label,
        observed,
        browser,
        `The deployed bundle turned ${action} into a correctly-shaped ${label} with a stable event id. The outgoing call was intercepted, so nothing was reported to TikTok.`,
        `${action} produced no ${label}. The listener is not mounted or the event mapping is wrong.`,
      ),
    );
  }

  // --- Purchase ----------------------------------------------------------
  checks.push({
    id: "purchase-browser",
    label: "Purchase browser event",
    tier: "PRODUCTION",
    status: "NOT_TESTED",
    detail:
      "Not synthesisable, on purpose. Purchase fires only when the order's own payment_status is paid, so the only honest test is a real paid order.",
    action: "The first genuine paid order verifies this row.",
  });

  const ledger = server.purchaseLedger;
  checks.push(
    !ledger
      ? {
          id: "purchase-server",
          label: "Purchase server event",
          tier: "PLATFORM",
          status: "NOT_TESTED",
          detail: "Not checked against TikTok in this run.",
        }
      : !ledger.available
        ? {
            id: "purchase-server",
            label: "Purchase server event",
            tier: "PLATFORM",
            status: "NOT_TESTED",
            detail:
              "There is no local record to read: the ad_purchase_events_sent ledger table has not been created, so nothing writes a row when a Purchase is sent. Sending still works — the ledger only guards against a re-opened confirmation link reporting twice after TikTok's own 48-hour window closes.",
            action:
              "Events Manager → your pixel → Activities is the authority for this row. A real Purchase appears there twice, once per connection method, collapsed into one conversion.",
          }
      : ledger.delivered > 0
        ? {
            id: "purchase-server",
            label: "Purchase server event",
            tier: "PLATFORM",
            status: "PASS",
            detail: `TikTok accepted ${ledger.delivered} of ${ledger.total} server-side Purchase event(s).`,
          }
        : {
            id: "purchase-server",
            label: "Purchase server event",
            tier: "PLATFORM",
            status: ledger.total > 0 ? "FAIL" : "NOT_TESTED",
            detail:
              ledger.total > 0
                ? `${ledger.total} server Purchase event(s) were attempted and TikTok accepted none of them.`
                : "No paid order has reached TikTok's reporting path yet.",
          },
  );

  // --- Deduplication -----------------------------------------------------
  checks.push({
    id: "dedup",
    label: "Deduplication",
    tier: "CODE",
    status: "PASS",
    detail:
      "Event ids are derived from the thing they describe (purchase-<order id>), never random, and the browser and server legs send the identical id. A refresh reproduces the same id rather than a new one, and TikTok collapses the pair. A ledger row per order stops a re-opened confirmation link reporting again after TikTok's own 48-hour window closes.",
  });

  // --- Auth --------------------------------------------------------------
  checks.push(
    !server.eventsApiTokenPresent
      ? {
          id: "api-auth",
          label: "API authentication",
          tier: "PRODUCTION",
          status: "FAIL",
          detail: "TIKTOK_EVENTS_API_ACCESS_TOKEN is not set on this deployment.",
          action: "Add it in Vercel → Settings → Environment Variables (Production), then redeploy.",
        }
      : !probe || !probe.attempted
        ? {
            id: "api-auth",
            label: "API authentication",
            tier: "PRODUCTION",
            status: "NOT_TESTED",
            detail: "The token is present on this deployment but has not been exercised against TikTok in this run.",
          }
        : isAuthFailure(probe.code)
          ? {
              id: "api-auth",
              label: "API authentication",
              tier: "PLATFORM",
              status: "FAIL",
              detail: `TikTok rejected the credential: code ${probe.code}, "${probe.message ?? "no message"}".`,
              action:
                "Regenerate the Events API token in Events Manager for THIS pixel, confirm it carries the Events permission, and replace it in Vercel.",
            }
          : {
              id: "api-auth",
              label: "API authentication",
              tier: "PLATFORM",
              status: probe.transportError ? "NOT_TESTED" : "PASS",
              detail: probe.transportError
                ? `Could not reach TikTok to check the credential — ${probe.transportError}.`
                : "TikTok authenticated the token; any error returned was about the payload, not the credential.",
            },
  );

  // --- Secrets -----------------------------------------------------------
  checks.push({
    id: "secrets",
    label: "Secrets protected",
    tier: "PRODUCTION",
    status: server.clientExposedSecretKeys.length === 0 ? "PASS" : "FAIL",
    detail:
      server.clientExposedSecretKeys.length === 0
        ? "The Events API token is read only in server code, sent only in a request header, and excluded from every diagnostic. No NEXT_PUBLIC_ variable on this deployment holds a token or secret."
        : `These NEXT_PUBLIC_ variables look like secrets and are shipped to every browser: ${server.clientExposedSecretKeys.join(", ")}.`,
    action:
      server.clientExposedSecretKeys.length === 0
        ? undefined
        : "Rotate each one and re-add it without the NEXT_PUBLIC_ prefix.",
  });

  // --- Deployment --------------------------------------------------------
  const isProd = server.deployment.env === "production";
  checks.push({
    id: "deployment",
    label: "Production deployment",
    tier: "PRODUCTION",
    status: isProd ? "PASS" : "NOT_TESTED",
    detail: isProd
      ? `Serving as production${server.deployment.url ? ` from ${server.deployment.url}` : ""}${server.deployment.commit ? `, commit ${server.deployment.commit.slice(0, 7)}` : ""}.`
      : `This is a ${server.deployment.env ?? "local/unknown"} environment, so nothing here reflects what production is doing.`,
  });

  // --- The row that actually matters -------------------------------------
  const productionEventsReaching = Boolean(ledger?.delivered);
  checks.push({
    id: "tiktok-production-events",
    label: "TikTok receiving production events",
    tier: "PLATFORM",
    status: productionEventsReaching ? "VERIFIED" : "NOT_VERIFIED",
    detail: productionEventsReaching
      ? "TikTok has accepted at least one real production conversion."
      : "TikTok has not confirmed receiving a real production event. A test-code event proves the connection but is routed to Test Events and does not count towards this.",
    action: productionEventsReaching ? undefined : ACCEPT_COOKIES_ACTION,
  });

  // --- The other two TikTok APIs -----------------------------------------
  const managementReady = server.ads.advertiserId && server.ads.managementToken;
  checks.push({
    id: "campaign-api",
    label: "Campaign API access",
    tier: "PRODUCTION",
    status: managementReady ? "AVAILABLE" : "NOT_AVAILABLE",
    detail: managementReady
      ? "An advertiser id and an Ads Management token are configured."
      : "Not connected. This is a different credential from the Events API token — creating or changing campaigns needs an Ads Management app authorised against the ad account.",
    action: managementReady ? undefined : "One authorisation in TikTok Ads Manager → Developer, then two environment variables.",
  });
  checks.push({
    id: "reporting-api",
    label: "Reporting API access",
    tier: "PRODUCTION",
    status: managementReady ? "AVAILABLE" : "NOT_AVAILABLE",
    detail: managementReady
      ? "Spend, impressions, clicks and conversions can be pulled for the configured advertiser."
      : "Not connected. Reporting rides on the same Ads Management authorisation as the campaign API, so both arrive together.",
  });

  return checks;
}

/** Rows that are outright broken, in board order. Empty is the goal. */
export function failures(checks: HealthCheck[]): HealthCheck[] {
  return checks.filter((c) => c.status === "FAIL");
}

/**
 * The one thing worth doing next.
 *
 * A board of sixteen rows is only useful if it resolves to a single action, so
 * failures win over unverified rows and the first one in board order wins over
 * the rest.
 */
export function nextAction(checks: HealthCheck[]): string | null {
  const ordered = [...checks.filter((c) => c.status === "FAIL"), ...checks.filter((c) => c.status === "NOT_VERIFIED")];
  return ordered.find((c) => c.action)?.action ?? null;
}
