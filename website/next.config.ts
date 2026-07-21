import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Product/COA images are hosted on Supabase Storage (and other https CDNs),
    // so allow any https host. Plain http is intentionally omitted — optimizing
    // images fetched over http would strip transport security for no benefit.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
};

export default nextConfig;
