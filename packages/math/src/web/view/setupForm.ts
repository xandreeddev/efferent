import { html, join, type Html } from "@xandreed/surface"
import { ACTION_TOPIC_PATH } from "../contract.js"
import type { MathSetupView } from "./types.js"

const GRADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const

/**
 * The setup stage: pick a grade + a topic, start practicing. A suggestion chip
 * is a SUBMIT button carrying its topic (`name="theme"`), so one tap starts —
 * zero JS. The free-text field rides as `theme-custom`; the server prefers the
 * chip's `theme` when both arrive.
 */
export const renderSetupForm = (view: MathSetupView): Html =>
  html`<form class="ef-m-setup" method="post" action="${ACTION_TOPIC_PATH}" hx-post="${ACTION_TOPIC_PATH}" hx-swap="none">
    <h1 class="ef-m-setup-title">What are we practicing?</h1>
    <div class="ef-m-field">
      <label class="ef-m-label" for="ef-m-grade">Grade</label>
      <select id="ef-m-grade" class="ef-m-select" name="grade">
        ${join(
          GRADES.map(
            (g) => html`<option value="${g}"${g === (view.grade ?? 4) ? html` selected` : ""}>Grade ${g}</option>`,
          ),
        )}
      </select>
    </div>
    <div class="ef-m-field">
      <span class="ef-m-label">Topic</span>
      <div class="ef-m-sugs">
        ${join(
          view.suggestions.map(
            (s) => html`<button type="submit" class="ef-m-sug" name="theme" value="${s}">${s}</button>`,
          ),
        )}
      </div>
      <input
        class="ef-m-input"
        type="text"
        name="theme-custom"
        placeholder="or type any topic — long division, negative numbers…"
        value="${view.theme ?? ""}"
        autocomplete="off"
      />
    </div>
    <button type="submit" class="ef-m-btn ef-m-btn--primary ef-m-start">Start practicing</button>
  </form>`
