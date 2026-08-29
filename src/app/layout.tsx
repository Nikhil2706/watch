import type { Metadata } from "next";

import { NavProgress } from "@/components/NavProgress";
import { ScreenAgent } from "@/components/remote/ScreenAgent";
import { TvProvider } from "@/components/tv/TvProvider";
import { resolveTvModeFromRequest } from "@/lib/tv/detect";

import "./globals.css";
import "./tv.css";

export const metadata: Metadata = {
  title: "Watch",
  description: "Private media library.",
  // Invite links get pasted into chat apps that follow URLs. Keep them out of
  // any index and out of link previews.
  robots: { index: false, follow: false },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Watch",
  },
  icons: {
    icon: [{ url: "/favicon-32.png", sizes: "32x32", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport = {
  themeColor: "#06070a",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Zero-flash TV detection for the very first response: a persisted
  // override cookie (see middleware.ts's `?tv=` handling) wins, otherwise a
  // User-Agent match for a known TV browser. The client can only refine this
  // further after hydration, once it can actually measure hover/pointer
  // capability — see TvProvider.tsx.
  const tvMode = await resolveTvModeFromRequest();

  return (
    <html lang="en" data-tv={tvMode ? "true" : "false"}>
      <body>
        {/* Navigation feedback that does NOT blank the page — see the
            component for why a generic loading.tsx was the wrong shape here. */}
        <NavProgress />
        <TvProvider initialTvMode={tvMode}>{children}</TvProvider>
        {/* Renders nothing. Registers this browser as a remote-controllable
            screen, but only when it plausibly is a television — see the
            component for the opt-in rules. */}
        <ScreenAgent tvMode={tvMode} />
        {/* Registered here rather than a client component: no UI depends on
            it, and this keeps it out of the client JS bundle entirely. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if ('serviceWorker' in navigator) { window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {})); }`,
          }}
        />
      </body>
    </html>
  );
}
