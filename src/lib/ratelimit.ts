import "server-only";

/**
 * In-memory sliding-window rate limiter. No Redis, per the brief.
 *
 * Sliding rather than fixed-window: a fixed window lets an attacker fire the
 * full quota at 14:59 and again at 15:00, doubling the effective burst. The
 * quotas here are single digits, so keeping a short array of hit timestamps per
 * bucket costs a few hundred bytes at most.
 *
 * Caveats, stated plainly:
 *  - State is per process. If this app is ever run under `next start` with more
 *    than one worker, or restarted by the Windows service manager, counters
 *    reset. For a handful of invited users in front of one Jellyfin box that is
 *    the right trade; it is not a defence against a distributed attacker.
 *  - Pinned to globalThis so Next's dev-mode hot reload does not silently reset
 *    the limiter on every file save.
 */

type Bucket = number[];

interface LimiterState {
  buckets: Map<string, Bucket>;
  lastSweep: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateRateLimit: LimiterState | undefined;
}

function state(): LimiterState {
  if (!globalThis.__jellyfinGateRateLimit) {
    globalThis.__jellyfinGateRateLimit = { buckets: new Map(), lastSweep: 0 };
  }
  return globalThis.__jellyfinGateRateLimit;
}

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Hard ceiling on distinct buckets, so a spoofed-IP flood cannot exhaust RAM. */
const MAX_BUCKETS = 10_000;

export interface RateLimitRule {
  /** Bucket namespace, e.g. "login". Keeps quotas from bleeding into each other. */
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
}

export const LOGIN_LIMIT: RateLimitRule = {
  name: "login",
  limit: 5,
  windowMs: 15 * 60 * 1000,
};

export const REDEEM_LIMIT: RateLimitRule = {
  name: "redeem",
  limit: 10,
  windowMs: 60 * 60 * 1000,
};

/**
 * Client-reported errors (player failures, React crashes) — the one log
 * source anyone who can load the site can trigger, deliberately or not.
 * Generous enough that a genuinely rough playback session (a few stalls, a
 * couple of retries) doesn't get clipped, tight enough that a scripted flood
 * can't turn the event log into noise.
 */
export const CLIENT_ERROR_LIMIT: RateLimitRule = {
  name: "client-error",
  limit: 20,
  windowMs: 60 * 60 * 1000,
};

/**
 * Posting a comment or a rating — a small trusted group, so this exists as
 * a sanity guard (a stuck retry loop, a fat-fingered double-submit) rather
 * than real anti-abuse. Keyed by session id at the call site, not IP, so
 * housemates sharing a connection don't share a bucket.
 */
export const COMMENT_LIMIT: RateLimitRule = {
  name: "comment",
  limit: 30,
  windowMs: 60 * 60 * 1000,
};

/** Starting a watch party is rare and deliberate — this is just a ceiling against a runaway client, not real anti-abuse. */
export const PARTY_CREATE_LIMIT: RateLimitRule = {
  name: "party_create",
  limit: 10,
  windowMs: 60 * 60 * 1000,
};

/**
 * Messages into a watch party — chat, which writes a row per call, and sync,
 * which fans out to every member's stream. Sized for a lively room (a burst
 * of reactions during a scene, a player emitting seeks while someone
 * scrubs), so it only catches a client stuck in a loop or someone pasting a
 * flood. Keyed per identity per room at the call site, so one noisy room
 * can't rate-limit the same person in another.
 *
 * Unlike the rest of the party endpoints this one is reachable by a guest
 * holding nothing but a share link, which is why it gets a ceiling at all.
 */
export const PARTY_SEND_LIMIT: RateLimitRule = {
  name: "party_send",
  limit: 240,
  windowMs: 60 * 1000,
};

/** Starting a TV pairing handshake — same shape as LOGIN_LIMIT, since both ultimately hit Jellyfin's own auth. */
export const DEVICE_START_LIMIT: RateLimitRule = {
  name: "device_start",
  limit: 10,
  windowMs: 15 * 60 * 1000,
};

/**
 * A TV polls every ~2s while its pairing screen is up, for up to the 5-minute
 * lifetime of a code — a legitimate session is ~150 requests. Generous on
 * purpose; this is a ceiling against a runaway/looping client, not the thing
 * that makes pairing secure (Jellyfin's own Code/Secret expiry is).
 */
export const DEVICE_POLL_LIMIT: RateLimitRule = {
  name: "device_poll",
  limit: 200,
  windowMs: 10 * 60 * 1000,
};

/** Approving a code from an already-authenticated phone/laptop — a handful of taps at most. */
export const DEVICE_APPROVE_LIMIT: RateLimitRule = {
  name: "device_approve",
  limit: 20,
  windowMs: 15 * 60 * 1000,
};

/**
 * A consumer asking to fetch subtitles for the title they're watching. Not
 * about protecting this route itself — it's a soft guard on the shared
 * OpenSubtitles daily download quota (100/day across the whole app), on top
 * of subtitle-fetch.ts's own "don't retry an already-attempted title"
 * short-circuit. Keyed by session id at the call site, not IP.
 */
export const SUBTITLE_FETCH_LIMIT: RateLimitRule = {
  name: "subtitle_fetch",
  limit: 10,
  windowMs: 60 * 60 * 1000,
};

/**
 * The "how many subtitles exist" availability check — cheap and not
 * download-quota-limited on OpenSubtitles' side, but their /features
 * endpoint itself caps at 40 requests/10s across this app's ENTIRE Api-Key
 * (every viewer combined, not per-user), so this stays a real ceiling
 * rather than a formality.
 */
export const SUBTITLE_CHECK_LIMIT: RateLimitRule = {
  name: "subtitle_check",
  limit: 30,
  windowMs: 60 * 1000,
};

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the caller may retry. 0 when allowed. */
  readonly retryAfterSeconds: number;
}

/**
 * Records an attempt and reports whether it is permitted.
 *
 * Note this counts *attempts*, not failures: a successful login still consumes
 * quota. That is intentional for a private instance — it bounds credential
 * stuffing regardless of whether any given guess happens to succeed.
 */
export function checkRateLimit(
  rule: RateLimitRule,
  identifier: string,
): RateLimitResult {
  const store = state();
  const now = Date.now();

  sweep(store, now);

  const key = `${rule.name}:${identifier}`;
  const windowStart = now - rule.windowMs;

  const existing = store.buckets.get(key) ?? [];
  const hits = existing.filter((timestamp) => timestamp > windowStart);

  if (hits.length >= rule.limit) {
    store.buckets.set(key, hits);
    const oldest = hits[0] ?? now;
    const retryAfterMs = Math.max(0, oldest + rule.windowMs - now);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    };
  }

  hits.push(now);
  store.buckets.set(key, hits);

  return {
    allowed: true,
    remaining: rule.limit - hits.length,
    retryAfterSeconds: 0,
  };
}

/**
 * Gives back one unit of quota. Called after a *successful* invite redemption
 * so that a legitimate user who is handed several invites is not locked out by
 * their own success, while failed guesses still accumulate.
 */
export function refundRateLimit(rule: RateLimitRule, identifier: string): void {
  const store = state();
  const key = `${rule.name}:${identifier}`;
  const hits = store.buckets.get(key);
  if (!hits || hits.length === 0) return;
  hits.pop();
  if (hits.length === 0) store.buckets.delete(key);
}

function sweep(store: LimiterState, now: number): void {
  if (now - store.lastSweep < SWEEP_INTERVAL_MS && store.buckets.size < MAX_BUCKETS) {
    return;
  }
  store.lastSweep = now;

  // The longest window in play bounds how far back anything can still matter.
  const longestWindow = Math.max(LOGIN_LIMIT.windowMs, REDEEM_LIMIT.windowMs, CLIENT_ERROR_LIMIT.windowMs, COMMENT_LIMIT.windowMs);
  const cutoff = now - longestWindow;

  for (const [key, hits] of store.buckets) {
    const live = hits.filter((timestamp) => timestamp > cutoff);
    if (live.length === 0) {
      store.buckets.delete(key);
    } else if (live.length !== hits.length) {
      store.buckets.set(key, live);
    }
  }

  // If a flood still leaves us over the ceiling, drop the oldest buckets. Worst
  // case some attackers get their quota reset; the alternative is unbounded RAM
  // growth on an 8 GB box.
  if (store.buckets.size > MAX_BUCKETS) {
    const excess = store.buckets.size - MAX_BUCKETS;
    let dropped = 0;
    for (const key of store.buckets.keys()) {
      store.buckets.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/** Standard headers so a client can back off politely. */
export function rateLimitHeaders(
  rule: RateLimitRule,
  result: RateLimitResult,
): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(rule.limit),
    "RateLimit-Remaining": String(result.remaining),
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(result.retryAfterSeconds);
  }
  return headers;
}
