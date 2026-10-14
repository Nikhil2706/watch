"use client";

import { useCallback, useEffect, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { fmtBytes } from "@/lib/admin/health-view";
import { fmtDate } from "@/lib/admin/invites-view";
import {
  scanNote,
  STATUS_LABEL,
  statusTone,
  uploadActions,
  uploadChips,
  visibleUploads,
  type Upload,
  type UploadFilter,
} from "@/lib/admin/uploads-view";

import { useToasts } from "../Toasts";

/**
 * Langlois-mode uploads: each waits in quarantine until it clears the virus
 * scan (ClamAV in the worker) and your review. Approve moves it into the
 * watch folder, where the worker picks it up. Ported from curator.html's
 * Uploads tab.
 */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function UploadsWorkspace() {
  const { show } = useToasts();
  const [uploads, setUploads] = useState<Upload[] | null>(null);
  const [filter, setFilter] = useState<UploadFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await adminApi<{ uploads: Upload[] }>("/api/admin/uploads");
      setUploads(d.uploads ?? []);
    } catch (e) {
      show("err", message(e));
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(u: Upload, action: "approve" | "reject") {
    const ask =
      action === "approve"
        ? "Approve this upload? It will move into the watch folder and appear in the library once processed."
        : "Reject and delete this upload? This can't be undone.";
    if (!confirm(ask)) return;
    setBusy(u.id);
    try {
      await adminApi(`/api/admin/uploads/${encodeURIComponent(u.id)}/${action}`, { method: "POST", body: {} });
      show("ok", action === "approve" ? "Approved — the worker will pick it up shortly." : "Rejected.");
      await load();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(null);
    }
  }

  const rows = uploads ? visibleUploads(uploads, filter) : [];

  return (
    <section className="adm-card">
      <div className="adm-row adm-list-head">
        <h2 className="adm-card-title adm-grow">Langlois-mode uploads</h2>
        <button type="button" className="secondary" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className="hint">
        Every upload sits here until it clears both the virus scan and your own review. Nothing reaches the real library without both — Approve
        only becomes available once the scan comes back clean.
      </p>
      {!uploads ? (
        <p className="hint">Loading…</p>
      ) : (
        <>
          <div className="adm-chips">
            {uploadChips(uploads, filter).map((c) => (
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
          {!uploads.length ? (
            <p className="hint">No uploads yet.</p>
          ) : !rows.length ? (
            <p className="hint">Nothing in that state.</p>
          ) : (
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>From</th>
                    <th>Size</th>
                    <th>Status</th>
                    <th>Uploaded</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => {
                    const acts = uploadActions(u);
                    const note = scanNote(u);
                    return (
                      <tr key={u.id}>
                        <td className="adm-break">{u.filename}</td>
                        <td>{u.username}</td>
                        <td>{fmtBytes(u.size_bytes)}</td>
                        <td>
                          <span className={`adm-pill ${statusTone(u.status)}`}>{STATUS_LABEL[u.status] ?? u.status}</span>
                          {note ? <div className="hint">{note}</div> : null}
                        </td>
                        <td>{fmtDate(u.created_at)}</td>
                        <td className="adm-right">
                          {acts.approve ? (
                            <button type="button" disabled={busy === u.id} onClick={() => decide(u, "approve")}>
                              Approve
                            </button>
                          ) : null}{" "}
                          {acts.reject ? (
                            <button type="button" className="adm-danger" disabled={busy === u.id} onClick={() => decide(u, "reject")}>
                              Reject
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
