// Lesson 10, "Skills": instructions and tools the model is not sent until it
// asks. The base program over lesson 2's tools and memory, and one file
// more, skills.ts: two skills and the one value that holds them with the
// tools. The model reads a catalogue in the system text, loads a skill with
// a tool call, and the loop offers, at each step, what the journal says is
// loaded.
import { Effect, Layer, Option, Predicate, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { CONVERSATION_VOCABULARY, Core, messageOf, vocabularyOf, readJournal, Sessions, turnStartedEvent, userMessage } from "@xandreed/core"
import { callTool, defineSkill, Memory, modelAnswer, paired, promptMessage, skills } from "@xandreed/sdk"
import { named, programOf, run, runStatements } from "../../evaluate.ts"
import type { Lesson, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY, MEMORY_INTRO, memoryDocumentOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { alwaysOn, noCatalogue, noHandlers } from "./config-edit.ts"
import { DEFAULT_SKILLS, SKILLS_HEADER, SKILLS_IMPORTS, skillsBodyOf, skillsDocumentOf } from "./skills.source.ts"

const memoryNames = { Effect, Layer, Option, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Memory, paired, promptMessage }
const toolsNames = { Effect, Schema, Tool, Toolkit }
const skillsNames = (tools: unknown) => ({ Effect, Schema, Tool, Toolkit, defineSkill, skills, tools })

/** What skills.ts made, as agent.ts imports it: each value as it came. */
interface MadeSkills {
  readonly haiku: unknown
  readonly skillSet: unknown
  readonly units: unknown
  readonly unitsLive: unknown
}

const agentNames = (parts: PageParts, flatMemory: unknown, made: MadeSkills, toolsLive: unknown) => ({
  Effect, Stream, LanguageModel, Prompt,
  Core, Sessions, turnStartedEvent, userMessage, callTool, Memory, modelAnswer, Chat,
  kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
  flatMemory, haiku: made.haiku, skillSet: made.skillSet, units: made.units, unitsLive: made.unitsLive, toolsLive, pane: parts.pane, model: parts.model,
})

/**
 * Whether a value has what agent.ts reads of a skill set: the catalogue, a text; what to offer, a function; the
 * handler of `loadSkill`, a layer; and the whole toolkit. `skills(…)` makes one, and refuses in its own words what
 * makes none, so this only tells a value that never went through it.
 */
const isSkillSet = (value: unknown): boolean =>
  Predicate.hasProperty(value, "catalogue") && typeof value.catalogue === "string"
  && Predicate.hasProperty(value, "offered") && typeof value.offered === "function"
  && Predicate.hasProperty(value, "handlers") && Layer.isLayer(value.handlers)
  && Predicate.hasProperty(value, "toolkit") && Predicate.hasProperty(value.toolkit, "tools")

/** memory.ts, tools.ts, skills.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(run("memory.ts did not run: ", sources.memory ?? "", memoryNames), (memory) => {
    if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …).")
    return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (madeTools) => {
      const toolsLive = named(madeTools, "toolsLive")
      if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … }).")
      // skills.ts is statements: the set is made as the file runs, so skills `skills` refuses are refused here, as the build.
      return Result.flatMap(runStatements("skills.ts did not run: ", skillsBodyOf(sources.skills ?? ""), "{ haiku, skillSet, units, unitsLive }", skillsNames(named(madeTools, "tools"))), (madeSkills) => {
        const made: MadeSkills = { haiku: named(madeSkills, "haiku"), skillSet: named(madeSkills, "skillSet"), units: named(madeSkills, "units"), unitsLive: named(madeSkills, "unitsLive") }
        if (!isSkillSet(made.skillSet)) return Result.fail("skills.ts did not run: skillSet is not a skill set. It should be skills(tools, units, haiku).")
        if (!Layer.isLayer(made.unitsLive)) return Result.fail("skills.ts did not run: unitsLive is not a layer. It should be units.tools.toLayer({ … }).")
        return Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", agentNames(parts, parts.watchMemory(memory), made, toolsLive)), (main) =>
          // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
          programOf(main))
      })
    })
  })

/** Both skills loaded by name and a sum, which one turn takes together: three calls in one step, then one answer. */
const THREE = ["Load units.", "Load haiku.", "What is 2 + 3?"]

/** What the page's one `data-fill` button sends: a call of the units skill's tool before the skill is loaded. */
const UNLOADED = ["Use convert without loading."]

export const skillsLesson: Lesson = {
  slug: "skills",
  files: [
    {
      id: "skills", label: "skills.ts", defaultText: DEFAULT_SKILLS, documentOf: skillsDocumentOf, editableFrom: SKILLS_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: SKILLS_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    {
      id: "agent", label: "agent.ts", defaultText: DEFAULT_AGENT, documentOf, editableFrom: HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: IMPORTS.length }) }], folded: ["imports"], readOnly: false,
    },
    {
      id: "tools", label: "tools.ts", defaultText: DEFAULT_TOOLS, documentOf: toolsDocumentOf, editableFrom: TOOLS_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: TOOLS_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    { id: "chat", label: "chat.ts", defaultText: "", documentOf: () => CHAT, editableFrom: CHAT.length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    {
      id: "memory", label: "memory.ts", defaultText: DEFAULT_MEMORY, documentOf: memoryDocumentOf, editableFrom: MEMORY_INTRO.length, formatPrefix: "const flatMemory = ",
      sections: [], folded: [], readOnly: false,
    },
  ],
  mainFile: "skills",
  chips: ["How far is 5 km in miles?", "Write a haiku about rain.", "What is 2 + 3?", "Load units."],
  // Sent at once, one turn takes all three: both skills loaded and the sum worked out in one step.
  three: THREE,
  // The one fill of the page: a call of `convert` before its skill is loaded (an experiment that edits no file).
  fill: UNLOADED,
  controls: {},
  experiments: {
    "always-on": { file: "agent", apply: alwaysOn },
    "no-catalogue": { file: "agent", apply: noCatalogue },
    "no-handlers": { file: "agent", apply: noHandlers },
  },
  evaluate: evaluateLesson,
}
