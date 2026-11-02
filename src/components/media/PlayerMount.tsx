"use client";

import dynamic from "next/dynamic";
import { useLayoutEffect, useState } from "react";

import { useTvMode } from "@/components/tv/TvProvider";
import { importOrReload } from "@/lib/chunk-reload";
import { cameByInAppNavigation } from "@/lib/tv-memory";

import type { PlayerPartySync, PlayerPictureSubtitle, PlayerSubtitle } from "./Player";

/**
 * Client-only mount for the player.
 *
 * Vidstack's Plyr layout touches `window` while constructing its controls, so
 * server-rendering it throws "window is not defined" and the whole watch page
 * 500s. A `"use client"` component is still server-rendered by default in the
 * App Router — only `ssr: false` actually prevents it, and that option is not
 * allowed from a Server Component, hence this thin wrapper.
 *
 * The placeholder keeps the page from jumping when the real controls arrive.
 *
 * The player is its own chunk, fetched when the watch page opens. A TV left
 * on a page from before a deploy asks for the old one; importOrReload loads
 * the page again instead of failing (chunk-reload.ts).
 */
const Player = dynamic(() => importOrReload(() => import("./Player")).then((m) => m.Player), {
  ssr: false,
  loading: () => (
    <div className="player-stage">
      <div className="player-skeleton" aria-hidden="true" />
    </div>
  ),
});

import type { RatePrompt } from "./EndPrompt";
import type { ReadingItem } from "./EndReading";
import type { LiveProgramme } from "./Player";

export interface PlayerMountProps {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  mode: "direct" | "hls";
  src: string;
  title: string;
  poster?: string | null;
  startSeconds: number;
  screeningProgress?: boolean;
  transcodeReasons: string[];
  subtitles: PlayerSubtitle[];
  defaultSubtitleIndex: number | null;
  pictureSubtitles?: PlayerPictureSubtitle[];
  burnedSubtitleIndex?: number | null;
  party?: PlayerPartySync;
  /** The next episode's watch URL, for Shift+N and the "Next episode" button. */
  nextHref?: string | null;
  nextLabel?: string | null;
  creditsStart?: number | null;
  ratePrompt?: RatePrompt | null;
  reading?: ReadingItem[];
  live?: LiveProgramme | null;
}

export function PlayerMount(props: PlayerMountProps) {
  const tvMode = useTvMode();
  const [reloading, setReloading] = useState(false);

  // A TV opening a title from a page it reached in-app loads the page afresh
  // first, so the memory of the pages and players before it is let go
  // (tv-memory.ts). Before the player mounts, so no stream is started only to
  // be dropped. Once: after the reload the page is the document's own.
  useLayoutEffect(() => {
    if (!tvMode || !window.location.pathname.startsWith("/watch/")) return;
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (!cameByInAppNavigation(entry?.name, window.location.href)) return;
    setReloading(true);
    window.location.replace(window.location.href);
  }, [tvMode]);

  if (reloading) {
    return (
      <div className="player-stage">
        <div className="player-skeleton" aria-hidden="true" />
      </div>
    );
  }
  return <Player {...props} />;
}
