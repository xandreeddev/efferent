import { html, join, type Html } from "../../html.js"
import {
  ACTION_CHECK_PATH,
  ACTION_REPORT_PATH,
  ACTION_REVEAL_PATH,
  MATH_EX_FIELD,
  MATH_VALUE_FIELD,
} from "../../protocol/contract.js"
import { sanitizeMathml } from "../../sanitize.js"
import type { MathExerciseView, MathFeedbackView } from "../../mathViews.js"

/** A model-authored equation snippet → a display block, or nothing when the
 *  strict sanitizer rejects it (the prompt text always carries the question). */
const equation = (mathml: string | undefined): Html => {
  if (mathml === undefined || mathml.trim() === "") return html``
  const safe = sanitizeMathml(mathml)
  return safe.ok ? html`<div class="ef-m-equation">${safe.html}</div>` : html``
}

/** Inline MathML for a choice label — falls back to the plain label text. */
const choiceLabel = (label: string, mathml: string | undefined): Html => {
  if (mathml !== undefined && mathml.trim() !== "") {
    const safe = sanitizeMathml(mathml)
    if (safe.ok) return html`${safe.html}`
  }
  return html`${label}`
}

const feedbackBlock = (fb: MathFeedbackView): Html => {
  const tone =
    fb.verdict === "correct" ? "ef-m-feedback--ok" : fb.verdict === "wrong" ? "ef-m-feedback--err" : "ef-m-feedback--info"
  const headline =
    fb.verdict === "correct"
      ? `✓ Correct${fb.echo !== undefined ? ` — ${fb.echo}` : ""}`
      : fb.verdict === "wrong"
        ? `✗ Not yet${fb.echo !== undefined ? ` — you answered ${fb.echo}` : ""}`
        : `The answer is ${fb.correctAnswer ?? "below"}`
  return html`<div class="ef-m-feedback ${tone}">
    <p class="ef-m-verdict">${headline}</p>
    ${fb.hint !== undefined && html`<p class="ef-m-hint"><b>Hint:</b> ${fb.hint}</p>`}
    ${fb.solution !== undefined && fb.solution.length > 0
      ? html`<div class="ef-m-solution">
          ${fb.verdict !== "revealed" && fb.correctAnswer !== undefined
            ? html`<p class="ef-m-solution-answer">The answer is <b>${fb.correctAnswer}</b>. Here's how:</p>`
            : ""}
          <ol class="ef-m-steps">
            ${join(
              fb.solution.map(
                (s) => html`<li class="ef-m-step">${s.text}${equation(s.mathml)}</li>`,
              ),
            )}
          </ol>
        </div>`
      : ""}
  </div>`
}

const answerForm = (view: MathExerciseView): Html => {
  const retry = view.feedback?.verdict === "wrong"
  const button = html`<button type="submit" class="ef-m-btn ef-m-btn--primary ef-m-check">${
    retry ? "Try again" : "Check answer"
  }</button>`
  const hidden = html`<input type="hidden" name="${MATH_EX_FIELD}" value="${view.id}" />`
  if (view.input.kind === "choice") {
    const chosen = view.feedback?.echo
    return html`<form class="ef-m-answer" method="post" action="${ACTION_CHECK_PATH}" hx-post="${ACTION_CHECK_PATH}" hx-swap="none">
      ${hidden}
      <div class="ef-m-choices">
        ${join(
          (view.input.choices ?? []).map(
            (c) => html`<label class="ef-m-choice">
              <input type="radio" name="${MATH_VALUE_FIELD}" value="${c.id}"${chosen === c.id ? html` checked` : ""} required />
              <span class="ef-m-choice-label">${choiceLabel(c.label, c.mathml)}</span>
            </label>`,
          ),
        )}
      </div>
      ${button}
    </form>`
  }
  return html`<form class="ef-m-answer ef-m-answer--row" method="post" action="${ACTION_CHECK_PATH}" hx-post="${ACTION_CHECK_PATH}" hx-swap="none">
    ${hidden}
    <input
      class="ef-m-input"
      type="text"
      name="${MATH_VALUE_FIELD}"
      inputmode="${view.input.kind === "numeric" ? "decimal" : "text"}"
      placeholder="${view.input.placeholder ?? "your answer"}"
      value="${retry && view.feedback?.echo !== undefined ? view.feedback.echo : ""}"
      autocomplete="off"
      required
    />
    ${button}
  </form>`
}

/**
 * ONE exercise as a clean, self-contained card: eyebrow → prompt → typeset
 * equation → answer control → (feedback) → the quiet foot (Reveal / Report).
 * Grading is server-instant — this component just renders whatever verdict
 * state the model of record holds; it never talks to the agent.
 */
export const renderExerciseCard = (view: MathExerciseView): Html =>
  html`<article class="ef-m-exercise" data-ex="${view.id}">
    <div class="ef-m-eyebrow">
      <span class="ef-m-eyebrow-label">Exercise ${view.index} of ${view.total}${
        view.topic !== undefined ? html` · ${view.topic}` : ""
      }</span>
      ${view.difficulty !== undefined && html`<span class="ef-m-diff">${view.difficulty}</span>`}
    </div>
    <p class="ef-m-prompt">${view.prompt}</p>
    ${equation(view.mathml)}
    ${view.done ? "" : answerForm(view)}
    ${view.feedback !== undefined ? feedbackBlock(view.feedback) : ""}
    <div class="ef-m-foot">
      ${view.done
        ? ""
        : html`<form method="post" action="${ACTION_REVEAL_PATH}" hx-post="${ACTION_REVEAL_PATH}" hx-swap="none">
            <input type="hidden" name="${MATH_EX_FIELD}" value="${view.id}" />
            <button type="submit" class="ef-m-btn ef-m-btn--link">Show the answer</button>
          </form>`}
      <form method="post" action="${ACTION_REPORT_PATH}" hx-post="${ACTION_REPORT_PATH}" hx-swap="none">
        <input type="hidden" name="${MATH_EX_FIELD}" value="${view.id}" />
        <button type="submit" class="ef-m-btn ef-m-btn--link" title="something wrong with this exercise? skip it and tell the tutor">Report a problem</button>
      </form>
    </div>
  </article>`
