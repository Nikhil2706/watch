"use client";

import { useState } from "react";

export interface PartyGuestLinkView {
  token: string;
  label: string;
  url: string;
}

/**
 * Creator-only panel: mint a per-person guest link (name optional — blank
 * becomes "Guest N"), see every link already handed out, copy its URL, or
 * show its QR code for a phone. Each link is its own stable identity in
 * chat (party_guest_links in schema.ts) — this is the "track who's talking
 * without making them sign up" piece.
 */
export function PartyGuestLinksPanel({ roomId, initialLinks }: { roomId: string; initialLinks: PartyGuestLinkView[] }) {
  const [links, setLinks] = useState(initialLinks);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  async function createLink(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch(`/api/party/${roomId}/guests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() || undefined }),
      });
      if (response.ok) {
        const { link } = (await response.json()) as { link: { token: string; label: string } };
        setLinks((prev) => [...prev, { token: link.token, label: link.label, url: `/party/${roomId}/g/${link.token}` }]);
        setLabel("");
      }
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string, token: string) {
    try {
      await navigator.clipboard.writeText(new URL(url, window.location.origin).toString());
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 1500);
    } catch {
      /* clipboard permission denied — the URL is still shown/selectable in the row itself */
    }
  }

  return (
    <div className="party-guests">
      <h3>Guest links</h3>
      <p className="party-guests-hint">
        Anyone with one of these can chat without an account — each link is its own name in the conversation.
      </p>

      <form className="party-guests-form" onSubmit={createLink}>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Name (optional)"
          maxLength={60}
        />
        <button type="submit" disabled={busy}>
          Create link
        </button>
      </form>

      <ul className="party-guests-list">
        {links.map((l) => (
          <li key={l.token} className="party-guest-row">
            <span className="party-guest-label">{l.label}</span>
            <button type="button" onClick={() => copy(l.url, l.token)}>
              {copiedToken === l.token ? "Copied" : "Copy link"}
            </button>
            <button type="button" onClick={() => setQrFor(qrFor === l.token ? null : l.token)}>
              QR
            </button>
            {qrFor === l.token ? (
              <img
                className="party-guest-qr"
                src={`/api/party/${roomId}/guests/${l.token}/qr`}
                alt={`QR code for ${l.label}'s link`}
                width={140}
                height={140}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
