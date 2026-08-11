import "server-only";

/**
 * Environment access, validated once at module load.
 *
 * Anything secret lives here and only here. Nothing in this module may be
 * imported from a client component — the `server-only` import above turns that
 * into a build error rather than a silent secret leak into the JS bundle.
 */

/**
 * Build-time escape hatch.
 *
 * `next build` imports every route module to collect page data, which runs the
 * validation below. A Docker build has no secrets and should not need them — the
 * alternative is baking placeholder credentials into an image layer, which is
 * strictly worse.
 *
 * Set ONLY in the Dockerfile's build stage. If this is ever set at runtime the
 * app will start with empty credentials and reject every request, so the failure
 * is loud rather than silent.
 */
const skipValidation = process.env.SKIP_ENV_VALIDATION === "1";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    if (skipValidation) return "";
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }
  return parsed;
}

const adminApiKey = required("ADMIN_API_KEY");
if (!skipValidation && adminApiKey.length < 32) {
  // A short admin key is the single worst failure mode in this app: it grants
  // Jellyfin user creation. Refuse to boot rather than run with a weak one.
  throw new Error(
    "ADMIN_API_KEY must be at least 32 characters. Generate one with:\n" +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
  );
}

export const env = {
  /** Base URL of the Jellyfin server, no trailing slash. */
  jellyfinUrl: optional("JELLYFIN_URL", "http://127.0.0.1:8096").replace(
    /\/+$/,
    "",
  ),

  /** Jellyfin API key from Dashboard -> Advanced -> API Keys. Admin-scoped. */
  jellyfinApiKey: required("JELLYFIN_API_KEY"),

  /** Static bearer for /api/admin/*, sent as the X-Admin-Key header. */
  adminApiKey,

  /** Public origin, used to build invite redemption URLs. No trailing slash. */
  publicUrl: required("PUBLIC_URL").replace(/\/+$/, ""),

  /** Absolute or project-relative path to the SQLite file. */
  databasePath: optional("DATABASE_PATH", "./data/jellyfin-gate.db"),

  /**
   * Only enable when the app is genuinely unreachable except through
   * Cloudflare. `CF-Connecting-IP` is an ordinary request header: if a client
   * can reach this app directly, it can forge the header and get a fresh rate
   * limit bucket on every request.
   */
  trustCloudflareIp: bool("TRUST_CF_CONNECTING_IP", false),

  sessionTtlDays: int("SESSION_TTL_DAYS", 30),

  /**
   * Sliding-renewal threshold. A session is only rewritten once it has burned
   * this many days of its lifetime, so a video stream issuing hundreds of Range
   * requests does not issue hundreds of SQLite writes.
   */
  sessionRenewAfterHours: int("SESSION_RENEW_AFTER_HOURS", 24),

  defaultInviteMaxUses: int("INVITE_DEFAULT_MAX_USES", 1),
  defaultInviteExpiryDays: int("INVITE_DEFAULT_EXPIRY_DAYS", 7),

  isProduction: process.env.NODE_ENV === "production",
} as const;

/**
 * Whether the session cookie carries the `Secure` attribute.
 *
 * Browsers silently drop `Secure` cookies over plain http, so with this on you
 * simply cannot log in over an http origin — the login succeeds, the cookie is
 * discarded, and the next request looks logged out. That is correct in
 * production, where the only route in is https through Cloudflare.
 *
 * The override exists for one legitimate case: testing over a LAN address such
 * as http://192.168.1.20:3000 from a phone, where there is no certificate.
 *
 * Setting COOKIE_SECURE=false on an internet-facing deployment means session
 * cookies travel in cleartext to anyone who can see the traffic. Only use it on
 * a trusted local network.
 */
export const cookieSecure = bool("COOKIE_SECURE", env.isProduction);

if (env.isProduction && !cookieSecure) {
  console.warn(
    "[env] COOKIE_SECURE=false in production: session cookies will be sent over " +
      "plain http. Acceptable for LAN testing only — never for an internet-facing origin.",
  );
}
