"use client";

import { useEffect, useRef, useState } from "react";

import { focusTvAutofocusTarget, useTvBack } from "@/components/tv/TvProvider";
import { focusFieldForTyping } from "@/lib/tv/tv-fields";

/**
 * Fallback TV login: large D-pad-focusable fields, for when pairing
 * (TvPairingLogin.tsx) isn't what someone wants — a TV with no phone handy.
 * Typing uses the TV's own system keyboard, the one every other app on it
 * uses: OK on a field opens it (lib/tv/tv-fields.ts), its Enter key moves
 * from the username to the password and then signs in.
 *
 * Posts to the exact same /api/auth/login as the ordinary LoginForm — this
 * is a different shell around the same request, not a different auth path.
 */
export function TvPasswordLogin({ next, onUsePairing }: { next: string; onUsePairing?: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Switching into this view (from TvPairingLogin's "use password instead")
  // is a client-side state change, not a navigation — TvProvider's own
  // "focus something on page load" effect only runs on mount/pathname
  // change, so it never sees this component appear. Land focus explicitly.
  useEffect(() => {
    focusTvAutofocusTarget();
  }, []);

  // Back returns to the pairing code this form was opened from, rather than
  // leaving the app.
  useTvBack(() => {
    if (!onUsePairing) return false;
    onUsePairing();
    return true;
  });

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const name = username.trim();
    if (!name || !password) {
      setError("Enter your username and password.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name, password }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { message?: string };
        setError(data.message ?? "Sign in failed.");
        setPending(false);
        return;
      }
      window.location.assign(next);
    } catch {
      setError("No connection. Check your network and try again.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="tv-username">Username</label>
        <div className="field-input">
          <input
            id="tv-username"
            value={username}
            data-tv-autofocus="true"
            // The keyboard's Enter here means "next field", not "submit".
            enterKeyHint="next"
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !passwordRef.current) return;
              event.preventDefault();
              focusFieldForTyping(passwordRef.current);
            }}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            style={{ fontSize: "1.3rem", padding: "16px 18px" }}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="tv-password">Password</label>
        <div className="field-input">
          <input
            id="tv-password"
            type="password"
            ref={passwordRef}
            value={password}
            enterKeyHint="go"
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            style={{ fontSize: "1.3rem", padding: "16px 18px" }}
          />
        </div>
      </div>

      <button type="submit" className="auth-submit" style={{ marginTop: 18 }} disabled={pending}>
        {pending ? (
          <>
            <span className="btn-spinner" aria-hidden="true" />
            Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </button>

      {onUsePairing ? (
        <button type="button" className="tv-pair-toggle" onClick={onUsePairing}>
          Sign in with a code instead
        </button>
      ) : null}
    </form>
  );
}
