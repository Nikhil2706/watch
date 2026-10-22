/**
 * Friends' activity, as Home shows it: who may see whose, and how a stream of
 * watches, ratings and reviews becomes one card per film. Pure, so it is
 * tested directly; friends-activity.ts reads the tables and Jellyfin.
 */

/* ------------------------------------------------------------------ *
 * Who sees whose activity
 * ------------------------------------------------------------------ */

/** Each person's own choice (users.activity_visibility). */
export type ActivityVisibility = "friends" | "nobody";

export function parseVisibility(value: unknown): ActivityVisibility {
  return value === "nobody" ? "nobody" : "friends";
}

/**
 * Whether `viewer` may see what `owner` watches, rates and reviews. Never
 * their own (Home has Continue watching and Recently watched for that); never
 * someone who chose "nobody"; otherwise only friends. `friends` is the site's
 * answer (friends.ts): on a small site everyone is everyone's friend.
 */
export function maySeeActivity(input: {
  viewerId: string;
  ownerId: string;
  ownerVisibility: ActivityVisibility;
  friends: boolean;
}): boolean {
  if (input.viewerId === input.ownerId) return false;
  if (input.ownerVisibility === "nobody") return false;
  return input.friends;
}

/* ------------------------------------------------------------------ *
 * The feed
 * ------------------------------------------------------------------ */

export type ActivityEvent =
  | { kind: "watched"; userId: string; username: string; filmKey: string; at: number }
  | { kind: "rated"; userId: string; username: string; filmKey: string; at: number; score: number }
  | { kind: "reviewed"; userId: string; username: string; filmKey: string; at: number; text: string };

/** One friend's part in a card: what they did with the film, newest first. */
export interface FriendTake {
  userId: string;
  username: string;
  at: number;
  watched: boolean;
  /** 1-10 (half stars), when they rated it. */
  score: number | null;
  /** Their latest review's text, when they wrote one. */
  review: string | null;
}

export interface FriendsCard {
  filmKey: string;
  /** The newest thing any friend did with it. */
  at: number;
  takes: FriendTake[];
}

/**
 * One card per film, newest activity first; on each, one entry per friend
 * combining whether they watched it, their rating and their review.
 */
export function friendsFeed(events: readonly ActivityEvent[], limit: number): FriendsCard[] {
  const films = new Map<string, Map<string, FriendTake>>();
  for (const e of events) {
    const takes = films.get(e.filmKey) ?? new Map<string, FriendTake>();
    films.set(e.filmKey, takes);
    const take = takes.get(e.userId) ?? {
      userId: e.userId,
      username: e.username,
      at: 0,
      watched: false,
      score: null,
      review: null,
    };
    takes.set(e.userId, take);
    if (e.kind === "watched") take.watched = true;
    if (e.kind === "rated") take.score = e.score;
    // The latest review wins.
    if (e.kind === "reviewed" && e.at >= take.at) take.review = e.text;
    take.at = Math.max(take.at, e.at);
  }
  return [...films]
    .map(([filmKey, takes]) => {
      const list = [...takes.values()].sort((a, b) => b.at - a.at);
      return { filmKey, at: list[0]!.at, takes: list };
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/** Half stars from the 1-10 score: 7 -> "★★★½". */
export function stars(score: number): string {
  const full = Math.floor(score / 2);
  return "★".repeat(full) + (score % 2 ? "½" : "");
}

/** "rewati ★★★★ · Mammannii watched" — the card's one line. */
export function takesLine(takes: readonly FriendTake[]): string {
  const first = takes[0]!;
  const lead = first.score !== null ? `${first.username} ${stars(first.score)}` : first.username;
  return takes.length > 1 ? `${lead} +${takes.length - 1}` : lead;
}

/** The start of a review, one line long. */
export function reviewSnippet(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `“${flat.slice(0, max - 1)}…”` : `“${flat}”`;
}
