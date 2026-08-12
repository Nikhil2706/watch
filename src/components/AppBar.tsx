import Link from "next/link";

import { Ambience } from "@/components/Ambience";
import { Wordmark } from "@/components/Brand";

import { LogoutButton } from "./LogoutButton";
import { SearchBox } from "./SearchBox";

/** Persistent top bar. Search is a plain GET form, so it needs no JavaScript. */
export function AppBar({ username, query }: { username: string; query?: string }) {
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
        </nav>
        <div className="spacer" />
        <SearchBox initialQuery={query ?? ""} />
        <span className="who">{username}</span>
        <LogoutButton />
      </header>
    </>
  );
}
