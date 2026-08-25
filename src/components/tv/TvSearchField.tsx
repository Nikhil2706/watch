"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { useTvMode } from "@/components/tv/TvProvider";
import { TvKeyboard } from "@/components/tv/TvKeyboard";

/**
 * TV's search entry point. A type-ahead dropdown (SearchBox.tsx, used on
 * desktop/mobile) is awkward with a D-pad — this instead builds the whole
 * query with a large field plus an on-screen keyboard, then submits as a
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

  if (!tvMode) return null;

  function submit() {
    const trimmed = query.trim();
    router.push(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search");
  }

  return (
    <div style={{ padding: "0 48px 12px" }}>
      <input
        ref={inputRef}
        type="text"
        value={query}
        data-tv-autofocus="true"
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
      <TvKeyboard
        onInsert={(text) => setQuery((q) => q + text)}
        onBackspace={() => setQuery((q) => q.slice(0, -1))}
      />
      <div style={{ marginTop: 16 }}>
        <button type="button" className="btn" onClick={submit}>
          Search
        </button>
      </div>
    </div>
  );
}
