"use client";

import { useState } from "react";

export function LogoutButton() {
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    // Fire and navigate regardless of the outcome: the server clears the cookie
    // on every response from this endpoint, including failures. With others
    // still signed in on this device it says to go to "Who's watching?".
    const result = await fetch("/api/auth/logout", { method: "POST" })
      .then((r) => r.json() as Promise<{ next?: string }>)
      .catch(() => ({ next: undefined }));
    window.location.assign(result.next === "/profiles" ? "/profiles" : "/login");
  }

  return (
    <button className="secondary" onClick={onClick} disabled={pending}>
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
