/**
 * Cloudflare Worker: friendly page when the origin is unreachable.
 *
 * WHY THIS LIVES AT THE EDGE
 *
 * The app runs on the same machine as Jellyfin. When that machine is off, on a
 * dead internet connection, or mid-reboot, nothing on it can answer — so the
 * fallback cannot live there. It also must not live on a second origin that
 * normal traffic is routed through, because then every byte of video would be
 * relayed through that box just to keep a maintenance page reachable. A Worker
 * runs on Cloudflare's edge, so it is up precisely when the origin is not, and
 * it sits in the path only for the routes you point it at.
 *
 * DEPLOY
 *
 *   npx wrangler deploy deploy/maintenance-worker.js --name watch-maintenance
 *
 * Then, in the Cloudflare dashboard under Workers Routes, add ONLY the
 * human-facing page routes:
 *
 *   watch.<domain>/
 *   watch.<domain>/login*
 *   watch.<domain>/invite/*
 *
 * Deliberately NOT `watch.<domain>/*`. Video streaming through /jf/* generates
 * a large number of Range requests, and routing those through a Worker would
 * burn the free tier's daily request budget for no benefit — a failed XHR does
 * not need a pretty HTML page, and by the time one fires the user has already
 * seen this page on the route that served their tab.
 */

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

const CONFIG = {
  /** Shown as the page heading. */
  title: "Be right back",

  /** Main line. Keep it honest and non-technical. */
  message:
    "The media server is offline at the moment. Nothing is wrong with your account — this page will start working again on its own once it is back.",

  /** Optional second line. Set to null to omit. */
  detail: "This page retries by itself every minute.",

  /** Seconds between automatic retries. Set to 0 to disable. */
  retrySeconds: 60,

  /**
   * Optional: a second origin to try before giving up, e.g. a Raspberry Pi
   * serving a status page you control.
   *
   * Leave as null unless you actually want it. Setting it does NOT put that box
   * in the normal traffic path — it is only contacted when the primary origin
   * has already failed, and this Worker is only routed onto the page URLs, so
   * no media ever passes through it.
   *
   * Example: "https://status.example.com"
   */
  fallbackOrigin: null,
};

/**
 * Statuses that mean "the origin did not serve this".
 *
 * 52x and 530 are Cloudflare's own origin-failure codes (522 connection timed
 * out, 523 origin unreachable, 530 is what a disconnected Cloudflare Tunnel
 * surfaces as). 502/504 cover a tunnel that is up but has nothing behind it.
 *
 * 500 is deliberately absent: an application error is the app's to report, and
 * dressing it up as scheduled maintenance would hide a real bug.
 */
const ORIGIN_DOWN = new Set([502, 504, 521, 522, 523, 524, 525, 526, 530]);

export default {
  async fetch(request) {
    let response;

    try {
      response = await fetch(request);
    } catch {
      // Nothing answered at all.
      return await fallback(request);
    }

    if (ORIGIN_DOWN.has(response.status)) {
      return await fallback(request);
    }

    return response;
  },
};

async function fallback(request) {
  if (CONFIG.fallbackOrigin) {
    try {
      const url = new URL(request.url);
      const target = new URL(url.pathname + url.search, CONFIG.fallbackOrigin);
      const secondary = await fetch(target.toString(), {
        method: "GET",
        headers: { "User-Agent": request.headers.get("user-agent") ?? "" },
      });
      if (secondary.ok) {
        const headers = new Headers(secondary.headers);
        headers.set("Cache-Control", "no-store");
        // Still a 503: the service genuinely is unavailable, whatever the
        // status page chose to return. Reporting 200 here would tell crawlers
        // and uptime monitors that everything is fine.
        return new Response(secondary.body, { status: 503, headers });
      }
    } catch {
      // Fall through to the built-in page.
    }
  }

  return maintenancePage();
}

function maintenancePage() {
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    // Tells well-behaved clients and monitors this is temporary, and keeps the
    // outage out of search results.
    "X-Robots-Tag": "noindex, nofollow",
  };
  if (CONFIG.retrySeconds > 0) {
    headers["Retry-After"] = String(CONFIG.retrySeconds);
  }

  // 503, not 200. This is a real outage and should be reported as one.
  return new Response(html(), { status: 503, headers });
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function html() {
  const refresh =
    CONFIG.retrySeconds > 0
      ? `<meta http-equiv="refresh" content="${CONFIG.retrySeconds}">`
      : "";

  const detail = CONFIG.detail
    ? `<p class="detail">${escapeHtml(CONFIG.detail)}</p>`
    : "";

  // Styling is inlined and mirrors src/app/globals.css so the outage page does
  // not look like it came from somewhere else entirely.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${refresh}
<title>${escapeHtml(CONFIG.title)}</title>
<style>
  :root {
    --bg: #0d0f13;
    --surface: #161a21;
    --border: #262c37;
    --text: #e6e9ef;
    --muted: #8b94a6;
    --accent: #5b8def;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    background: var(--bg); color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 16px; line-height: 1.55;
  }
  main { min-height: 100dvh; display: grid; place-items: center; padding: 24px; }
  .card {
    width: 100%; max-width: 420px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 32px;
  }
  .dot {
    width: 9px; height: 9px; border-radius: 50%;
    background: var(--accent); display: inline-block; margin-right: 9px;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
  h1 { margin: 0 0 10px; font-size: 1.3rem; font-weight: 600; }
  p { margin: 0 0 14px; color: var(--muted); font-size: 0.92rem; }
  p:last-child { margin-bottom: 0; }
  .detail { font-size: 0.8rem; opacity: 0.75; }
</style>
</head>
<body>
  <main>
    <div class="card">
      <h1><span class="dot" aria-hidden="true"></span>${escapeHtml(CONFIG.title)}</h1>
      <p>${escapeHtml(CONFIG.message)}</p>
      ${detail}
    </div>
  </main>
</body>
</html>`;
}
