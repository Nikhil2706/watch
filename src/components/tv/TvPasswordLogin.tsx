"use client";

import { useEffect, useState } from "react";

import { TvKeyboard } from "@/components/tv/TvKeyboard";
import { focusTvAutofocusTarget } from "@/components/tv/TvProvider";

/**
 * Fallback TV login: large D-pad-focusable fields plus the shared on-screen
 * keyboard (TvKeyboard.tsx), for when pairing (TvPairingLogin.tsx) isn't
 * what someone wants — a TV with no phone handy, or a remote with a
 * physical keyboard already attached, which types into these fields
 * normally alongside the on-screen one.
 *
 * Posts to the exact same /api/auth/login as the ordinary LoginForm — this
 * is a different shell around the same request, not a different auth path.
 */
export function TvPasswordLogin({ next, onUsePairing }: { next: string; onUsePairing?: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [activeField, setActiveField] = useState<"username" | "password">("username");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Switching into this view (from TvPairingLogin's "use password instead")
  // is a client-side state change, not a navigation — TvProvider's own
  // "focus something on page load" effect only runs on mount/pathname
  // change, so it never sees this component appear. Land focus explicitly.
  useEffect(() => {
    focusTvAutofocusTarget();
  }, []);

  function insert(text: string) {
    if (activeField === "username") setUsername((v) => v + text);
    else setPassword((v) => v + text);
  }

  function backspace() {
    if (activeField === "username") setUsername((v) => v.slice(0, -1));
    else setPassword((v) => v.slice(0, -1));
  }

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
            onFocus={() => setActiveField("username")}
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
            value={password}
            onFocus={() => setActiveField("password")}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            style={{ fontSize: "1.3rem", padding: "16px 18px" }}
          />
        </div>
      </div>

      <TvKeyboard onInsert={insert} onBackspace={backspace} />

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
