"use client";

/**
 * The /admin pages' one way to call /api/admin/*: with the admin's own
 * session cookie (admin-auth.ts accepts it from this site), never a key.
 * Same error shape as the old console's api(): the server's message when it
 * sent one.
 */
export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function adminApi<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const init: RequestInit = { method: opts.method ?? "GET", credentials: "same-origin", cache: "no-store" };
  if (opts.body !== undefined && opts.body !== null) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const d = data as { message?: string; error?: string } | null;
    let why = d?.message || d?.error || text || `HTTP ${res.status}`;
    if (res.status === 401) why = "Signed out — sign in again.";
    throw new AdminApiError(why, res.status);
  }
  return data as T;
}
