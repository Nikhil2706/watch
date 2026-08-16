"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

type NotificationKind = "reply" | "new_item" | "curators_pick";

interface NotificationItem {
  id: string;
  kind: NotificationKind;
  actorUsername: string | null;
  filmTitle: string;
  filmHref: string;
  commentId: string | null;
  createdAt: number;
  read: boolean;
}

function notificationText(n: NotificationItem): ReactNode {
  switch (n.kind) {
    case "new_item":
      return (
        <>
          <b>{n.filmTitle}</b> was just added to the library
        </>
      );
    case "curators_pick":
      return (
        <>
          Curator&apos;s Pick — Just For You: <b>{n.filmTitle}</b>
        </>
      );
    case "reply":
    default:
      return (
        <>
          <b>{n.actorUsername}</b> replied to your comment on <b>{n.filmTitle}</b>
        </>
      );
  }
}

function notificationHref(n: NotificationItem): string {
  return n.kind === "reply" && n.commentId ? `${n.filmHref}#comment-${n.commentId}` : n.filmHref;
}

/** Long enough to be a non-issue as background traffic, short enough that a reply feels "found," not lost. */
const POLL_INTERVAL_MS = 30_000;

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

/**
 * In-app-only notification bell — no push, no email. Polls for replies to
 * the viewer's own comments, new library items, and curator's-pick
 * recommendations; opening the dropdown marks everything currently shown
 * as read. Outside-click-to-close mirrors SearchBox.tsx's existing popover
 * mechanics exactly.
 */
export function NotificationBell() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const response = await fetch("/api/notifications");
      if (!response.ok) return;
      const data = (await response.json()) as { items?: NotificationItem[]; unreadCount?: number };
      setItems(data.items ?? []);
      setUnreadCount(data.unreadCount ?? 0);
    } catch {
      /* offline — leave whatever's already shown alone */
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    function onDocClick(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unreadCount > 0) {
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
      void fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      }).catch(() => {});
    }
  }

  return (
    <div className="bell-wrap" ref={wrapRef}>
      <button type="button" className="bell-btn" aria-label="Notifications" onClick={toggle}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" focusable="false">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {unreadCount > 0 ? <span className="bell-badge">{unreadCount > 9 ? "9+" : unreadCount}</span> : null}
      </button>

      {open ? (
        <div className="bell-dropdown">
          <div className="bell-dropdown-head">Notifications</div>
          {items.length === 0 ? (
            <div className="notif-empty">Nothing yet — replies, new titles, and curator picks show up here.</div>
          ) : (
            items.map((n) => (
              <a
                key={n.id}
                href={notificationHref(n)}
                className={`notif-row ${n.read ? "read" : "unread"}`}
              >
                <span className="notif-dot" aria-hidden="true" />
                <span className="notif-text">
                  {notificationText(n)}
                  <span className="notif-time">{timeAgo(n.createdAt)}</span>
                </span>
              </a>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
