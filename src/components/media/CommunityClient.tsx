"use client";

import { useCallback, useEffect, useState } from "react";

import type { CommentNode } from "@/lib/community";
import { STAR_PATH, scoreToStars, starStates, starsToScore } from "@/lib/stars";

import { Stars } from "./Stars";

/**
 * The interactive half of the Community section: rate it, post a comment,
 * reply, edit or delete your own. Optimistic throughout, same reasoning as
 * ListButtons.tsx — a rating click or a posted comment that waits on a
 * round trip before showing anything feels broken, so the UI updates first
 * and only reverts if the server disagrees.
 *
 * Replies are exactly one level deep (enforced server-side in
 * addComment()) — a top-level comment's replies render indented beneath
 * it. Replying to a reply posts into the same thread, addressed to the
 * person by name, so a thread reads as a conversation.
 *
 * Live: the page holds a stream open (/api/comments/events) and reads the
 * thread again whenever anyone posts, edits or deletes, so what somebody
 * else writes appears without a reload.
 */

const MAX_COMMENT_CHARS = 2000;

/**
 * Half-star picker: five stars, each split into a left half (sets N-0.5)
 * and a right half (sets N) via two invisible overlaid buttons — the
 * standard way to get half-star precision out of five icons without a
 * drag/slider interaction.
 */
function StarPicker({ value, onRate }: { value: number | null; onRate: (stars: number) => void }) {
  const states = starStates(value);
  return (
    <span className="stars star-picker" style={{ "--star-size": "24px" } as React.CSSProperties}>
      {states.map((state, i) => {
        const pos = i + 1;
        return (
          <span className={`star star-${state}`} key={pos}>
            <svg viewBox="0 0 24 24" className="star-outline" aria-hidden="true">
              <path d={STAR_PATH} />
            </svg>
            <svg viewBox="0 0 24 24" className="star-fill" aria-hidden="true">
              <path d={STAR_PATH} />
            </svg>
            <button
              type="button"
              className="star-hit star-hit-left"
              aria-label={`Rate ${pos - 0.5} stars`}
              onClick={() => onRate(pos - 0.5)}
            />
            <button
              type="button"
              className="star-hit star-hit-right"
              aria-label={`Rate ${pos} stars`}
              onClick={() => onRate(pos)}
            />
          </span>
        );
      })}
    </span>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

async function postJson(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    return { ok: response.ok, data };
  } catch {
    return { ok: false, data: null };
  }
}

/**
 * The server's thread, with anything of ours still on its way kept in place.
 * A comment being posted has a "pending-" id and is not in what the server
 * sent yet; dropping it would make it blink out and back.
 */
function mergeLive(mine: CommentNode[], fresh: CommentNode[]): CommentNode[] {
  const pending = (nodes: CommentNode[]) => nodes.filter((c) => c.id.startsWith("pending-"));
  const repliesInFlight = new Map(mine.map((c) => [c.id, pending(c.replies)] as const));
  return [
    ...fresh.map((c) => {
      const waiting = repliesInFlight.get(c.id) ?? [];
      return waiting.length > 0 ? { ...c, replies: [...c.replies, ...waiting] } : c;
    }),
    ...pending(mine),
  ];
}

/**
 * Enter sends, as in any chat; Shift+Enter makes a new line. Only where there
 * is a real keyboard: on a phone the on-screen Enter key is how a new line is
 * typed, and the Post button is right there. Ctrl/Cmd+Enter sends everywhere.
 */
function sendsOnEnter(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (e.key !== "Enter" || e.nativeEvent.isComposing) return false;
  if (e.metaKey || e.ctrlKey) return true;
  if (e.shiftKey || e.altKey) return false;
  return typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function Avatar({ name }: { name: string }) {
  return (
    <div className="avatar" aria-hidden="true">
      {initials(name)}
    </div>
  );
}

export function CommunityClient({
  imdbId,
  filmTitle,
  filmHref,
  initialComments,
  initialAverage,
  initialCount,
  initialYourRating,
  currentUsername,
}: {
  imdbId: string;
  filmTitle: string;
  filmHref: string;
  initialComments: CommentNode[];
  initialAverage: number | null;
  initialCount: number;
  initialYourRating: number | null;
  currentUsername: string;
}) {
  const [comments, setComments] = useState(initialComments);
  const [average, setAverage] = useState(initialAverage);
  const [count, setCount] = useState(initialCount);
  const [yourRating, setYourRating] = useState(initialYourRating);
  const [composerText, setComposerText] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyOpenFor, setReplyOpenFor] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [live, setLive] = useState(false);
  /** How many people have this film's page open, us included. */
  const [here, setHere] = useState(0);
  // Decided after mount: the server cannot know what keyboard this is.
  const [enterSends, setEnterSends] = useState(false);
  useEffect(() => setEnterSends(window.matchMedia("(hover: hover) and (pointer: fine)").matches), []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/comments?imdbId=${encodeURIComponent(imdbId)}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { comments?: CommentNode[] };
      if (Array.isArray(data.comments)) setComments((prev) => mergeLive(prev, data.comments!));
    } catch {
      // Offline for a moment; the stream reconnecting brings it up to date.
    }
  }, [imdbId]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(`/api/comments/events?imdbId=${encodeURIComponent(imdbId)}`);
    let connectedBefore = false;
    source.addEventListener("ready", () => {
      setLive(true);
      // A reconnect means there was a gap, and anything said in it was missed.
      if (connectedBefore) void refresh();
      connectedBefore = true;
    });
    source.addEventListener("changed", () => void refresh());
    source.addEventListener("presence", (event) => {
      try {
        const n = (JSON.parse((event as MessageEvent<string>).data) as { here?: number }).here;
        if (typeof n === "number") setHere(n);
      } catch {
        // A frame we cannot read says nothing about who is here.
      }
    });
    source.onerror = () => {
      setLive(false);
      setHere(0);
    };

    // A phone that was in a pocket: the stream may have been cut while the
    // page was hidden, so read the thread again on the way back.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    // And if the stream cannot be held at all, fall back to asking.
    const poll = setInterval(() => {
      if (source.readyState !== EventSource.OPEN && document.visibilityState === "visible") void refresh();
    }, 30_000);

    return () => {
      source.close();
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(poll);
    };
  }, [imdbId, refresh]);

  /** stars: 0.5-5.0. Converted to the DB's 1-10 scale right here, at the input boundary — see src/lib/stars.ts. */
  async function rate(stars: number) {
    const score = starsToScore(stars);
    const previousScore = yourRating;
    const previousAverage = average;
    const previousCount = count;

    // Optimistic recompute: replace this rater's contribution to the
    // average if they'd already rated, otherwise add a new one.
    const hadRating = previousScore !== null;
    const totalBefore = (previousAverage ?? 0) * previousCount;
    const nextCount = hadRating ? previousCount : previousCount + 1;
    const nextTotal = hadRating ? totalBefore - previousScore! + score : totalBefore + score;
    setYourRating(score);
    setAverage(nextTotal / nextCount);
    setCount(nextCount);

    const { ok } = await postJson("/api/ratings", "POST", { imdbId, score });
    if (!ok) {
      setYourRating(previousScore);
      setAverage(previousAverage);
      setCount(previousCount);
      setError("Couldn't save your rating — try again.");
    }
  }

  /**
   * Takes the caller's rating back off. The API could always do this
   * (DELETE /api/ratings); nothing on the page ever asked it to, so a star
   * tapped by mistake was there for good.
   */
  async function removeRating() {
    const previousScore = yourRating;
    if (previousScore === null) return;
    const previousAverage = average;
    const previousCount = count;

    const nextCount = Math.max(0, previousCount - 1);
    const totalBefore = (previousAverage ?? 0) * previousCount;
    setYourRating(null);
    setCount(nextCount);
    setAverage(nextCount > 0 ? (totalBefore - previousScore) / nextCount : null);
    setError(null);

    const { ok } = await postJson(`/api/ratings?imdbId=${encodeURIComponent(imdbId)}`, "DELETE");
    if (!ok) {
      setYourRating(previousScore);
      setAverage(previousAverage);
      setCount(previousCount);
      setError("Couldn't remove your rating — try again.");
    }
  }

  async function submitComment(parentId: string | null, text: string, clear: () => void) {
    const body = text.trim();
    if (!body || posting) return;
    setPosting(true);
    setError(null);

    const tempId = `pending-${Date.now()}`;
    const optimisticNode: CommentNode = {
      id: tempId,
      userId: "me",
      username: currentUsername,
      body,
      createdAt: Date.now(),
      editedAt: null,
      deleted: false,
      // Whatever the viewer's own rating already is right now — a comment
      // posted after rating shows it immediately, same as it will once
      // the real listComments() query picks it up.
      rating: yourRating,
      replies: [],
    };

    setComments((prev) => {
      if (!parentId) return [...prev, optimisticNode];
      return prev.map((c) => (c.id === parentId ? { ...c, replies: [...c.replies, optimisticNode] } : c));
    });
    clear();

    const { ok, data } = await postJson("/api/comments", "POST", { imdbId, body, parentId, filmTitle, filmHref });
    const realId = ok && data && typeof data.id === "string" ? data.id : null;

    setComments((prev) => {
      // The live stream can deliver our own comment before this answer does,
      // in which case it is already here under its real id and the stand-in
      // only has to go.
      const arrived = (nodes: CommentNode[]): boolean =>
        nodes.some((c) => c.id === realId || arrived(c.replies));
      const drop = !ok || (realId !== null && arrived(prev));
      function replaceId(nodes: CommentNode[]): CommentNode[] {
        return nodes
          .filter((c) => !drop || c.id !== tempId)
          .map((c) =>
            c.id === tempId && realId
              ? { ...c, id: realId }
              : { ...c, replies: replaceId(c.replies) },
          );
      }
      return replaceId(prev);
    });

    if (!ok) setError("Couldn't post that — try again.");
    setPosting(false);
  }

  async function saveEdit(id: string) {
    const body = editText.trim();
    if (!body) return;
    const { ok } = await postJson(`/api/comments/${id}`, "PATCH", { body });
    if (ok) {
      setComments((prev) => updateNode(prev, id, (c) => ({ ...c, body, editedAt: Date.now() })));
      setEditingId(null);
    } else {
      setError("Couldn't save your edit — try again.");
    }
  }

  async function deleteComment(id: string) {
    if (!confirm("Delete this comment? Any replies underneath will stay.")) return;
    const { ok } = await postJson(`/api/comments/${id}`, "DELETE");
    if (ok) {
      setComments((prev) => updateNode(prev, id, (c) => ({ ...c, body: "", deleted: true })));
    } else {
      setError("Couldn't delete that — try again.");
    }
  }

  function renderComment(comment: CommentNode, isReply: boolean, threadId: string = comment.id) {
    const isMine = comment.username === currentUsername && !comment.id.startsWith("pending-");
    const isEditing = editingId === comment.id;

    return (
      <div className={isReply ? "comment reply" : "comment"} key={comment.id} id={`comment-${comment.id}`}>
        <Avatar name={comment.username} />
        <div className="comment-body">
          <div className="comment-head">
            <span className="comment-author">{comment.username}</span>
            {comment.rating !== null ? <Stars value={scoreToStars(comment.rating)} size={13} /> : null}
            <span className="comment-time">
              {timeAgo(comment.createdAt)}
              {comment.editedAt ? " · edited" : ""}
            </span>
          </div>

          {comment.deleted ? (
            <p className="comment-text comment-deleted">[deleted]</p>
          ) : isEditing ? (
            <div className="reply-composer" style={{ paddingLeft: 0 }}>
              <textarea
                className="composer-input"
                value={editText}
                maxLength={MAX_COMMENT_CHARS}
                onChange={(e) => setEditText(e.target.value)}
              />
            </div>
          ) : (
            <p className="comment-text">{comment.body}</p>
          )}

          {!comment.deleted ? (
            <div className="comment-actions">
              {isEditing ? (
                <>
                  <button onClick={() => saveEdit(comment.id)}>Save</button>
                  <button onClick={() => setEditingId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  {!comment.id.startsWith("pending-") ? (
                    <button
                      onClick={() => {
                        if (isReply) {
                          // Into the same thread, addressed to them.
                          setReplyOpenFor(threadId);
                          setReplyText(comment.username === currentUsername ? "" : `@${comment.username} `);
                        } else {
                          setReplyOpenFor(replyOpenFor === comment.id ? null : comment.id);
                          setReplyText("");
                        }
                      }}
                    >
                      Reply
                    </button>
                  ) : null}
                  {isMine ? (
                    <>
                      <button
                        onClick={() => {
                          setEditingId(comment.id);
                          setEditText(comment.body);
                        }}
                      >
                        Edit
                      </button>
                      <button onClick={() => deleteComment(comment.id)}>Delete</button>
                    </>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {!isReply && comment.replies.length > 0 ? (
            <div className="reply-list">{comment.replies.map((r) => renderComment(r, true, comment.id))}</div>
          ) : null}

          {!isReply && replyOpenFor === comment.id ? (
            <div className="reply-composer">
              <Avatar name={currentUsername} />
              <div style={{ flex: 1 }}>
                <textarea
                  className="composer-input"
                  placeholder={comment.replies.length > 0 ? "Reply to this conversation…" : `Reply to ${comment.username}…`}
                  value={replyText}
                  maxLength={MAX_COMMENT_CHARS}
                  autoFocus
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (sendsOnEnter(e)) {
                      e.preventDefault();
                      void submitComment(comment.id, replyText, () => {
                        setReplyText("");
                        setReplyOpenFor(null);
                      });
                    }
                  }}
                />
                <div className="composer-actions">
                  <button
                    type="button"
                    className="btn-post"
                    disabled={posting || !replyText.trim()}
                    onClick={() =>
                      submitComment(comment.id, replyText, () => {
                        setReplyText("");
                        setReplyOpenFor(null);
                      })
                    }
                  >
                    Reply
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="community-card">
      <div className="rate-row">
        <span className="rate-label">Your rating</span>
        <StarPicker value={yourRating !== null ? scoreToStars(yourRating) : null} onRate={rate} />
        {yourRating !== null ? (
          <button type="button" className="rate-remove" onClick={() => void removeRating()}>
            Remove
          </button>
        ) : null}
        {count > 0 ? (
          <span className="rate-average">
            <Stars value={scoreToStars(average!)} size={14} />
            <span className="hint" style={{ margin: 0 }}>
              {scoreToStars(average!).toFixed(1)} · {count} rating{count === 1 ? "" : "s"}
            </span>
          </span>
        ) : null}
      </div>

      <div className="composer">
        <Avatar name={currentUsername} />
        <div style={{ flex: 1 }}>
          <textarea
            className="composer-input"
            placeholder="Share what you thought…"
            value={composerText}
            maxLength={MAX_COMMENT_CHARS}
            onChange={(e) => setComposerText(e.target.value)}
            onKeyDown={(e) => {
              if (sendsOnEnter(e)) {
                e.preventDefault();
                void submitComment(null, composerText, () => setComposerText(""));
              }
            }}
          />
          <div className="composer-actions">
            {enterSends ? <span className="composer-hint">Enter to send · Shift+Enter for a new line</span> : null}
            {live ? (
              <span className="comments-live" title="New comments appear here as they are written">
                {here > 1 ? `${here} here now` : "Live"}
              </span>
            ) : null}
            <button
              type="button"
              className="btn-post"
              disabled={posting || !composerText.trim()}
              onClick={() => submitComment(null, composerText, () => setComposerText(""))}
            >
              Post
            </button>
          </div>
        </div>
      </div>

      {error ? <p className="hint" style={{ color: "var(--danger)" }}>{error}</p> : null}

      {comments.length > 0 ? (
        <div className="comment-list">{comments.map((c) => renderComment(c, false))}</div>
      ) : (
        <p className="hint" style={{ marginTop: 16 }}>Nobody's said anything yet — be the first.</p>
      )}
    </div>
  );
}

function updateNode(nodes: CommentNode[], id: string, fn: (c: CommentNode) => CommentNode): CommentNode[] {
  return nodes.map((c) => {
    if (c.id === id) return fn(c);
    if (c.replies.length > 0) return { ...c, replies: updateNode(c.replies, id, fn) };
    return c;
  });
}
