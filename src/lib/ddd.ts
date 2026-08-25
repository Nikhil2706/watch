import "server-only";

import { env } from "./env";

/**
 * Thin client for Does the Dog Die's v3 API — a second, independent
 * content-warning signal for parental-control filtering, alongside TMDB's
 * certifications/keywords (tmdb.ts). Verified against a live call with a
 * real key rather than guessed at; see the topic-category ids below, pulled
 * directly from GET /topiccategories.
 *
 * Attribution requirement, from their API Terms (section 6) — read this
 * before enabling DDD_API_KEY on a deployment other people can see:
 * "Powered by DoesTheDogDie.com", linked, reasonably visible wherever this
 * data appears — not just a footer. Since this app never displays DDD's
 * ratings/comments/timestamps directly (a restricted title is simply
 * hidden, not shown with a "here's why" label), the one place this data
 * actually surfaces to a person is the curator's own Users panel, where the
 * attribution lives (see curator.html).
 */

const BASE_URL = "https://www.doesthedogdie.com/api/v3";

export class DddError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DddError";
  }
}

export function isDddConfigured(): boolean {
  return env.dddApiKey !== "";
}

async function dddFetch<T>(path: string): Promise<T> {
  if (!env.dddApiKey) {
    throw new DddError("DDD_API_KEY is not configured.", 0);
  }
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: { "X-API-KEY": env.dddApiKey },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch (cause) {
    throw new DddError(`Could not reach Does the Dog Die: ${cause instanceof Error ? cause.message : String(cause)}`, 0);
  }
  if (!response.ok) {
    throw new DddError(`DDD ${path} failed with ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

interface SearchResult {
  id: number;
  imdbId: string | null;
}

/** Resolves an IMDb id to DDD's own item id. */
export async function findDddItemByImdbId(imdbId: string): Promise<number | null> {
  const id = imdbId.startsWith("tt") ? imdbId : `tt${imdbId}`;
  const results = await dddFetch<SearchResult[]>(`/items?imdb=${encodeURIComponent(id)}`);
  return results[0]?.id ?? null;
}

interface TopicItemStat {
  topicId: number;
  topicName: string;
  yesSum: number;
  noSum: number;
}

interface ItemDetailResponse {
  id: number;
  topicItemStats: TopicItemStat[];
}

/**
 * Category ids covering "sex/nudity/extreme violence" — pulled from a live
 * GET /topiccategories call, not guessed. Deliberately category-level, not
 * the whole "Violence" SUPER-category: that super-category also contains
 * Natural Disasters and Vehicular (car crashes), which aren't the concern
 * here and would over-restrict disaster/action films with no real sexual
 * or graphically violent content.
 *
 *   11 Sex · 50 Sexual Assault          (super-category: Sexual Content/Assault)
 *   14 Violence · 46 Large-scale Violence · 28 Assault · 25 Abuse   (super-category: Violence)
 *   3 Bodily Harm · 51 Appendages · 52 Head · 53 Neck · 54 Whole Body   (super-category: Bodily Harm — graphic injury/gore)
 */
const RESTRICTED_CATEGORY_IDS = new Set([11, 50, 14, 46, 28, 25, 3, 51, 52, 53, 54]);

/**
 * A film's topics don't carry their category id directly (topicItemStats
 * only has topicId/topicName) — this maps topicId -> topicCategoryId via
 * GET /topics, fetched once per process and cached in memory. The full
 * topic list changes rarely enough that a stale in-memory copy for the life
 * of the process is an acceptable trade against fetching it on every
 * backfill tick.
 */
interface Topic {
  id: number;
  topicCategoryId: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateDddTopicMap: Map<number, number> | undefined;
}

async function getTopicCategoryMap(): Promise<Map<number, number>> {
  if (globalThis.__jellyfinGateDddTopicMap) return globalThis.__jellyfinGateDddTopicMap;
  const topics = await dddFetch<Topic[]>("/topics");
  const map = new Map(topics.map((t) => [t.id, t.topicCategoryId]));
  globalThis.__jellyfinGateDddTopicMap = map;
  return map;
}

export interface DddSignal {
  restricted: boolean;
  signals: string[];
}

/**
 * The "does this need hiding from parental-control accounts" check. A topic
 * only counts if the community actually leans "yes" on it — yesSum >= 2 and
 * strictly more yes than no votes — so a single stray or contested vote
 * can't flag a title on its own.
 */
export async function getDddSignal(itemId: number): Promise<DddSignal> {
  const [detail, topicCategories] = await Promise.all([
    dddFetch<ItemDetailResponse>(`/items/${itemId}`),
    getTopicCategoryMap(),
  ]);

  const signals: string[] = [];
  for (const stat of detail.topicItemStats) {
    const categoryId = topicCategories.get(stat.topicId);
    if (categoryId === undefined || !RESTRICTED_CATEGORY_IDS.has(categoryId)) continue;
    if (stat.yesSum >= 2 && stat.yesSum > stat.noSum) {
      signals.push(`ddd:${stat.topicName} (${stat.yesSum} yes / ${stat.noSum} no)`);
    }
  }

  return { restricted: signals.length > 0, signals };
}
