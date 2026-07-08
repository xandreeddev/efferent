import { Either, Schema } from "effect"
import { sanitizeMathml } from "@xandreed/surface"

/**
 * The structured content vocabulary of the `efferent math` surface. The math
 * agent never authors HTML — it emits these items through the `render_math`
 * tool, and the driver renders them through server-owned design-system
 * components. Each exercise is SELF-CONTAINED: it carries its answer key, a
 * hint, and a worked solution at generation time, so the server grades a
 * student's answer instantly (pure functions below) with no model round-trip.
 */

/** One step of a worked solution. */
export const MathStep = Schema.Struct({
  text: Schema.String.annotations({
    description: "One step of the worked solution, in plain student-facing language.",
  }),
  mathml: Schema.optional(Schema.String).annotations({
    description: "Optional presentation MathML for this step (a single <math> element).",
  }),
})
export type MathStep = typeof MathStep.Type

/** One option of a multiple-choice exercise. */
export const MathChoice = Schema.Struct({
  id: Schema.String.annotations({
    description: "Short stable id for this option (e.g. 'a', 'b').",
  }),
  label: Schema.String.annotations({
    description: "The option's text (plain text / unicode math).",
  }),
  mathml: Schema.optional(Schema.String).annotations({
    description: "Optional presentation MathML shown instead of the plain label.",
  }),
})
export type MathChoice = typeof MathChoice.Type

/**
 * The answer key — the grading contract. `value` is ALWAYS a string ("42",
 * "3.5", "3/4", "isosceles", or the correct choice id); the input control the
 * student sees is derived from `kind`, so the key and the control can never
 * contradict each other.
 */
export const MathAnswer = Schema.Struct({
  kind: Schema.Literal("integer", "decimal", "fraction", "text", "choice").annotations({
    description:
      "What the student types: integer / decimal / fraction get a number-ish field, " +
      "text a free field, choice a tap-one option group.",
  }),
  value: Schema.String.annotations({
    description:
      "The correct answer, as a string: '42', '3.5', '3/4', 'isosceles', or the correct " +
      "choice id. MUST be arithmetically correct — the server grades with it verbatim.",
  }),
  tolerance: Schema.optional(Schema.Number).annotations({
    description: "decimal only: accept answers within this absolute distance (default 0).",
  }),
  accept: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: "Extra accepted forms of the same answer (e.g. ['0.75'] for value '3/4').",
  }),
})
export type MathAnswer = typeof MathAnswer.Type

export const MathExercise = Schema.Struct({
  kind: Schema.Literal("exercise"),
  id: Schema.String.annotations({
    description: "Unique in this session, e.g. 'ex-7'. Never reuse an id for a new exercise.",
  }),
  prompt: Schema.String.annotations({
    description:
      "The question, in student-facing words (unicode inline math ok). Always complete and " +
      "answerable on its own — never a placeholder.",
  }),
  mathml: Schema.optional(Schema.String).annotations({
    description:
      "The display equation as ONE presentation-MathML <math> element (mfrac/msup/msqrt/mtable…). " +
      "No LaTeX, no HTML, no SVG.",
  }),
  choices: Schema.optional(Schema.Array(MathChoice)).annotations({
    description: "Required when answer.kind is 'choice': 2-5 options; exactly one is correct.",
  }),
  answer: MathAnswer,
  hint: Schema.String.annotations({
    description: "Shown after the first wrong attempt: a nudge toward the method, NOT the answer.",
  }),
  solution: Schema.Array(MathStep).annotations({
    description: "The complete worked solution, step by step (shown after the second wrong attempt).",
  }),
  difficulty: Schema.optional(
    Schema.Literal("intro", "easy", "medium", "hard", "challenge"),
  ).annotations({ description: "Relative difficulty tag — used to show progression." }),
})
export type MathExercise = typeof MathExercise.Type

/** A one-line coach note shown above the exercise card (replaces the previous note). */
export const MathNote = Schema.Struct({
  kind: Schema.Literal("note"),
  text: Schema.String.annotations({
    description: "One short line from the tutor (an encouragement, a correction after a report).",
  }),
})
export type MathNote = typeof MathNote.Type

export const MathItem = Schema.Union(MathExercise, MathNote)
export type MathItem = typeof MathItem.Type

// ---------------------------------------------------------------------------
// Per-item validation — one bad exercise never loses the batch.
// ---------------------------------------------------------------------------

export interface RejectedMathItem {
  readonly index: number
  readonly id?: string
  readonly reason: string
}

export interface ParsedMathItems {
  readonly accepted: ReadonlyArray<MathItem>
  readonly rejected: ReadonlyArray<RejectedMathItem>
}

const decodeItem = Schema.decodeUnknownEither(MathItem)

const firstLine = (s: string): string => {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? s
  return line.trim().slice(0, 200)
}

/**
 * Validate a `render_math` payload item by item: structural decode plus the
 * semantic invariants Schema can't express (a choice key must reference an
 * existing option, numeric keys must parse, ids must be unique in the call).
 * Used identically by the tool handler, the replay path, and the evals — so
 * what the model gets away with live is exactly what replays later.
 */
export const parseMathItems = (
  input: unknown,
  sessionSeen: ReadonlySet<string> = new Set(),
): ParsedMathItems => {
  const items = Array.isArray(input) ? input : []
  const accepted: Array<MathItem> = []
  const rejected: Array<RejectedMathItem> = []
  const seenIds = new Set<string>()
  const noteSeen = (): boolean => accepted.some((a) => a.kind === "note")
  items.forEach((raw, index) => {
    const decoded = decodeItem(raw)
    if (Either.isLeft(decoded)) {
      const id =
        typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
          ? { id: (raw as { id: string }).id }
          : {}
      rejected.push({ index, ...id, reason: firstLine(String(decoded.left)) })
      return
    }
    const item = decoded.right
    if (item.kind === "note") {
      if (noteSeen()) {
        rejected.push({ index, reason: "only one note per call — merge them into one line" })
        return
      }
      if (item.text.trim().length === 0) {
        rejected.push({ index, reason: "note.text is empty" })
        return
      }
      accepted.push(item)
      return
    }
    const reason = validateExercise(item, seenIds, sessionSeen)
    if (reason !== undefined) {
      rejected.push({ index, id: item.id, reason })
      return
    }
    seenIds.add(item.id)
    accepted.push(item)
  })
  return { accepted, rejected }
}

/** `undefined` = the mathml is fine (absent, or strictly valid). */
const mathmlProblem = (mathml: string | undefined, where: string): string | undefined =>
  mathml === undefined || mathml.trim() === "" || sanitizeMathml(mathml).ok
    ? undefined
    : `${where} mathml was rejected by the strict sanitizer — use presentation MathML only (one well-formed <math> root, layout elements/attributes, no semantics/annotation/scripts) or omit the mathml field`

const validateExercise = (
  ex: MathExercise,
  seenIds: ReadonlySet<string>,
  sessionSeen: ReadonlySet<string>,
): string | undefined => {
  if (ex.id.trim().length === 0) return "exercise id is empty"
  if (seenIds.has(ex.id)) return `duplicate exercise id '${ex.id}' in this call`
  if (sessionSeen.has(ex.id)) {
    return `exercise id '${ex.id}' was already served this session — write a NEW exercise with a new id`
  }
  const mathml =
    mathmlProblem(ex.mathml, "the exercise") ??
    (ex.choices ?? [])
      .map((c) => mathmlProblem(c.mathml, `choice '${c.id}'`))
      .find((r) => r !== undefined) ??
    ex.solution
      .map((s, i) => mathmlProblem(s.mathml, `solution step ${i + 1}`))
      .find((r) => r !== undefined)
  if (mathml !== undefined) return mathml
  if (ex.prompt.trim().length === 0) return "prompt is empty"
  if (/[?]\s*\/\s*[?]|\?\?/.test(ex.prompt)) return "prompt contains placeholder '?' content"
  // There is NO picture on this surface (MathML can't draw shapes) — a prompt
  // that references one is unanswerable as written.
  if (/\b(shaded|diagram|figure|picture|image|graph below|shown (?:below|above))\b/i.test(ex.prompt)) {
    return "prompt references a picture/diagram that cannot be shown — ask something answerable from the text and MathML alone"
  }
  if (ex.hint.trim().length === 0) return "hint is empty"
  if (ex.solution.length === 0) return "solution has no steps"
  if (ex.solution.some((s) => s.text.trim().length === 0)) return "a solution step is empty"
  if (ex.answer.value.trim().length === 0) return "answer.value is empty"
  switch (ex.answer.kind) {
    case "choice": {
      const choices = ex.choices ?? []
      if (choices.length < 2) return "answer.kind 'choice' needs at least 2 choices"
      const ids = choices.map((c) => c.id.trim())
      if (new Set(ids).size !== ids.length) return "choice ids are not unique"
      if (!ids.includes(ex.answer.value.trim())) {
        return `answer.value '${ex.answer.value}' is not one of the choice ids (${ids.join(", ")})`
      }
      return undefined
    }
    case "integer": {
      const n = parseNumeric(ex.answer.value)
      if (n === undefined || !isIntegral(n)) {
        return `answer.value '${ex.answer.value}' is not an integer`
      }
      return undefined
    }
    case "decimal": {
      if (parseNumeric(ex.answer.value) === undefined) {
        return `answer.value '${ex.answer.value}' is not a number`
      }
      return undefined
    }
    case "fraction": {
      if (parseRational(ex.answer.value) === undefined) {
        return `answer.value '${ex.answer.value}' is not a fraction or number`
      }
      return undefined
    }
    case "text":
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Grading — pure, total, instant.
// ---------------------------------------------------------------------------

export interface GradeResult {
  readonly correct: boolean
  /** The canonical echo of what the student's input parsed to (for display). */
  readonly normalized: string
}

const EPSILON = 1e-9

/** "3.5" / "3,5" / " 1 234 " → number; undefined when it isn't one. */
const parseNumeric = (raw: string): number | undefined => {
  const t = raw.trim().replace(/\s+/g, "").replace(",", ".")
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

const isIntegral = (n: number): boolean => Math.abs(n - Math.round(n)) <= EPSILON

interface Rational {
  readonly num: number
  readonly den: number
}

/** "3/4", "-3/4", mixed "1 1/2", or any plain number → a rational (den 1 scaled
 *  for decimals). undefined when unparseable or the denominator is zero. */
const parseRational = (raw: string): Rational | undefined => {
  const t = raw.trim().replace(",", ".")
  const mixed = /^(-?)(\d+)\s+(\d+)\s*\/\s*(\d+)$/.exec(t)
  if (mixed !== null) {
    const sign = mixed[1] === "-" ? -1 : 1
    const whole = Number(mixed[2])
    const num = Number(mixed[3])
    const den = Number(mixed[4])
    if (den === 0) return undefined
    return { num: sign * (whole * den + num), den }
  }
  const frac = /^([+-]?\d+)\s*\/\s*([+-]?\d+)$/.exec(t)
  if (frac !== null) {
    const num = Number(frac[1])
    const den = Number(frac[2])
    if (den === 0) return undefined
    return den < 0 ? { num: -num, den: -den } : { num, den }
  }
  const dec = parseNumeric(t)
  if (dec === undefined) return undefined
  // Scale a decimal to an exact rational over a power of ten ("0.75" → 75/100).
  const m = /^[+-]?\d*\.(\d+)$/.exec(t)
  const places = m !== null ? m[1]!.length : 0
  const den = 10 ** Math.min(places, 12)
  return { num: Math.round(dec * den), den }
}

const rationalsEqual = (a: Rational, b: Rational): boolean => a.num * b.den === b.num * a.den

const normalizeText = (raw: string): string =>
  raw.normalize("NFC").toLowerCase().trim().replace(/\s+/g, " ").replace(/\.$/, "")

const matchesKey = (answer: MathAnswer, keyValue: string, raw: string): boolean => {
  switch (answer.kind) {
    case "integer": {
      const got = parseNumeric(raw)
      const want = parseNumeric(keyValue)
      return got !== undefined && want !== undefined && isIntegral(got) &&
        Math.abs(got - want) <= EPSILON
    }
    case "decimal": {
      const got = parseNumeric(raw)
      const want = parseNumeric(keyValue)
      if (got === undefined || want === undefined) return false
      return Math.abs(got - want) <= (answer.tolerance ?? 0) + EPSILON
    }
    case "fraction": {
      const got = parseRational(raw)
      const want = parseRational(keyValue)
      return got !== undefined && want !== undefined && rationalsEqual(got, want)
    }
    case "text":
      return normalizeText(raw) === normalizeText(keyValue)
    case "choice":
      return raw.trim().toLowerCase() === keyValue.trim().toLowerCase()
  }
}

/**
 * Grade a student's raw input against an exercise's answer key. Total — an
 * unparseable input is simply wrong, never an error. Fraction keys accept any
 * equivalent form (2/8 ≡ 1/4 ≡ 0.25); `accept` entries are alternate keys
 * checked with the same kind semantics.
 */
export const gradeAnswer = (answer: MathAnswer, raw: string): GradeResult => {
  const correct =
    matchesKey(answer, answer.value, raw) ||
    (answer.accept ?? []).some((alt) => matchesKey(answer, alt, raw))
  return { correct, normalized: normalizeEcho(answer, raw) }
}

const normalizeEcho = (answer: MathAnswer, raw: string): string => {
  switch (answer.kind) {
    case "integer":
    case "decimal": {
      const n = parseNumeric(raw)
      return n === undefined ? raw.trim() : String(n)
    }
    case "fraction": {
      const r = parseRational(raw)
      if (r === undefined) return raw.trim()
      return r.den === 1 ? String(r.num) : `${r.num}/${r.den}`
    }
    case "text":
    case "choice":
      return raw.trim()
  }
}
