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
  //
  // pdf-parse (and its optional @napi-rs/canvas polyfill for pdfjs-dist's
  // DOMMatrix/ImageData/Path2D) has to be external too: bundling it into a
  // server chunk breaks its own conditional `require("@napi-rs/canvas")` at
  // runtime, AND — separately — makes the standalone-output file tracer skip
  // copying that dependency's real files into the trimmed node_modules, so
  // even a successful require finds nothing on disk. Marking both external
  // keeps them as real node_modules entries the tracer preserves.
  serverExternalPackages: ["node:sqlite", "pdf-parse", "@napi-rs/canvas"],

  // The whole point of this app is that it sits in front of Jellyfin. Never let
  // a stray framework header leak information about the upstream.
  poweredByHeader: false,

  async headers() {
    return [
      {
        // CORS for the admin API only, so a local admin console opened from
        // disk (Origin: null) can call it.
        //
        // Safe *specifically because* /api/admin/* authenticates on the
        // X-Admin-Key header alone and never on cookies. A browser attaches
        // cookies to cross-origin requests by itself; it never attaches a
        // custom header. So a hostile page can reach this endpoint and still
        // gets 401 without the key — the same as it would with no CORS at all.
        // This would NOT be safe on a cookie-authenticated route.
        source: "/api/admin/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, PATCH, PUT, DELETE, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, X-Admin-Key" },
          { key: "Access-Control-Max-Age", value: "86400" },
        ],
      },
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
