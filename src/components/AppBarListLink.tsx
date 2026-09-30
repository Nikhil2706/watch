"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * My list, as an icon beside the bell on a phone. Its tab went to Picks, which
 * had lived only in the More menu inside the app, where Downloads takes the
 * tab bar's fifth slot. Wider screens have My list in the top nav (CSS).
 */
export function AppBarListLink() {
  const active = (usePathname() ?? "").startsWith("/watchlist");
  return (
    <Link
      href="/watchlist"
      className={active ? "appbar-list is-active" : "appbar-list"}
      aria-label="My list"
      aria-current={active ? "page" : undefined}
    >
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" focusable="false">
        <path d="M6 3h12v18l-6-4-6 4z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}
