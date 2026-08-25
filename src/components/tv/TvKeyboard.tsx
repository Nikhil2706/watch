"use client";

import { useState } from "react";

/**
 * A D-pad-navigable on-screen keyboard.
 *
 * No bespoke key-handling of its own — every key is a plain `<button>`, so
 * the app's normal spatial focus engine (TvProvider.tsx / spatial-nav.ts)
 * already moves between them correctly by geometry, the same way it moves
 * between poster cards. This component only needs to lay keys out in
 * sensible rows and report what was typed.
 *
 * Two layers (letters, numbers/symbols) cover real Jellyfin passwords,
 * which can contain punctuation an alnum-only keyboard would make
 * impossible to enter. A real keyboard/remote with alphanumeric input still
 * works normally alongside this — it edits the same `value`.
 */

const LETTER_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const SYMBOL_ROWS = ["1234567890", "-_=+[]{};:", "'\",.<>/?\\|~`!@#$%^&*()"];

export function TvKeyboard({
  onInsert,
  onBackspace,
}: {
  onInsert: (text: string) => void;
  onBackspace: () => void;
}) {
  const [shift, setShift] = useState(false);
  const [symbols, setSymbols] = useState(false);

  const rows = symbols ? SYMBOL_ROWS : LETTER_ROWS;

  return (
    <div className="tv-keyboard" role="group" aria-label="On-screen keyboard">
      {rows.map((row, i) => (
        <div className="tv-keyboard-row" key={i}>
          {row.split("").map((char) => {
            const display = !symbols && shift ? char.toUpperCase() : char;
            return (
              <button
                key={char}
                type="button"
                className="tv-keyboard-key"
                onClick={() => {
                  onInsert(display);
                  if (shift) setShift(false);
                }}
              >
                {display}
              </button>
            );
          })}
        </div>
      ))}
      <div className="tv-keyboard-row">
        {!symbols ? (
          <button
            type="button"
            className={`tv-keyboard-key wide${shift ? " active" : ""}`}
            aria-pressed={shift}
            onClick={() => setShift((v) => !v)}
          >
            ⇧ Shift
          </button>
        ) : null}
        <button
          type="button"
          className="tv-keyboard-key wide"
          onClick={() => setSymbols((v) => !v)}
        >
          {symbols ? "ABC" : "123"}
        </button>
        <button
          type="button"
          className="tv-keyboard-key"
          style={{ minWidth: 220 }}
          onClick={() => onInsert(" ")}
        >
          Space
        </button>
        <button type="button" className="tv-keyboard-key wide" onClick={onBackspace}>
          ⌫ Delete
        </button>
      </div>
    </div>
  );
}
