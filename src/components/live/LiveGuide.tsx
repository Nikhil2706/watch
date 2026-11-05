"use client";

import { MediaPlayer, MediaProvider, type MediaPlayerInstance } from "@vidstack/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import type { GridChannel, GridProgramme } from "@/lib/live-guide";

const HALF_HOUR = 30 * 60_000;
const WINDOW = 3 * 60 * 60_000;
/** Resting on a channel this long starts its preview, not every channel passed on the way down. */
const PREVIEW_AFTER_MS = 900;

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const href = (channelId: string) => `/live/${encodeURIComponent(channelId)}`;

interface Focus {
  channel: number;
  programme: number;
}

/**
 * Live TV as Pluto TV lays it out: the highlighted channel playing (muted) at
 * the top beside what is on, and the guide below, channels down the side and
 * three hours across, a line at now. On now, a programme tunes in when
 * pressed; a later one shows what it is. The D-pad moves through the grid by
 * position (TvProvider's spatial navigation): up and down between channels,
 * left and right along the timeline.
 */
export function LiveGuide({ channels, serverNowMs }: { channels: GridChannel[]; serverNowMs: number }) {
  const router = useRouter();
  const [now, setNow] = useState(serverNowMs);
  const [focus, setFocus] = useState<Focus>({ channel: 0, programme: 0 });
  const windowStart = useMemo(() => serverNowMs - (serverNowMs % HALF_HOUR), [serverNowMs]);
  const windowEnd = windowStart + WINDOW;

  // The now line moves; when something on now ends, the guide is asked again.
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(tick);
  }, []);
  const firstEnd = Math.min(...channels.map((c) => c.programmes[0]?.endMs ?? Infinity));
  useEffect(() => {
    if (now >= firstEnd) router.refresh();
  }, [now, firstEnd, router]);

  const selectedChannel = channels[focus.channel] ?? channels[0];
  const selected = selectedChannel?.programmes[focus.programme] ?? selectedChannel?.programmes[0];
  const onNow = (p: GridProgramme) => p.startMs <= now && now < p.endMs;

  // The preview follows the highlighted channel, once it has been rested on.
  const [previewId, setPreviewId] = useState<string | null>(channels[0]?.id ?? null);
  useEffect(() => {
    const id = selectedChannel?.id ?? null;
    const timer = window.setTimeout(() => setPreviewId(id), PREVIEW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [selectedChannel?.id]);

  const position = (p: GridProgramme) => {
    const from = Math.max(p.startMs, windowStart);
    const to = Math.min(p.endMs, windowEnd);
    return { left: ((from - windowStart) / WINDOW) * 100, width: ((to - from) / WINDOW) * 100 };
  };
  const marks = Array.from({ length: WINDOW / HALF_HOUR }, (_, i) => windowStart + i * HALF_HOUR);

  if (!selectedChannel || !selected) return null;
  return (
    <div className="lg">
      <section className="lg-top">
        {/* Not a focus stop: the remote's way in is the programme on now. */}
        <div className="lg-preview" onClick={() => router.push(href(selectedChannel.id))} title={`Watch ${selectedChannel.name}`}>
          {previewId ? (
            <LivePreview
              key={previewId}
              channelId={previewId}
              art={channels.find((ch) => ch.id === previewId)?.programmes[0]?.art ?? null}
            />
          ) : null}
          <span className="lg-preview-badge">
            <span className="live-dot" aria-hidden="true" /> {selectedChannel.number} · {selectedChannel.name}
          </span>
        </div>
        <div className="lg-info">
          <p className="lg-info-when">
            {onNow(selected)
              ? `On now · ${Math.max(1, Math.round((selected.endMs - now) / 60_000))} min left`
              : `${selected.startMs > now ? "Later" : "Earlier"} · ${clock(selected.startMs)}–${clock(selected.endMs)}`}
          </p>
          <h2 className="lg-info-title">{selected.title}</h2>
          {selected.line ? <p className="lg-info-line">{selected.line}</p> : null}
          {selected.overview ? <p className="lg-info-overview">{selected.overview}</p> : null}
          {onNow(selected) ? (
            <Link className="btn" href={href(selectedChannel.id)} tabIndex={-1}>
              ▶ Watch {selectedChannel.name}
            </Link>
          ) : null}
        </div>
      </section>

      <div className="lg-grid" role="grid" aria-label="Channel guide">
        <div className="lg-row lg-times" role="row">
          <div className="lg-chan lg-chan-head" role="columnheader">
            Today
          </div>
          <div className="lg-track">
            {marks.map((m) => (
              <span key={m} className="lg-mark" style={{ left: `${((m - windowStart) / WINDOW) * 100}%` }}>
                {clock(m)}
              </span>
            ))}
            <span className="lg-now-line" style={{ left: `${((now - windowStart) / WINDOW) * 100}%` }} aria-hidden="true" />
          </div>
        </div>

        {channels.map((channel, c) => (
          <div key={channel.id} className={`lg-row${c === focus.channel ? " lg-row-on" : ""}`} role="row">
            <Link
              href={href(channel.id)}
              className="lg-chan"
              onFocus={() => setFocus({ channel: c, programme: 0 })}
              onMouseEnter={() => setFocus({ channel: c, programme: 0 })}
            >
              <span className="lg-chan-number">{channel.number}</span>
              <span className="lg-chan-name">{channel.name}</span>
            </Link>
            <div className="lg-track">
              <span className="lg-now-line" style={{ left: `${((now - windowStart) / WINDOW) * 100}%` }} aria-hidden="true" />
              {channel.programmes.map((p, i) => {
                const { left, width } = position(p);
                if (width <= 0) return null;
                const live = onNow(p);
                const common = {
                  className: `lg-prog${live ? " lg-prog-now" : ""}`,
                  style: { left: `${left}%`, width: `${width}%` },
                  onFocus: () => setFocus({ channel: c, programme: i }),
                  onMouseEnter: () => setFocus({ channel: c, programme: i }),
                  title: `${clock(p.startMs)}–${clock(p.endMs)} · ${p.title}${p.line ? ` · ${p.line}` : ""}`,
                };
                const body = (
                  <>
                    <span className="lg-prog-title">{p.title}</span>
                    <span className="lg-prog-line">{p.line ? `${clock(p.startMs)} · ${p.line}` : clock(p.startMs)}</span>
                  </>
                );
                return live ? (
                  <Link key={`${p.itemId}:${p.startMs}`} href={href(channel.id)} {...common} {...(c === 0 ? { "data-tv-autofocus": "true" } : {})}>
                    {body}
                  </Link>
                ) : (
                  <button key={`${p.itemId}:${p.startMs}`} type="button" {...common} onClick={() => setFocus({ channel: c, programme: i })}>
                    {body}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The highlighted channel, playing muted where it is now. Browsers let muted
 * video start by itself, so this never needs the "Tap to watch" the channel
 * page can. Nothing is reported to Jellyfin: browsing is not watching.
 */
function LivePreview({ channelId, art }: { channelId: string; art: string | null }) {
  const [stream, setStream] = useState<{ src: string; mode: "direct" | "hls"; offsetSeconds: number; atMs: number } | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const seeked = useRef(false);
  const player = useRef<MediaPlayerInstance>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/live/${encodeURIComponent(channelId)}/preview`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d: { src?: string; mode?: "direct" | "hls"; offsetSeconds?: number; atMs?: number; nextAtMs?: number }) => {
        if (d.src && d.mode) setStream({ src: d.src, mode: d.mode, offsetSeconds: d.offsetSeconds ?? 0, atMs: d.atMs ?? Date.now() });
        else if (d.nextAtMs) setNextAt(d.nextAtMs);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [channelId]);

  return (
    <span className="lg-preview-stage">
      {art ? <img className="lg-preview-art" src={art} alt="" /> : null}
      {stream ? (
        <MediaPlayer
          ref={player}
          className="lg-preview-player"
          src={stream.mode === "hls" ? { src: stream.src, type: "application/x-mpegurl" } : { src: stream.src, type: "video/mp4" }}
          muted
          autoPlay
          playsInline
          load="eager"
          keyDisabled
          crossOrigin="anonymous"
          onCanPlay={() => {
            if (seeked.current || !player.current) return;
            seeked.current = true;
            player.current.currentTime = stream.offsetSeconds + (Date.now() - stream.atMs) / 1000;
          }}
        >
          <MediaProvider />
        </MediaPlayer>
      ) : nextAt ? (
        <span className="lg-preview-next">Next at {clock(nextAt)}</span>
      ) : null}
    </span>
  );
}
