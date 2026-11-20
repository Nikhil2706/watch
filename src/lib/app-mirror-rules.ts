/**
 * The app-update mirror's rules, apart from its I/O (app-mirror.ts) so they
 * can be tested. ZERO imports.
 */

export interface Descriptor {
  versionCode: number;
  versionName: string;
}

/** A GitHub latest.json, checked; null when it is not one. */
export function parseDescriptor(text: string): Descriptor | null {
  try {
    const d = JSON.parse(text) as { versionCode?: unknown; versionName?: unknown };
    const code = Number(d.versionCode);
    if (!Number.isInteger(code) || code <= 0) return null;
    const name = typeof d.versionName === "string" && d.versionName.trim() ? d.versionName.trim() : String(code);
    return { versionCode: code, versionName: name };
  } catch {
    return null;
  }
}

/**
 * One byte range of the file, from a Range header; null means the whole file
 * (no header, or one this does not understand). Android's DownloadManager
 * resumes an interrupted download with "bytes=N-".
 */
export function byteRange(header: string | null, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}
