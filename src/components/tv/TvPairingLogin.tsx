"use client";

import { useEffect, useRef, useState } from "react";

import { focusTvAutofocusTarget } from "@/components/tv/TvProvider";

const POLL_INTERVAL_MS = 2500;

type Phase = "starting" | "waiting" | "expired" | "error";

/**
 * The TV side of device-pairing login (see src/lib/device-pairing.ts for the
 * full handshake). Starts a Quick Connect pairing on mount, shows the code
 * plus a QR code of the approval URL, and polls until a phone/laptop
 * approves it — at which point the poll response itself carries the new
 * session cookie and this just navigates on, exactly like a normal
 * username/password sign-in.
 */
export function TvPairingLogin({
  next,
  onUsePassword,
}: {
  next: string;
  onUsePassword: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [code, setCode] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let pairId: string | null = null;

    async function start() {
      setPhase("starting");
      setCode(null);
      setQrDataUrl(null);

      try {
        const response = await fetch("/api/auth/device/start", { method: "POST" });
        if (!response.ok) throw new Error("start failed");
        const data = (await response.json()) as { pairId: string; code: string };
        if (cancelled) return;

        pairId = data.pairId;
        setCode(data.code);
        setPhase("waiting");

        // Client-side rendering, not a server route: the URL a QR code for
        // this encodes is no more sensitive than the code already shown as
        // plain text right next to it.
        const QRCode = (await import("qrcode")).default;
        const url = `${window.location.origin}/pair?code=${encodeURIComponent(data.code)}`;
        const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
        if (!cancelled) setQrDataUrl(dataUrl);

        let pollInFlight = false;
        pollTimer.current = setInterval(async () => {
          if (!pairId || pollInFlight) return;
          pollInFlight = true;
          try {
            const pollResponse = await fetch("/api/auth/device/poll", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pairId }),
            });
            if (pollResponse.status === 404) {
              if (pollTimer.current) clearInterval(pollTimer.current);
              if (!cancelled) setPhase("expired");
              return;
            }
            if (!pollResponse.ok) return;
            const pollData = (await pollResponse.json()) as { status: string };
            if (pollData.status === "authenticated") {
              if (pollTimer.current) clearInterval(pollTimer.current);
              window.location.assign(next);
            }
          } catch {
            /* transient network hiccup — the next tick tries again */
          } finally {
            pollInFlight = false;
          }
        }, POLL_INTERVAL_MS);
      } catch {
        if (!cancelled) setPhase("error");
      }
    }

    void start();

    return () => {
      cancelled = true;
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, next]);

  // This screen's own content (the code, the retry buttons) all arrives
  // after an async fetch — TvProvider's own "focus something on page load"
  // effect runs once, right on mount, and would find nothing yet. Re-run
  // the same targeting logic every time what's on screen actually changes.
  useEffect(() => {
    focusTvAutofocusTarget();
  }, [phase]);

  return (
    <div className="tv-pair">
      {phase === "starting" ? <p className="tv-pair-status">Getting a code…</p> : null}

      {phase === "waiting" && code ? (
        <>
          <div className="tv-pair-code" aria-live="polite">
            {code}
          </div>
          <p className="tv-pair-status">
            Open <span className="tv-pair-url">watch/pair</span> on your phone or computer,
            sign in, and enter this code — or scan it below.
          </p>
          {qrDataUrl ? (
            <div className="tv-pair-qr">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrDataUrl} alt="QR code linking to the pairing page" width={200} height={200} />
            </div>
          ) : null}
          <p className="tv-pair-status">Waiting for approval…</p>
        </>
      ) : null}

      {phase === "expired" ? (
        <>
          <p className="tv-pair-status">That code expired.</p>
          <button type="button" className="btn" data-tv-autofocus="true" onClick={() => setAttempt((n) => n + 1)}>
            Get a new code
          </button>
        </>
      ) : null}

      {phase === "error" ? (
        <>
          <p className="tv-pair-status">Could not reach the server.</p>
          <button type="button" className="btn" data-tv-autofocus="true" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </>
      ) : null}

      <button type="button" className="tv-pair-toggle" data-tv-autofocus="true" onClick={onUsePassword}>
        Use username &amp; password instead
      </button>
    </div>
  );
}
