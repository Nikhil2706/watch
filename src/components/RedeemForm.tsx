"use client";

import { useEffect, useRef, useState } from "react";

import { PasswordField } from "@/components/auth/PasswordField";

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
  const errorRef = useRef<HTMLParagraphElement>(null);

  const mismatch = confirm !== "" && confirm !== password;

  // Same reasoning as the sign-in form: `role="alert"` covers screen readers,
  // this covers a sighted keyboard user whose focus is still in a field.
  useEffect(() => {
    // preventScroll: the message is already the topmost thing in the
    // panel, and letting the browser scroll to it jumps the page.
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (password.length < 10) {
      setError("Your password needs to be at least 10 characters.");
      return;
    }

    if (password !== confirm) {
      setError("The two passwords do not match.");
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
        <label htmlFor="username">Choose a username</label>
        <div className="field-input">
          <input
            id="username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            required
            minLength={2}
            maxLength={32}
            pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{1,31}"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            aria-describedby="username-hint"
          />
        </div>
        <p className="field-note" id="username-hint">
          2&ndash;32 characters. Letters, numbers, dot, dash, underscore.
        </p>
      </div>

      <PasswordField
        id="password"
        label="Choose a password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        hint="At least 10 characters."
      />

      <PasswordField
        id="confirm"
        label="Confirm password"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        invalid={mismatch}
        hint={mismatch ? "These do not match yet." : undefined}
      />

      <button type="submit" className="auth-submit" disabled={pending}>
        {pending ? (
          <>
            <span className="btn-spinner" aria-hidden="true" />
            Creating account&hellip;
          </>
        ) : (
          "Create account"
        )}
      </button>
    </form>
  );
}
