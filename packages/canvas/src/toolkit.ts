import { Tool, Toolkit } from "@effect/ai"
import { Effect, Schema } from "effect"
import { Failure } from "@xandreed/engine"
import { renderUiFindings, validateUi } from "@xandreed/surface"

/**
 * The canvas agent's ONE way to show anything: `render_ui`. The harness
 * doctrine, enforced at the chokepoint — every call runs the deterministic
 * UI gates (`validateUi`) BEFORE anything reaches the browser; a finding
 * rejects the whole call with the findings as model-readable feedback
 * (`failureMode: "return"`), so the model fixes exactly what the gate names
 * and re-sends in the same run. The sanitizer stays the security boundary at
 * render time; the gates are the FEEDBACK boundary here.
 */

export const HTML_MAX_BYTES = 131_072

/** One accepted render — the product event the UI folds. */
export interface CanvasEntry {
  readonly id: string
  readonly title: string
  readonly html: string
  readonly mode: "replace" | "append"
  readonly active: boolean
}

export const RenderUi = Tool.make("render_ui", {
  description:
    "Render (or update) one full PAGE on the user's canvas. `id` names the page — the same id re-renders in place, `mode:\"append\"` adds sections to it. Plain HTML + Tailwind utility classes (NO arbitrary values like w-[37px] or bg-[url(…)]); forms post to /action/ui with a hidden ui-id input. The call is checked by deterministic UI gates — a rejection lists every violation; fix exactly those and re-send.",
  parameters: {
    id: Schema.String.annotations({
      description: "Stable page id (kebab-case). Same id = update that page.",
    }),
    title: Schema.String.annotations({ description: "Short tab label for the page." }),
    html: Schema.String.annotations({
      description: "The page's HTML (fragment — no <html>/<head>/<body>).",
    }),
    mode: Schema.optional(
      Schema.Literal("replace", "append").annotations({
        description: "replace (default) swaps the page; append adds to its end.",
      }),
    ),
    active: Schema.optional(
      Schema.Boolean.annotations({
        description:
          "Focus hint: a NEW page opens focused by default; pass false to build in the background, true on an update to pull the user over.",
      }),
    ),
  },
  success: Schema.Struct({ rendered: Schema.Boolean, id: Schema.String }),
  failure: Failure,
  failureMode: "return",
})

export const canvasToolkit = Toolkit.make(RenderUi)
export type CanvasToolkit = typeof canvasToolkit

/** Handlers bound to the session's render sink (the chassis `publish`). */
export const makeCanvasHandlers = (
  sink: (entry: CanvasEntry) => Effect.Effect<void>,
) =>
  canvasToolkit.toLayer({
    render_ui: ({ id, title, html, mode, active }) =>
      Effect.gen(function* () {
        if (html.length > HTML_MAX_BYTES) {
          return yield* Effect.fail({
            error: "HtmlTooLarge",
            message: `this render is ${html.length} bytes (cap ${HTML_MAX_BYTES}) — split it: render the page skeleton first, then stream sections with mode:"append"`,
          })
        }
        const findings = validateUi(html)
        if (findings.length > 0) {
          return yield* Effect.fail({
            error: "UiRejected",
            message: `this render failed ${findings.length} UI gate(s) — fix exactly these and re-send:\n${renderUiFindings(findings)}`,
          })
        }
        yield* sink({
          id,
          title,
          html,
          mode: mode ?? "replace",
          active: active ?? true,
        })
        return { rendered: true, id }
      }),
  })
