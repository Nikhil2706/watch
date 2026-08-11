"use client";

import { useState } from "react";

/**
 * Posts credentials to /api/auth/login and follows the redirect on success.
 *
 * The response body carries no token — the server sets an httpOnly cookie this
 * component cannot read. That is intentional: there is nothing here for an XSS
 * bug to steal.
 */
export function LoginForm({ next }: { next: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        setError(data.message ?? "Sign in failed.");
        setPending(false);
        return;
      }

      // Full navigation rather than a client-side push, so the new cookie is
      // picked up by the server components on the next render.
      window.location.assign(next);
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

      <label htmlFor="username">Username</label>
      <input
        id="username"
        name="username"
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        required
        value={username}
        onChange={(event) => setUsername(event.target.value)}
      />

      <label htmlFor="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />

      <button type="submit" disabled={pending || !username || !password}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
