/**
 * MathModel → `@xandreed/web` math views → OOB fragments / the full page. The
 * ONE file that imports the web package's math surface (the adapter seam —
 * same discipline as the web driver's render.ts).
 */
import {
  render,
  renderMathFullSync,
  renderMathShell,
  upsertMathControls,
  upsertMathHeader,
  upsertMathNote,
  upsertMathStage,
  type MathControlsView,
  type MathExerciseView,
  type MathHeaderView,
  type MathShellView,
  type MathStage,
} from "@xandreed/web"
import type { MathExercise } from "../domain/MathContent.js"
import { Option } from "effect"
import { canNext, findExercise, type ExerciseState, type MathModel, type MathPatch } from "./model.js"

export interface MathMeta {
  readonly title: string
  readonly wsUrl: string
}

const DEFAULT_SUGGESTIONS = [
  "fractions",
  "multiplication",
  "long division",
  "decimals",
  "negative numbers",
  "percentages",
  "equations",
  "geometry",
] as const

const inputKindFor = (ex: MathExercise): MathExerciseView["input"] => {
  switch (ex.answer.kind) {
    case "choice":
      return {
        kind: "choice",
        choices: (ex.choices ?? []).map((c) => ({
          id: c.id,
          label: c.label,
          ...(c.mathml !== undefined ? { mathml: c.mathml } : {}),
        })),
      }
    case "integer":
    case "decimal":
      return { kind: "numeric", placeholder: "your answer" }
    case "fraction":
      return { kind: "text", placeholder: "e.g. 3/4" }
    case "text":
      return { kind: "text", placeholder: "your answer" }
  }
}

const feedbackFor = (e: ExerciseState): MathExerciseView["feedback"] => {
  const solution = e.item.solution.map((s) => ({
    text: s.text,
    ...(s.mathml !== undefined ? { mathml: s.mathml } : {}),
  }))
  // A choice key's value is the option ID — students read the LABEL.
  const key =
    e.item.answer.kind === "choice"
      ? (e.item.choices ?? []).find((c) => c.id.trim() === e.item.answer.value.trim())?.label ??
        e.item.answer.value
      : e.item.answer.value
  switch (e.verdict) {
    case "correct":
      return {
        verdict: "correct",
        ...(e.lastAnswer !== undefined ? { echo: e.lastAnswer } : {}),
      }
    case "wrong":
      return e.attempts >= 2
        ? {
            verdict: "wrong",
            ...(e.lastAnswer !== undefined ? { echo: e.lastAnswer } : {}),
            correctAnswer: key,
            solution,
          }
        : {
            verdict: "wrong",
            ...(e.lastAnswer !== undefined ? { echo: e.lastAnswer } : {}),
            hint: e.item.hint,
          }
    case "revealed":
      return { verdict: "revealed", correctAnswer: key, solution }
    case "fresh":
    case "reported":
      return undefined
  }
}

const exerciseView = (m: MathModel, e: ExerciseState): MathExerciseView => {
  const index = m.exercises.findIndex((x) => x.item.id === e.item.id) + 1
  const feedback = feedbackFor(e)
  return {
    id: e.item.id,
    index,
    total: m.exercises.length,
    ...(m.theme !== undefined ? { topic: m.theme } : {}),
    ...(e.item.difficulty !== undefined ? { difficulty: e.item.difficulty } : {}),
    prompt: e.item.prompt,
    ...(e.item.mathml !== undefined ? { mathml: e.item.mathml } : {}),
    input: inputKindFor(e.item),
    ...(feedback !== undefined ? { feedback } : {}),
    done: e.verdict === "correct" || e.verdict === "revealed",
  }
}

const stageFor = (m: MathModel): MathStage => {
  if (m.setupOpen || !m.started) {
    return {
      kind: "setup",
      setup: {
        ...(m.grade !== undefined ? { grade: m.grade } : {}),
        ...(m.theme !== undefined ? { theme: m.theme } : {}),
        suggestions: [...DEFAULT_SUGGESTIONS],
      },
    }
  }
  const current =
    m.currentId !== undefined
      ? Option.getOrUndefined(findExercise(m, m.currentId))
      : undefined
  if (current !== undefined && current.verdict !== "reported") {
    return { kind: "exercise", exercise: exerciseView(m, current) }
  }
  if (m.lastError !== undefined) {
    return {
      kind: "error",
      message: m.lastError.message,
      ...(m.lastError.detail !== undefined ? { detail: m.lastError.detail } : {}),
    }
  }
  return {
    kind: "skeleton",
    message: m.generating
      ? "writing your exercises…"
      : "Nothing on screen — More below writes the next batch.",
  }
}

const headerFor = (m: MathModel): MathHeaderView => ({
  ...(m.grade !== undefined ? { grade: m.grade } : {}),
  ...(m.theme !== undefined ? { theme: m.theme } : {}),
  solved: m.solved,
  generating: m.generating,
})

const controlsFor = (m: MathModel): MathControlsView => ({
  started: m.started && !m.setupOpen,
  canNext: canNext(m),
  generating: m.generating,
})

export const buildMathShellView = (m: MathModel, meta: MathMeta): MathShellView => ({
  title: meta.title,
  wsUrl: meta.wsUrl,
  header: headerFor(m),
  ...(m.note !== undefined ? { note: m.note } : {}),
  stage: stageFor(m),
  controls: controlsFor(m),
})

/** One patch → one OOB fragment. */
export const renderMathPatch = (m: MathModel, meta: MathMeta, patch: MathPatch): string => {
  switch (patch) {
    case "header":
      return render(upsertMathHeader(headerFor(m)))
    case "stage":
      return render(upsertMathStage(stageFor(m)))
    case "note":
      return render(upsertMathNote(m.note))
    case "controls":
      return render(upsertMathControls(controlsFor(m)))
  }
}

/** The reconnect batch (all four singletons). */
export const renderMathSync = (m: MathModel, meta: MathMeta): string =>
  render(renderMathFullSync(buildMathShellView(m, meta)))

/** The full document (GET /). */
export const renderMathPage = (m: MathModel, meta: MathMeta): string =>
  renderMathShell(buildMathShellView(m, meta))
