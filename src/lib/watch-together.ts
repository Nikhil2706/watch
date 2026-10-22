import "server-only";

import { generateId } from "./crypto";
import { asRow, getDb } from "./db";
import { friendsSharingWith } from "./friends";
import { notifyWatchTogether } from "./notifications";
import { createPartyRoom } from "./party";

/**
 * "Ask to watch together" (v64). On Home's Friends watching now, a viewer asks
 * a friend to turn what they are watching into a watch party. The friend gets
 * a bell notification that opens /together/{id}; starting it makes an
 * ordinary party room with them in charge, and the asker is told where it is.
 */

/** One ask per friend and title in this long: a second press is not a second ping. */
export const ASK_AGAIN_AFTER_MS = 15 * 60 * 1000;

export class TogetherError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 429 = 400,
  ) {
    super(message);
  }
}

export interface TogetherAsk {
  id: string;
  fromUserId: string;
  fromUsername: string;
  toUserId: string;
  itemId: string;
  filmTitle: string;
  createdAt: number;
  answeredAt: number | null;
  roomId: string | null;
}

export function askToWatchTogether(input: {
  fromUserId: string;
  friendId: string;
  item: { Id: string; Name: string; ProviderIds?: Record<string, string> };
  now?: number;
}): TogetherAsk {
  const now = input.now ?? Date.now();
  // Only someone whose activity the asker can see: that is how they knew.
  if (!friendsSharingWith(input.fromUserId).some((f) => f.id === input.friendId)) {
    throw new TogetherError("You can only ask a friend who shares what they watch.", 403);
  }
  const recent = asRow<{ id: string }>(
    getDb()
      .prepare(
        `SELECT id FROM watch_together
         WHERE from_user_id = ? AND to_user_id = ? AND item_id = ? AND created_at > ?`,
      )
      .get(input.fromUserId, input.friendId, input.item.Id, now - ASK_AGAIN_AFTER_MS),
  );
  if (recent) throw new TogetherError("You've just asked them about this one.", 429);

  const id = generateId();
  getDb()
    .prepare(
      `INSERT INTO watch_together (id, from_user_id, to_user_id, item_id, film_title, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.fromUserId, input.friendId, input.item.Id, input.item.Name, now);
  notifyWatchTogether({
    userId: input.friendId,
    actorUserId: input.fromUserId,
    kind: "watch_together_ask",
    imdbId: input.item.ProviderIds?.Imdb ?? input.item.Id,
    filmTitle: input.item.Name,
    filmHref: `/together/${id}`,
  });
  return getAsk(id)!;
}

export function getAsk(id: string): TogetherAsk | null {
  const r = asRow<{
    id: string;
    from_user_id: string;
    username: string;
    to_user_id: string;
    item_id: string;
    film_title: string;
    created_at: number;
    answered_at: number | null;
    room_id: string | null;
  }>(
    getDb()
      .prepare(
        `SELECT w.*, u.username FROM watch_together w JOIN users u ON u.id = w.from_user_id WHERE w.id = ?`,
      )
      .get(id),
  );
  return r
    ? {
        id: r.id,
        fromUserId: r.from_user_id,
        fromUsername: r.username,
        toUserId: r.to_user_id,
        itemId: r.item_id,
        filmTitle: r.film_title,
        createdAt: r.created_at,
        answeredAt: r.answered_at,
        roomId: r.room_id,
      }
    : null;
}

/**
 * The friend's answer. "start" makes a party room with them in charge and
 * tells the asker where it is; "decline" just closes the ask (the asker is
 * not told: a quiet no). Answering twice gives the first answer back.
 */
export function answerAsk(input: {
  askId: string;
  userId: string;
  answer: "start" | "decline";
  film: { href: string; imdbId: string | null };
}): TogetherAsk {
  const ask = getAsk(input.askId);
  if (!ask || ask.toUserId !== input.userId) throw new TogetherError("That invitation isn't yours.", 404);
  if (ask.answeredAt !== null) return ask;

  const now = Date.now();
  if (input.answer === "decline") {
    getDb().prepare("UPDATE watch_together SET answered_at = ? WHERE id = ?").run(now, ask.id);
    return { ...ask, answeredAt: now };
  }
  const room = createPartyRoom({
    jellyfinId: ask.itemId,
    filmTitle: ask.filmTitle,
    filmHref: input.film.href,
    creatorUserId: input.userId,
  });
  getDb().prepare("UPDATE watch_together SET answered_at = ?, room_id = ? WHERE id = ?").run(now, room.id, ask.id);
  notifyWatchTogether({
    userId: ask.fromUserId,
    actorUserId: input.userId,
    kind: "watch_together_ready",
    imdbId: input.film.imdbId ?? ask.itemId,
    filmTitle: ask.filmTitle,
    filmHref: `/party/${room.id}`,
  });
  return { ...ask, answeredAt: now, roomId: room.id };
}
