import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Ambassadors are ordinary customer accounts, so there is no separate partner
// login. /partner/login has said exactly that, and forwarded to the single
// account sign-in, for a while. This route did not: it rendered its own
// "Partner Portal — Secure Login" form asking for "your approved partner
// credentials", which do not exist.
//
// Worse, that form was a DEAD END (audit E3). It carried no "Forgot your
// password?", no "Resend confirmation email" and no Turnstile token, so an
// affiliate who reached it and could not sign in had no route out — and the
// day a CAPTCHA secret is set in the Supabase dashboard, every tokenless call
// from it would start being rejected with no code change to point at.
//
// Nothing in the app ever linked here; it was reachable only by bookmark or an
// old link, which is exactly the returning-affiliate case it failed. Forwarding
// to the single account sign-in gives those visitors the full form.
// THE QUERY COMES WITH IT, FOR THE SAME REASON EVERY OTHER HOP CARRIES IT.
//
// This dropped the query string, so an old link that still carried a campaign
// tag or a referral code arrived at the portal stripped of both — the same
// silent attribution loss the access wall used to cause, one route further
// out. `next` is not special-cased: the whole query is forwarded, so a `next`
// riding on it reaches the sign-in form, which re-validates it through
// safeInternalPath exactly as it does on every other path in.
//
// The destination is a constant, so nothing in the query can redirect anyone
// anywhere: this cannot become an open redirect however the URL was built.
export default async function LegacyPartnerLoginRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    // A repeated parameter arrives as an array; keep every occurrence rather
    // than silently picking one.
    for (const single of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(key, single);
    }
  }
  const search = query.toString();
  redirect(search ? `/account/login?${search}` : "/account/login");
}
