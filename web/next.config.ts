import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@wdash/shared"],
  // web-push uses Node crypto; keep it out of the bundle.
  serverExternalPackages: ["web-push"],
  // Baked into the client bundle so an open tab can tell when a newer deploy is live.
  env: { NEXT_PUBLIC_BUILD_VERSION: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
};

export default config;
