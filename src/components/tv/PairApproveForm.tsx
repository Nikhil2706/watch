"use client";

import { useState } from "react";

/**
 * Approves a TV's pairing code using this browser's own session — see
 * /api/auth/device/approve. Deliberately plain, not TV-styled: this page is
 * meant to be used on the phone/laptop that is APPROVING a TV, not on the
 * TV itself, so it gets the ordinary mobile/desktop form treatment.
 */
export function PairApproveForm({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError("Enter the code shown on your TV.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/device/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { message?: string };
        setError(data.message ?? "Could not approve that code.");
        setPending(false);
        return;
      }
      setDone(true);
    } catch {
      setError("No connection. Check your network and try again.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="auth-foot">
        <p>
          <strong>Done.</strong> Your TV should sign in within a couple of
          seconds. You can close this page.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="pair-code">Code</label>
        <div className="field-input">
          <input
            id="pair-code"
            name="code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            required
            style={{ fontSize: "1.4rem", letterSpacing: "0.12em", textAlign: "center" }}
          />
        </div>
      </div>

      <button type="submit" className="auth-submit" disabled={pending}>
        {pending ? (
          <>
            <span className="btn-spinner" aria-hidden="true" />
            Signing in your TV…
          </>
        ) : (
          "Sign in this TV"
        )}
      </button>
    </form>
  );
}
