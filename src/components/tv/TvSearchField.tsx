"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useTvMode } from "@/components/tv/TvProvider";

/**
 * TV's search entry point. A type-ahead dropdown (SearchBox.tsx, used on
 * desktop/mobile) is awkward with a D-pad — this instead builds the whole
 * query in a large field with the TV's system keyboard (OK on the field
 * opens it, lib/tv/tv-fields.ts; its Enter key searches), then submits as a
 * normal navigation to /search?q=..., which is the exact same route and
 * the exact same result rendering desktop search already uses.
 *
 * Renders nothing outside TV mode: search/page.tsx mounts this
 * unconditionally so the desktop/mobile page stays untouched.
 */
export function TvSearchField({ initialQuery }: { initialQuery: string }) {
  const tvMode = useTvMode();
  const [query, setQuery] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // With results on the page, land on the first one; the field is one press
  // up. (Only the empty search page autofocuses the field itself.)
  useEffect(() => {
    if (!tvMode || !initialQuery) return;
    const first = document.querySelector<HTMLElement>(".grid .poster-link");
    if (!first) return;
    // Marked as the page's autofocus target as well, so TvProvider's own
    // landing focus (which can run after this) agrees.
    first.setAttribute("data-tv-autofocus", "true");
    first.focus();
  }, [tvMode, initialQuery]);

  if (!tvMode) return null;

  function submit() {
    // Drop focus first: it closes the system keyboard, which otherwise
    // stayed open over the results.
    inputRef.current?.blur();
    const trimmed = query.trim();
    router.push(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search");
  }

  return (
    <div style={{ padding: "0 48px 12px" }}>
      <input
        ref={inputRef}
        type="text"
        value={query}
        data-tv-autofocus={initialQuery ? undefined : "true"}
        enterKeyHint="search"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && submit()}
        placeholder="Search titles, cast, genre…"
        aria-label="Search"
        autoComplete="off"
        style={{
          width: "100%",
          fontSize: "1.4rem",
          padding: "18px 22px",
          borderRadius: 12,
        }}
      />
      <div style={{ marginTop: 16, display: "flex", justifyContent: "center" }}>
        <button type="button" className="btn" onClick={submit}>
          Search
        </button>
      </div>
    </div>
  );
}
