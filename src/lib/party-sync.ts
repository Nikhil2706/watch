/**
 * The watch party's sync rules now live in session-clock.ts, shared with the
 * phone remote (docs/playback-sessions.md, step 2). Kept so existing imports
 * keep working.
 */
export * from "./session-clock.ts";
