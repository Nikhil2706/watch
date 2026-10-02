import Link from "next/link";

import { Ambience } from "@/components/Ambience";
import { Wordmark } from "@/components/Brand";

import { AppBarListLink } from "./AppBarListLink";
import { AppBarMore } from "./AppBarMore";
import { AppVersionItem } from "./AppVersionItem";
import { LogoutButton } from "./LogoutButton";
import { MobileTabBar } from "./MobileTabBar";
import { NotificationBell } from "./NotificationBell";
import { SearchBox } from "./SearchBox";

/**
 * Persistent top bar. Search is a plain GET form, so it needs no JavaScript.
 *
 * On a phone it shrinks to one row — wordmark, My list, notifications, a More menu —
 * and the main destinations move to MobileTabBar at the bottom. The search
 * field shows there only on the search page, which the Search tab opens.
 */
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
  const searching = query !== undefined;
  return (
    <>
      <Ambience />
      <header className={searching ? "appbar is-searching" : "appbar"}>
        <Link href="/" className="brand" aria-label="Watch — home">
          <Wordmark size={20} />
        </Link>
        <nav>
          <Link href="/">Home</Link>
          <Link href="/browse">Browse</Link>
          <Link href="/watchlist">My list</Link>
          <Link href="/picks">Picks</Link>
          {langloisMode ? <Link href="/upload">Upload</Link> : null}
          {/* Both halves of the phone-remote feature, reachable from every
              page. Which one you want depends on which device you are holding,
              so both are always offered rather than guessed at: "Remote" turns
              this device into the controller, "Pair phone" turns it into the
              screen being controlled. */}
          <Link href="/remote" className="nav-remote">
            Remote
          </Link>
          <Link href="/screen" className="nav-remote">
            Pair phone
          </Link>
        </nav>
        <div className="spacer" />
        <SearchBox initialQuery={query ?? ""} autoFocus={searching && !query} />
        <AppBarListLink />
        <NotificationBell />
        <span className="who">{username}</span>
        <LogoutButton />
        <AppBarMore>
          <span className="appbar-more-who">Signed in as {username}</span>
          {langloisMode ? <Link href="/upload">Upload</Link> : null}
          <Link href="/remote">Use this phone as a remote</Link>
          <Link href="/screen">Pair a phone with this screen</Link>
          <AppVersionItem />
          <LogoutButton />
        </AppBarMore>
      </header>
      <MobileTabBar />
    </>
  );
}
