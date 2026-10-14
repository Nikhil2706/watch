"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/**
 * The console's message line and its undo bar, for every /admin tab.
 *
 * Fixed to the bottom of the screen rather than at the top of the page: deep
 * in a long list, jumping back to the top on every action was worse than not
 * seeing the message. A success fades after six seconds; an error stays until
 * the next message.
 *
 * Undo: every decision here is reversible (nothing touches a file), so the
 * confirmation carries the way back for twelve seconds — long enough to
 * notice, short enough not to sit there claiming to be undoable forever.
 */

type Kind = "ok" | "err";
interface Undo {
  text: string;
  label: string;
  run: () => Promise<unknown>;
}
interface ToastApi {
  show: (kind: Kind, text: string) => void;
  offerUndo: (text: string, label: string, run: () => Promise<unknown>) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {}, offerUndo: () => {} });

export function useToasts(): ToastApi {
  return useContext(ToastContext);
}

export function Toasts({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<{ kind: Kind; text: string; at: number } | null>(null);
  const [undo, setUndo] = useState<(Undo & { busy: boolean }) | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((kind: Kind, text: string) => {
    setMsg({ kind, text, at: Date.now() });
    if (msgTimer.current) clearTimeout(msgTimer.current);
    if (kind === "ok") msgTimer.current = setTimeout(() => setMsg(null), 6000);
  }, []);

  const offerUndo = useCallback((text: string, label: string, run: () => Promise<unknown>) => {
    setUndo({ text, label, run, busy: false });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 12000);
  }, []);

  useEffect(
    () => () => {
      if (msgTimer.current) clearTimeout(msgTimer.current);
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );

  async function runUndo() {
    if (!undo) return;
    setUndo({ ...undo, busy: true });
    try {
      await undo.run();
      setUndo(null);
      show("ok", "Undone.");
    } catch (e) {
      setUndo({ ...undo, busy: false });
      show("err", e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <ToastContext.Provider value={{ show, offerUndo }}>
      {children}
      <div className="adm-toasts" aria-live="polite">
        {undo ? (
          <div className="adm-undo">
            <span>{undo.text}</span>
            <button type="button" className="secondary" disabled={undo.busy} onClick={runUndo}>
              {undo.busy ? "Undoing…" : undo.label}
            </button>
          </div>
        ) : null}
        {msg ? (
          <div key={msg.at} className={`adm-msg ${msg.kind}`} role={msg.kind === "err" ? "alert" : "status"}>
            <span>{msg.text}</span>
            <button type="button" className="adm-x" aria-label="Dismiss" onClick={() => setMsg(null)}>
              ×
            </button>
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}
