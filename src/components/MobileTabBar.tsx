"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { offlineSupported } from "@/lib/offline/bridge";

/**
 * Phone navigation, at the bottom where a thumb reaches it.
 *
 * Only shown at phone widths and never in TV mode (both in CSS). The top bar
 * carries the same destinations on wider screens, so nothing is reachable
 * only from here.
 *
 * Picks has a tab everywhere; My list moved up beside the bell to make room
 * (AppBarListLink) - in the app Picks used to be reachable only from the More
 * menu. Downloads is a fifth tab inside the app, where the device can hold
 * files, and absent in a phone browser, where it cannot: a Downloads tab there
 * would only ever say "open this in the app".
 *
 * Admin is a last tab for accounts with admin access only (users.is_admin),
 * in the app and in a phone browser alike: the curator's tools used to be
 * reachable on a phone only from the More menu.
 */

type Tab = { href: string; label: string; icon: React.ReactNode; match: (p: string) => boolean };

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const HOME: Tab = {
  href: "/",
  label: "Home",
  icon: icon("M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"),
  match: (p) => p === "/",
};
const BROWSE: Tab = {
  href: "/browse",
  label: "Browse",
  icon: icon("M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"),
  match: (p) => p.startsWith("/browse") || p.startsWith("/collection") || p.startsWith("/person"),
};
const SEARCH: Tab = {
  href: "/search",
  label: "Search",
  icon: icon("M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4-4"),
  match: (p) => p.startsWith("/search"),
};
const DOWNLOADS: Tab = {
  href: "/downloads",
  label: "Downloads",
  icon: icon("M12 3v12M7 10l5 5 5-5M4 20h16"),
  match: (p) => p.startsWith("/downloads"),
};
const PICKS: Tab = {
  href: "/picks",
  label: "Picks",
  icon: icon("M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"),
  match: (p) => p.startsWith("/picks") || p.startsWith("/curator"),
};

const ADMIN: Tab = {
  href: "/admin",
  label: "Admin",
  // A sliders icon: settings for the library, not the viewer's own.
  icon: icon("M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4"),
  match: (p) => p.startsWith("/admin"),
};

export function MobileTabBar({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname() ?? "/";
  // After mount: the bridge lives on window, and deciding during render would
  // disagree with the server-rendered HTML.
  const [inApp, setInApp] = useState(false);
  useEffect(() => setInApp(offlineSupported()), []);

  const tabs = [HOME, BROWSE, SEARCH, PICKS, ...(inApp ? [DOWNLOADS] : []), ...(isAdmin ? [ADMIN] : [])];

  return (
    <nav className="tabbar" aria-label="Main">
      {tabs.map((tab) => {
        const active = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={active ? "tab is-active" : "tab"}
            aria-current={active ? "page" : undefined}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
