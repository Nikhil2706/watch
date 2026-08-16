import "server-only";

import { createReadStream, createWriteStream, existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import { env } from "./env";

/**
 * Subtitle auto-promotion.
 *
 * Downloaded subtitles land in a "Subs"/"Subtitles" folder next to the video,
 * not inside it — that's how most subtitle sites and downloaders package
 * them. Jellyfin only picks up external subtitles that sit in the SAME
 * folder as the video, named "<video-basename>.<lang>.srt", so a sub pack in
 * its own subfolder is invisible to it until copied out. This runs on every
 * scan, copies (never moves — the Subs folder and its originals are left
 * exactly as they were) any new match it finds, and skips a target that
 * already exists so re-running is always a no-op.
 */

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".m4v", ".wmv", ".flv", ".webm", ".ts", ".m2ts",
]);

const SUBTITLE_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".vtt"]);

const SUB_DIR_PATTERN = /^sub(s|title|titles)?$/i;

/** ISO 639-1/639-2 codes recognised as standalone filename tokens. */
const KNOWN_CODES = new Set([
  "en", "eng", "hi", "hin", "ta", "tam", "te", "tel", "bn", "ben", "mr", "mar",
  "kn", "kan", "ml", "mal", "gu", "guj", "pa", "pan", "ur", "urd", "fr", "fre", "fra",
  "de", "ger", "deu", "es", "spa", "it", "ita", "ja", "jpn", "ko", "kor",
  "zh", "chi", "zho", "ru", "rus", "pt", "por", "ar", "ara", "nl", "dut", "nld",
]);

/** ISO 639-1 -> ISO 639-2/B, so an "en" filename token promotes to the fuller "eng" Jellyfin expects. */
const TWO_TO_THREE: Record<string, string> = {
  en: "eng", hi: "hin", ta: "tam", te: "tel", bn: "ben", mr: "mar", kn: "kan",
  ml: "mal", gu: "guj", pa: "pan", ur: "urd", fr: "fre", de: "ger", es: "spa",
  it: "ita", ja: "jpn", ko: "kor", zh: "chi", ru: "rus", pt: "por", ar: "ara", nl: "dut",
};

/** Readable language names people actually type into filenames, mapped to their code. */
const NAME_TO_CODE: Record<string, string> = {
  english: "eng", hindi: "hin", tamil: "tam", telugu: "tel", bengali: "ben",
  marathi: "mar", kannada: "kan", malayalam: "mal", gujarati: "guj", punjabi: "pan",
  urdu: "urd", french: "fre", german: "ger", spanish: "spa", italian: "ita",
  japanese: "jpn", korean: "kor", chinese: "chi", mandarin: "chi", russian: "rus",
  portuguese: "por", arabic: "ara", dutch: "dut",
};

interface ParsedSubtitle {
  code: string;
  forced: boolean;
  sdh: boolean;
}

/**
 * Pulls a language code and forced/SDH flags out of a subtitle filename.
 * Returns null when nothing recognisable is in the name — skipping a file
 * beats promoting it under a guessed-wrong language.
 */
function parseSubtitleName(filename: string): ParsedSubtitle | null {
  const stem = filename.slice(0, filename.length - extname(filename).length);
  const tokens = stem.split(/[._\-\s]+/).filter(Boolean);

  let code: string | null = null;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (KNOWN_CODES.has(lower)) {
      code = TWO_TO_THREE[lower] ?? lower;
      break;
    }
    if (NAME_TO_CODE[lower]) {
      code = NAME_TO_CODE[lower];
      break;
    }
  }
  if (!code) return null;

  return {
    code,
    forced: /forced/i.test(stem),
    sdh: /\bsdh\b|hearing.?impaired/i.test(stem),
  };
}

function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(name).toLowerCase());
}

function isSubtitleFile(name: string): boolean {
  return SUBTITLE_EXTENSIONS.has(extname(name).toLowerCase());
}

interface PendingCopy {
  from: string;
  to: string;
}

/**
 * Finds every Sub- or Subtitle-named folder that sits next to exactly one
 * video file, and returns the copy operations that would promote its recognisable
 * subtitles into that video's own folder. Read-only — no fs writes happen
 * here, so a caller can inspect the plan before acting on it.
 *
 * Deliberately skips a folder with zero or 2+ sibling videos: with exactly
 * one video the mapping is unambiguous; with more there is no way to tell
 * which subtitle belongs to which file without guessing, and a wrong guess
 * means captions burned onto the wrong film.
 */
function planPromotions(root: string): PendingCopy[] {
  const plan: PendingCopy[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    const subDirs: string[] = [];
    const videoFiles: string[] = [];

    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        subDirs.push(entry);
        walk(full);
      } else if (isVideoFile(entry)) {
        videoFiles.push(entry);
      }
    }

    for (const subDirName of subDirs) {
      if (!SUB_DIR_PATTERN.test(subDirName)) continue;
      if (videoFiles.length !== 1) continue;

      const videoFile = videoFiles[0]!;
      const videoBase = videoFile.slice(0, videoFile.length - extname(videoFile).length);
      const subDirPath = join(dir, subDirName);

      let subFiles: string[];
      try {
        subFiles = readdirSync(subDirPath);
      } catch {
        continue;
      }

      for (const subFile of subFiles) {
        if (!isSubtitleFile(subFile)) continue;
        const parsed = parseSubtitleName(subFile);
        if (!parsed) continue;

        const flagSuffix = parsed.forced ? ".forced" : parsed.sdh ? ".sdh" : "";
        const targetName = `${videoBase}.${parsed.code}${flagSuffix}${extname(subFile).toLowerCase()}`;
        const targetPath = join(dir, targetName);
        if (existsSync(targetPath)) continue;

        plan.push({ from: join(subDirPath, subFile), to: targetPath });
      }
    }
  }

  walk(root);
  return plan;
}

export interface PromotionResult {
  promoted: PendingCopy[];
  failed: Array<PendingCopy & { error: string }>;
}

/**
 * Walks the library and copies every newly-found subtitle into place.
 *
 * Uses a manual stream copy rather than fs.copyFileSync: copyFileSync's
 * copy_file_range fast path has been observed failing with EPERM on this
 * Docker Desktop/WSL2 virtiofs setup, so the safe path is read-stream ->
 * write-stream, same workaround used for the earlier file-move code.
 */
export async function promoteSubtitles(
  root: string = env.mediaLibraryPath,
): Promise<PromotionResult> {
  const plan = planPromotions(root);
  const promoted: PendingCopy[] = [];
  const failed: Array<PendingCopy & { error: string }> = [];

  for (const copy of plan) {
    try {
      await pipeline(createReadStream(copy.from), createWriteStream(copy.to));
      promoted.push(copy);
    } catch (error) {
      failed.push({ ...copy, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { promoted, failed };
}
