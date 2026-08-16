#!/usr/bin/env bash
#
# Convert files a browser cannot play into files it can, once, ahead of time.
#
#   scripts/pretranscode.sh ~/Videos                 # dry run, shows what it would do
#   scripts/pretranscode.sh ~/Videos --write         # actually convert
#
# WHY THIS EXISTS
#
# Jellyfin transcodes on demand and has no "prepare everything" mode. Every time
# someone plays a 4K HEVC MKV, the server decodes 4K HEVC and encodes H.264 in
# real time, for that one viewer, again from scratch on every seek.
#
# Measured on a 16-thread i5-1240P, software transcoding one such file runs at
# roughly 2-3x realtime — workable. The i3-6100 this is deployed to has four
# threads and no hardware decode for 10-bit HEVC, so the same job lands well
# below realtime and the viewer buffers permanently.
#
# Converting once turns that into direct play: the server does no work at all
# beyond reading bytes off disk, seeks are instant, and several people can watch
# at once. The cost is disk space and a one-off wait.
#
# WHAT IT PRODUCES
#
# 1080p H.264 High profile + AAC stereo in MP4 — the combination every browser
# direct-plays. CRF 20 with a 6 Mbps ceiling keeps it visually close to the
# source at roughly a third of the size.
#
# The original is never touched. Output goes next to it as "<name> [1080p].mp4".
# Point Jellyfin at the directory and it will pick up both; delete the originals
# yourself once you are happy with the results.

set -uo pipefail

DIR="${1:-}"
WRITE="${2:-}"

if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
  echo "usage: $0 <media-directory> [--write]" >&2
  exit 1
fi

command -v ffprobe >/dev/null || { echo "ffprobe not found (install ffmpeg)" >&2; exit 1; }

# Hardware encoding if the box can do it, software otherwise. Encoding is the
# expensive half; decoding 10-bit HEVC stays on the CPU either way because
# older Intel chips cannot do it in hardware.
VCODEC="libx264 -preset slow -crf 20"
ACCEL="software (libx264)"
# Captured to a variable rather than piped into `grep -q`: under `pipefail`,
# grep exits on the first match, ffmpeg takes SIGPIPE, and the pipeline reports
# failure — silently disabling hardware encoding on machines that support it.
ENCODERS=$(ffmpeg -hide_banner -encoders 2>/dev/null || true)
if [ -e /dev/dri/renderD128 ] && [[ "$ENCODERS" == *h264_vaapi* ]]; then
  if ffmpeg -hide_banner -loglevel error -vaapi_device /dev/dri/renderD128 \
       -f lavfi -i testsrc=duration=0.1:size=320x240:rate=5 \
       -vf 'format=nv12,hwupload' -c:v h264_vaapi -f null - 2>/dev/null; then
    VCODEC="h264_vaapi -qp 22"
    ACCEL="VAAPI hardware encode"
  fi
fi

echo "Encoder: $ACCEL"
[ "$WRITE" = "--write" ] || echo "DRY RUN — pass --write to actually convert."
echo

total_in=0
total_est=0
count=0

while IFS= read -r -d '' f; do
  case "$f" in *"[1080p].mp4") continue;; esac

  probe=$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=codec_name,width,height -of csv=p=0 "$f" 2>/dev/null)
  [ -z "$probe" ] && continue

  codec=$(echo "$probe" | cut -d, -f1)
  width=$(echo "$probe" | cut -d, -f2)
  ext="${f##*.}"

  # Already browser-friendly? Leave it alone.
  if [ "$codec" = "h264" ] && { [ "$ext" = "mp4" ] || [ "$ext" = "m4v" ]; } && [ "${width:-0}" -le 1920 ]; then
    continue
  fi

  out="${f%.*} [1080p].mp4"
  [ -f "$out" ] && { echo "  skip (exists): $(basename "$out")"; continue; }

  size=$(stat -c%s "$f")
  total_in=$((total_in + size))
  est=$((size / 3))
  total_est=$((total_est + est))
  count=$((count + 1))

  printf '  %s\n    %s %spx  %.2f GB  ->  ~%.2f GB\n' \
    "$(basename "$f")" "$codec" "$width" \
    "$(echo "$size" | awk '{print $1/1e9}')" \
    "$(echo "$est" | awk '{print $1/1e9}')"

  if [ "$WRITE" = "--write" ]; then
    if [ "$ACCEL" = "VAAPI hardware encode" ]; then
      ffmpeg -hide_banner -loglevel warning -stats -y \
        -vaapi_device /dev/dri/renderD128 \
        -i "$f" \
        -vf "scale=w=min(1920\,iw):h=-2,format=nv12,hwupload" \
        -c:v $VCODEC -maxrate 6M -bufsize 12M \
        -c:a aac -ac 2 -b:a 192k \
        -movflags +faststart -sn \
        "$out" || { echo "    FAILED: $(basename "$f")"; rm -f "$out"; continue; }
    else
      ffmpeg -hide_banner -loglevel warning -stats -y \
        -i "$f" \
        -vf "scale=w=min(1920\,iw):h=-2" \
        -c:v $VCODEC -maxrate 6M -bufsize 12M -profile:v high -level 4.1 \
        -c:a aac -ac 2 -b:a 192k \
        -movflags +faststart -sn \
        "$out" || { echo "    FAILED: $(basename "$f")"; rm -f "$out"; continue; }
    fi
    printf '    done: %.2f GB\n' "$(stat -c%s "$out" | awk '{print $1/1e9}')"
  fi
done < <(find "$DIR" -type f \( -iname '*.mkv' -o -iname '*.mp4' -o -iname '*.avi' -o -iname '*.mov' -o -iname '*.m4v' \) -print0)

echo
if [ "$count" -eq 0 ]; then
  echo "Nothing needs converting — everything already direct-plays."
else
  printf '%d file(s), %.1f GB in, roughly %.1f GB out\n' \
    "$count" "$(echo "$total_in" | awk '{print $1/1e9}')" "$(echo "$total_est" | awk '{print $1/1e9}')"
  [ "$WRITE" = "--write" ] || echo "Re-run with --write to convert. Originals are never modified."
fi
echo
echo "Afterwards: rescan the library in Jellyfin so it picks up the new files."
