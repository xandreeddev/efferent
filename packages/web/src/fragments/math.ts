import { html, join, type Html } from "../html.js"
import type { MathControlsView, MathHeaderView, MathShellView, MathStage } from "../mathViews.js"
import { renderMathControls } from "../components/math/controls.js"
import { renderMathNote } from "../components/math/note.js"
import { renderMathStage } from "../components/math/stage.js"
import { renderMathTopbar } from "../components/math/topbar.js"

/**
 * OOB fragment builders for the math shell. The math UI is SINGLETON-ONLY —
 * one topbar, one stage slot, one note, one controls row — so every fragment
 * is a `hx-swap-oob="true"` outerHTML upsert and a reconnect full-sync is just
 * all four at once, idempotent by construction (same ids, same builders as the
 * initial page — the regions.ts anti-drift discipline).
 */
export const upsertMathHeader = (view: MathHeaderView): Html => renderMathTopbar(view, "true")

export const upsertMathStage = (stage: MathStage): Html => renderMathStage(stage, "true")

export const upsertMathNote = (note: string | undefined): Html => renderMathNote(note, "true")

export const upsertMathControls = (view: MathControlsView): Html =>
  renderMathControls(view, "true")

/** The reconnect batch — every singleton, one WS message. */
export const renderMathFullSync = (view: MathShellView): Html =>
  join([
    upsertMathHeader(view.header),
    upsertMathNote(view.note),
    upsertMathStage(view.stage),
    upsertMathControls(view.controls),
  ])

/** The non-OOB body contents the shell page renders (same builders — the
 *  initial document and a resync can never drift). */
export const mathBodyContents = (view: MathShellView): Html =>
  html`${renderMathTopbar(view.header)}
  <main class="ef-m-main">
    ${renderMathNote(view.note)}
    ${renderMathStage(view.stage)}
    ${renderMathControls(view.controls)}
  </main>`
