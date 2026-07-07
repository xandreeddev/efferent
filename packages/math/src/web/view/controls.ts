import { html, type Html } from "@xandreed/surface"
import { ID_MATH_CONTROLS } from "../ids.js"
import {
  ACTION_EASIER_PATH,
  ACTION_HARDER_PATH,
  ACTION_INTERRUPT_PATH,
  ACTION_MORE_PATH,
  ACTION_NEXT_PATH,
} from "../contract.js"
import type { MathControlsView } from "./types.js"
import { oobAttr } from "./oob.js"

const actionForm = (path: string, label: string, cls: string, disabled: boolean): Html =>
  html`<form method="post" action="${path}" hx-post="${path}" hx-swap="none">
    <button type="submit" class="${cls}"${disabled ? html` disabled` : ""}>${label}</button>
  </form>`

/**
 * The action row under the card — every button is a typed POST, no chat.
 * Agent-driven actions (More/Harder/Easier) freeze while a generation turn
 * runs (server-rendered `disabled` — the server is the busy authority); Next
 * is instant and stays live whenever another exercise is ready.
 */
export const renderMathControls = (view: MathControlsView, oob?: string): Html =>
  html`<nav id="${ID_MATH_CONTROLS}" class="ef-m-controls"${oobAttr(oob)}>${
    view.started
      ? html`${actionForm(ACTION_NEXT_PATH, "Next →", "ef-m-btn ef-m-btn--primary", !view.canNext)}
        ${actionForm(ACTION_MORE_PATH, "More", "ef-m-btn ef-m-btn--ghost", view.generating)}
        ${actionForm(ACTION_HARDER_PATH, "Harder", "ef-m-btn ef-m-btn--ghost", view.generating)}
        ${actionForm(ACTION_EASIER_PATH, "Easier", "ef-m-btn ef-m-btn--ghost", view.generating)}
        ${view.generating
          ? html`<span class="ef-m-writing">writing the next ones…
              ${actionForm(ACTION_INTERRUPT_PATH, "stop", "ef-m-btn ef-m-btn--link", false)}</span>`
          : ""}`
      : ""
  }</nav>`
