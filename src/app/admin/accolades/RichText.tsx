"use client";

import { useRef } from "react";

import { RT_TAGS, sanitizeRichText, wrapTag } from "@/lib/admin/accolades-view";

const LABELS: Record<(typeof RT_TAGS)[number], { title: string; face: React.ReactNode }> = {
  b: { title: "Bold", face: <b>B</b> },
  i: { title: "Italic", face: <i>I</i> },
  u: { title: "Underline", face: <u>U</u> },
  s: { title: "Strikethrough", face: <s>S</s> },
  sub: { title: "Subscript", face: <>X<sub>2</sub></> },
  sup: { title: "Superscript", face: <>X<sup>2</sup></> },
};

/**
 * A plain textarea with a toolbar that wraps the selection in one of the six
 * tags the server keeps (not contenteditable: the exact tag names are what
 * the server's sanitiser allows), and a preview of how it will read.
 */
export function RichText({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrap = (tag: string) => {
    const t = ref.current;
    if (!t) return;
    const next = wrapTag(t.value, t.selectionStart, t.selectionEnd, tag);
    if (next.value === t.value) return;
    onChange(next.value);
    requestAnimationFrame(() => {
      t.focus();
      t.setSelectionRange(next.start, next.end);
    });
  };
  return (
    <div className="adm-ac-rt">
      <div className="adm-ac-rt-toolbar">
        {RT_TAGS.map((tag) => (
          <button key={tag} type="button" className="secondary adm-ac-rt-btn" title={LABELS[tag].title} onMouseDown={(e) => e.preventDefault()} onClick={() => wrap(tag)}>
            {LABELS[tag].face}
          </button>
        ))}
      </div>
      <textarea ref={ref} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {/* Only the six bare tags survive sanitizeRichText, so this is safe to render. */}
      {value ? <div className="adm-ac-rt-preview" dangerouslySetInnerHTML={{ __html: sanitizeRichText(value) }} /> : null}
    </div>
  );
}
