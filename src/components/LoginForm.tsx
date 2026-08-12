"use client";

import { useEffect, useRef, useState } from "react";

import { PasswordField } from "@/components/auth/PasswordField";

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
  const errorRef = useRef<HTMLParagraphElement>(null);

  // Move focus to the message when one appears. `role="alert"` announces it to
  // a screen reader, but a sighted keyboard user whose focus is still in the
  // password field gets no signal at all without this.
  useEffect(() => {
    // preventScroll: the message is already the topmost thing in the
    // panel, and letting the browser scroll to it jumps the page.
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();

    // Invite links and usernames get passed around in chat apps, which love to
    // attach a trailing space to a copied word. Trimming here turns a baffling
    // "incorrect password" into a successful sign-in.
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
        const data = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        setError(
          // The server's own wording is good for the cases it knows about. A
          // 502 is the exception: "the media server is not responding" is
          // accurate but reads as the viewer's fault, when in fact it means
          // somebody's home machine is off.
          response.status === 502
            ? "Can't reach the library right now. The machine it runs on may be offline — try again in a few minutes."
            : (data.message ?? "Sign in failed."),
        );
        setPending(false);
        return;
      }

      // Full navigation rather than a client-side push, so the new cookie is
      // picked up by the server components on the next render.
      window.location.assign(next);
    } catch {
      setError("No connection. Check your network and try again.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {error ? (
        <p className="error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="username">Username</label>
        <div className="field-input">
          <input
            id="username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            // The only thing anyone comes to this page to do.
            autoFocus
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>
      </div>

      <PasswordField
        id="password"
        label="Password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />

      {/*
       * Never disabled while fields are empty. A dead button gives no reason
       * for being dead — pressing it and being told what is missing is both
       * faster and reachable by a screen reader.
       */}
      <button type="submit" className="auth-submit" disabled={pending}>
        {pending ? (
          <>
            <span className="btn-spinner" aria-hidden="true" />
            Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </button>
    </form>
  );
}
