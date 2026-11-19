// The controls and experiments edit the learner's code in place, so the
// code and the controls never disagree. A line the learner rewrote beyond
// recognition is left alone (None) rather than guessed at.
import { Option, Schema } from "effect"

/**
 * `const system = "…"` in agent.ts, on one line or as Format wraps a long one: `const system =`, then the string on
 * the next line. The string is written where it stands, so the code keeps the form it has.
 */
const systemLine = /(const system =\s*)("(?:[^"\\\n]|\\.)*")/

/** A string literal as written (the controls write it with JSON.stringify), read back. */
const quoted = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))

export const readSystem = (agent: string): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(systemLine.exec(agent)?.[2]), quoted)

export const writeSystem = (agent: string, text: string): Option.Option<string> =>
  systemLine.test(agent) ? Option.some(agent.replace(systemLine, (_all, head: string) => `${head}${JSON.stringify(text)}`)) : Option.none()

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, to)) : Option.none()

/** A reminder sent after the context in every prompt, never stored. */
export const withReminder = swap(
  `const prompt = Prompt.make([{ role: "system", content: system }, ...history])`,
  `const prompt = Prompt.make([
        { role: "system", content: system },
        ...history,
        // A reminder after the context: sent every time, stored never.
        { role: "user", content: "Answer in one sentence." },
      ])`,
)

/** The reply shown in capitals; what is stored stays as the model wrote it. */
export const shouting = swap("      return answer\n", "      return answer.toUpperCase()\n")

/** main without its memory module. */
export const withoutMemory = (agent: string): Option.Option<string> => {
  const line = /\n[ \t]*Effect\.provide\(flatMemory\),[^\n]*/
  return line.test(agent) ? Option.some(agent.replace(line, "")) : Option.none()
}
