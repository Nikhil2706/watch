import Link from "next/link";

import { LogoutButton } from "./LogoutButton";
import { SearchBox } from "./SearchBox";

/** Persistent top bar. Search is a plain GET form, so it needs no JavaScript. */
export function AppBar({ username, query }: { username: string; query?: string }) {
  return (
    <header className="appbar">
      <Link href="/" className="brand">
        Watch
      </Link>
      <nav>
        <Link href="/">Home</Link>
        <Link href="/browse">Browse</Link>
        <Link href="/watchlist">My list</Link>
      </nav>
      <div className="spacer" />
      <SearchBox initialQuery={query ?? ""} />
      <span className="who">{username}</span>
      <LogoutButton />
    </header>
  );
}
