/**
 * The Invites tab's data shaping (step 2c of moving the console): invites
 * (active first, the rest behind one line), the create form's request, and
 * the Users list with its counted chips. Ported from curator.html (render,
 * renderUsers, the create handler); no React, so it can be tested.
 */

export interface Invite {
  id: string;
  label: string | null;
  max_uses: number;
  use_count: number;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  status: "active" | "revoked" | "expired" | "exhausted";
  redeemed_usernames: string[];
  email: string | null;
  langlois_mode: boolean;
}

export type InviteFilter = "all" | Invite["status"];

export const INVITE_FILTERS: ReadonlyArray<[InviteFilter, string]> = [
  ["all", "All"],
  ["active", "Active only"],
  ["revoked", "Revoked"],
  ["expired", "Expired"],
  ["exhausted", "Exhausted"],
];

/**
 * A revoked or expired invite is history, not work: on the default view they
 * collapse behind one line you can open. Choosing a status means you asked
 * for them, so nothing is hidden then.
 */
export function inviteRows(
  invites: readonly Invite[],
  filter: InviteFilter,
  showInactive: boolean,
): { rows: Invite[]; hidden: number; count: string } {
  let rows = invites.filter((i) => filter === "all" || i.status === filter);
  let hidden = 0;
  if (filter === "all" && !showInactive) {
    const live = rows.filter((i) => i.status === "active");
    hidden = rows.length - live.length;
    rows = live;
  }
  const count = `${invites.length} invite${invites.length === 1 ? "" : "s"}${hidden ? ` · ${rows.length} active` : ""}`;
  return { rows, hidden, count };
}

export function fmtDate(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

export function daysLeft(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "expired";
  const n = Math.ceil(ms / 86400000);
  return n === 1 ? "1 day left" : `${n} days left`;
}

export interface InviteForm {
  label: string;
  uses: string;
  days: string;
  email: string;
  langlois: boolean;
}

/** The POST body, sending only what differs from the server's defaults (1 use, 7 days). */
export function inviteRequest(f: InviteForm): { body: Record<string, unknown> } | { error: string } {
  const label = f.label.trim();
  if (!label) return { error: "Give it a label so you can tell them apart." };
  const body: Record<string, unknown> = { label };
  const uses = parseInt(f.uses, 10);
  const days = parseInt(f.days, 10);
  if (uses > 1) body.max_uses = uses;
  if (days && days !== 7) body.expires_in_days = days;
  if (f.email.trim()) body.email = f.email.trim();
  if (f.langlois) body.langlois_mode = true;
  return { body };
}

export function emailStatus(d: { email?: string | null; email_sent?: boolean; email_error?: string | null }): { ok: boolean; text: string } | null {
  if (!d.email) return null;
  return d.email_sent
    ? { ok: true, text: `Emailed to ${d.email}. The link below still works too.` }
    : { ok: false, text: `Created, but the email to ${d.email} didn't send (${d.email_error || "unknown reason"}). Share the link yourself.` };
}

/* ---- users ------------------------------------------------------------ */

export interface User {
  id: string;
  username: string;
  last_seen_at: number;
  langlois_mode: boolean | number;
  parental_control: boolean | number;
  suspended: boolean | number;
  is_admin: boolean | number;
}

export const PEOPLE_FILTERS = [
  { key: "all", label: "Everyone", test: () => true },
  { key: "active", label: "Active", test: (u: User) => !u.suspended && !u.is_admin },
  { key: "suspended", label: "Suspended", test: (u: User) => Boolean(u.suspended) },
  { key: "langlois", label: "Langlois mode", test: (u: User) => Boolean(u.langlois_mode) },
  { key: "admin", label: "Admins", test: (u: User) => Boolean(u.is_admin) },
] as const;

export type PeopleFilter = (typeof PEOPLE_FILTERS)[number]["key"];

export function peopleChips(users: readonly User[], on: PeopleFilter): Array<{ key: PeopleFilter; label: string; count: number; on: boolean; alert: boolean }> {
  return PEOPLE_FILTERS.map((f) => {
    const count = users.filter(f.test).length;
    return { key: f.key, label: f.label, count, on: f.key === on, alert: f.key === "suspended" && count > 0 };
  });
}

export function visibleUsers(users: readonly User[], on: PeopleFilter): User[] {
  const f = PEOPLE_FILTERS.find((x) => x.key === on) ?? PEOPLE_FILTERS[0];
  return users.filter(f.test);
}

export function suspendConfirm(username: string): string {
  return (
    `Revoke ${username}'s access?\n\nThey are signed out on every device immediately and cannot sign back in.` +
    "\nNothing is deleted — ratings, lists and comments all stay, and you can restore access at any time."
  );
}

export function suspendReport(on: boolean, signedOut: number | undefined): string {
  if (!on) return "Access restored. They can sign in again.";
  return `Access revoked${signedOut ? ` — signed out of ${signedOut} session${signedOut === 1 ? "" : "s"}.` : "."}`;
}
