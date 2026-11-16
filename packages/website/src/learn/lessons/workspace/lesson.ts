// Lesson 15, "A workspace": give the agent files to work on. The base program
// with the kernel's four file tools merged into its toolkit, over the page's
// workspace: one `Files`, built once per page load, given to the program as a
// value (`PageParts.files`), so the files outlive every rebuild and a reload
// starts them over. workspace.ts is the app's permission layer, a function of
// those files; the file tools ask no one. tools.ts and memory.ts are lesson
// 2's, shown read-only: the page runs their starter text.
import { Effect, Layer, Option, Predicate, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { CONVERSATION_VOCABULARY, Core, messageOf, readJournal, Sessions, toolResult, turnStartedEvent, userMessage, vocabularyOf } from "@xandreed/core/kernel"
import {
  Approval, approveIn, callTool, fileHandlers, Files, FilesRefused, fileTools, Memory, modelAnswer, paired, promptMessage, workspacePath,
} from "@xandreed/sdk/kernel"
import { named, programOf, run, runStatements, textOf } from "../../evaluate.ts"
import type { Lesson, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY, memoryDocumentOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsBodyOf, toolsDocumentOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { askFirst, judged, keepDocs, slowWrites } from "./config-edit.ts"
import { DEFAULT_WORKSPACE, WORKSPACE_HEADER, WORKSPACE_IMPORTS, workspaceBodyOf, workspaceDocumentOf } from "./workspace.source.ts"

/** The long file's lines: numbered, so a page that starts inside it shows where it is. */
const LONG_LINES = Array.from({ length: 80 }, (_, index) => `${index + 1}. A line of a long file, there to make it longer than one page of readFile.\n`)

/**
 * The files the page's workspace starts with, on every page load: a short list to read and edit, a guide under docs/
 * (the folder lesson 15's `keep-docs` declines writes to), and a file longer than one page of `readFile`.
 */
export const SEED: Readonly<Record<string, string>> = {
  "notes/todo.md": "- buy milk\n- call Ana\n",
  "docs/guide.md": "# Guide\n\nThis workspace lives in the page's memory: a reload starts it over.\nThe agent reaches it through four tools, and nothing else.\n",
  "notes/long.md": `# A long file\n\n${LONG_LINES.join("")}`,
}

/** The read-only files as the page runs them: lesson 2's starter text, whatever any other tab holds. */
const memoryNames = { Effect, Layer, Option, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Memory, paired, promptMessage }
const toolsNames = { Effect, Schema, Tool, Toolkit }
const workspaceNames = { Effect, Layer, Files, FilesRefused }

const agentNames = (parts: PageParts, files: Layer.Layer<Files>, flatMemory: unknown, tools: unknown, toolsLive: unknown, workspace: unknown) => ({
  Effect, Layer, Predicate, Result, Stream, LanguageModel, Prompt, Toolkit,
  Core, Sessions, toolResult, turnStartedEvent, userMessage,
  Approval, approveIn, callTool, fileHandlers, fileTools, Memory, modelAnswer, workspacePath, Chat,
  kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
  flatMemory, tools, toolsLive, workspace,
  // Named by no import: the page's, as `pane` and `model` are. The workspace, and who is asked, are the host's parts.
  files, approvalOn: parts.approvalOn,
  pane: parts.pane, model: parts.model,
})

const NOT_A_FUNCTION = "workspace.ts did not run: workspace is not a function. It should take the page's files, and give them as a layer."
const NOT_A_LAYER = "workspace.ts did not run: workspace(files) is not a layer. It should give the page's files, or a layer over them."

/**
 * workspace.ts as the page runs it: the learner's `workspace`, a function, called once with the page's files to
 * hold what it gives to a layer, or why it is none, in words that name the file. agent.ts calls it again in main.
 */
const workspaceOf = (sources: Sources, files: Layer.Layer<Files>): Result.Result<unknown, string> =>
  Result.flatMap(runStatements("workspace.ts did not run: ", workspaceBodyOf(sources.workspace ?? ""), "workspace", workspaceNames), (workspace) => {
    if (!Predicate.isFunction(workspace)) return Result.fail(NOT_A_FUNCTION)
    const made = Effect.runSync(Effect.result(Effect.try({ try: (): unknown => Reflect.apply(workspace, undefined, [files]), catch: textOf })))
    if (Result.isFailure(made)) return Result.fail(`workspace.ts did not run: workspace(files) threw: ${made.failure}`)
    return Layer.isLayer(made.success) ? Result.succeed(workspace) : Result.fail(NOT_A_LAYER)
  })

/** memory.ts, tools.ts, workspace.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Option.match(parts.files, {
    onNone: () => Result.fail("this page has no workspace to give the agent."),
    onSome: (files) =>
      Result.flatMap(run("memory.ts did not run: ", DEFAULT_MEMORY, memoryNames), (memory) => {
        if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …).")
        return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(DEFAULT_TOOLS), "{ tools, toolsLive }", toolsNames), (made) => {
          const tools = named(made, "tools")
          const toolsLive = named(made, "toolsLive")
          if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … }).")
          return Result.flatMap(workspaceOf(sources, files), (workspace) =>
            Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", agentNames(parts, files, parts.watchMemory(memory), tools, toolsLive, workspace)), (main) =>
              // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
              programOf(main)))
        })
      }),
  })

/** Three messages at once, one turn: a list, a read and a write, each a call of its own in one step. */
const THREE = ["List the files.", "Read notes/todo.md.", "Write scratch/plan.md: Read the guide, then the list."]

export const workspace: Lesson = {
  slug: "workspace",
  files: [
    {
      id: "workspace", label: "workspace.ts", defaultText: DEFAULT_WORKSPACE, documentOf: workspaceDocumentOf, editableFrom: WORKSPACE_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: WORKSPACE_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    {
      id: "agent", label: "agent.ts", defaultText: DEFAULT_AGENT, documentOf, editableFrom: HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: IMPORTS.length }) }], folded: ["imports"], readOnly: false,
    },
    { id: "tools", label: "tools.ts", defaultText: "", documentOf: () => toolsDocumentOf(DEFAULT_TOOLS), editableFrom: toolsDocumentOf(DEFAULT_TOOLS).length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    { id: "memory", label: "memory.ts", defaultText: "", documentOf: () => memoryDocumentOf(DEFAULT_MEMORY), editableFrom: memoryDocumentOf(DEFAULT_MEMORY).length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    { id: "chat", label: "chat.ts", defaultText: "", documentOf: () => CHAT, editableFrom: CHAT.length, formatPrefix: "", sections: [], folded: [], readOnly: true },
  ],
  mainFile: "workspace",
  chips: ["List the files.", "Read notes/todo.md.", "In notes/todo.md replace call Ana with call Ana at noon.", "Write hello.txt: hello"],
  three: THREE,
  // No button of the page sends a fill: the type asks for one, and it is the same three.
  fill: THREE,
  controls: {},
  experiments: {
    "keep-docs": { file: "workspace", apply: keepDocs },
    "ask-first": { file: "agent", apply: askFirst },
    judge: { file: "agent", apply: judged },
    "slow-writes": { file: "workspace", apply: slowWrites },
  },
  evaluate: evaluateLesson,
  workspace: { seed: SEED },
}
