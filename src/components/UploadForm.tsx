"use client";

import { useRef, useState } from "react";

type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; percent: number }
  | { phase: "done"; filename: string }
  | { phase: "error"; message: string };

/**
 * fetch() has no upload-progress event, only download-progress — so a large
 * file upload with a visible progress bar needs XMLHttpRequest specifically,
 * not the fetch API this codebase otherwise prefers everywhere else.
 */
export function UploadForm() {
  const [state, setState] = useState<UploadState>({ phase: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  function handleUpload() {
    const file = inputRef.current?.files?.[0];
    if (!file) return;

    setState({ phase: "uploading", percent: 0 });

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?filename=${encodeURIComponent(file.name)}`);

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      setState({ phase: "uploading", percent: Math.round((event.loaded / event.total) * 100) });
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setState({ phase: "done", filename: file.name });
      } else {
        let message = "Upload failed.";
        try {
          message = (JSON.parse(xhr.responseText) as { message?: string }).message ?? message;
        } catch {
          /* non-JSON error body — keep the default message */
        }
        setState({ phase: "error", message });
      }
    });

    xhr.addEventListener("error", () => setState({ phase: "error", message: "The upload connection dropped." }));

    xhr.send(file);
  }

  if (state.phase === "done") {
    return (
      <div className="empty" style={{ marginTop: 24 }}>
        <p>&ldquo;{state.filename}&rdquo; uploaded — it&apos;s in the review queue now.</p>
        <button
          className="btn ghost"
          onClick={() => {
            setState({ phase: "idle" });
            if (inputRef.current) inputRef.current.value = "";
          }}
        >
          Upload another
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 20 }}>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        disabled={state.phase === "uploading"}
        style={{ display: "block", marginBottom: 12 }}
      />
      <button className="btn" onClick={handleUpload} disabled={state.phase === "uploading"}>
        {state.phase === "uploading" ? `Uploading — ${state.percent}%` : "Upload"}
      </button>

      {state.phase === "uploading" ? (
        <div
          style={{
            marginTop: 12,
            height: 6,
            borderRadius: 3,
            background: "var(--surface-2, #1a1f28)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${state.percent}%`,
              height: "100%",
              background: "var(--accent, #5b8def)",
              transition: "width 0.2s",
            }}
          />
        </div>
      ) : null}

      {state.phase === "error" ? (
        <p className="note err" style={{ marginTop: 12 }}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
