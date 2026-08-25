"use client";

import { useState } from "react";

import { LoginForm } from "@/components/LoginForm";
import { TvPairingLogin } from "@/components/tv/TvPairingLogin";
import { TvPasswordLogin } from "@/components/tv/TvPasswordLogin";

type Mode = "pair" | "password";

/**
 * Decides what /login actually shows. `tvModeGuess` is the server's own
 * detection (see layout.tsx / lib/tv/detect.ts) — used only as the initial
 * client state, so there is nothing to hydrate-mismatch on.
 *
 *  - Detected TV: starts on device-pairing (the preferred flow — see
 *    DESIGN-tv-mode.md), with a manual fallback to a big-target
 *    on-screen-keyboard password form.
 *  - Everything else: the ordinary LoginForm, completely unchanged, with a
 *    manual escape hatch into pairing for anyone testing it from a desktop.
 */
export function LoginScreen({ tvModeGuess, next }: { tvModeGuess: boolean; next: string }) {
  const [mode, setMode] = useState<Mode>(tvModeGuess ? "pair" : "password");

  if (mode === "pair") {
    return <TvPairingLogin next={next} onUsePassword={() => setMode("password")} />;
  }

  if (tvModeGuess) {
    return <TvPasswordLogin next={next} onUsePairing={() => setMode("pair")} />;
  }

  return <LoginForm next={next} />;
}
