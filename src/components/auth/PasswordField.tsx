"use client";

import { useState } from "react";

/**
 * Password input with a reveal toggle and a Caps Lock warning.
 *
 * Both exist because they are the two things that actually make people fail a
 * login they know the password for: a typo they cannot see, and a stuck Caps
 * Lock. The browser reports Caps Lock through `getModifierState`, so warning
 * about it is free and never guesses.
 *
 * The toggle is a real `button` with `aria-pressed`, not an icon with a click
 * handler, so it is reachable by keyboard and announced correctly. It is also
 * `tabIndex={-1}`: someone tabbing from the password field wants the submit
 * button, not a detour through a control they can trigger with the mouse.
 */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  hint?: string;
  invalid?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);

  function trackCaps(event: React.KeyboardEvent<HTMLInputElement>) {
    setCaps(event.getModifierState("CapsLock"));
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="field-input">
        <input
          id={id}
          name={id}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          required
          value={value}
          aria-invalid={invalid || undefined}
          aria-describedby={caps ? `${id}-caps` : hint ? `${id}-hint` : undefined}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={trackCaps}
          onKeyUp={trackCaps}
          // Leaving the field should clear a warning that is no longer visible
          // to act on.
          onBlur={() => setCaps(false)}
        />
        <button
          type="button"
          className="field-toggle"
          onClick={() => setShown((on) => !on)}
          aria-pressed={shown}
          aria-label={shown ? "Hide password" : "Show password"}
          tabIndex={-1}
        >
          {shown ? (
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M3 3l18 18M10.6 10.7a2 2 0 002.8 2.8M9.4 5.2A9.6 9.6 0 0112 5c5 0 9 4.5 9 7a11 11 0 01-2.6 3.6M6.2 6.6A11.5 11.5 0 003 12c0 2.5 4 7 9 7a9.7 9.7 0 003.9-.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M3 12s3.6-7 9-7 9 7 9 7-3.6 7-9 7-9-7-9-7z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
              />
              <circle
                cx="12"
                cy="12"
                r="2.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
              />
            </svg>
          )}
        </button>
      </div>

      {caps ? (
        <p className="field-note warn" id={`${id}-caps`}>
          Caps Lock is on.
        </p>
      ) : hint ? (
        <p className="field-note" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
