import type { CuratorNote as CuratorNoteData } from "@/lib/notifications";

/**
 * "The curator picked this for you", with the reason he typed when he sent it.
 *
 * Only ever rendered for the one person it was sent to — a pick is addressed
 * to somebody, and shown to anyone else it would read as a review. The
 * notification that announced it stays a single line; this is where the
 * substance of the recommendation lives.
 */
export function CuratorNote({ note }: { note: CuratorNoteData }) {
  const sent = new Date(note.sentAt);

  return (
    <aside className="curator-note" aria-label="A note from the curator">
      <div className="curator-note-head">
        Picked for you
        <time dateTime={sent.toISOString()}>
          {sent.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}
        </time>
      </div>
      <blockquote>{note.note}</blockquote>
    </aside>
  );
}
