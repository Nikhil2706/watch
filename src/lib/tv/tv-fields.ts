/**
 * Text fields on a TV, and the system keyboard.
 *
 * On Android TV, focus landing on an editable field opens the system
 * keyboard at once, and the keyboard then owns the D-pad. So a field that
 * merely sits on the way somewhere (Browse's "Search genres…" between the
 * tabs and the genre list) swallowed the remote: "down" moved around the
 * keyboard instead of down the page.
 *
 * The rule here: moving onto a field does not open the keyboard; pressing OK
 * on it does. While a field is only focused it is held read-only, which is
 * what keeps the keyboard closed — and, unlike inputmode="none", still lets
 * the OK key reach the page (the WebView swallows OK on an editable field).
 * OK makes the field editable again and re-focuses it, which opens the
 * keyboard. Leaving the field resets it. The keyboard is the system's own,
 * the one every other app on the TV uses; there is no in-app keyboard.
 */

type Field = HTMLInputElement | HTMLTextAreaElement;

const NON_TEXT_INPUTS = new Set(["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "hidden", "image"]);

/** A field someone can type in (one we are holding read-only still counts). */
export function isTvTextField(el: EventTarget | null): el is Field {
  if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLInputElement)) return false;
  if (el instanceof HTMLInputElement && NON_TEXT_INPUTS.has(el.type)) return false;
  if (el.disabled) return false;
  return !el.readOnly || el.dataset.tvHeld === "true";
}

/** True while blur()+focus() is re-opening a field for typing (so the blur is not "leaving"). */
let reopening = false;

/** Focus arrived on a field: keep the keyboard closed unless it was opened for typing. */
export function holdKeyboard(el: Field): void {
  if (el.dataset.tvTyping === "true" || el.dataset.tvHeld === "true") return;
  el.dataset.tvHeld = "true";
  el.readOnly = true;
}

/** Is this field focused with the keyboard held closed (OK should open it)? */
export function keyboardHeld(el: Field): boolean {
  return el.dataset.tvHeld === "true";
}

function unhold(el: Field): void {
  if (el.dataset.tvHeld !== "true") return;
  delete el.dataset.tvHeld;
  el.readOnly = false;
}

/** OK on a held field: open the system keyboard on it. */
export function openKeyboard(el: Field): void {
  el.dataset.tvTyping = "true";
  unhold(el);
  // Editable again, but the keyboard opens on focus: give it one.
  reopening = true;
  try {
    el.blur();
    el.focus();
  } finally {
    reopening = false;
  }
}

/** Focus a field with the keyboard open: the next field after the keyboard's Enter. */
export function focusFieldForTyping(el: Field): void {
  el.dataset.tvTyping = "true";
  unhold(el);
  el.focus();
}

/** Focus left a field for good: back to "focus does not open the keyboard". */
export function releaseField(el: Field): void {
  if (reopening) return;
  delete el.dataset.tvTyping;
  unhold(el);
}
