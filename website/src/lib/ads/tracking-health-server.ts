import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { credentialStatus, PIXEL_ID } from "@/lib/ads/tiktok-events-api";
import type { ServerHealthInput } from "@/lib/ads/tracking-health";
import { BACKFILL_EVENT_ID, countLedger, type LedgerCountRow, type LedgerPlatform } from "@/lib/ads/purchase-ledger";

/**
 * Everything the health board can learn without leaving the server.
 *
 * Deliberately reports facts, not verdicts. The board decides what a fact
 * means; this only answers "what is actually true of this running deployment"
 * — which environment it is, which pixel it reports to, whether the token
 * exists, whether any real conversion has ever been accepted.
 *
 * Nothing here returns a secret. The token is tested for presence and used as
 * a needle when searching public variables; its value is never placed in the
 * result.
 */

/**
 * A NEXT_PUBLIC_ variable is compiled into the JavaScript every visitor
 * downloads, so anything secret in one is already public.
 *
 * Two passes, because name-matching alone is both too eager and too lax.
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY` is meant to be public and would trip a naive
 * /KEY/ rule; a token pasted into a harmlessly-named variable would slip past
 * it. So: match names that can only mean a secret, and separately look for the
 * actual token value wherever it might have been copied.
 */
const SECRET_NAME = /(SECRET|ACCESS_TOKEN|PRIVATE_KEY|SERVICE_ROLE|PASSWORD|WEBHOOK_SECRET)/;

export function findClientExposedSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const exposed = new Set<string>();
  const token = env.TIKTOK_EVENTS_API_ACCESS_TOKEN?.trim();

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("NEXT_PUBLIC_")) continue;
    if (SECRET_NAME.test(key)) exposed.add(key);
    if (token && token.length >= 8 && typeof value === "string" && value.includes(token)) exposed.add(key);
  }

  return [...exposed].sort();
}

/**
 * How many server-side Purchase events ONE platform has attempted, and had
 * accepted.
 *
 * Scoped to a platform because the ledger is no longer one row per order. Its
 * key is (order_id, platform), so an unfiltered read returns every channel's
 * rows, and this figure is rendered as "TikTok accepted N of M" — Reddit's
 * genuine sends would land in TikTok's numerator.
 *
 * `backfill-no-send` rows are excluded for a sharper reason. They are the
 * suppression rows ads-purchase-ledger-per-platform.sql writes so historical
 * orders cannot newly report; nothing was sent for them. Counting them would
 * not merely inflate M — on an account with no delivered TikTok row, any
 * non-zero total flips this check from NOT_TESTED to FAIL, so a green
 * integration would report as broken.
 *
 * Both exclusions are applied twice on purpose: in the query, so `.limit(1000)`
 * still budgets a thousand of THIS platform's rows rather than a third of that,
 * and again in countLedger, which is the pure, tested arithmetic.
 *
 * Failure mode unchanged: a missing table or a query error still answers
 * `{ available: false, total: 0, delivered: 0 }` — "nothing recorded", not an
 * error to surface.
 */
async function readPurchaseLedger(platform: LedgerPlatform = "tiktok"): Promise<ServerHealthInput["purchaseLedger"]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("ad_purchase_events_sent")
      .select("platform, delivered, event_id")
      .eq("platform", platform)
      .neq("event_id", BACKFILL_EVENT_ID)
      .limit(1000);
    // A missing table is a legitimate state, not an error to surface: the
    // ledger is an enhancement and its absence only means "nothing recorded".
    if (error || !data) return { available: false, total: 0, delivered: 0 };
    return countLedger(data as LedgerCountRow[], platform);
  } catch {
    return { available: false, total: 0, delivered: 0 };
  }
}

export async function collectServerHealth(): Promise<ServerHealthInput> {
  const credentials = credentialStatus();

  return {
    pixelId: PIXEL_ID,
    eventsApiTokenPresent: !credentials.missing.includes("TIKTOK_EVENTS_API_ACCESS_TOKEN"),
    clientExposedSecretKeys: findClientExposedSecrets(),
    deployment: {
      env: process.env.VERCEL_ENV ?? (process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV ?? null),
      url: process.env.NEXT_PUBLIC_SITE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null),
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    },
    ads: {
      advertiserId: Boolean(process.env.TIKTOK_ADVERTISER_ID?.trim()),
      managementToken: Boolean(process.env.TIKTOK_ADS_ACCESS_TOKEN?.trim()),
    },
    probe: null,
    purchaseLedger: await readPurchaseLedger(),
  };
}
