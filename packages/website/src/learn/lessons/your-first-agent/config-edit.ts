// The controls edit the learner's agent text in place, so the code and the
// controls never disagree. A line the learner rewrote beyond recognition is
// left alone (the setter returns None) rather than guessed at.
import { Option, Schema } from "effect"

const patterns = {
  system: /(system:\s*)("(?:[^"\\\n]|\\.)*")/,
  budgetTokens: /(budgetTokens:\s*)(\d[\d_]*)/,
} as const

/** The memory line: `windowMemory({ ... })` or `lastMessages({ ... })`. */
const memoryCall = /\b(windowMemory|lastMessages)\(\{([^}]*)\}\)/

/** Which memory the agent uses: the stock window, or the learner's own (the last message only, as the picker sets it). */
export type MemoryChoice = "window" | "last"

export type ControlKey = "system" | "budgetTokens" | "memory"

export interface Controls {
  readonly system?: string
  readonly budgetTokens?: number
  readonly memory?: MemoryChoice
}

/** A string literal as written (the controls write it with JSON.stringify), read back. */
const quoted = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))

const budgetOf = (source: string): Option.Option<number> =>
  Option.map(Option.fromNullishOr(patterns.budgetTokens.exec(source)?.[2]), (digits) => Number(digits.replaceAll("_", "")))

export const readControls = (source: string): Controls => {
  const system = Option.flatMap(Option.fromNullishOr(patterns.system.exec(source)?.[2]), quoted)
  const memory = Option.map(Option.fromNullishOr(memoryCall.exec(source)?.[1]), (call): MemoryChoice => call === "lastMessages" ? "last" : "window")
  return {
    ...Option.match(system, { onNone: () => ({}), onSome: (value) => ({ system: value }) }),
    ...Option.match(budgetOf(source), { onNone: () => ({}), onSome: (value) => ({ budgetTokens: value }) }),
    ...Option.match(memory, { onNone: () => ({}), onSome: (value) => ({ memory: value }) }),
  }
}

/** The memory line for a choice, keeping the budget the agent already has. */
const memoryLine = (choice: MemoryChoice, budget: number): string =>
  choice === "last" ? `lastMessages({ n: 1, budgetTokens: ${budget} })` : `windowMemory({ budgetTokens: ${budget} })`

/** The new source, or None when the line cannot be found in it. */
export const setField = (source: string, key: ControlKey, value: string | number): Option.Option<string> => {
  if (key === "memory") {
    if (!memoryCall.test(source) || (value !== "window" && value !== "last")) return Option.none()
    const budget = Option.getOrElse(budgetOf(source), () => 3000)
    return Option.some(source.replace(memoryCall, memoryLine(value, budget)))
  }
  const pattern = patterns[key]
  const literal = key === "system" ? JSON.stringify(String(value)) : String(value)
  return pattern.test(source) ? Option.some(source.replace(pattern, (_all, head: string) => `${head}${literal}`)) : Option.none()
}

/** The agent without its memory line: what the "remove the memory" experiment leaves. */
export const withoutMemory = (source: string): Option.Option<string> => {
  const line = /\n[ \t]*Layer\.provideMerge\((?:windowMemory|lastMessages)\([^\n]*/
  return line.test(source) ? Option.some(source.replace(line, "")) : Option.none()
}

/** The budget the "raise" button offers after a refusal: above the budget that refused and twice the estimate, at least 100, rounded up to tens. */
export const raisedBudget = (refused: { readonly budgetTokens: number; readonly estimatedTokens: number }): number =>
  Math.ceil(Math.max(100, refused.budgetTokens * 2, refused.estimatedTokens * 2) / 10) * 10
