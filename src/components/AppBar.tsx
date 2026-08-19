import Link from "next/link";

import { Ambience } from "@/components/Ambience";
import { Wordmark } from "@/components/Brand";

import { LogoutButton } from "./LogoutButton";
import { NotificationBell } from "./NotificationBell";
import { SearchBox } from "./SearchBox";

/** Persistent top bar. Search is a plain GET form, so it needs no JavaScript. */
export function AppBar({
  username,
  query,
  langloisMode,
}: {
  username: string;
  query?: string;
  /** Shows the Upload link — off by default so every existing caller keeps working unchanged. */
  langloisMode?: boolean;
}) {
  return (
    <>
      <Ambience />
      <header className="appbar">
        <Link href="/" className="brand" aria-label="Watch — home">
          <Wordmark size={20} />
        </Link>
        <nav>
          <Link href="/">Home</Link>
          <Link href="/browse">Browse</Link>
          <Link href="/watchlist">My list</Link>
          <Link href="/curator">Picks</Link>
          {langloisMode ? <Link href="/upload">Upload</Link> : null}
        </nav>
        <div className="spacer" />
        <SearchBox initialQuery={query ?? ""} />
        <NotificationBell />
        <span className="who">{username}</span>
        <LogoutButton />
      </header>
    </>
  );
}
