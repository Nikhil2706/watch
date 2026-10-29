"use client";

import { STAR_PATH, starStates } from "@/lib/stars";

/**
 * Half-star picker: five stars, each split into a left half (sets N-0.5)
 * and a right half (sets N) via two invisible overlaid buttons — the
 * standard way to get half-star precision out of five icons without a
 * drag/slider interaction.
 */
export function StarPicker({ value, onRate }: { value: number | null; onRate: (stars: number) => void }) {
  const states = starStates(value);
  return (
    <span className="stars star-picker" style={{ "--star-size": "24px" } as React.CSSProperties}>
      {states.map((state, i) => {
        const pos = i + 1;
        return (
          <span className={`star star-${state}`} key={pos}>
            <svg viewBox="0 0 24 24" className="star-outline" aria-hidden="true">
              <path d={STAR_PATH} />
            </svg>
            <svg viewBox="0 0 24 24" className="star-fill" aria-hidden="true">
              <path d={STAR_PATH} />
            </svg>
            <button
              type="button"
              className="star-hit star-hit-left"
              aria-label={`Rate ${pos - 0.5} stars`}
              onClick={() => onRate(pos - 0.5)}
            />
            <button
              type="button"
              className="star-hit star-hit-right"
              aria-label={`Rate ${pos} stars`}
              onClick={() => onRate(pos)}
            />
          </span>
        );
      })}
    </span>
  );
}
