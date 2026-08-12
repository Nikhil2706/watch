import { Wordmark } from "@/components/Brand";

/**
 * The front door.
 *
 * This is the only page most people will ever see — anyone who hears about the
 * club, anyone whose session lapsed, anyone who mistypes the URL. The old
 * version was a grey box on a grey page that said "Sign in" and nothing else,
 * so a visitor without an account learned neither what this is nor how to get
 * in. This shell answers both.
 *
 * The backdrop is a projector beam over film grain. It is drawn entirely in CSS
 * and one inline SVG — no images, no webfonts, no third-party request. That
 * matters more than usual here: this page is served to unauthenticated
 * visitors, so anything it fetched would be fetched by strangers, and the whole
 * point of a self-hosted box is not to phone anywhere.
 *
 * Deliberately absent: real poster art. A wall of covers from the library would
 * look wonderful and would also publish exactly what the club owns to anyone
 * who loads the page, which defeats the invite gate.
 */
export function AuthShell({
  children,
  pitch = true,
}: {
  children: React.ReactNode;
  /** The pitch is for strangers. Pages reached by an invite link skip it. */
  pitch?: boolean;
}) {
  return (
    <main className="auth-root">
      {/* Light first, then the room it is in: beam, counter-glow, vignette,
          grain. Each is inert and pointer-transparent. */}
      <div className="auth-beam" aria-hidden="true" />
      <div className="auth-glow" aria-hidden="true" />
      <div className="auth-vignette" aria-hidden="true" />
      <svg className="auth-grain" aria-hidden="true" focusable="false">
        <filter id="auth-grain">
          {/* Monochrome fractal noise. The overlay blend keeps it in the
              shadows instead of fogging the whole screen. */}
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.82"
            numOctaves="3"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#auth-grain)" />
      </svg>

      <div className="auth-layout">
        <div className="auth-brand">
          <Wordmark size={30} />
          <p className="auth-tagline">A private film club.</p>
        </div>

        <div className="auth-panel">{children}</div>

        {/* Below the form on a phone, beside it on a desktop. A returning
            member should never have to scroll past the pitch to sign in, and a
            stranger should never have to hunt for what this place is. */}
        {pitch ? (
          <div className="auth-pitch">
            <p>
              Films chosen on purpose, watched on your own time, and argued
              about afterwards. Everything here was picked by a person, not by a
              recommendation engine.
            </p>
            <ul>
              <li>
                <strong>Picked, not served.</strong> Every film arrives with
                notes from whoever chose it.
              </li>
              <li>
                <strong>Carry on anywhere.</strong> Start on the TV, finish on
                your phone, keep your place.
              </li>
              <li>
                <strong>Invite only.</strong> Membership comes from a member.
              </li>
            </ul>
          </div>
        ) : null}
      </div>
    </main>
  );
}
