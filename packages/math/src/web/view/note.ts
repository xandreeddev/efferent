import { html, type Html } from "@xandreed/surface"
import { ID_MATH_NOTE } from "../ids.js"
import { oobAttr } from "./oob.js"

/** The tutor's one-line coach note above the card. Singleton — a new note
 *  replaces the old; empty renders the (CSS-hidden) empty slot. */
export const renderMathNote = (note: string | undefined, oob?: string): Html =>
  html`<div id="${ID_MATH_NOTE}" class="ef-m-note"${oobAttr(oob)}>${
    note !== undefined && note.trim() !== "" ? html`<span class="ef-m-note-text">${note}</span>` : ""
  }</div>`
