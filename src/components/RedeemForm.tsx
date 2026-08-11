"use client";

import { useState } from "react";

/**
 * Invite redemption. Creates the Jellyfin account and signs the user in.
 *
 * The token is held in component state only for the duration of this POST. It
 * is never written to localStorage and never appears in a URL this component
 * constructs — the address bar is the only place it lives, which is unavoidable
 * for a link you paste into a chat.
 */
export function RedeemForm({ token }: { token: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const mismatch = confirm !== "" && confirm !== password;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/invite/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, username, password }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        message?: string;
        redirect?: string;
      };

      if (!response.ok) {
        setError(data.message ?? "Could not create your account.");
        setPending(false);
        return;
      }

      window.location.assign(data.redirect ?? "/");
    } catch {
      setError("Could not reach the server.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <label htmlFor="username">Choose a username</label>
      <input
        id="username"
        name="username"
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        required
        minLength={2}
        maxLength={32}
        pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{1,31}"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
      />
      <p className="hint">2–32 characters. Letters, numbers, dot, dash, underscore.</p>

      <label htmlFor="password">Choose a password</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <p className="hint">At least 10 characters.</p>

      <label htmlFor="confirm">Confirm password</label>
      <input
        id="confirm"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        aria-invalid={mismatch}
      />
      {mismatch ? <p className="hint">Passwords do not match.</p> : null}

      <button
        type="submit"
        disabled={pending || !username || password.length < 10 || mismatch}
      >
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
