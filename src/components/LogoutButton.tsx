"use client";

import { useState } from "react";

export function LogoutButton() {
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    // Fire and navigate regardless of the outcome: the server clears the cookie
    // on every response from this endpoint, including failures.
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.assign("/login");
  }

  return (
    <button className="secondary" onClick={onClick} disabled={pending}>
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
