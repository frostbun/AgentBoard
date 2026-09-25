import os from "node:os";
import type { NextConfig } from "next";

/**
 * Next dev blocks its dev-only resources (HMR, chunks) for origins other than
 * localhost. The board defaults to HOST=0.0.0.0, so every address it can be
 * reached on has to be allowed or the page loads without hydrating.
 */
function devOrigins(): string[] {
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]", os.hostname()]);
  for (const entry of Object.values(os.networkInterfaces()).flat()) {
    if (entry && entry.family === "IPv4" && !entry.internal) hosts.add(entry.address);
  }
  return [...hosts];
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  allowedDevOrigins: devOrigins(),
  serverExternalPackages: ["node:sqlite"],
};

export default nextConfig;
