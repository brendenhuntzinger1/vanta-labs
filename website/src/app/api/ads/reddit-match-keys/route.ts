import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { detectRoleFromUser } from "@/lib/auth-role";
import { buildRedditMatchKeys } from "@/lib/ads/reddit-matching";

/**
 * GET /api/ads/reddit-match-keys
 *
 * The hashed identifiers the Reddit pixel puts in its `rdt('init')` call.
 *
 * WHY AN ENDPOINT RATHER THAN A LAYOUT PROP. The obvious place to compute this
 * is the root layout, which is where the pixel mounts — but RootLayout is a
 * SYNCHRONOUS component that does no server data fetching, and adding an auth
 * lookup to it would make every page in the app dynamically rendered to
 * personalise an advertising identifier. That is a real cost on every request
 * for a feature that only applies to signed-in customers.
 *
 * SIGNED-IN CUSTOMERS ONLY. A guest gets `{}`. The digests are derived from the
 * session, never from anything the caller sends, so this cannot be used to hash
 * an arbitrary address: there is no input to it.
 *
 * ONLY DIGESTS LEAVE. Hashing happens here, on the server. The raw address is
 * never handed to client JavaScript — see lib/ads/reddit-matching.ts.
 */
export async function GET() {
  const empty = NextResponse.json({ matchKeys: null });
  // Never cached, by anything. These are per-person values; a shared cache
  // entry would hand one customer's identifier to the next visitor.
  empty.headers.set("Cache-Control", "no-store, private");

  try {
    const user = await getAuthenticatedUser();
    if (!user || detectRoleFromUser(user) !== "customer") {
      return empty;
    }

    const matchKeys = buildRedditMatchKeys({
      email: user.email ?? null,
      externalId: user.id,
    });

    const response = NextResponse.json({ matchKeys });
    response.headers.set("Cache-Control", "no-store, private");
    return response;
  } catch (error) {
    // An advertising identifier is never worth failing a page over. The pixel
    // treats this as "no keys" and still loads.
    console.error("[ads/reddit-match-keys]", error);
    return empty;
  }
}
