import { STAR_PATH, starStates } from "@/lib/stars";

/**
 * Five stars, full/half/empty. Purely presentational — no "use client"
 * needed, so it renders equally well inside a server component
 * (RatingsRow's "Us" cell) or inside a client component's tree
 * (CommunityClient's average and per-comment rating badges).
 */
export function Stars({ value, size = 16 }: { value: number | null; size?: number }) {
  const states = starStates(value);
  return (
    <span className="stars" style={{ "--star-size": `${size}px` } as React.CSSProperties}>
      {states.map((state, i) => (
        <span className={`star star-${state}`} key={i}>
          <svg viewBox="0 0 24 24" className="star-outline" aria-hidden="true">
            <path d={STAR_PATH} />
          </svg>
          <svg viewBox="0 0 24 24" className="star-fill" aria-hidden="true">
            <path d={STAR_PATH} />
          </svg>
        </span>
      ))}
    </span>
  );
}
