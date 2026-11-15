// Lesson 9, "Approvals": some actions need a person's yes. The base program
// over lesson 2's tools and one more, `forget`, which asks before it deletes
// every note. The page is who it asks: `approvalOn(pane)` puts the question
// in the chat, and the answer is a record of the turn.
import { Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { CONVERSATION_VOCABULARY, Core, messageOf, vocabularyOf, readJournal, Sessions, toolResult, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import { Approval, approve, approveIn, autoApprove, callTool, CurrentTurn, Memory, modelAnswer, paired, promptMessage } from "@xandreed/sdk/kernel"
import { named, programOf, run, runStatements } from "../../evaluate.ts"
import type { Lesson, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY, MEMORY_INTRO, memoryDocumentOf } from "../tools/memory.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { askInLoop, autoApproved, noApproval, noAsk } from "./config-edit.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "./tools.source.ts"

const memoryNames = { Effect, Layer, Option, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Memory, paired, promptMessage }
const toolsNames = { Effect, Schema, Tool, Toolkit, Approval, approve, CurrentTurn }

const agentNames = (parts: PageParts, flatMemory: unknown, tools: unknown, toolsLive: unknown) => ({
  Effect, Stream, LanguageModel, Prompt,
  Core, Sessions, toolResult, turnStartedEvent, userMessage, approveIn, autoApprove, callTool, Memory, modelAnswer, Chat,
  kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
  // Named by no import: the page's, as `pane` and `model` are. Who is asked is the host's part.
  approvalOn: parts.approvalOn,
  flatMemory, tools, toolsLive, pane: parts.pane, model: parts.model,
})

/** memory.ts, tools.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(run("memory.ts did not run: ", sources.memory ?? "", memoryNames), (memory) => {
    if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …).")
    return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (made) => {
      const tools = named(made, "tools")
      const toolsLive = named(made, "toolsLive")
      if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … }).")
      return Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", agentNames(parts, parts.watchMemory(memory), tools, toolsLive)), (main) =>
        // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
        programOf(main))
    })
  })

/** Two notes and the question that reads them back: one turn takes all three, and nothing is left to approve. */
const THREE = ["Remember to buy milk.", "Remember to call Ana.", "What are my notes?"]

export const approvals: Lesson = {
  slug: "approvals",
  files: [
    {
      id: "tools", label: "tools.ts", defaultText: DEFAULT_TOOLS, documentOf: toolsDocumentOf, editableFrom: TOOLS_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: TOOLS_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    {
      id: "agent", label: "agent.ts", defaultText: DEFAULT_AGENT, documentOf, editableFrom: HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: IMPORTS.length }) }], folded: ["imports"], readOnly: false,
    },
    { id: "chat", label: "chat.ts", defaultText: "", documentOf: () => CHAT, editableFrom: CHAT.length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    {
      id: "memory", label: "memory.ts", defaultText: DEFAULT_MEMORY, documentOf: memoryDocumentOf, editableFrom: MEMORY_INTRO.length, formatPrefix: "const flatMemory = ",
      sections: [], folded: [], readOnly: false,
    },
  ],
  mainFile: "tools",
  chips: ["Remember to buy milk.", "Remember to call Ana.", "What are my notes?", "Forget my notes."],
  // Sent at once, one turn takes all three: two notes saved and read back in one step.
  three: THREE,
  // No button of the page sends a fill: the type asks for one, and it is the same three.
  fill: THREE,
  controls: {},
  experiments: {
    "auto-approve": { file: "agent", apply: autoApproved },
    "no-approval": { file: "agent", apply: noApproval },
    "ask-in-loop": { file: "agent", apply: askInLoop },
    "no-ask": { file: "tools", apply: noAsk },
  },
  evaluate: evaluateLesson,
}
