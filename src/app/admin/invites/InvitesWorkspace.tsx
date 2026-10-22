"use client";

import { useCallback, useEffect, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import {
  daysLeft,
  emailStatus,
  fmtDate,
  INVITE_FILTERS,
  inviteRequest,
  inviteRows,
  peopleChips,
  suspendConfirm,
  suspendReport,
  visibleUsers,
  type Invite,
  type InviteFilter,
  type InviteForm,
  type PeopleFilter,
  type User,
} from "@/lib/admin/invites-view";

import { useToasts } from "../Toasts";

/** The owner's account keeps admin access (db.ts OWNER_USERNAME; checked again by the server). */
const OWNER_USERNAME = "mammannii";

/**
 * The Invites tab: make an invite (its link is shown once — only a hash is
 * stored), the invites themselves with Revoke, and the people who have
 * signed up, with Langlois mode, parental control and access. Ported from
 * curator.html's Invites tab.
 */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const EMPTY_FORM: InviteForm = { label: "", uses: "1", days: "7", email: "", langlois: false };

function CreateInvite({ onCreated }: { onCreated: () => void }) {
  const { show } = useToasts();
  const [form, setForm] = useState<InviteForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [mail, setMail] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function create() {
    const req = inviteRequest(form);
    if ("error" in req) {
      show("err", req.error);
      return;
    }
    setBusy(true);
    try {
      const d = await adminApi<{ url: string; email?: string | null; email_sent?: boolean; email_error?: string | null }>("/api/admin/invites", {
        method: "POST",
        body: req.body,
      });
      setLink(d.url);
      setMail(emailStatus(d));
      setForm(EMPTY_FORM);
      setCopied(false);
      onCreated();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      show("err", "Couldn't copy — select the link and copy it yourself.");
    }
  }

  return (
    <section className="adm-card">
      <h2 className="adm-card-title">New invite</h2>
      <div className="adm-row">
        <label>
          Label
          <input value={form.label} placeholder="who is this for?" spellCheck={false} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </label>
        <label className="narrow">
          Max uses
          <input type="number" min={1} value={form.uses} onChange={(e) => setForm({ ...form, uses: e.target.value })} />
        </label>
        <label className="narrow">
          Expires (days)
          <input type="number" min={1} value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
        </label>
      </div>
      <div className="adm-row">
        <label>
          Email (optional)
          <input
            type="email"
            value={form.email}
            placeholder="send the invite straight to them"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
      </div>
      <div className="adm-row adm-invite-foot">
        <label className="adm-check adm-grow">
          <input type="checkbox" checked={form.langlois} onChange={(e) => setForm({ ...form, langlois: e.target.checked })} />
          <span>Langlois mode — raw film file + subtitle download, not just streaming</span>
        </label>
        <button type="button" disabled={busy} onClick={create}>
          {busy ? "Creating…" : "Create invite"}
        </button>
      </div>
      {mail ? <p className={mail.ok ? "adm-ok" : "error"}>{mail.text}</p> : null}
      {link ? (
        <>
          <div className="adm-row adm-link-out">
            <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
            <button type="button" className="secondary" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="hint">Save this now — the token is hashed on storage and cannot be shown again.</p>
        </>
      ) : null}
    </section>
  );
}

function InviteList({ invites, onChanged }: { invites: Invite[] | null; onChanged: () => void }) {
  const { show } = useToasts();
  const [filter, setFilter] = useState<InviteFilter>("all");
  const [showInactive, setShowInactive] = useState(false);
  const now = Date.now();

  async function revoke(i: Invite) {
    const who = i.label ? `"${i.label}"` : i.id.slice(0, 8);
    if (!confirm(`Revoke invite ${who}?\n\nThe link stops working immediately.\nAnyone who already signed up with it keeps their account.`)) return;
    try {
      await adminApi(`/api/admin/invites/${encodeURIComponent(i.id)}`, { method: "DELETE" });
      show("ok", "Revoked.");
      onChanged();
    } catch (e) {
      show("err", message(e));
    }
  }

  if (!invites) return <p className="hint">Loading…</p>;
  const { rows, hidden, count } = inviteRows(invites, filter, showInactive);

  return (
    <section className="adm-card">
      <div className="adm-row adm-list-head">
        <strong className="adm-grow">{count}</strong>
        <select value={filter} onChange={(e) => setFilter(e.target.value as InviteFilter)} aria-label="Which invites">
          {INVITE_FILTERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button type="button" className="secondary" onClick={onChanged}>
          Refresh
        </button>
      </div>
      {!rows.length && !hidden ? (
        <p className="hint">Nothing to show.</p>
      ) : !rows.length ? (
        <p className="hint">No active invites.</p>
      ) : (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Label</th>
                <th>Uses</th>
                <th>Expires</th>
                <th>Redeemed by</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td>
                    <span className={`adm-pill s-${i.status}`}>{i.status}</span>
                  </td>
                  <td>
                    {i.label || "—"}{" "}
                    {i.langlois_mode ? (
                      <span className="adm-pill" title="Raw film file + subtitle download">
                        Langlois
                      </span>
                    ) : null}
                    <div className="hint">{i.id.slice(0, 8)}…</div>
                  </td>
                  <td>
                    {i.use_count} / {i.max_uses}
                  </td>
                  <td>
                    {fmtDate(i.expires_at)}
                    <div className="hint">{i.status === "active" ? daysLeft(i.expires_at, now) : ""}</div>
                  </td>
                  <td>{i.redeemed_usernames.length ? i.redeemed_usernames.join(", ") : <span className="hint">—</span>}</td>
                  <td className="adm-right">
                    {i.status === "active" ? (
                      <button type="button" className="adm-danger" onClick={() => revoke(i)}>
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filter === "all" && hidden ? (
        <button type="button" className="secondary" onClick={() => setShowInactive(true)}>
          Show {hidden} inactive invite{hidden === 1 ? "" : "s"}
        </button>
      ) : filter === "all" && showInactive ? (
        <button type="button" className="secondary" onClick={() => setShowInactive(false)}>
          Hide inactive invites
        </button>
      ) : null}
    </section>
  );
}

function Users() {
  const { show } = useToasts();
  const [users, setUsers] = useState<User[] | null>(null);
  const [filter, setFilter] = useState<PeopleFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await adminApi<{ users: User[] }>("/api/admin/users");
      setUsers(d.users ?? []);
    } catch (e) {
      show("err", message(e));
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(u: User, body: Record<string, boolean>, done: (d: { signed_out?: number }) => string) {
    setBusy(u.id);
    try {
      const d = await adminApi<{ signed_out?: number }>(`/api/admin/users/${encodeURIComponent(u.id)}`, { method: "PATCH", body });
      show("ok", done(d ?? {}));
      await load();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="adm-card">
      <div className="adm-row adm-list-head">
        <h2 className="adm-card-title adm-grow">Users</h2>
        <button type="button" className="secondary" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className="hint">
        Langlois mode grants raw film file + subtitle downloads instead of just streaming. Set it here for an existing account, or when making
        an invite for a new one.
      </p>
      <p className="hint">
        Parental control hides R / NC-17 / TV-MA (and equivalent) titles for that account, plus anything TMDB’s certifications or{" "}
        <a href="https://www.doesthedogdie.com" target="_blank" rel="noopener">
          Does the Dog Die?
        </a>
        ’s community content-warning data flags for sexual content or graphic violence — checked across every country TMDB has a rating for.
        It’s a best-effort filter, not a guarantee: an obscure title with no rating or warning data anywhere will still slip through. Data on
        sexual content/violence topics{" "}
        <a href="https://www.doesthedogdie.com" target="_blank" rel="noopener">
          Powered by DoesTheDogDie.com
        </a>
        .
      </p>
      {users ? (
        <>
          <div className="adm-chips">
            {peopleChips(users, filter).map((c) => (
              <button
                key={c.key}
                type="button"
                className={`adm-chip${c.on ? " on" : ""}${c.alert ? " alert" : ""}`}
                disabled={!c.count}
                aria-pressed={c.on}
                onClick={() => setFilter(c.key)}
              >
                {c.label} <b>{c.count}</b>
              </button>
            ))}
          </div>
          {!users.length ? (
            <p className="hint">No users yet.</p>
          ) : (
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Last seen</th>
                    <th>Langlois mode</th>
                    <th>Parental control</th>
                    <th>Admin</th>
                    <th>Access</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers(users, filter).map((u) => (
                    <tr key={u.id}>
                      <td>
                        {u.username}{" "}
                        {u.is_admin ? (
                          <span className="adm-pill" title="Administrator">
                            Admin
                          </span>
                        ) : null}{" "}
                        {u.suspended ? (
                          <span className="adm-pill s-revoked" title="Access withdrawn: signed out everywhere and blocked from signing back in">
                            Suspended
                          </span>
                        ) : null}
                      </td>
                      <td>{fmtDate(u.last_seen_at)}</td>
                      <td>
                        {u.is_admin ? (
                          <span className="hint" title="Applying Langlois mode would also touch admin rights, so this is disabled for admin accounts">
                            —
                          </span>
                        ) : (
                          <label className="adm-check">
                            <input
                              type="checkbox"
                              checked={Boolean(u.langlois_mode)}
                              disabled={busy === u.id}
                              onChange={(e) =>
                                patch(u, { langlois_mode: e.target.checked }, () => `Langlois mode ${e.target.checked ? "enabled" : "disabled"}.`)
                              }
                            />
                            <span>{u.langlois_mode ? "On" : "Off"}</span>
                          </label>
                        )}
                      </td>
                      <td>
                        <label className="adm-check" title="Hides R / NC-17 / TV-MA (and equivalent) titles everywhere for this account, and blocks direct links to them">
                          <input
                            type="checkbox"
                            checked={Boolean(u.parental_control)}
                            disabled={busy === u.id}
                            onChange={(e) =>
                              patch(u, { parental_control: e.target.checked }, () => `Parental control ${e.target.checked ? "enabled" : "disabled"}.`)
                            }
                          />
                          <span>{u.parental_control ? "On" : "Off"}</span>
                        </label>
                      </td>
                      <td>
                        <label
                          className="adm-check"
                          title="The curator's tools (/admin), with their own sign-in, from any device. The owner's account always keeps it, and nobody can remove their own."
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(u.site_admin)}
                            disabled={busy === u.id || u.username.toLowerCase() === OWNER_USERNAME}
                            onChange={(e) => {
                              const on = e.target.checked;
                              if (on && !confirm(`Give ${u.username} admin access? They'll be able to use everything here: invites, users, the library and the worker.`)) return;
                              void patch(u, { site_admin: on }, () => `${u.username} ${on ? "is now an admin" : "is no longer an admin"}.`);
                            }}
                          />
                          <span>{u.site_admin ? "Yes" : "No"}</span>
                        </label>
                      </td>
                      <td>
                        {u.is_admin ? (
                          <span className="hint" title="Revoking would also strip admin rights, so this is disabled for admin accounts">
                            —
                          </span>
                        ) : (
                          <button
                            type="button"
                            className={u.suspended ? "secondary" : "adm-danger"}
                            disabled={busy === u.id}
                            onClick={() => {
                              const on = !u.suspended;
                              if (on && !confirm(suspendConfirm(u.username))) return;
                              void patch(u, { suspended: on }, (d) => suspendReport(on, d.signed_out));
                            }}
                          >
                            {u.suspended ? "Restore access" : "Revoke access"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <p className="hint">Loading…</p>
      )}
    </section>
  );
}

export function InvitesWorkspace() {
  const { show } = useToasts();
  const [invites, setInvites] = useState<Invite[] | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await adminApi<{ invites: Invite[] }>("/api/admin/invites");
      setInvites(d.invites ?? []);
    } catch (e) {
      show("err", message(e));
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="adm-invites">
      <CreateInvite onCreated={() => void load()} />
      <InviteList invites={invites} onChanged={() => void load()} />
      <Users />
    </div>
  );
}
