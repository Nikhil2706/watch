"use client";

import dynamic from "next/dynamic";

import type { PlayerSubtitle } from "./Player";

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
 */
const Player = dynamic(() => import("./Player").then((m) => m.Player), {
  ssr: false,
  loading: () => (
    <div className="player-stage">
      <div className="player-skeleton" aria-hidden="true" />
    </div>
  ),
});

export interface PlayerMountProps {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  mode: "direct" | "hls";
  src: string;
  title: string;
  poster?: string | null;
  startSeconds: number;
  transcodeReasons: string[];
  subtitles: PlayerSubtitle[];
  defaultSubtitleIndex: number | null;
}

export function PlayerMount(props: PlayerMountProps) {
  return <Player {...props} />;
}
