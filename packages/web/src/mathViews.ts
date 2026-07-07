/**
 * View-model prop types for the standalone `efferent math` shell — the
 * structural shapes the cli's math driver maps its model onto (same adapter
 * discipline as `views.ts` for the web shell; this package never imports
 * sdk-core, so these are independent structural types, not the tool schema).
 *
 * Everything here is plain data. The ONLY model-authored string that crosses
 * into markup is `mathml` (an equation snippet), and the components run it
 * through the strict `sanitizeMathml` — a rejected snippet simply doesn't
 * display (the prompt text always carries the question).
 */

export interface MathHeaderView {
  readonly grade?: number
  readonly theme?: string
  /** Exercises answered correctly this session. */
  readonly solved: number
  /** A generation turn is in flight — the topbar shows a subtle pulse. */
  readonly generating: boolean
}

export interface MathSetupView {
  readonly grade?: number
  readonly theme?: string
  /** Tappable theme suggestions (server-curated). */
  readonly suggestions: ReadonlyArray<string>
}

export interface MathChoiceView {
  readonly id: string
  readonly label: string
  readonly mathml?: string
}

export interface MathSolutionStepView {
  readonly text: string
  readonly mathml?: string
}

export interface MathFeedbackView {
  readonly verdict: "correct" | "wrong" | "revealed"
  /** The student's answer, normalized (echoed in the banner). */
  readonly echo?: string
  /** The correct answer — shown with the solution tier and on reveal. */
  readonly correctAnswer?: string
  /** First wrong attempt: a nudge. */
  readonly hint?: string
  /** Second wrong attempt / reveal: the complete worked solution. */
  readonly solution?: ReadonlyArray<MathSolutionStepView>
}

export interface MathExerciseView {
  readonly id: string
  /** 1-based position of this exercise in the session. */
  readonly index: number
  readonly total: number
  /** Eyebrow context, e.g. "fractions". */
  readonly topic?: string
  readonly difficulty?: string
  readonly prompt: string
  /** Raw model MathML — sanitized inside the component. */
  readonly mathml?: string
  readonly input: {
    readonly kind: "numeric" | "text" | "choice"
    readonly placeholder?: string
    readonly choices?: ReadonlyArray<MathChoiceView>
  }
  readonly feedback?: MathFeedbackView
  /** Correct or revealed — the answer controls freeze. */
  readonly done: boolean
}

/** What the single stage slot shows — exactly one of these at a time. */
export type MathStage =
  | { readonly kind: "setup"; readonly setup: MathSetupView }
  | { readonly kind: "skeleton"; readonly message: string }
  | { readonly kind: "exercise"; readonly exercise: MathExerciseView }
  | { readonly kind: "error"; readonly message: string; readonly detail?: string }

export interface MathControlsView {
  /** Practice has started (controls render at all). */
  readonly started: boolean
  /** An unanswered exercise is ready beyond the current one. */
  readonly canNext: boolean
  /** A generation turn is running — the agent buttons freeze (server-owned). */
  readonly generating: boolean
}

export interface MathShellView {
  /** Document title. */
  readonly title: string
  readonly wsUrl: string
  readonly header: MathHeaderView
  /** The tutor's one-line coach note (replaces the previous one). */
  readonly note?: string
  readonly stage: MathStage
  readonly controls: MathControlsView
}
