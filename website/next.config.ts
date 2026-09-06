import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Which build is this? Inlined at build time so a page can say out loud what
  // it is running. The whole point is to settle "is the in-app browser even
  // getting the new deployment?" without guessing — an in-app webview cannot be
  // attached to a debugger, so the page has to be able to answer for itself.
  //
  // A short commit SHA and a timestamp. Neither is a secret; both are already
  // public in the repository.
  env: {
    NEXT_PUBLIC_BUILD_ID:
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
      process.env.NEXT_PUBLIC_BUILD_ID ??
      "local",
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
    // The FULL commit SHA, inlined so the browser tags Sentry events with the
    // same release string the server uses. Without this the client fell back to
    // the 7-character NEXT_PUBLIC_BUILD_ID while the server sent the full SHA,
    // which splits one deployment into two releases in Sentry and breaks the
    // question the release tag exists to answer: "did this start after commit
    // X?". Not a secret — the SHA is already public in the repository.
    NEXT_PUBLIC_SENTRY_RELEASE:
      process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.NEXT_PUBLIC_BUILD_ID ?? "local",
  },
  images: {
    // ONE HOST: THE STORAGE PROJECT THIS DEPLOYMENT ACTUALLY USES.
    //
    // This said `**.supabase.co` and `**.cloudfront.net`, above a comment
    // explaining that a wildcard "turns the optimizer into an open image proxy
    // (SSRF / bandwidth abuse)". Both patterns ARE wildcards in the way that
    // matters: anyone can create a Supabase project or a CloudFront
    // distribution in a couple of minutes, so
    // /_next/image?url=https://attacker.cloudfront.net/… fetched and re-served
    // arbitrary content through this domain, on Vercel's image optimizer, billed
    // to this account.
    //
    // Checked before narrowing rather than assumed: all 42 rows in
    // product_images are on the configured Supabase host, and the string
    // "cloudfront" appears nowhere in this repository except the line that was
    // allowing it. So the second pattern permitted a class of abuse in exchange
    // for nothing at all.
    //
    // Derived from NEXT_PUBLIC_SUPABASE_URL so it follows the project rather
    // than being a second copy of it. The wildcard remains ONLY as the fallback
    // for a build with no Supabase URL configured — a local or preview build —
    // because an empty remotePatterns list breaks every remote image, which is
    // a worse failure than the one being closed.
    remotePatterns: [
      (() => {
        const configured = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
        const hostname = configured ? (() => { try { return new URL(configured).hostname; } catch { return null; } })() : null;
        return { protocol: "https" as const, hostname: hostname ?? "**.supabase.co" };
      })(),
    ],
  },
};

export default nextConfig;
