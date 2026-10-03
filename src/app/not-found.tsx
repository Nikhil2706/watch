import Link from "next/link";

/**
 * Any path, film or show that does not exist. Next's built-in page had
 * nothing to focus, which on a TV is a dead end for the remote; this one has
 * a way home, focused on arrival (data-tv-autofocus).
 */
export default function NotFound() {
  return (
    <main className="not-found-tv" style={{ minHeight: "70vh", display: "grid", placeItems: "center", padding: "48px" }}>
      <div style={{ textAlign: "center", display: "grid", gap: 16, justifyItems: "center" }}>
        <h1 style={{ margin: 0 }}>Nothing here</h1>
        <p className="page-sub" style={{ margin: 0 }}>
          This page, film or show doesn&rsquo;t exist, or isn&rsquo;t in the library any more.
        </p>
        <Link href="/" className="btn" data-tv-autofocus="true">
          Go home
        </Link>
      </div>
    </main>
  );
}
