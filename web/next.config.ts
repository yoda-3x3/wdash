import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@wdash/shared"],
  // web-push uses Node crypto; keep it out of the bundle.
  serverExternalPackages: ["web-push"],
};

export default config;
