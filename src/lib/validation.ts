import "server-only";

/**
 * Input rules for account creation.
 *
 * Jellyfin will accept a much wider range of usernames than this. The set is
 * narrowed deliberately: usernames end up interpolated into Jellyfin API paths
 * and displayed in its dashboard, and there is no reason to accept anything
 * exotic on a private instance. Rejecting early gives a clear error instead of
 * an opaque Jellyfin 400.
 */

const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;

export function validateUsername(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("Username is required.");
  const username = value.trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw new ValidationError(
      "Username must be 2-32 characters: letters, numbers, dot, dash or underscore, starting with a letter or number.",
    );
  }
  return username;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("Password is required.");
  // No trimming: leading/trailing spaces are legitimate password characters and
  // silently stripping them would make the password unreproducible elsewhere.
  if (value.length < 10) {
    throw new ValidationError("Password must be at least 10 characters.");
  }
  if (value.length > 256) {
    throw new ValidationError("Password must be at most 256 characters.");
  }
  return value;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Parses a JSON body without letting a malformed one produce a 500. */
export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ValidationError("Could not read request body.");
  }

  if (text.trim() === "") return {};

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError("Request body must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("Request body must be valid JSON.");
  }
}

export function optionalInt(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new ValidationError(`${key} must be a number.`);
}

/**
 * Pulls an IMDb or TMDB id out of whatever an admin pastes — a full URL
 * ("https://www.imdb.com/title/tt0079636/"), or just the bare id
 * ("tt0079636", "11216"). Accepts either provider; returns whichever one
 * matched, or both if the input happens to satisfy both patterns (it won't
 * in practice, but the caller only needs to check what's present).
 */
export function parseProviderLink(value: unknown): { imdb?: string; tmdb?: string } {
  if (typeof value !== "string" || !value.trim()) return {};
  const v = value.trim();

  const imdbId = v.match(/\b(tt\d{6,9})\b/i)?.[1];
  if (imdbId) return { imdb: imdbId.toLowerCase() };

  const tmdbId = v.match(/themoviedb\.org\/movie\/(\d+)/i)?.[1];
  if (tmdbId) return { tmdb: tmdbId };

  // A bare number, with nothing else on the line, is only unambiguous as a
  // TMDB id — IMDb ids always carry the "tt" prefix, so there's no case
  // where a plain digit string could mean anything else here.
  if (/^\d+$/.test(v)) return { tmdb: v };

  return {};
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${key} must be a string.`);
  return value.slice(0, 200);
}
