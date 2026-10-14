/**
 * The Uploads tab's data shaping (step 2d of moving the console). Ported from
 * curator.html (renderUploads); no React, so it can be tested.
 *
 * Deliberately still a table, not a rail and pane: who sent it, how big,
 * whether the scan cleared it, when — all things you compare across rows
 * before approving anything.
 */

export type UploadStatus = "uploaded" | "scanning" | "clean" | "infected" | "approved" | "rejected";

export interface Upload {
  id: string;
  filename: string;
  username: string;
  size_bytes: number;
  status: UploadStatus;
  scan_result: string | null;
  created_at: number;
}

export const STATUS_LABEL: Record<UploadStatus, string> = {
  uploaded: "Waiting for the virus scan",
  scanning: "Scanning",
  clean: "Clean — ready for review",
  infected: "Infected",
  approved: "Approved",
  rejected: "Rejected",
};

export const UPLOAD_FILTERS = [
  { key: "review", label: "Ready to review", test: (u: Upload) => u.status === "clean", alert: true },
  { key: "scanning", label: "Scanning", test: (u: Upload) => u.status === "scanning" || u.status === "uploaded", alert: false },
  { key: "infected", label: "Failed the scan", test: (u: Upload) => u.status === "infected", alert: true },
  { key: "all", label: "Everything", test: () => true, alert: false },
] as const;

export type UploadFilter = (typeof UPLOAD_FILTERS)[number]["key"];

export function uploadChips(list: readonly Upload[], on: UploadFilter): Array<{ key: UploadFilter; label: string; count: number; on: boolean; alert: boolean }> {
  return UPLOAD_FILTERS.map((f) => {
    const count = list.filter(f.test).length;
    return { key: f.key, label: f.label, count, on: f.key === on, alert: f.alert && count > 0 };
  });
}

export function visibleUploads(list: readonly Upload[], on: UploadFilter): Upload[] {
  const f = UPLOAD_FILTERS.find((x) => x.key === on) ?? UPLOAD_FILTERS[3];
  return list.filter(f.test);
}

/** What can be done to an upload in its state: approve only once the scan is clean. */
export function uploadActions(u: Pick<Upload, "status">): { approve: boolean; reject: boolean } {
  return {
    approve: u.status === "clean",
    reject: u.status === "clean" || u.status === "infected" || u.status === "uploaded" || u.status === "scanning",
  };
}

/** The scan's detail, while it still matters (not once approved or rejected). */
export function scanNote(u: Pick<Upload, "status" | "scan_result">): string | null {
  return u.scan_result && u.status !== "approved" && u.status !== "rejected" ? u.scan_result : null;
}

export function statusTone(status: UploadStatus): "s-infected" | "s-clean" | "" {
  return status === "infected" ? "s-infected" : status === "clean" ? "s-clean" : "";
}
