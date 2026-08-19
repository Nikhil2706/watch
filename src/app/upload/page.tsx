import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { UploadForm } from "@/components/UploadForm";
import { currentSession } from "@/lib/current-user";

export const dynamic = "force-dynamic";

/**
 * Langlois-mode only — see the langlois_mode column comment in schema.ts.
 * Not gated by the /jf/* proxy or middleware.ts (this is a real page, not a
 * media endpoint); the check lives here, same as every other
 * session.langloisMode gate in this app (the download/subtitle links on
 * item/[id]/page.tsx).
 */
export default async function UploadPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} />

      <div style={{ padding: "18px 20px 0", maxWidth: 640, margin: "0 auto" }}>
        <h1 style={{ margin: 0, fontSize: "1.25rem" }}>Upload a film</h1>

        {!session.langloisMode ? (
          <div className="empty" style={{ marginTop: 24 }}>
            <p>Uploads are only available in Langlois mode.</p>
            <p className="hint" style={{ margin: 0 }}>
              Ask a curator if you think you should have this.
            </p>
          </div>
        ) : (
          <>
            <p className="hint" style={{ marginTop: 12 }}>
              Uploaded films are reviewed before they appear on the site — a Windows Defender scan,
              then a curator's own check. Nothing is published automatically.
            </p>
            <UploadForm />
          </>
        )}
      </div>
    </>
  );
}
