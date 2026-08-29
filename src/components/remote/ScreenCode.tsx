"use client";

import { useEffect, useState } from "react";

/**
 * Shown on the television. Registers this browser as a controllable screen
 * (and marks it opted in, so ScreenAgent keeps running here on later visits
 * even if TV-mode detection does not fire) then displays the pairing code for
 * someone to type into their phone.
 *
 * The code is re-fetched periodically because it expires; a TV left on this
 * page overnight should still show something valid in the morning rather than
 * a stale code that fails with no explanation.
 */

const SCREEN_ID_KEY = "jfg.screenId";
const SCREEN_OPT_IN_KEY = "jfg.screenOptIn";
const REFRESH_MS = 4 * 60 * 1000;

export function ScreenCode() {
  const [code, setCode] = useState<string | null>(null);
  const [name, setName] = useState<string>("Television");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(SCREEN_OPT_IN_KEY, "1");

    async function register() {
      try {
        const response = await fetch("/api/remote/screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ screenId: localStorage.getItem(SCREEN_ID_KEY) }),
        });
        if (!response.ok) {
          setError("Couldn't register this screen. Try reloading.");
          return;
        }
        const data = (await response.json()) as { screenId: string; code: string; name: string };
        localStorage.setItem(SCREEN_ID_KEY, data.screenId);
        setCode(data.code);
        setName(data.name);
        setError(null);
      } catch {
        setError("No connection to the server.");
      }
    }

    void register();
    const timer = setInterval(register, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="screen-code">
      <h2>Pair a phone with this screen</h2>
      <p>
        On your phone, open <strong>/remote</strong> on this site and enter the code below. Both devices
        need to be signed in to the same account.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : (
        <span className="code" aria-label={code ? `Pairing code ${code.split("").join(" ")}` : "Loading code"}>
          {code ?? "······"}
        </span>
      )}
      <p style={{ marginTop: 12 }}>This screen is called “{name}”.</p>
    </section>
  );
}
