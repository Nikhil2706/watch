"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The console's tabs, in the order the old one listed them. A tab not moved
 * here yet says so and is not a link: until every one is, the old console
 * keeps working unchanged for those.
 */
export const ADMIN_TABS: ReadonlyArray<{ key: string; label: string; ported: boolean }> = [
  { key: "library", label: "Library", ported: true },
  { key: "health", label: "Health", ported: true },
  { key: "invites", label: "Invites", ported: true },
  { key: "uploads", label: "Uploads", ported: true },
  { key: "dupes", label: "Duplicates", ported: false },
  { key: "worker", label: "Worker", ported: true },
  { key: "accolades", label: "Accolades", ported: false },
  { key: "tmdb", label: "TMDB", ported: false },
  { key: "picks", label: "Picks", ported: false },
  { key: "screenings", label: "Screening Room", ported: false },
];

export function AdminNav() {
  const path = usePathname() ?? "";
  return (
    <nav className="adm-tabs" aria-label="Curator's tools">
      {ADMIN_TABS.map((t) =>
        t.ported ? (
          <Link key={t.key} href={`/admin/${t.key}`} className={path.startsWith(`/admin/${t.key}`) ? "on" : undefined}>
            {t.label}
          </Link>
        ) : (
          <span key={t.key} className="adm-tab-later" title="Not moved here yet — still in the old console">
            {t.label}
          </span>
        ),
      )}
    </nav>
  );
}
