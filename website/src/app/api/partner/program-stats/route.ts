import { NextResponse } from "next/server";
import { getPartnerProgramStats, type PartnerProgramStats } from "@/lib/partner-portal";
import { customerSafeMessage } from "@/lib/safe-error";

export const dynamic = "force-dynamic";

/**
 * How long one read of the program counters stands for.
 *
 * THIS ROUTE IS UNAUTHENTICATED AND IT SCANS FOUR TABLES. getPartnerProgramStats
 * pages `partner_payouts` and `referral_orders` to exhaustion and reads
 * `partners` and `partner_program_stats` whole, all with the service-role key,
 * and the /partner landing page polls this endpoint every 30 seconds from every
 * open tab. Uncached that is (tabs x 2 per minute) x 4 table reads, growing with
 * the ambassador program, and payable by anyone on the internet with a `for`
 * loop and no account. In the production runtime logs it was already the single
 * busiest path in the store — 306 requests in six hours, one every seventy
 * seconds — before launch traffic existed.
 *
 * A minute is chosen against what these numbers ARE: public marketing counters
 * on a recruitment page. Nothing decides money from them, the client's own poll
 * is 30 seconds, and a counter that lags by up to a minute is indistinguishable
 * from one that does not.
 */
const STATS_TTL_MS = 60_000;

let cached: { at: number; stats: PartnerProgramStats } | null = null;

/**
 * The read currently in flight, if any.
 *
 * The TTL alone does not bound a stampede: on a cold instance, or the instant a
 * window expires, every concurrent request misses the cache together and each
 * starts its own scan. Sharing the in-flight promise makes a burst cost one
 * query rather than one each. Cleared on settle, and the cache is written only
 * on success — a transient database failure must not be pinned in front of the
 * page for the rest of the window.
 */
let inFlight: Promise<PartnerProgramStats> | null = null;

async function readProgramStats(): Promise<PartnerProgramStats> {
  if (cached && Date.now() - cached.at < STATS_TTL_MS) return cached.stats;
  if (inFlight) return inFlight;

  inFlight = getPartnerProgramStats()
    .then((stats) => {
      cached = { at: Date.now(), stats };
      return stats;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export async function GET() {
  try {
    const stats = await readProgramStats();
    return NextResponse.json({ success: true, stats });
  } catch (error) {
    const message = customerSafeMessage(error, "Unable to load partner program stats");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
