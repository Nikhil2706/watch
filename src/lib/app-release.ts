/**
 * Where the Android app is published. The APK workflow
 * (.github/workflows/android-apk.yml) replaces the "latest" GitHub release on
 * every app change, and GitHub serves /releases/latest/download/<asset> as a
 * redirect to it — so these URLs never change, and the installed app's
 * self-update (UpdateChecker.java) reads the very same latest.json.
 */
const RELEASES = "https://github.com/Nikhil2706/watch/releases/latest/download/";

export const APP_APK_URL = `${RELEASES}watch-release.apk`;
export const APP_MANIFEST_URL = `${RELEASES}latest.json`;

export type AppRelease = { versionCode: number; versionName: string };

/** Server-side, cached ten minutes; null when GitHub can't be reached. */
export async function getLatestAppRelease(): Promise<AppRelease | null> {
  try {
    const response = await fetch(APP_MANIFEST_URL, {
      next: { revalidate: 600 },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<AppRelease>;
    if (typeof data.versionCode !== "number") return null;
    return { versionCode: data.versionCode, versionName: String(data.versionName ?? data.versionCode) };
  } catch {
    return null;
  }
}
