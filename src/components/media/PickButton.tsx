"use client";

import { useState } from "react";

import { PickSheet } from "./PickSheet";

/**
 * The entry point. Kept separate from the sheet so the sheet's code is not in
 * the bundle until someone actually asks for a pick.
 */
export function PickButton({ label = "Choose for me", className = "btn" }: { label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? <PickSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}
