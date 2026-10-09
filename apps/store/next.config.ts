import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// The repo-root .env is the one env source for every process; Next.js itself only reads this app's directory.
const rootEnv = path.resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  distDir: process.env.STORE_DIST_DIR ?? ".next",
  transpilePackages: ["@reup/chain-proof"],
};

export default nextConfig;
