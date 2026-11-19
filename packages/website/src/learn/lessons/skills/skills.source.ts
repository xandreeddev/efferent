// Lesson 10's skills.ts: two skills, and the one value that holds them with
// the agent's tools. A skill is instructions and tools the model is not sent
// until it asks: `units` has a tool of its own, `haiku` is instructions
// alone. The file is statements, as tools.ts is: `skills(…)` is made once,
// as the file runs, so a set it refuses refuses the build. The learner edits
// all of it; the page runs it as written, and program.test.ts compiles and
// runs it.

/** Read-only: what the skills import. `tools` is tools.ts's toolkit: the tools the agent always has. */
export const SKILLS_IMPORTS = `import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { defineSkill, skills } from "@xandreed/sdk"
import { tools } from "./tools.ts"`

/** Everything before the editable part. */
export const SKILLS_HEADER = `${SKILLS_IMPORTS}\n\n`

/** The skill with a tool of its own: the tool, the skill, and what the tool does. */
export const UNITS = `// A skill is a value: a name, one line for the catalogue, instructions, and tools of its own.
// Neither the instructions nor the tool below is sent to the model until it loads the skill.
const convert = Tool.make("convert", {
  description: "Convert a length from one unit to another.",
  parameters: Schema.Struct({
    value: Schema.Number,
    from: Schema.Literals(["km", "mi"]),
    to: Schema.Literals(["km", "mi"]),
  }),
  success: Schema.Number,
})

export const units = defineSkill({
  id: "units",
  // The skill's line in the catalogue, which the model always reads: it says when to load it.
  summary: "Convert a length between kilometres and miles.",
  // What loading the skill gives the model, as the result of its loadSkill call.
  instructions: [
    "Convert with the convert tool, never in your head.",
    "Give it the number as it was written, and each unit as km or mi.",
    "Answer with the number and its unit, to one decimal.",
  ].join("\\n"),
  tools: Toolkit.make(convert),
})

// What the skill's tool does when it is called. main provides it, loaded or not.
export const unitsLive = units.tools.toLayer({
  convert: ({ value, from, to }) =>
    Effect.succeed(from === to ? value : from === "km" ? value / 1.609344 : value * 1.609344),
})
`

/** The skill that is instructions alone. */
export const HAIKU = `// A skill that is instructions alone: loading it changes what the model reads, and adds no tool.
export const haiku = defineSkill({
  id: "haiku",
  summary: "Answer in a haiku.",
  instructions: [
    "Answer in a haiku: three lines of five, seven and five syllables.",
    "Write about what the message names. Add no title and no comment.",
  ].join("\\n"),
  tools: Toolkit.empty,
})
`

/** The one value over the tools and the skills. */
export const SKILL_SET = `// One value over the tools and the skills. The whole toolkit, the catalogue, loadSkill's handler
// and what to offer at each step all come from it, so the tools and the skills cannot disagree.
export const skillSet = skills(tools, units, haiku)`

/** What the learner edits: the two skills and the one value. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_SKILLS = `${UNITS}\n${HAIKU}\n${SKILL_SET}`

/** The whole file as the learner reads it. */
export const skillsDocumentOf = (skills: string): string => `${SKILLS_HEADER}${skills}\n`

/** The same file as a module a test can compile: nothing in it needs a type. */
export const skillsModuleOf = (skills: string): string => `${SKILLS_HEADER}${skills}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const skillsBodyOf = (skills: string): string => skills.replace(/^export /gm, "")
