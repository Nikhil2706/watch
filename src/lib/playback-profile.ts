/**
 * The device profile sent with every PlaybackInfo request, per kind of
 * client. Pure (no server-only, no imports beyond tv/constants.ts) so it is
 * tested directly.
 *
 * Direct play is claimed only for the combinations every browser handles:
 * H.264 video with AAC/MP3 audio in an MP4 container, plus WebM. Everything
 * else — MKV containers, HEVC, TrueHD — is declared unsupported so Jellyfin
 * transcodes to HLS rather than sending something the <video> element will
 * silently refuse. Claiming more here would produce a black screen instead of
 * a transcode.
 *
 * The one thing that differs by client is the H.264 level ceiling. It used to
 * be 4.1 for everyone, so a TV or a desktop transcoded files it plays
 * directly: The Social Network (High@5.1, 1.3 Mbps) transcoded for every
 * viewer on 2026-10-14 with "VideoLevelNotSupported".
 */

import { resolveTvMode } from "./tv/constants.ts";

export type PlaybackClient = "phone" | "tv" | "desktop";

/**
 * Jellyfin's VideoLevel is the level times ten.
 *
 * phone 4.1: the highest level with broad hardware decode on phones; above
 *   it some fall back to software decode and drain the battery or drop
 *   frames. Tablets are counted here too (same chips).
 * tv 5.2: what the Android TV / Fire TV decoders and TV browsers handle; the
 *   Watch app on a TV reports itself as one (" AndroidTV" in its agent).
 * desktop 5.2: every desktop browser decodes H.264 5.x (hardware or not).
 */
export const H264_MAX_LEVEL: Record<PlaybackClient, number> = { phone: 41, tv: 52, desktop: 52 };

/** A phone or tablet: iOS, or Android that isn't a TV (TV mode is decided first). */
const HANDHELD_AGENT = /\b(iPhone|iPod|iPad|Android)\b|Mobi/i;

/**
 * Which kind of client a request is from. TV mode is the site's own decision
 * (the watch_tv cookie, else the agent) so a TV in TV mode always gets the TV
 * profile; then a handheld agent; everything else is a desktop browser. No
 * agent at all gets the phone's profile, the one that is always safe.
 */
export function playbackClient(input: { cookieValue: string | undefined; userAgent: string | null }): PlaybackClient {
  if (resolveTvMode(input)) return "tv";
  if (!input.userAgent) return "phone";
  return HANDHELD_AGENT.test(input.userAgent) ? "phone" : "desktop";
}

/**
 * Ceiling for transcoded output.
 *
 * A transcode is only ever a fallback for a file the browser cannot play, and
 * re-encoding a 4K source at 4K is close to the worst thing you can ask of a
 * CPU. Measured on a 16-thread i5-1240P, software-transcoding a 3840x1920 HEVC
 * 10-bit source to H.264 at full resolution ran at 1.77x realtime — barely
 * ahead of playback, so any seek dropped it behind and the player stalled. On
 * the i3-6100 this is actually deployed to, the same job is well below realtime
 * and simply does not work.
 *
 * Capping the ladder at 1080p cuts the pixel count by ~4x. Nobody watching on a
 * phone over a home uplink can tell the difference, and it is the difference
 * between a transcode that keeps up and one that does not.
 */
export const MAX_TRANSCODE_WIDTH = 1920;
export const MAX_TRANSCODE_HEIGHT = 1080;
export const MAX_TRANSCODE_BITRATE = 8_000_000;

export function browserProfile(client: PlaybackClient) {
  return {
    // Was 120 Mbps, which told Jellyfin to spend an enormous bitrate re-encoding
    // 4K. Nothing streaming to a browser over a home connection needs that.
    MaxStreamingBitrate: MAX_TRANSCODE_BITRATE,
    DirectPlayProfiles: [
      { Container: "mp4,m4v", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,mp3" },
      { Container: "webm", Type: "Video", VideoCodec: "vp8,vp9,av1", AudioCodec: "vorbis,opus" },
    ],
    TranscodingProfiles: [
      {
        Container: "ts",
        Type: "Video",
        VideoCodec: "h264",
        AudioCodec: "aac",
        Protocol: "hls",
        Context: "Streaming",
        MaxAudioChannels: "2",
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
    ],
    ContainerProfiles: [],
    /**
     * This is what actually makes Jellyfin downscale. Without these conditions it
     * builds a `scale=` filter bounded by the *source* dimensions, which is a
     * no-op, and encodes at full resolution.
     *
     * `IsRequired: false` marks them as preferences rather than hard requirements:
     * Jellyfin brings the output down to satisfy them instead of refusing to play
     * anything that exceeds them.
     */
    CodecProfiles: [
      {
        Type: "Video",
        Codec: "h264",
        Conditions: [
          { Condition: "LessThanEqual", Property: "Width", Value: String(MAX_TRANSCODE_WIDTH), IsRequired: false },
          { Condition: "LessThanEqual", Property: "Height", Value: String(MAX_TRANSCODE_HEIGHT), IsRequired: false },
          { Condition: "LessThanEqual", Property: "VideoBitrate", Value: String(MAX_TRANSCODE_BITRATE), IsRequired: false },
          { Condition: "LessThanEqual", Property: "VideoLevel", Value: String(H264_MAX_LEVEL[client]), IsRequired: false },
        ],
      },
    ],
    SubtitleProfiles: [
      { Format: "vtt", Method: "External" },
      { Format: "srt", Method: "External" },
    ],
  };
}
