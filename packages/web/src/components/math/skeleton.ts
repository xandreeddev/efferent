import { html, type Html } from "../../html.js"
import { ACTION_MORE_PATH } from "../../protocol/contract.js"

/** The generation pending state — a pure-CSS shimmer card. Never a dead page:
 *  it's what the student sees between asking and the first exercise landing. */
export const renderSkeleton = (message: string): Html =>
  html`<div class="ef-m-skel" role="status">
    <div class="ef-m-skel-bar ef-m-skel-bar--eyebrow"></div>
    <div class="ef-m-skel-bar ef-m-skel-bar--prompt"></div>
    <div class="ef-m-skel-bar ef-m-skel-bar--equation"></div>
    <div class="ef-m-skel-bar ef-m-skel-bar--input"></div>
    <p class="ef-m-skel-msg">${message}</p>
  </div>`

/** A failed generation turn — the reason plus a Retry that re-asks for
 *  exercises. State is never lost; answered exercises stay answered. */
export const renderMathError = (message: string, detail: string | undefined): Html =>
  html`<div class="ef-m-error" role="alert">
    <p class="ef-m-error-msg">${message}</p>
    ${detail !== undefined && detail.trim() !== "" && html`<p class="ef-m-error-detail">${detail}</p>`}
    <form method="post" action="${ACTION_MORE_PATH}" hx-post="${ACTION_MORE_PATH}" hx-swap="none">
      <button type="submit" class="ef-m-btn ef-m-btn--primary">Try again</button>
    </form>
  </div>`
