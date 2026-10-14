"use client";

import dynamic from "next/dynamic";

import { importOrReload } from "@/lib/chunk-reload";

import type { PlayerPartySync, PlayerSubtitle } from "./Player";

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
  party?: PlayerPartySync;
  /** The next episode's watch URL, for Shift+N. */
  nextHref?: string | null;
}

export function PlayerMount(props: PlayerMountProps) {
  return <Player {...props} />;
}
