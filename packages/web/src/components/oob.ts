import { raw, type Html } from "../html.js"

/**
 * The `hx-swap-oob` attribute for a component root. Values we use:
 * - `"true"` — outerHTML-replace the element with the same id (upsert)
 * - `"beforeend:#<region>"` — append into a region (new block)
 * - `"innerHTML"` — replace the same-id element's contents (full sync)
 * - `"delete"` — remove the same-id element (a dropped component)
 * Stamped IN the component root, never by post-hoc string surgery.
 */
export const oobAttr = (oob: string | undefined): Html =>
  oob === undefined ? raw("") : raw(` hx-swap-oob="${oob}"`)
