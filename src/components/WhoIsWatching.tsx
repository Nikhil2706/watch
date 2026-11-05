"use client";

import { useState } from "react";

export interface DeviceAccount {
  userId: string;
  username: string;
  /** The account this device is using right now. */
  active: boolean;
}

/** A steady colour per name, so each person finds their own tile at a glance. */
function avatarHue(name: string): number {
  let hash = 0;
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/**
 * The tiles of /profiles. One press switches: the device already holds each
 * account's session, so there is no password and no pairing code. On a TV
 * the remote starts on the account in use (or the first), and the arrows
 * move between tiles like any other row.
 */
export function WhoIsWatching({ accounts }: { accounts: DeviceAccount[] }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = accounts.find((a) => a.active) ?? accounts[0];

  async function choose(account: DeviceAccount) {
    setPending(account.userId);
    setError(null);
    const response = await fetch("/api/auth/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: account.userId }),
    }).catch(() => null);
    if (response?.ok) {
      window.location.assign("/");
      return;
    }
    const body = (await response?.json().catch(() => null)) as { message?: string } | null;
    setError(body?.message ?? "Could not switch. Try again.");
    setPending(null);
    // Signed out elsewhere: the server has already dropped it; show the rest.
    if (response?.status === 404) window.location.reload();
  }

  return (
    <div className="who-watching">
      <h1 className="who-watching-title">Who&apos;s watching?</h1>
      <ul className="who-watching-tiles">
        {accounts.map((account) => (
          <li key={account.userId}>
            <button
              type="button"
              className="who-tile"
              onClick={() => void choose(account)}
              disabled={pending !== null}
              data-tv-autofocus={account === start ? "true" : undefined}
              aria-current={account.active ? "true" : undefined}
            >
              <span className="who-avatar" style={{ "--who-hue": avatarHue(account.username) } as React.CSSProperties}>
                {account.username.slice(0, 1).toUpperCase()}
              </span>
              <span className="who-name">{account.username}</span>
              {pending === account.userId ? <span className="who-note">Switching…</span> : null}
            </button>
          </li>
        ))}
        <li>
          <a className="who-tile who-add" href="/login?add=1">
            <span className="who-avatar" aria-hidden="true">
              +
            </span>
            <span className="who-name">Add someone</span>
          </a>
        </li>
      </ul>
      {error ? <p className="msg err">{error}</p> : null}
    </div>
  );
}
