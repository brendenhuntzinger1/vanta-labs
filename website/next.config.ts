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
    // Pin the image optimizer to the CDNs we actually serve product/COA images
    // from (Supabase Storage + our image CDN) instead of a wildcard host. A
    // wildcard turns the optimizer into an open image proxy (SSRF / bandwidth
    // abuse); these patterns cover every real image source.
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "https", hostname: "**.cloudfront.net" },
    ],
  },
};

export default nextConfig;
