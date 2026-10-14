/**
 * The Screening Room's data shaping (step 2e of moving the console): film
 * search, the create request and each screening's one line. Ported from
 * curator.html (scrSearch, scrCreate, scrLoad); no React, so it can be tested.
 */

export interface LibraryHit {
  id: string;
  name: string;
  year: number | null;
}

/** The library is held whole and filtered here; two letters before anything is shown. */
export function searchFilms(items: readonly LibraryHit[], query: string, limit = 8): LibraryHit[] | null {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return null;
  return items.filter((it) => (it.name || "").toLowerCase().includes(q)).slice(0, limit);
}

export interface ScreeningForm {
  label: string;
  message: string;
  windowHours: string;
  expiryDays: string;
  maxDevices: string;
  startsOn: "open" | "play";
}

export function screeningRequest(itemId: string | null, f: ScreeningForm): { body: Record<string, unknown> } | { error: string } {
  if (!itemId) return { error: "Pick a film first." };
  return {
    body: {
      itemId,
      recipientLabel: f.label.trim() || null,
      message: f.message.trim() || null,
      windowHours: Number(f.windowHours) || 48,
      expiryDays: Number(f.expiryDays) || 7,
      maxDevices: Number(f.maxDevices) || 2,
      windowStartsOn: f.startsOn,
    },
  };
}

export interface Screening {
  id: string;
  titles: string[];
  recipientLabel: string | null;
  revoked: boolean;
  firstOpenedAt: number | null;
  deviceCount: number;
  deviceAttempts: number;
  openedBy: string[];
}

export function screeningLine(r: Screening): string {
  const who = r.recipientLabel || "unlabelled";
  const state = r.revoked ? "withdrawn" : r.firstOpenedAt ? "opened" : "not opened yet";
  const names = r.openedBy.length ? ` — opened by someone calling themselves ${r.openedBy.join(", ")}` : "";
  return `${r.titles.join(" + ")} · for ${who} · ${state} · ${r.deviceCount}/${r.deviceAttempts} devices${names}`;
}
