/**
 * The math driver's server-side model — a pure, framework-free state machine
 * (the web driver's `model.ts` discipline). One instance per session, fed by
 * TWO writers through the same fold entries: the live event reducer
 * (`reduce.ts` — generation results) and the typed-action handlers
 * (`server.ts` via `pump.apply` — instant grading, navigation). Rendering
 * derives a `MathShellView` from it (`render.ts`); replay rebuilds it from the
 * persisted log through these same functions (`replay.ts`).
 */
import { Option } from "effect"
import { gradeAnswer, type MathExercise, type MathItem } from "../domain/MathContent.js"
import type { ProgressEntry } from "../protocol.js"

export type Verdict = "fresh" | "correct" | "wrong" | "revealed" | "reported"

export interface ExerciseState {
  readonly item: MathExercise
  readonly attempts: number
  readonly verdict: Verdict
  /** The student's last answer, normalized (echoed in feedback / retry). */
  readonly lastAnswer?: string
}

export interface MathModel {
  readonly grade?: number
  readonly theme?: string
  /** A start/topic has been submitted — practice is running. */
  readonly started: boolean
  /** The setup stage is explicitly open (topbar chip). */
  readonly setupOpen: boolean
  /** Ordered; upsert by exercise id (a re-sent id replaces — duplicates are
   *  harmless by construction). */
  readonly exercises: ReadonlyArray<ExerciseState>
  /** The exercise on screen. */
  readonly currentId?: string
  readonly note?: string
  /** A generation turn is in flight. */
  readonly generating: boolean
  readonly lastError?: { readonly message: string; readonly detail?: string }
  /** Graded results not yet reported to the agent — drained into the next
   *  agent-bound message. */
  readonly pendingProgress: ReadonlyArray<ProgressEntry>
  /** Exercises accepted since the current turn started (empty-turn detection). */
  readonly acceptedThisTurn: number
  readonly solved: number
}

export const emptyMathModel = (seed?: { grade?: number; theme?: string }): MathModel => ({
  ...(seed?.grade !== undefined ? { grade: seed.grade } : {}),
  ...(seed?.theme !== undefined ? { theme: seed.theme } : {}),
  started: false,
  setupOpen: false,
  exercises: [],
  generating: false,
  pendingProgress: [],
  acceptedThisTurn: 0,
  solved: 0,
})

export const findExercise = (m: MathModel, id: string): Option.Option<ExerciseState> =>
  Option.fromNullable(m.exercises.find((e) => e.item.id === id))

/* exactOptionalPropertyTypes: optional fields clear by OMISSION, never by an
 * explicit `undefined`. */
const dropError = (m: MathModel): MathModel => {
  const { lastError: _e, ...rest } = m
  return rest
}
const dropCurrent = (m: MathModel): MathModel => {
  const { currentId: _c, ...rest } = m
  return rest
}

const isFresh = (e: ExerciseState): boolean => e.verdict === "fresh" || e.verdict === "wrong"

/** Fresh exercises waiting beyond the current one (drives Next + auto-refill). */
export const unservedCount = (m: MathModel): number =>
  m.exercises.filter((e) => e.verdict === "fresh" && e.item.id !== m.currentId).length

export const canNext = (m: MathModel): boolean => unservedCount(m) > 0

/**
 * Fold a `render_math` batch in: upsert exercises by id, replace the note,
 * clear the pending/error machinery, and serve the first exercise when nothing
 * is on screen. Also flips `started` (content exists ⇒ practice is running —
 * covers replay, where items may precede our knowledge of the action).
 */
interface PutFold {
  readonly exercises: ReadonlyArray<ExerciseState>
  readonly note: string | undefined
  readonly added: number
}

export const putItems = (m: MathModel, items: ReadonlyArray<MathItem>): MathModel => {
  const folded = items.reduce<PutFold>(
    (acc, item) => {
      if (item.kind === "note") return { ...acc, note: item.text }
      const idx = acc.exercises.findIndex((e) => e.item.id === item.id)
      return idx >= 0
        ? { ...acc, exercises: acc.exercises.map((e, i) => (i === idx ? { ...e, item } : e)) }
        : {
            ...acc,
            exercises: [...acc.exercises, { item, attempts: 0, verdict: "fresh" }],
            added: acc.added + 1,
          }
    },
    { exercises: m.exercises, note: m.note, added: 0 },
  )
  const { exercises, note, added } = folded
  const current =
    m.currentId !== undefined && exercises.some((e) => e.item.id === m.currentId)
      ? m.currentId
      : exercises.find((e) => e.verdict === "fresh")?.item.id
  const base = added > 0 ? dropError(m) : m
  return {
    ...base,
    exercises,
    ...(note !== undefined ? { note } : {}),
    ...(current !== undefined ? { currentId: current } : {}),
    started: m.started || exercises.length > 0,
    setupOpen: false,
    acceptedThisTurn: m.acceptedThisTurn + added,
  }
}

export interface GradeOutcome {
  readonly model: MathModel
  /** False when the exercise doesn't exist / is already done (no-op). */
  readonly graded: boolean
}

/** Instant server grading: attempts++, verdict, echo; a correct answer counts
 *  toward `solved` and records its progress entry immediately. */
export const applyGrade = (m: MathModel, exId: string, raw: string): GradeOutcome => {
  const found = findExercise(m, exId)
  if (Option.isNone(found)) return { model: m, graded: false }
  const ex = found.value
  if (ex.verdict === "correct" || ex.verdict === "revealed" || ex.verdict === "reported") {
    return { model: m, graded: false }
  }
  const result = gradeAnswer(ex.item.answer, raw)
  const attempts = ex.attempts + 1
  const verdict: Verdict = result.correct ? "correct" : "wrong"
  // A choice answer echoes its LABEL — the id ("a") means nothing to a student.
  const echo =
    ex.item.answer.kind === "choice"
      ? (ex.item.choices ?? []).find(
          (c) => c.id.trim().toLowerCase() === result.normalized.trim().toLowerCase(),
        )?.label ?? result.normalized
      : result.normalized
  const exercises = m.exercises.map((e) =>
    e.item.id === exId ? { ...e, attempts, verdict, lastAnswer: echo } : e,
  )
  return {
    model: {
      ...m,
      exercises,
      solved: m.solved + (result.correct ? 1 : 0),
      pendingProgress: result.correct
        ? [...m.pendingProgress, { ex: exId, result: "correct", attempts }]
        : m.pendingProgress,
    },
    graded: true,
  }
}

/** Give up on the current exercise's answer: show the solution, record it. */
export const applyReveal = (m: MathModel, exId: string): MathModel => {
  const found = findExercise(m, exId)
  if (Option.isNone(found)) return m
  const ex = found.value
  if (!isFresh(ex)) return m
  return {
    ...m,
    exercises: m.exercises.map((e) => (e.item.id === exId ? { ...e, verdict: "revealed" } : e)),
    pendingProgress: [
      ...m.pendingProgress,
      { ex: exId, result: "revealed", attempts: ex.attempts },
    ],
  }
}

/** Dispute an exercise (likely a wrong key): exclude it, move on instantly,
 *  and carry the evidence to the tutor. */
export const applyReport = (m: MathModel, exId: string): MathModel => {
  const found = findExercise(m, exId)
  if (Option.isNone(found)) return m
  const ex = found.value
  if (ex.verdict === "reported") return m
  const marked: MathModel = {
    ...m,
    exercises: m.exercises.map((e) => (e.item.id === exId ? { ...e, verdict: "reported" } : e)),
    // A reported-but-solved exercise stops counting toward solved.
    solved: ex.verdict === "correct" ? m.solved - 1 : m.solved,
    pendingProgress: [
      ...m.pendingProgress,
      {
        ex: exId,
        result: "reported",
        attempts: ex.attempts,
        ...(ex.lastAnswer !== undefined ? { student: ex.lastAnswer } : {}),
        key: ex.item.answer.value,
      },
    ],
  }
  return m.currentId === exId ? advance(marked) : marked
}

/**
 * Move to the next fresh exercise. Leaving a wrong-in-progress exercise counts
 * as giving up (it never re-serves — one-at-a-time has no back button), so its
 * progress entry records honestly.
 */
export const advance = (m: MathModel): MathModel => {
  const cur =
    m.currentId !== undefined
      ? Option.getOrUndefined(findExercise(m, m.currentId))
      : undefined
  const abandoned =
    cur !== undefined && cur.verdict === "wrong"
      ? [{ ex: cur.item.id, result: "wrong" as const, attempts: cur.attempts, gaveUp: true }]
      : []
  const exercises =
    abandoned.length > 0
      ? m.exercises.map((e) => (e.item.id === m.currentId ? { ...e, verdict: "revealed" as Verdict } : e))
      : m.exercises
  const next = exercises.find((e) => e.verdict === "fresh" && e.item.id !== m.currentId)
  return {
    ...m,
    exercises,
    ...(next !== undefined ? { currentId: next.item.id } : {}),
    pendingProgress: [...m.pendingProgress, ...abandoned],
  }
}

export const openSetup = (m: MathModel): MathModel => ({ ...m, setupOpen: true })

export const closeSetup = (m: MathModel): MathModel => ({ ...m, setupOpen: false })

/** Switch grade/theme: unserved exercises drop (they're for the old topic),
 *  answered history stays for the record. */
export const applyTopic = (
  m: MathModel,
  grade: number | undefined,
  theme: string | undefined,
): MathModel => ({
  ...dropError(dropCurrent(m)),
  ...(grade !== undefined ? { grade } : {}),
  ...(theme !== undefined && theme !== "" ? { theme } : {}),
  started: true,
  setupOpen: false,
  exercises: m.exercises.filter((e) => e.verdict !== "fresh"),
})

export const setGenerating = (m: MathModel, generating: boolean): MathModel => ({
  ...(generating ? dropError(m) : m),
  generating,
  ...(generating ? { acceptedThisTurn: 0 } : {}),
})

export const setError = (m: MathModel, message: string, detail?: string): MathModel => ({
  ...m,
  generating: false,
  lastError: { message, ...(detail !== undefined && detail !== "" ? { detail } : {}) },
})

/** Take the unreported results (they ride the next agent-bound message). */
export const drainProgress = (m: MathModel): readonly [ReadonlyArray<ProgressEntry>, MathModel] =>
  [m.pendingProgress, { ...m, pendingProgress: [] }] as const

export type MathPatch = "header" | "stage" | "note" | "controls"

export const ALL_PATCHES: ReadonlyArray<MathPatch> = ["header", "stage", "note", "controls"]
