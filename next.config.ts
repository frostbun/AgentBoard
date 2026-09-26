import os from "node:os";
import type { NextConfig } from "next";

/**
 * Next dev blocks its dev-only resources (HMR, chunks) for origins other than
 * localhost, or the page loads without hydrating. The board defaults to
 * HOST=0.0.0.0 and is reached over the LAN, a tunnel, or a phone, so allow
 * every origin a browser can send: the dotted wildcards match any IPv4 or
 * DNS-name origin, the explicit entries any single-label one. Wildcards cannot
 * match a bare `*`, so `AGENTBOARD_DEV_ORIGINS` (exact origins) covers what is
 * left: single-label aliases, IPv6, `null`.
 */
function devOrigins(): string[] {
  const hosts = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
    os.hostname(),
    "*.*",
    "*.*.*",
    "*.*.*.*",
  ]);
  for (const entry of Object.values(os.networkInterfaces()).flat()) {
    if (entry && entry.family === "IPv4" && !entry.internal) hosts.add(entry.address);
  }
  for (const origin of (process.env.AGENTBOARD_DEV_ORIGINS ?? "").split(",")) {
    if (origin.trim()) hosts.add(origin.trim());
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
