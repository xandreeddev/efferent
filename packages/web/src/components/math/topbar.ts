import { html, type Html } from "../../html.js"
import { ID_CONN, ID_MATH_HEADER } from "../../ids.js"
import { ACTION_SETUP_PATH } from "../../protocol/contract.js"
import type { MathHeaderView } from "../../mathViews.js"
import { oobAttr } from "../oob.js"

/**
 * The math app's topbar: wordmark · the grade/theme chip (opens the setup
 * stage) · solved count · a subtle "writing…" pulse while a generation turn
 * runs · conn badge. Server-rendered singleton — every change upserts it.
 */
export const renderMathTopbar = (view: MathHeaderView, oob?: string): Html => {
  const scope =
    view.grade !== undefined && view.theme !== undefined
      ? `grade ${view.grade} · ${view.theme}`
      : view.theme ?? (view.grade !== undefined ? `grade ${view.grade}` : "choose a topic")
  return html`<header id="${ID_MATH_HEADER}" class="ef-m-topbar"${oobAttr(oob)}>
    <span class="ef-m-wordmark">▌efferent <b>math</b></span>
    <span class="ef-m-topbar-right">
      ${view.generating && html`<span class="ef-m-pulse">writing…</span>`}
      ${view.solved > 0 && html`<span class="ef-m-solved" title="solved this session">✓ ${view.solved}</span>`}
      <form method="post" action="${ACTION_SETUP_PATH}" hx-post="${ACTION_SETUP_PATH}" hx-swap="none">
        <button type="submit" class="ef-m-chip" title="change grade or topic">${scope} ▾</button>
      </form>
      <span id="${ID_CONN}" class="ef-m-conn ef-m-conn--closed" title="connection">○</span>
    </span>
  </header>`
}
