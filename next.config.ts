import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Emits .next/standalone with a self-contained server.js and only the traced
  // dependencies, which is what the Docker image copies. Harmless outside
  // Docker — `next start` ignores it.
  output: "standalone",

  // `node:sqlite` is a built-in, but Next's bundler will try to trace/bundle it
  // unless it is marked external. Keeping it external also guarantees we get the
  // real single process-wide DatabaseSync handle rather than a bundled copy.
  serverExternalPackages: ["node:sqlite"],

  // The whole point of this app is that it sits in front of Jellyfin. Never let
  // a stray framework header leak information about the upstream.
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          // Invite links land in chat apps; don't let them get indexed if the
          // domain is ever crawled.
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
