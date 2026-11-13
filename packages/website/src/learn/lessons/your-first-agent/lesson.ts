// Lesson 1, "Your first agent": the learner edits the layers above a shared
// base (agent.ts) and writes a memory of their own (tiny-memory.ts).
import { Effect, Layer, Option, Result } from "effect"
import { messageOf, readerFor, readJournal } from "@xandreed/core/kernel"
import { estimateRequest, inbox, LOOP_READER, Memory, OverBudget, settings, Settings, stepLoop, Tokens, windowMemory } from "@xandreed/sdk/kernel"
import { checkedLayer, run } from "../../evaluate.ts"
import type { Lesson } from "../../lesson.ts"
import { BASE, DEFAULT_AGENT, HEADER, IMPORTS, programOf, RUN_START_MARK } from "./agent.source.ts"
import { DEFAULT_TINY, TINY_INTRO, tinyProgramOf } from "./tiny-memory.source.ts"
import { raisedBudget, readControls, setField, withoutMemory } from "./config-edit.ts"

/** The names tiny-memory.ts imports: all its code may use. */
export const tinyNames = { Effect, Layer, Option, messageOf, readerFor, readJournal, estimateRequest, LOOP_READER, Memory, OverBudget, Settings, Tokens }

/** The names agent.ts may use; `lastMessages` is the learner's own memory, when the agent uses it. */
const agentNames = (lastMessages: unknown) => ({
  Layer: checkedLayer("windowMemory({ budgetTokens: 3000 }), lastMessages({ n: 1, budgetTokens: 3000 })"),
  inbox, stepLoop, windowMemory, settings, lastMessages,
})

/** Evaluate the learner's memory file: a function that makes a memory layer. */
export const evaluateTiny = (source: string): Result.Result<unknown, string> => run("tiny-memory.ts did not run: ", source, tinyNames)

/** Evaluate agent.ts, and tiny-memory.ts first when the agent uses `lastMessages`, so a broken memory file never stops a window agent. */
export const evaluateAgent = (agent: string, tiny: string): Result.Result<unknown, string> => {
  const lastMessages = agent.includes("lastMessages") ? evaluateTiny(tiny) : Result.succeed(undefined)
  return Result.flatMap(lastMessages, (made) => run("agent.ts did not run: ", agent, agentNames(made)))
}

const control = (key: "system" | "budgetTokens" | "memory") => ({
  read: (source: string) => Option.fromNullishOr(readControls(source)[key]),
  write: (source: string, value: string | number) => setField(source, key, value),
})

export const yourFirstAgent: Lesson = {
  slug: "your-first-agent",
  files: [
    {
      id: "agent",
      label: "agent.ts",
      defaultText: DEFAULT_AGENT,
      documentOf: programOf,
      editableFrom: HEADER.length,
      formatPrefix: "const Agent = ",
      sections: [
        { id: "imports", label: "imports", range: () => ({ from: 0, to: IMPORTS.length }) },
        { id: "base", label: "the base, built once", range: () => ({ from: IMPORTS.length + 2, to: IMPORTS.length + 2 + BASE.length }) },
        {
          id: "run",
          label: "run: listen, then queue messages",
          range: (doc, editable) => {
            const from = doc.indexOf(RUN_START_MARK, editable.to)
            return { from: from < 0 ? doc.length : from, to: doc.length }
          },
        },
      ],
    },
    {
      id: "tiny",
      label: "tiny-memory.ts",
      defaultText: DEFAULT_TINY,
      documentOf: tinyProgramOf,
      editableFrom: TINY_INTRO.length,
      formatPrefix: "const lastMessages = ",
      sections: [],
    },
  ],
  mainFile: "agent",
  chips: ["Tell me about loops", "What did I just say?", "What is in your context?"],
  // The second and third turns can only answer from the turns before them.
  three: ["My name is Ana.", "What did I just say?", "What is in your context?"],
  // Step 6's fill: five short messages, queued at once.
  fill: ["tell me about topic 1", "tell me about topic 2", "tell me about topic 3", "tell me about topic 4", "tell me about topic 5"],
  controls: { system: control("system"), budgetTokens: control("budgetTokens"), memory: control("memory") },
  experiments: {
    pirate: (source) => setField(source, "system", "You are a pirate. Answer in at most two short sentences, and always say arr."),
    "no-memory": withoutMemory,
    "tiny-budget": (source) => setField(source, "budgetTokens", 5),
    "swap-memory": (source) => setField(source, "memory", readControls(source).memory === "last" ? "window" : "last"),
    "last-memory": (source) => setField(source, "memory", "last"),
    "window-memory": (source) => setField(source, "memory", "window"),
  },
  raisedBudget: (refused) => Option.some(raisedBudget(refused)),
  evaluate: (sources) => evaluateAgent(sources.agent ?? "", sources.tiny ?? ""),
}
