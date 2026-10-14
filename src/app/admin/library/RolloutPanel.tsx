"use client";

import { useEffect, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import {
  fileName,
  noScheduleMessage,
  rolloutFormFrom,
  rolloutRequest,
  slotStatus,
  slotsSummary,
  type RolloutForm,
  type RolloutPlan,
  type RolloutSlot,
} from "@/lib/admin/library-extras";

import { useToasts } from "../Toasts";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ago(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} hr ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * A scheduled release (rollout.ts): a show's episodes, or a franchise's
 * films, revealed so many at a time. The same panel for both; only what a
 * slot holds (a file, or an IMDb id) differs.
 */
export function RolloutPanel({ subjectType, subjectId, totalLabel }: { subjectType: "group" | "series"; subjectId: string; totalLabel: string }) {
  const { show } = useToasts();
  const [form, setForm] = useState<RolloutForm | null>(null);
  const [slots, setSlots] = useState<RolloutSlot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    adminApi<{ plan: RolloutPlan | null; slots: RolloutSlot[] }>(
      `/api/admin/library/rollout?subjectType=${subjectType}&subjectId=${encodeURIComponent(subjectId)}`,
    )
      .then((d) => {
        if (!live) return;
        setForm(rolloutFormFrom(d.plan, d.slots ?? [], Date.now()));
        setSlots(d.slots ?? []);
      })
      .catch(() => {
        if (!live) return;
        setForm(rolloutFormFrom(null, [], Date.now()));
        setError("Couldn't load the rollout schedule.");
      });
    return () => {
      live = false;
    };
  }, [subjectType, subjectId]);

  async function save() {
    if (!form) return;
    const req = rolloutRequest(subjectType, subjectId, form, Date.now());
    if (!req.ok) {
      show("err", req.error);
      return;
    }
    setSaving(true);
    try {
      const d = await adminApi<{ slots: RolloutSlot[] }>("/api/admin/library/rollout", { method: "POST", body: req.body });
      setSlots(d.slots ?? []);
      setError(null);
      show("ok", "Rollout schedule saved.");
    } catch (e) {
      show("err", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!form) return <p className="hint">Loading the release schedule…</p>;
  const set = (patch: Partial<RolloutForm>) => setForm({ ...form, ...patch });
  const now = Date.now();

  return (
    <div className="adm-rollout">
      <strong>Scheduled rollout</strong>
      <div className="adm-row">
        <label>
          Release
          <select value={form.mode} onChange={(e) => set({ mode: e.target.value as RolloutForm["mode"] })}>
            <option value="immediate">Everything now</option>
            <option value="daily">N per day</option>
            <option value="weekly">Weekly, one day/time</option>
          </select>
        </label>
        <label className="narrow">
          Per release
          <input type="number" min={1} value={form.perRelease} onChange={(e) => set({ perRelease: e.target.value })} />
        </label>
        {form.mode === "weekly" ? (
          <>
            <label className="narrow">
              Weekday
              <select value={form.weekday} onChange={(e) => set({ weekday: e.target.value })}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={String(i)}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="narrow">
              Time
              <input type="time" value={form.timeOfDay} onChange={(e) => set({ timeOfDay: e.target.value })} />
            </label>
          </>
        ) : null}
        <label>
          Starts
          <input type="datetime-local" value={form.start} onChange={(e) => set({ start: e.target.value })} />
        </label>
        <label className="narrow">
          {totalLabel}
          <input type="number" min={1} value={form.total} onChange={(e) => set({ total: e.target.value })} />
        </label>
      </div>
      <div className="adm-acts">
        <button type="button" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save schedule"}
        </button>
      </div>
      {error ? <p className="hint">{error}</p> : null}
      {slots && !slots.length ? <p className="hint">{noScheduleMessage(subjectType)}</p> : null}
      {slots && slots.length ? (
        <div className="adm-list-box">
          <div className="adm-ep hint">{slotsSummary(slots)}</div>
          {slots.map((s) => {
            const status = slotStatus(s, now);
            return (
              <div key={s.slotIndex} className={`adm-ep adm-slot-${status}`}>
                <span className="adm-ep-n">#{s.slotIndex}</span>
                <span className="adm-ep-t">
                  {subjectType === "group" ? (s.path ? fileName(s.path) : <em>no file yet</em>) : s.imdbId ? s.imdbId : <em>no owned film yet</em>}
                </span>
                <span className="hint">{s.revealedAt ? `revealed ${ago(s.revealedAt)}` : new Date(s.releaseAt).toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
