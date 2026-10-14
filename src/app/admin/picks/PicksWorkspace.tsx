"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import {
  countsLine,
  droppedBefore,
  fullOrder,
  homeNote,
  itemBody,
  keptLine,
  moved,
  pickChips,
  publishQuestion,
  sourceBits,
  splitItems,
  statusLine,
  stripTags,
  underOf,
  usePassage,
  type Pick,
  type PickItem,
  type Under,
} from "@/lib/admin/picks-view";

import { Thumb } from "../library/Thumb";
import { useToasts } from "../Toasts";

/**
 * Picks: lists of films and shows for everyone or chosen people, each with
 * a writeup per title. The order of the list is the order on the Picks page.
 * A pick is a draft until published; publishing one made for chosen people
 * notifies them. Ported from curator.html's Picks tab.
 */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface UserLite {
  id: string;
  username: string;
}

interface PickData {
  pick: Pick;
  items: PickItem[];
  recipients: string[];
  notified?: number;
}

/** Drag a row onto another to move it in front; works with the mouse, the arrows work everywhere. */
function useDrag(onDrop: (dragged: string, target: string) => void) {
  const dragging = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  return {
    over,
    rowProps: (id: string) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        const t = e.target as HTMLElement;
        // Dragging out of a text box is selecting text, not moving the row.
        if (t.matches?.("textarea, input")) {
          e.preventDefault();
          return;
        }
        dragging.current = id;
        e.dataTransfer.effectAllowed = "move";
      },
      onDragOver: (e: React.DragEvent) => {
        if (!dragging.current || dragging.current === id) return;
        e.preventDefault();
        setOver(id);
      },
      onDragLeave: () => setOver((o) => (o === id ? null : o)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const d = dragging.current;
        dragging.current = null;
        setOver(null);
        if (d && d !== id) onDrop(d, id);
      },
      onDragEnd: () => {
        dragging.current = null;
        setOver(null);
      },
    }),
  };
}

function autoGrow(area: HTMLTextAreaElement | null) {
  if (!area) return;
  // As tall as its text, up to about twenty lines.
  area.style.height = "auto";
  area.style.height = `${Math.min(area.scrollHeight + 2, 440)}px`;
  area.style.overflowY = area.scrollHeight + 2 > 440 ? "auto" : "hidden";
}

function ItemRow({
  item,
  index,
  under,
  pickId,
  onSaved,
  onMove,
  onRemove,
  drag,
  over,
}: {
  item: PickItem;
  index: number;
  under: Under;
  pickId: string;
  onSaved: (it: Partial<PickItem> & { id: string }) => void;
  onMove: (dir: "up" | "down") => void;
  onRemove: () => void;
  drag: ReturnType<ReturnType<typeof useDrag>["rowProps"]>;
  over: boolean;
}) {
  const [writeup, setWriteup] = useState(item.writeup ?? "");
  const [credit, setCredit] = useState(item.writeup_source_label ?? "");
  const [creditUrl, setCreditUrl] = useState<string | null>(item.writeup_source_url);
  const [rank, setRank] = useState(item.rank === null ? "" : String(item.rank));
  const [word, setWord] = useState(item.label ?? "");
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);
  const [passages, setPassages] = useState<Array<{ text: string; sourceName: string; articleTitle: string; articleUrl: string | null }> | null | "loading">(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => autoGrow(area.current), [writeup]);

  async function save(over?: Partial<{ writeup: string; credit: string; creditUrl: string | null }>) {
    setSaved({ ok: true, text: "Saving…" });
    try {
      const body = itemBody({
        writeup: over?.writeup ?? writeup,
        credit: over?.credit ?? credit,
        creditUrl: over?.creditUrl !== undefined ? over.creditUrl : creditUrl,
        ...(under === "number" ? { rank } : {}),
        ...(under === "word" ? { word } : {}),
      });
      const d = await adminApi<{ item: PickItem }>(`/api/admin/picks/${encodeURIComponent(pickId)}/items/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body,
      });
      onSaved({ ...d.item, id: item.id });
      setSaved({ ok: true, text: "Saved" });
      setTimeout(() => setSaved((s) => (s?.text === "Saved" ? null : s)), 2500);
    } catch (e) {
      setSaved({ ok: false, text: message(e) });
    }
  }

  async function togglePassages() {
    if (passages && passages !== "loading") {
      setPassages(null);
      return;
    }
    setPassages("loading");
    try {
      const d = await adminApi<{ passages: NonNullable<Exclude<typeof passages, "loading">> }>(
        `/api/admin/picks/sources?imdb_id=${encodeURIComponent(item.imdb_id ?? "")}`,
      );
      setPassages(d.passages ?? []);
    } catch (e) {
      setPassages([]);
      setSaved({ ok: false, text: message(e) });
    }
  }

  function use(p: { text: string; sourceName: string; articleUrl: string | null }, how: "replace" | "append") {
    const next = usePassage(writeup, p.text, how);
    setWriteup(next);
    setCredit(p.sourceName);
    setCreditUrl(p.articleUrl);
    void save({ writeup: next, credit: p.sourceName, creditUrl: p.articleUrl });
  }

  return (
    <div className={`adm-pk-item${over ? " over" : ""}`} {...drag}>
      <span className="adm-pk-grip" title="Drag to reorder" aria-hidden="true">
        ⠿
      </span>
      {under === "number" ? (
        <input
          className="adm-pk-rank"
          type="number"
          min={1}
          value={rank}
          placeholder={String(index + 1)}
          title="The number shown under the poster. Leave empty to number by position."
          aria-label="Number under the poster"
          onChange={(e) => setRank(e.target.value)}
          onBlur={() => void save()}
        />
      ) : under === "word" ? (
        <input
          className="adm-pk-word"
          maxLength={12}
          value={word}
          placeholder="Word"
          title="The word shown under the poster, up to 12 characters."
          aria-label="Word under the poster"
          onChange={(e) => setWord(e.target.value)}
          onBlur={() => void save()}
        />
      ) : null}
      <Thumb url={item.posterUrl} className="adm-thumb" />
      <div className="adm-grow">
        <div className="adm-row adm-pk-item-head">
          <div className="adm-grow adm-pk-item-title">
            {item.displayTitle} {item.displayYear ? <span className="hint">{item.displayYear}</span> : null}
            {item.kind !== "film" ? <span className="hint"> · {item.kind}</span> : null}
          </div>
          <span className="adm-acts">
            <button type="button" className="secondary adm-sf-x" title="Move up" onClick={() => onMove("up")}>
              ↑
            </button>
            <button type="button" className="secondary adm-sf-x" title="Move down" onClick={() => onMove("down")}>
              ↓
            </button>
            <button
              type="button"
              className="secondary adm-sf-x"
              title="Remove from this pick"
              onClick={() => {
                if (writeup.trim() && !confirm("Remove this title and its writeup from the pick?")) return;
                onRemove();
              }}
            >
              ✕
            </button>
          </span>
        </div>
        <textarea
          ref={area}
          className="adm-pk-writeup"
          placeholder="Why this one. A blank line starts a new paragraph."
          value={writeup}
          onChange={(e) => setWriteup(e.target.value)}
          onBlur={() => {
            if (writeup !== (item.writeup ?? "")) void save();
          }}
        />
        <div className="adm-row adm-pk-foot">
          <input
            className="adm-grow"
            placeholder="Credit, if the words are someone else’s"
            value={credit}
            aria-label="Credit"
            onChange={(e) => setCredit(e.target.value)}
            onBlur={() => {
              if (credit !== (item.writeup_source_label ?? "")) void save();
            }}
          />
          {item.kind === "film" && item.imdb_id ? (
            <button type="button" className="secondary" onClick={togglePassages}>
              Scraped passages
            </button>
          ) : null}
          {saved ? <span className={saved.ok ? "hint" : "adm-bad"}>{saved.text}</span> : null}
        </div>
        {passages === "loading" ? (
          <p className="hint">Loading…</p>
        ) : passages ? (
          passages.length ? (
            <div className="adm-pk-passages">
              {passages.map((p, i) => (
                <div key={i} className="adm-pk-passage">
                  <div>{p.text}</div>
                  <div className="adm-row adm-pk-passage-foot">
                    <span className="hint adm-grow">
                      {p.sourceName} · {p.articleTitle}
                    </span>
                    <button type="button" className="secondary" onClick={() => use(p, "replace")}>
                      Use this
                    </button>
                    <button type="button" className="secondary" onClick={() => use(p, "append")}>
                      Add below
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="hint">Nothing has been scraped for this film.</p>
          )
        ) : null}
      </div>
    </div>
  );
}

function AddTitle({ pickId, onAdded }: { pickId: string; onAdded: (items: PickItem[]) => void }) {
  const { show } = useToasts();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ imdbId: string; name: string; year: number | null; href: string; posterUrl: string | null }> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef("");

  function search(value: string) {
    setQ(value);
    if (timer.current) clearTimeout(timer.current);
    const query = value.trim();
    latest.current = query;
    if (query.length < 2) {
      setResults(null);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const d = await adminApi<{ results: NonNullable<typeof results> }>(`/api/admin/accolades/search?episodes=1&q=${encodeURIComponent(query)}`);
        if (latest.current === query) setResults(d.results ?? []);
      } catch (e) {
        if (latest.current === query) show("err", message(e));
      }
    }, 250);
  }

  async function add(r: NonNullable<typeof results>[number]) {
    try {
      const d = await adminApi<{ items: PickItem[] }>(`/api/admin/picks/${encodeURIComponent(pickId)}/items`, {
        method: "POST",
        body: { title: r.name, imdb_id: r.imdbId, href: r.href, ...(r.year ? { year: r.year } : {}) },
      });
      onAdded(d.items ?? []);
      setQ("");
      setResults(null);
    } catch (e) {
      show("err", message(e));
    }
  }

  return (
    <div className="adm-pk-add">
      <label>
        Add a film, a show or an episode
        <input value={q} placeholder="Search your library — a film, a show, or an episode (west wing s02e22)" spellCheck={false} onChange={(e) => search(e.target.value)} />
      </label>
      {results === null ? null : results.length ? (
        <div className="adm-rows">
          {results.map((r) => (
            <button key={r.imdbId + r.href} type="button" className="adm-pk-result" onClick={() => add(r)}>
              <Thumb url={r.posterUrl} className="adm-thumb" />
              <span>
                {r.name} <span className="hint">{r.year ?? ""}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="hint">No matches in the library.</p>
      )}
    </div>
  );
}

function Editor({ id, users, onListChanged, onDeleted }: { id: string; users: UserLite[]; onListChanged: () => void; onDeleted: () => void }) {
  const { show } = useToasts();
  const [data, setData] = useState<PickData | null>(null);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [kept, setKept] = useState<Array<{ title: string; year: number | null; writeup: string | null; restored?: boolean; leftBecause?: string; leftAt: number; rank?: number | null; label?: string | null }>>([]);

  const apply = useCallback((d: PickData) => {
    setData(d);
    setTitle(d.pick.title);
    setSubtitle(d.pick.subtitle ?? "");
  }, []);

  const open = useCallback(async () => {
    try {
      apply(await adminApi<PickData>(`/api/admin/picks/${encodeURIComponent(id)}`));
    } catch (e) {
      show("err", message(e));
    }
  }, [apply, id, show]);

  useEffect(() => {
    void open();
    // Leaving soon keeps what was written about titles that have left it.
    if (id === "leaving-soon") {
      adminApi<{ kept: typeof kept }>("/api/admin/library/removals")
        .then((d) => setKept(d.kept ?? []))
        .catch(() => setKept([]));
    } else setKept([]);
  }, [id, open]);

  async function patch(body: Record<string, unknown>, quiet = false): Promise<PickData | null> {
    try {
      const d = await adminApi<PickData>(`/api/admin/picks/${encodeURIComponent(id)}`, { method: "PATCH", body });
      apply(d);
      onListChanged();
      if (!quiet) show("ok", "Saved.");
      return d;
    } catch (e) {
      show("err", message(e));
      void open();
      return null;
    }
  }

  const drag = useDrag((dragged, target) => {
    if (!data) return;
    const shown = splitItems(data.items).present.map((p) => p.it.id);
    void reorder(droppedBefore(shown, dragged, target));
  });

  async function reorder(shownIds: string[]) {
    if (!data) return;
    try {
      const d = await adminApi<{ items: PickItem[] }>(`/api/admin/picks/${encodeURIComponent(id)}/items`, {
        method: "PUT",
        body: { ids: fullOrder(shownIds, data.items) },
      });
      setData({ ...data, items: d.items ?? [] });
    } catch (e) {
      show("err", message(e));
      void open();
    }
  }

  async function remove(itemId: string) {
    try {
      await adminApi(`/api/admin/picks/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
      await open();
      onListChanged();
    } catch (e) {
      show("err", message(e));
    }
  }

  if (!data) return <section className="adm-card"><p className="hint">Loading…</p></section>;
  const p = data.pick;
  const live = p.status === "live";
  const under = underOf(p);
  const { present, missing } = splitItems(data.items);
  const shownIds = present.map((x) => x.it.id);

  return (
    <section className="adm-card">
      <div className="adm-row adm-pk-editor-head">
        <div className="adm-grow">
          <b>{live ? "Live" : "Draft."}</b> {statusLine(p).replace(/^Live|^Draft\./, "")}
        </div>
        <div className="adm-acts">
          {live ? (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (!confirm("Take this pick off the site? It stays here as a draft.")) return;
                  void patch({ status: "draft" }, true).then((d) => d && show("ok", "Unpublished."));
                }}
              >
                Unpublish
              </button>
              <a className="btn ghost" href={`/picks/${encodeURIComponent(p.id)}`} target="_blank" rel="noopener">
                Open on the site ↗
              </a>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (!confirm(publishQuestion(p, data.recipients.length))) return;
                void patch({ status: "live" }, true).then((d) => d && show("ok", `Published.${d.notified ? ` Notified ${d.notified}.` : ""}`));
              }}
            >
              Publish
            </button>
          )}
          {p.id === "leaving-soon" ? null : (
            <button
              type="button"
              className="adm-danger"
              onClick={async () => {
                if (!confirm(`Delete “${p.title}” and every writeup in it? This can't be undone.`)) return;
                try {
                  await adminApi(`/api/admin/picks/${encodeURIComponent(p.id)}`, { method: "DELETE" });
                  show("ok", "Deleted.");
                  onDeleted();
                } catch (e) {
                  show("err", message(e));
                }
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>
      <label>
        Title
        <input
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            const v = title.trim();
            if (!v) setTitle(p.title);
            else if (v !== p.title) void patch({ title: v });
          }}
        />
      </label>
      <label>
        Subtitle (optional)
        <input
          maxLength={200}
          value={subtitle}
          placeholder="These movies make you want to believe things you know not to be true."
          onChange={(e) => setSubtitle(e.target.value)}
          onBlur={() => {
            if (subtitle.trim() !== (p.subtitle ?? "")) void patch({ subtitle: subtitle.trim() || null });
          }}
        />
      </label>
      <div className="adm-pk-options">
        <div>
          <div className="adm-pk-label">Under each poster</div>
          <div className="adm-seg" role="group" aria-label="Under each poster">
            {(["number", "word", "nothing"] as const).map((u) => (
              <button key={u} type="button" className={under === u ? "on" : undefined} aria-pressed={under === u} onClick={() => patch({ under: u })}>
                {u === "number" ? "A number" : u === "word" ? "A word" : "Nothing"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="adm-pk-label">Who sees it</div>
          <div className="adm-seg" role="group" aria-label="Who sees it">
            {(["everyone", "people"] as const).map((a) => (
              <button
                key={a}
                type="button"
                className={p.audience === a ? "on" : undefined}
                aria-pressed={p.audience === a}
                onClick={() => {
                  if (
                    a === "people" &&
                    live &&
                    data.recipients.length &&
                    !confirm(
                      `This pick is live. Switching it to chosen people hides it from everyone else and notifies the ${data.recipients.length} ticked now. Go ahead?`,
                    )
                  )
                    return;
                  void patch({ audience: a });
                }}
              >
                {a === "everyone" ? "Everyone" : "Chosen people"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="adm-pk-label">Home</div>
          <label className="adm-check">
            <input type="checkbox" checked={Boolean(p.pinned)} onChange={(e) => patch({ pinned: e.target.checked })} />
            <span>Keep on Home</span>
          </label>
          <div className="hint">{homeNote(p, Date.now())}</div>
        </div>
      </div>
      {p.audience === "people" ? (
        <div>
          <div className="adm-pk-label">Made for</div>
          <p className="hint">They get a notification when you publish. Anyone you add later is told then.</p>
          <div className="adm-pk-users">
            {users.length ? (
              users.map((u) => (
                <label key={u.id} className="adm-check">
                  <input
                    type="checkbox"
                    checked={data.recipients.includes(u.id)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...data.recipients, u.id] : data.recipients.filter((x) => x !== u.id);
                      void patch({ recipients: next }, true);
                    }}
                  />
                  <span>{u.username}</span>
                </label>
              ))
            ) : (
              <p className="hint">No users yet.</p>
            )}
          </div>
        </div>
      ) : null}
      {p.source_label ? <p className="hint">Copied from: {p.source_label}</p> : null}

      <div className="adm-row adm-pk-titles-head">
        <h3 className="adm-section adm-grow">Titles</h3>
        <span className="hint">{countsLine(present.length, missing.length)}</span>
      </div>
      <AddTitle
        pickId={p.id}
        onAdded={(items) => {
          setData({ ...data, items });
          onListChanged();
        }}
      />
      {present.length ? (
        present.map(({ it, index }) => (
          <ItemRow
            key={it.id}
            item={it}
            index={index}
            under={under}
            pickId={p.id}
            drag={drag.rowProps(it.id)}
            over={drag.over === it.id}
            onSaved={(changes) => setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === changes.id ? { ...x, ...changes } : x)) } : d))}
            onMove={(dir) => {
              const next = moved(shownIds, it.id, dir);
              if (next) void reorder(next);
            }}
            onRemove={() => void remove(it.id)}
          />
        ))
      ) : (
        <p className="hint">No titles from the library yet. Add one above.</p>
      )}
      {missing.length ? (
        <details className="adm-pk-missing">
          <summary>
            {missing.length} from this list {missing.length === 1 ? "is" : "are"} not in the library
          </summary>
          <p className="hint">Kept in the pick and hidden from the site. Each one joins the row when it arrives in the library.</p>
          {missing.map(({ it, index }) => (
            <div key={it.id} className="adm-row adm-pk-missing-row">
              <span className="adm-grow">
                {under === "number" ? `#${it.rank === null ? index + 1 : it.rank} · ` : ""}
                {it.displayTitle}
                {it.displayYear ? ` (${it.displayYear})` : ""}
              </span>
              <button type="button" className="secondary adm-sf-x" title="Remove from this pick" onClick={() => void remove(it.id)}>
                ✕
              </button>
            </div>
          ))}
        </details>
      ) : null}
      {kept.length ? (
        <details className="adm-pk-missing">
          <summary>
            {kept.length} writeup{kept.length === 1 ? "" : "s"} kept from titles that have left
          </summary>
          <p className="hint">Kept from titles that are no longer in this pick. If one is ever leaving again, what you wrote is put back on it.</p>
          {kept.map((k, i) => (
            <div key={i} className="adm-pk-kept">
              <b>{k.title}</b>
              {k.year ? ` ${k.year}` : ""} <span className="hint">{keptLine(k)}</span>
              {stripTags(k.writeup) ? <div className="hint">{stripTags(k.writeup)}</div> : null}
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}

function StartPick({ onCreated }: { onCreated: (id: string) => void }) {
  const { show } = useToasts();
  const [title, setTitle] = useState("");
  const [ranked, setRanked] = useState(false);
  const [q, setQ] = useState("");
  const [sources, setSources] = useState<Array<{ kind: "article" | "accolade"; id: string; title: string; sourceName: string; inLibrary: number; entries: number; ranked: boolean; withWriteups?: number }> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchSources = useCallback(
    async (query: string) => {
      try {
        const d = await adminApi<{ sources: NonNullable<typeof sources> }>(`/api/admin/picks/sources?q=${encodeURIComponent(query)}`);
        setSources(d.sources ?? []);
      } catch (e) {
        show("err", message(e));
      }
    },
    [show],
  );

  useEffect(() => {
    void searchSources("");
  }, [searchSources]);

  async function create(body: Record<string, unknown>) {
    try {
      const d = await adminApi<{ pick: { id: string } }>("/api/admin/picks", { method: "POST", body });
      if (body.from_article || body.from_accolade) show("ok", "Copied into a draft pick. Nothing is on the site until you publish it.");
      onCreated(d.pick.id);
    } catch (e) {
      show("err", message(e));
    }
  }

  return (
    <section className="adm-card">
      <h2 className="adm-card-title">Start a new pick</h2>
      <div className="adm-pk-start">
        <div>
          <label>
            From nothing
            <input maxLength={200} value={title} placeholder="Films that cause an itch in the brain" onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="adm-acts">
            <label className="adm-check">
              <input type="checkbox" checked={ranked} onChange={(e) => setRanked(e.target.checked)} />
              <span>Ranked</span>
            </label>
            <button
              type="button"
              onClick={() => {
                if (!title.trim()) {
                  show("err", "Give the pick a title first.");
                  return;
                }
                void create({ title: title.trim(), ranked });
              }}
            >
              Create
            </button>
          </div>
        </div>
        <div>
          <label>
            From a list or one of your accolades
            <input
              value={q}
              placeholder="Search list titles — best of 2025, Stephen King…"
              spellCheck={false}
              onChange={(e) => {
                setQ(e.target.value);
                if (timer.current) clearTimeout(timer.current);
                const v = e.target.value.trim();
                timer.current = setTimeout(() => void searchSources(v), 250);
              }}
            />
          </label>
          <p className="hint">A copy you can retitle, reorder, trim and write on. Lists with the most films in the library come first.</p>
        </div>
      </div>
      {sources === null ? null : sources.length ? (
        <div className="adm-rows">
          {sources.map((s) => (
            <div key={`${s.kind}:${s.id}`} className="adm-row">
              <div className="adm-grow">
                <b>{s.title}</b>
                <div className="hint">
                  {s.sourceName} · {sourceBits(s)}
                </div>
              </div>
              <button type="button" className="secondary" onClick={() => create(s.kind === "article" ? { from_article: s.id } : { from_accolade: s.id })}>
                Make a pick
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="hint">No lists match.</p>
      )}
    </section>
  );
}

export function PicksWorkspace() {
  const { show } = useToasts();
  const [picks, setPicks] = useState<Pick[] | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [view, setView] = useState<{ kind: "blank" } | { kind: "start" } | { kind: "edit"; id: string }>({ kind: "blank" });

  const load = useCallback(async () => {
    try {
      const d = await adminApi<{ picks: Pick[] }>("/api/admin/picks");
      setPicks(d.picks ?? []);
    } catch (e) {
      show("err", message(e));
    }
  }, [show]);

  useEffect(() => {
    void load();
    adminApi<{ users: UserLite[] }>("/api/admin/users")
      .then((d) => setUsers(d.users ?? []))
      .catch(() => {});
  }, [load]);

  async function saveOrder(ids: string[]) {
    try {
      const d = await adminApi<{ picks: Pick[] }>("/api/admin/picks/order", { method: "POST", body: { ids } });
      setPicks(d.picks ?? []);
    } catch (e) {
      show("err", message(e));
      void load();
    }
  }

  const drag = useDrag((dragged, target) => {
    if (picks) void saveOrder(droppedBefore(picks.map((p) => p.id), dragged, target));
  });
  const now = Date.now();
  const currentId = view.kind === "edit" ? view.id : null;

  return (
    <div className="adm-pk">
      <section className="adm-card adm-pk-side">
        <div className="adm-row">
          <h2 className="adm-card-title adm-grow">Picks</h2>
          <button type="button" onClick={() => setView({ kind: "start" })}>
            New pick
          </button>
        </div>
        <p className="hint">The order here is the order on the Picks page. Drag a pick, or use the arrows. People always see picks made for them first.</p>
        {picks === null ? (
          <p className="hint">Loading…</p>
        ) : !picks.length ? (
          <p className="hint">No picks yet. “New pick” starts one.</p>
        ) : (
          picks.map((p, i) => (
            <div key={p.id} className={`adm-pk-pick${currentId === p.id ? " sel" : ""}${drag.over === p.id ? " over" : ""}`} {...drag.rowProps(p.id)}>
              <span className="adm-pk-grip" aria-hidden="true">
                ⠿
              </span>
              <button type="button" className="adm-pk-pick-open adm-grow" onClick={() => setView({ kind: "edit", id: p.id })}>
                <span className="adm-pk-pick-title">{p.title}</span>
                <span className="adm-pk-chips">
                  {pickChips(p, now).map((c) => (
                    <span key={c.text} className={`adm-pill${c.tone ? ` pk-${c.tone}` : ""}`}>
                      {c.text}
                    </span>
                  ))}
                </span>
              </button>
              <span className="adm-acts">
                <button type="button" className="secondary adm-sf-x" title="Move up" disabled={i === 0} onClick={() => {
                    const next = moved(picks.map((x) => x.id), p.id, "up");
                    if (next) void saveOrder(next);
                  }}>
                  ↑
                </button>
                <button
                  type="button"
                  className="secondary adm-sf-x"
                  title="Move down"
                  disabled={i === picks.length - 1}
                  onClick={() => {
                    const next = moved(picks.map((x) => x.id), p.id, "down");
                    if (next) void saveOrder(next);
                  }}
                >
                  ↓
                </button>
              </span>
            </div>
          ))
        )}
      </section>
      <div className="adm-pk-main">
        {view.kind === "start" ? (
          <StartPick
            onCreated={(id) => {
              void load();
              setView({ kind: "edit", id });
            }}
          />
        ) : view.kind === "edit" ? (
          <Editor
            key={view.id}
            id={view.id}
            users={users}
            onListChanged={() => void load()}
            onDeleted={() => {
              setView({ kind: "blank" });
              void load();
            }}
          />
        ) : (
          <section className="adm-card">
            <h2 className="adm-card-title">Nothing selected</h2>
            <p className="hint">Choose a pick from the list to edit it, or start a new one.</p>
          </section>
        )}
      </div>
    </div>
  );
}
