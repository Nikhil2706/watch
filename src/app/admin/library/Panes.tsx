"use client";

import { useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import {
  copySpecs,
  duplicateCopies,
  episodeCode,
  groupEpisodesLabel,
  memberMarks,
  otherCopies,
  shortPath,
  statusLine,
  type FilmRow,
  type ShowRow,
  type SpecialFeature,
} from "@/lib/admin/library-rows";

import { useToasts } from "../Toasts";
import { FeatureBlock, FranchiseBlock, ReleaseDateBlock } from "./FilmExtras";
import { GroupSettings } from "./GroupSettings";
import { IdentifyPanel, ManualPanel, PosterPanel } from "./ItemPanels";
import type { LibraryContext } from "./LibraryWorkspace";
import { Thumb } from "./Thumb";
import { GroupSubtitles, SubtitleChooser } from "./SubtitlePanels";

/**
 * The right-hand pane: everything there is to do to the selected film or
 * show. Ported from curator.html (lwRenderFilmPane, lwRenderShowPane and
 * their actions); franchise membership and special-feature mappings are in
 * FilmExtras.tsx, Show settings in GroupSettings.tsx.
 */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Panel = "identify" | "manual" | "poster" | "subtitles" | null;

export function FilmPane({
  row,
  ctx,
  onGroupEpisodes,
}: {
  row: FilmRow;
  ctx: LibraryContext;
  onGroupEpisodes: (key: string) => Promise<void>;
}) {
  const { show, offerUndo } = useToasts();
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const it = row.item;
  const feature: SpecialFeature | undefined = ctx.features[it.id];

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(null);
    }
  }

  const hide = () =>
    act("exclude", async () => {
      // What it needed before, so Undo puts it back where it was in "Needs you".
      const needed = it.needsDecision;
      await adminApi("/api/admin/library/exclude", { method: "POST", body: { path: it.path } });
      ctx.patch(it.id, { isExcluded: true, needsDecision: false });
      offerUndo(`Hidden from the site — ${row.name}.`, "Put it back", async () => {
        await adminApi("/api/admin/library/unexclude", { method: "POST", body: { path: it.path } });
        ctx.patch(it.id, { isExcluded: false, needsDecision: needed });
      });
    });

  const unhide = () =>
    act("unexclude", async () => {
      await adminApi("/api/admin/library/unexclude", { method: "POST", body: { path: it.path } });
      ctx.patch(it.id, { isExcluded: false });
      show("ok", "No longer excluded.");
    });

  const whitelist = () =>
    act("whitelist", async () => {
      await adminApi("/api/admin/library/whitelist", { method: "POST", body: { path: it.path } });
      ctx.patch(it.id, { isWhitelisted: true, needsDecision: false });
      offerUndo(`${row.name} will show on the site now, without metadata.`, "Undo", async () => {
        await adminApi("/api/admin/library/unwhitelist", { method: "POST", body: { path: it.path } });
        ctx.patch(it.id, { isWhitelisted: false, needsDecision: true });
      });
    });


  const damage = (action: "allow" | "disallow" | "recheck") =>
    act(`damage-${action}`, async () => {
      // By file, so it works for an episode inside a show as well as a film.
      await adminApi("/api/admin/library/file-check", { method: "POST", body: { action, path: it.path } });
      show(
        "ok",
        action === "allow"
          ? "Shown on the site, damage and all."
          : action === "disallow"
            ? "Off the site again until the file is replaced."
            : "It will be read through again within a few minutes, when nobody is watching.",
      );
      await ctx.reload();
    });

  const keepAsFilm = () =>
    act("keep-film", async () => {
      await adminApi("/api/admin/library/keep-as-film", { method: "POST", body: { path: it.path } });
      show("ok", "Kept as a film. It is back on the site.");
      await ctx.reload();
    });

  const markFeature = () =>
    act("sf-mark", async () => {
      const d = await adminApi<{ features: SpecialFeature[] }>("/api/admin/special-features", {
        method: "POST",
        body: { action: "mark", itemId: it.id, title: row.name },
      });
      ctx.setFeatures(d.features ?? []);
    });

  const unmarkFeature = () => {
    if (!confirm("Show this in the library again? Its mappings are dropped.")) return;
    void act("sf-unmark", async () => {
      const d = await adminApi<{ features: SpecialFeature[] }>("/api/admin/special-features", {
        method: "POST",
        body: { action: "unmark", itemId: it.id },
      });
      ctx.setFeatures(d.features ?? []);
    });
  };

  /* ---- duplicates ---- */
  const { copies, bestId } = row.isDuplicate ? duplicateCopies(ctx.rows, row) : { copies: [], bestId: null };

  const keepThis = (keeperId: string) => {
    const keeper = copies.find((c) => c.id === keeperId);
    if (!keeper) return;
    const others = otherCopies(ctx.rows, keeper);
    if (!others.length) return;
    if (
      !confirm(
        `Hide ${others.length} other cop${others.length === 1 ? "y" : "ies"} of ${keeper.name}?\n\nNothing is deleted from the drive. They stop showing on the site and you can put any of them back.`,
      )
    )
      return;
    void act("keep-this", async () => {
      await Promise.all(others.map((o) => adminApi("/api/admin/library/exclude", { method: "POST", body: { path: o.item.path } })));
      show("ok", `Kept ${keeper.name}, hid the rest.`);
      await ctx.reload();
    });
  };

  const keepVersions = (primaryId: string) => {
    const primary = copies.find((c) => c.id === primaryId);
    if (!primary) return;
    const cuts = otherCopies(ctx.rows, primary);
    if (!cuts.length) return;
    void act("keep-versions", async () => {
      const r = await adminApi<{ set: Array<{ label: string }> }>("/api/admin/library/versions", {
        method: "POST",
        body: { primaryPath: primary.item.path, paths: [primary.item.path, ...cuts.map((c) => c.item.path)] },
      });
      show(
        "ok",
        `${primary.name}: kept as ${r.set.length} versions — ${r.set.map((v) => v.label).join(", ")}. Rename any of them from its page here.`,
      );
      await ctx.reload();
    });
  };

  /* ---- versions ---- */
  const version = (action: "rename" | "primary" | "split") => {
    if (!it.version) return;
    let req: () => Promise<unknown>;
    if (action === "rename") {
      const label = prompt("What should this cut be called on the site?", it.version.label);
      if (!label || !label.trim()) return;
      req = () => adminApi("/api/admin/library/versions", { method: "PATCH", body: { path: it.path, label: label.trim() } });
    } else if (action === "primary") {
      req = () => adminApi("/api/admin/library/versions", { method: "PATCH", body: { path: it.path, makePrimary: true } });
    } else {
      req = () => adminApi("/api/admin/library/versions", { method: "DELETE", body: { path: it.path } });
    }
    void act(`version-${action}`, async () => {
      await req();
      show("ok", "Saved.");
      await ctx.reload();
    });
  };

  const done = (label: string) => {
    show("ok", label);
    setPanel(null);
    void ctx.reload();
  };

  return (
    <div>
      <div className="adm-head">
        <Thumb url={it.posterUrl} className="adm-poster" />
        <div className="adm-head-text">
          <h2 className="adm-title">
            {row.name} {it.year ? <span className="hint">({it.year})</span> : null}
          </h2>
          <div className="adm-sub">{statusLine(it)}</div>
          <div className="adm-path">{it.path ?? ""}</div>
          <div className="adm-acts">
            {it.pendingEpisode ? (
              <>
                <button type="button" onClick={() => onGroupEpisodes(it.pendingEpisode!.key)}>
                  {groupEpisodesLabel(it.pendingEpisode)}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null}
                  title="Not an episode, or it should stand on its own: shown on the site, never grouped unasked"
                  onClick={keepAsFilm}
                >
                  Keep as a film
                </button>
              </>
            ) : null}
            <button type="button" onClick={() => setPanel(panel === "identify" ? null : "identify")}>
              Identify
            </button>
            <button type="button" className="secondary" onClick={() => setPanel(panel === "manual" ? null : "manual")}>
              Type it in
            </button>
            <button type="button" className="secondary" onClick={() => setPanel(panel === "poster" ? null : "poster")}>
              Poster
            </button>
            <button type="button" className="secondary" onClick={() => setPanel(panel === "subtitles" ? null : "subtitles")}>
              Subtitles
            </button>
            {it.isThinMetadata && !it.isWhitelisted ? (
              <button type="button" className="secondary" disabled={busy === "whitelist"} onClick={whitelist}>
                Show anyway
              </button>
            ) : null}
            {it.damage ? (
              <>
                {it.damage.verdict === "damaged" ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy !== null}
                    onClick={() => damage(it.damageAllowed ? "disallow" : "allow")}
                  >
                    {it.damageAllowed ? "Take the damaged file off the site" : "Show the damaged file anyway"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null}
                  title="After replacing the file this happens by itself"
                  onClick={() => damage("recheck")}
                >
                  Check the file again
                </button>
              </>
            ) : null}
            {!feature ? (
              <button type="button" className="secondary" disabled={busy !== null} title="Hide it from Browse and keep it as an extra" onClick={markFeature}>
                Mark as special feature
              </button>
            ) : (
              <button type="button" className="secondary" disabled={busy !== null} onClick={unmarkFeature}>
                Put back in the library
              </button>
            )}
            {it.isExcluded ? (
              <button type="button" className="secondary" disabled={busy !== null} onClick={unhide}>
                Put back on the site
              </button>
            ) : (
              <button type="button" className="adm-danger" disabled={busy !== null} onClick={hide}>
                Hide from the site
              </button>
            )}
          </div>
          <div className="adm-links">
            {/* The bare /item/{id} form, which slugs.ts documents as its own fallback. */}
            <a href={`/item/${it.id}`} target="_blank" rel="noopener">
              View on site
            </a>
          </div>
        </div>
      </div>

      {panel === "identify" ? <IdentifyPanel item={it} onDone={done} onClose={() => setPanel(null)} /> : null}
      {panel === "manual" ? <ManualPanel item={it} onDone={done} onClose={() => setPanel(null)} /> : null}
      {panel === "poster" ? <PosterPanel item={it} onDone={done} onClose={() => setPanel(null)} /> : null}
      {panel === "subtitles" ? <SubtitleChooser item={it} onClose={() => setPanel(null)} onAdded={() => void ctx.reload()} /> : null}

      <FeatureBlock item={it} name={row.name} feature={feature} guess={row.featureGuess ?? undefined} ctx={ctx} />
      <FranchiseBlock item={it} name={row.name} />
      <ReleaseDateBlock item={it} />

      {it.version ? (
        <>
          <h3 className="adm-section">Versions</h3>
          <p className="hint">
            {it.version.isPrimary
              ? `This is the one the site lists; its page offers the other ${it.version.setSize - 1} cut${it.version.setSize === 2 ? "" : "s"}.`
              : `One of ${it.version.setSize} cuts of this film. The site lists the main one and links here from its page.`}{" "}
            Shown as <b>{it.version.label}</b>.
          </p>
          <div className="adm-acts">
            <button type="button" className="secondary" disabled={busy !== null} onClick={() => version("rename")}>
              Rename
            </button>
            {it.version.isPrimary ? null : (
              <button type="button" className="secondary" disabled={busy !== null} onClick={() => version("primary")}>
                List this one instead
              </button>
            )}
            <button type="button" className="secondary" disabled={busy !== null} onClick={() => version("split")}>
              Make it a separate film
            </button>
          </div>
        </>
      ) : null}

      {copies.length ? (
        <>
          <h3 className="adm-section">The copies ({copies.length})</h3>
          <div className="adm-copies">
            {copies.map((c) => (
              <div key={c.id} className={`adm-copy${c.id === bestId ? " best" : ""}`}>
                <span className="adm-spec">{copySpecs(c.item)}</span>
                <span className="adm-path">{shortPath(c.item.path)}</span>
                {c.id === row.id ? (
                  <span className="hint">Showing this one</span>
                ) : (
                  <button type="button" className="secondary" onClick={() => ctx.select(c.id)}>
                    Look at this copy
                  </button>
                )}
                <button type="button" className="secondary" disabled={busy !== null} onClick={() => keepThis(c.id)}>
                  Keep this one, hide the rest
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null}
                  title="Different cuts of one film: the site lists this one and its page switches between them"
                  onClick={() => keepVersions(c.id)}
                >
                  Keep all as versions, list this one
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function ShowPane({ row, ctx }: { row: ShowRow; ctx: LibraryContext }) {
  const { show } = useToasts();
  const [dissolving, setDissolving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  async function dissolve() {
    // In the old console this button did nothing (no handler); here it works.
    if (!confirm("Dissolve this show? Its parts go back to showing individually on Browse.")) return;
    setDissolving(true);
    try {
      await adminApi("/api/admin/library/ungroup", { method: "POST", body: { groupId: row.groupId } });
      show("ok", "Group dissolved.");
      await ctx.reload();
    } catch (e) {
      show("err", message(e));
      setDissolving(false);
    }
  }


  return (
    <div>
      <div className="adm-head">
        <Thumb url={row.poster} className="adm-poster" />
        <div className="adm-head-text">
          <h2 className="adm-title">{row.name}</h2>
          <div className="adm-sub">
            {row.members.length} files{row.isMissingSubtitles ? " · some episodes have no subtitles" : ""}
          </div>
          <div className="adm-acts">
            <a className="btn ghost" href={`/collection/${row.groupId}`} target="_blank" rel="noopener">
              View on site
            </a>
            <button type="button" className="secondary" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((o) => !o)}>
              Show settings
            </button>
            <button type="button" className="adm-danger" disabled={dissolving} onClick={dissolve}>
              Dissolve this show
            </button>
          </div>
        </div>
      </div>

      {settingsOpen ? <GroupSettings groupId={row.groupId} onChanged={() => void ctx.reload()} /> : null}

      <GroupSubtitles groupId={row.groupId} />

      <h3 className="adm-section">Files</h3>
      <div className="adm-list-box">
        {row.members.map((m) => {
          const marks = memberMarks(m);
          return (
            <div key={m.id} className="adm-ep">
              <span className="adm-ep-n">
                {/* Which episodes made the show "Damaged": only those are off the site. */}
                {marks.damage ? <span className="adm-damaged">{marks.damage}</span> : null} {marks.noSubs ? "no subs" : ""}
              </span>
              <span className="adm-ep-t">{m.name}</span>
              <button type="button" className="secondary" onClick={() => ctx.select(m.id)}>
                Open
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
