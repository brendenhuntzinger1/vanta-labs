import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { credentialStatus, PIXEL_ID } from "@/lib/ads/tiktok-events-api";
import type { ServerHealthInput } from "@/lib/ads/tracking-health";

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

/** How many server-side Purchase events have been attempted, and accepted. */
async function readPurchaseLedger(): Promise<ServerHealthInput["purchaseLedger"]> {
  try {
    // COUNTED, NOT PAGED. This used to read up to 1000 rows and report
    // `data.length` as the lifetime total, so once the ledger passed 1000
    // events the board froze at "1000 attempted" forever and the delivered
    // share was computed over an arbitrary window rather than the ledger.
    // A head count is one round trip and is not subject to any row cap.
    // `order_id`, not `id`: this table has no `id` column at all — its key is
    // (order_id, platform), verified against production 2026-08-28 (F-02; the
    // repo's DDL had said `order_id text primary key` and was the stale record).
    // Naming a column that does not exist errors 42703, which the branch below
    // would then read as "table missing" and report the ledger as unavailable.
    const [{ count: total, error: totalError }, { count: delivered, error: deliveredError }] = await Promise.all([
      supabaseAdmin.from("ad_purchase_events_sent").select("order_id", { count: "exact", head: true }),
      supabaseAdmin
        .from("ad_purchase_events_sent")
        .select("order_id", { count: "exact", head: true })
        .eq("delivered", true),
    ]);
    // A missing table is a legitimate state, not an error to surface: the
    // ledger is an enhancement and its absence only means "nothing recorded".
    if (totalError || deliveredError) return { available: false, total: 0, delivered: 0 };
    return {
      available: true,
      total: total ?? 0,
      delivered: delivered ?? 0,
    };
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
