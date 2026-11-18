// Lesson 18's controls and experiments edit the learner's memory.ts in
// place, so the code and the buttons never disagree. The controls each read
// and write one option of the `withGraph({ … })(flatMemory)` call, a line of
// its own; an experiment swaps the whole statement. A piece the learner
// rewrote beyond recognition is left alone (None) rather than guessed at.
// A value the kernel does not take (hops 4, a limit of 0) is written as it
// is: withGraph refuses it in its own words when the file runs.
import { Option } from "effect"
import type { LessonControl } from "../../lesson.ts"
import { HOPS_LINE, WRAPPED } from "./memory.source.ts"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, () => to)) : Option.none()

/** The one call of memory.ts, its options a line each between `withGraph({` and `})(flatMemory)`. */
const CALL = /^export const memory = withGraph\(\{\n((?:.*\n)*?)\}\)\(flatMemory\)$/m

/** The call's option lines, comments included, and how to write the file with other ones; None when the call is not there. */
const optionsOf = (source: string): Option.Option<{ readonly lines: ReadonlyArray<string>; readonly with: (lines: ReadonlyArray<string>) => string }> =>
  Option.map(Option.fromNullishOr(CALL.exec(source)), (found) => ({
    lines: (found[1] ?? "").split("\n").slice(0, -1),
    with: (lines) => source.replace(CALL, () => `export const memory = withGraph({\n${lines.map((line) => `${line}\n`).join("")}})(flatMemory)`),
  }))

/** A whole number's option (`  hops: 2,`), read and written in place. */
const numberControl = (name: string): LessonControl => {
  const line = new RegExp(`^  ${name}: (\\d+),$`)
  return {
    file: "memory",
    read: (source) => Option.flatMap(optionsOf(source), ({ lines }) => Option.firstSomeOf(lines.map((one) => Option.map(Option.fromNullishOr(line.exec(one)), (found) => Number(found[1]))))),
    write: (source, value) => Option.flatMap(optionsOf(source), (call) => {
      const at = call.lines.findIndex((one) => line.test(one))
      return at < 0 ? Option.none() : Option.some(call.with(call.lines.map((one, index) => (index === at ? `  ${name}: ${String(value)},` : one))))
    }),
  }
}

/** The comment memory.ts writes over the `names` line. */
export const NAMES_COMMENT = "  // How a question names a thing: also by a word one letter away, or without accent marks."
/** The comment memory.ts writes over the `weights` line. */
export const WEIGHTS_COMMENT = "  // How links the question's words leave tied are weighed: the heavier first."

const NAMES = /^  names: "(exact|loose)",$/
const WEIGHTS = /^  weights: (?:"(count)"|\{ halfLifeDays: (\d+) \}),$/

/**
 * The call's lines with one option set: its line, and the comment over it, taken out, and put back last when
 * `line` is given, so `names` comes before `weights` as the page writes them.
 */
const withOption = (lines: ReadonlyArray<string>, pattern: RegExp, comment: string, line: Option.Option<string>): ReadonlyArray<string> => {
  const kept = lines.filter((one, index) => !pattern.test(one) && !(one === comment && pattern.test(lines[index + 1] ?? "")))
  const weightsAt = kept.findIndex((one) => WEIGHTS.test(one) || one === WEIGHTS_COMMENT)
  const added = Option.match(line, { onNone: () => [], onSome: (text) => [comment, text] })
  // The names line goes before the weights line, where there is one; anything else goes last.
  return pattern === NAMES && weightsAt >= 0 ? [...kept.slice(0, weightsAt), ...added, ...kept.slice(weightsAt)] : [...kept, ...added]
}

/** The `names` control: "exact" (no line: the kernel's default) or "loose". */
export const namesControl: LessonControl = {
  file: "memory",
  read: (source) => Option.map(optionsOf(source), ({ lines }) => Option.getOrElse(Option.firstSomeOf(lines.map((one) => Option.map(Option.fromNullishOr(NAMES.exec(one)), (found) => found[1] ?? "exact"))), () => "exact")),
  write: (source, value) => Option.flatMap(optionsOf(source), (call) =>
    value === "exact" || value === "loose"
      ? Option.some(call.with(withOption(call.lines, NAMES, NAMES_COMMENT, value === "loose" ? Option.some('  names: "loose",') : Option.none())))
      : Option.none()),
}

/** The `weights` control: "none" (no line), "count", or a half-life in days, written `{ halfLifeDays: 365 }`. */
export const weightsControl: LessonControl = {
  file: "memory",
  read: (source) => Option.map(optionsOf(source), ({ lines }) => Option.getOrElse(Option.firstSomeOf(lines.map((one) => Option.map(Option.fromNullishOr(WEIGHTS.exec(one)), (found) => found[1] ?? found[2] ?? "none"))), () => "none")),
  write: (source, value) => Option.flatMap(optionsOf(source), (call) => {
    const text = String(value)
    const line = text === "none" ? Option.some(Option.none<string>())
      : text === "count" ? Option.some(Option.some('  weights: "count",'))
        : /^\d+$/.test(text) ? Option.some(Option.some(`  weights: { halfLifeDays: ${text} },`)) : Option.none()
    return Option.map(line, (one) => call.with(withOption(call.lines, WEIGHTS, WEIGHTS_COMMENT, one)))
  }),
}

/** The four controls of the page, by `data-control` key: each writes one line of memory.ts's call. */
export const CONTROLS: Readonly<Record<string, LessonControl>> = {
  hops: numberControl("hops"),
  limit: numberControl("limit"),
  names: namesControl,
  weights: weightsControl,
}

/** memory.ts walking one link at most: the starter with `hops: 1`. */
export const HOPS_ONE = WRAPPED.replace(HOPS_LINE, HOPS_LINE.replace("hops: 2,", "hops: 1,"))

/** The `hops-one` experiment: a walk of one link. */
export const hopsOne = swap(WRAPPED, HOPS_ONE)

/** memory.ts with a wrapper of the learner's own, over the kernel's parts, that ranks the links by distance alone. */
export const BY_DISTANCE = `// A wrapper of your own, written over the kernel's parts: the walk is asked with the names the
// question holds, and no other of its words. With no word left to rank by, the links are ranked
// by how many links away they are, then the newest first.
const speaker = { name: "user", words: ["i", "me", "my"] }
const byDistance = (inner) =>
  Layer.effect(
    Memory,
    Effect.gen(function* () {
      const below = yield* Memory // the memory it wraps
      const sessions = yield* Sessions
      return Memory.of({
        context: (session) =>
          Effect.gen(function* () {
            const context = yield* below.context(session)
            // The links that stand, each with how often it was said, read from the graph session.
            const said = yield* Effect.provideService(saidLinks, Sessions, sessions)
            const links = said.map((one) => one.link)
            // The things your last message names, as one text of their names alone.
            const question = questionOf(yield* session.journal)
            const names = namedIn(links, question, Option.some(speaker)).join(" ")
            // The walk from them, two links away, and its first five links, each with how often and
            // when it was said: what the note writes beside it.
            const options = { hops: 2, limit: 5 }
            const walk = walked(links, names, options)
            const chosen = walk.reached
              .slice(0, options.limit)
              .flatMap((one) => said.filter((entry) => entry.link.id === one.link.id))
            // What the walk did, said for the Graph tab as withGraph says it. Should a listener
            // fail, the request goes on: the failure is logged, and nothing else.
            yield* session
              .publish(recalledEvent, recalledOf(names, options, walk, said))
              .pipe(Effect.ignoreCause({ log: "Warn", message: "the walk could not be said" }))
            if (chosen.length === 0) return context
            return [...context, { role: "user", content: linksNote(chosen) }]
          }),
      })
    }),
  ).pipe(Layer.provide(inner))

export const memory = byDistance(flatMemory)`

/** The `by-distance` experiment: the learner's own wrapper in place of the kernel's. */
export const byDistance = swap(WRAPPED, BY_DISTANCE)

/** memory.ts with no wrapper: the kernel's flat memory as it is. */
export const FOLLOW_ONLY = `// No wrapper: each request is sent the conversation alone. The links are still stored, and the
// model is sent none of them unless it calls followThings.
export const memory = flatMemory`

/** The `follow-only` experiment: the wrapper goes. */
export const followOnly = swap(WRAPPED, FOLLOW_ONLY)

/** One chip of a choice the page offers (names, weights): the value its control writes, its label, and the note under it. */
export interface Chip {
  readonly value: string
  readonly label: string
  readonly note: string
}

/** The chips of the `names` control, each with its note; lesson.test.ts pins what each note says. */
export const NAMES_CHIPS: ReadonlyArray<Chip> = [
  { value: "exact", label: "exact", note: 'By its own words, side by side in the question: "Eva Nowak" names the Eva of the first half alone.' },
  { value: "loose", label: "loose", note: 'Also by a word of five letters or more one letter away, or the same without accent marks: "Nowak" names Eva Novak.' },
]

/** The chips of the `weights` control, each with its note; lesson.test.ts pins what each note says. */
export const WEIGHTS_CHIPS: ReadonlyArray<Chip> = [
  { value: "none", label: "none", note: "Ties go to the link stored last. Bruno's pizza, said three times, ranks 6th." },
  { value: "count", label: "count", note: "ln(1 + the turns that said it): Bruno's pizza ranks 1st, and so does Eva Novak's old employer, said three times." },
  { value: "30", label: "30 days", note: "Halves every 30 days, so how recently a link was said decides: Eva Novak's current employer 1st, Bruno's pizza 3rd." },
  { value: "365", label: "365 days", note: "Halves every year: Eva Novak's current employer 1st, and Bruno's pizza 1st." },
  { value: "730", label: "730 days", note: "Halves every two years: Eva Novak's old employer, said three times, 1st again." },
]
