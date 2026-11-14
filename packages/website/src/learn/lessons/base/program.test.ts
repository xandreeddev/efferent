// The base program, lesson 2's on the kernel's two functions: lesson 2's text
// still holds every piece replaced, the result compiles, and, run as the page
// runs a lesson on one scripted model, the hand-written program and the base
// receive the same prompts and leave the same conversation in the journal.
// The one difference, a handler that dies, is pinned in a test of its own.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { CONVERSATION_VOCABULARY, Core, messageOf, readJournal, Sessions, turnStartedEvent, userMessage, vocabularyOf } from "@xandreed/core/kernel"
import { callTool, Memory, modelAnswer, paired, promptMessage, scriptedModel } from "@xandreed/sdk/kernel"
import { run, runStatements } from "../../evaluate.ts"
import { formatRegion } from "../../format.ts"
import type { Lesson, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { LessonRuntime } from "../../runtime.ts"
import type { Trace } from "../../runtime.ts"
import { DEFAULT_AGENT as TOOLS_AGENT, IMPORTS as TOOLS_IMPORTS } from "../tools/agent.source.ts"
import { CHAT } from "../tools/chat.source.ts"
import { tools as toolsLesson } from "../tools/lesson.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsBodyOf, toolsModuleOf } from "../tools/tools.source.ts"
import { BASE_AGENT, IMPORTS, KERNEL_FUNCTIONS, KERNEL_IMPORTS, moduleOf, withKernelFunctions } from "./agent.source.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })
const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

/** How many times `piece` is in `text`. */
const times = (text: string, piece: string): number => text.split(piece).length - 1

/** Every name an import line of `imports` brings in. */
const importedNames = (imports: string): ReadonlyArray<string> =>
  Array.from(imports.matchAll(/import \{ ([^}]+) \}/g), (match) => match[1] ?? "").flatMap((names) => names.split(",").map((name) => name.trim()))

/** The names lesson 2's memory.ts and tools.ts import, as its page gives them. */
const memoryNames = { Effect, Layer, Option, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Memory, paired, promptMessage }
const toolsNames = { Effect, Schema, Tool, Toolkit }

/**
 * The base as the page would run it: lesson 2's files and its memory and tools, with the names the base's agent.ts
 * imports. Lesson 2's own definition runs the hand-written program.
 */
const baseLesson: Lesson = {
  ...toolsLesson,
  slug: "base",
  evaluate: (sources: Sources, parts: PageParts) =>
    Result.flatMap(run("memory.ts did not run: ", sources.memory ?? "", memoryNames), (memory) =>
      Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (made) => {
        const { tools, toolsLive } = made as { readonly tools: unknown; readonly toolsLive: unknown }
        return Result.map(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", {
          Effect, Stream, LanguageModel, Prompt,
          Core, Sessions, turnStartedEvent, userMessage, callTool, Memory, modelAnswer, Chat,
          kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
          flatMemory: parts.watchMemory(memory as Layer.Layer<Memory>), tools, toolsLive, pane: parts.pane, model: parts.model,
        }), (main) => main as Effect.Effect<unknown, unknown>)
      })),
}

type Script = Parameters<typeof scriptedModel>[0]

/**
 * Run one program on the page's runtime with a scripted model: each message is sent once the one before is
 * answered, so each is a turn of its own. What comes back is what the model was sent, call by call, the chat
 * session's journal, and what the chat was told.
 */
const onThePage = async (lesson: Lesson, agent: string, script: Script, messages: ReadonlyArray<string>, tools: string = DEFAULT_TOOLS) => {
  const runtime = await LessonRuntime.create(lesson)
  opened.push(runtime)
  const scripted = await Effect.runPromise(scriptedModel(script))
  const model = await Effect.runPromise(Effect.scoped(Effect.map(Layer.build(scripted.model), (built) => Context.get(built, LanguageModel.LanguageModel))))
  runtime.setModel({ choice: { id: "scripted", kind: "echo", label: "Scripted", blurb: "A model that follows a script.", memoryMB: 0 }, model, interrupt: () => {}, dispose: () => {} })
  const heard: Array<Trace> = []
  runtime.onTrace((trace) => heard.push(trace))
  expect(await runtime.start({ agent, tools, memory: DEFAULT_MEMORY })).toEqual({ _tag: "Built" })
  for (const message of messages) {
    const answered = new Promise<void>((resolve) => { const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply" || trace._tag === "Failed") { stop(); resolve() } }) })
    runtime.send(message)
    await answered
  }
  const journal = await runtime.journal()
  return {
    prompts: await Effect.runPromise(scripted.calls),
    conversation: journal.map((record) => ({ name: String(record.name), turn: Number(record.turn), message: record.message })),
    data: journal.flatMap((record) => (record.name === "conversation.assistant.message" ? [record.data] : [])),
    told: heard.flatMap((trace) => (trace._tag === "Piece" || trace._tag === "Reply" || trace._tag === "Failed" || trace._tag === "Status" ? [trace] : [])),
  }
}

const MESSAGES = ["Hello.", "What is 6 * 7?", "What is 1 / 0?", "Search for x, and add six to seven."]
const SCRIPT: Script = [
  // A plain answer, in two pieces.
  { _tag: "Answers", pieces: ["Hi ", "there."] },
  // A call that succeeds, with words before it.
  { _tag: "Calls", pieces: ["Let me work it out."], calls: [{ name: "calculator", params: { a: 6, op: "*", b: 7 } }] },
  { _tag: "Answers", pieces: ["It is 42."] },
  // A call the tool fails.
  { _tag: "Calls", pieces: [], calls: [{ name: "calculator", params: { a: 1, op: "/", b: 0 } }] },
  { _tag: "Answers", pieces: ["That cannot be done."] },
  // A tool that does not exist, and parameters the toolkit refuses, in one answer.
  { _tag: "Calls", pieces: [], calls: [{ name: "search", params: { q: "x" } }, { name: "calculator", params: { a: "six", op: "+", b: 7 } }] },
  { _tag: "Answers", pieces: ["Neither worked."] },
]

describe("the base program", () => {
  test("lesson 2's text holds every piece the base replaces, once, and the base is what the replacements leave", () => {
    for (const [from] of KERNEL_FUNCTIONS) expect({ from, held: times(TOOLS_AGENT, from) }).toEqual({ from, held: 1 })
    for (const [from] of KERNEL_IMPORTS) expect({ from, held: times(TOOLS_IMPORTS, from) }).toEqual({ from, held: 1 })
    expect(withKernelFunctions(TOOLS_AGENT)).toBe(BASE_AGENT)
    // Nothing of the two hand-written blocks is left, and both functions are there.
    for (const gone of ["runTool", "toolResult", "assistantMessage", "Option.", "Stream.runCollect", "const parts", "const calls"]) expect({ gone, left: BASE_AGENT.includes(gone) }).toEqual({ gone, left: false })
    expect(times(BASE_AGENT, "yield* modelAnswer(")).toBe(1)
    expect(times(BASE_AGENT, "yield* callTool(toolkit, call, session)")).toBe(1)
    // Removing a block left no gap behind it.
    expect(BASE_AGENT.includes("\n\n\n")).toBe(false)
  })

  test("the base imports exactly the names its code uses", () => {
    const names = importedNames(IMPORTS)
    expect(names).toEqual([
      "Effect", "Stream", "LanguageModel", "Prompt",
      "Core", "kernel", "Sessions", "turnStartedEvent", "userMessage",
      "callTool", "inProcessJournal", "Memory", "modelAnswer", "sessions",
      "Chat", "chatOn", "flatMemory", "tools", "toolsLive",
    ])
    expect(names.filter((name) => !new RegExp(`\\b${name}\\b`).test(BASE_AGENT))).toEqual([])
  })

  test("Format leaves the base as it is", async () => {
    expect(await formatRegion(BASE_AGENT, "")).toEqual({ ok: true, text: BASE_AGENT })
  })

  test("the hand-written program and the base receive the same prompts and leave the same conversation in the journal", async () => {
    const byHand = await onThePage(toolsLesson, TOOLS_AGENT, SCRIPT, MESSAGES)
    const base = await onThePage(baseLesson, BASE_AGENT, SCRIPT, MESSAGES)
    expect(base.prompts).toEqual(byHand.prompts)
    expect(base.conversation).toEqual(byHand.conversation)
    expect(base.told).toEqual(byHand.told)
    // What both were compared on is the run the script describes: seven model calls, four turns, each kind of result.
    expect(byHand.prompts).toHaveLength(7)
    expect(byHand.conversation.map((record) => record.name)).toEqual([
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "core.session.turn.ended",
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "conversation.tool.result", "conversation.assistant.message", "core.session.turn.ended",
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "conversation.tool.result", "conversation.assistant.message", "core.session.turn.ended",
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "conversation.tool.result", "conversation.tool.result", "conversation.assistant.message", "core.session.turn.ended",
    ])
    expect(byHand.conversation.flatMap((record) => (record.message?._tag === "ToolResult" ? [[record.message.name, record.message.isFailure, record.message.result]] : []))).toEqual([
      ["calculator", false, 42],
      ["calculator", true, "cannot divide by zero"],
      ["search", true, "Toolkit.search.handle: Tool 'search' not found. Available tools: calculator, remember, recall"],
      // The calculator returns its failures (failureMode: "return"), so the toolkit hands the refusal back as its result.
      ["calculator", true, { _tag: "AiError", module: "Toolkit", method: "calculator.handle", reason: { _tag: "ToolParameterValidationError", toolName: "calculator", description: "Expected number\n  at [\"a\"]" } }],
    ])
    expect(byHand.told.flatMap((trace) => (trace._tag === "Reply" ? [trace.text] : []))).toEqual(["Hi there.", "It is 42.", "That cannot be done.", "Neither worked."])
    // Beside the conversation: modelAnswer stores what the provider said each call cost, which the hand-written block does not.
    expect(byHand.data).toEqual(Array.from({ length: 7 }, () => ({})))
    expect(base.data).toEqual(Array.from({ length: 7 }, () => ({ usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } })))
  }, 30_000)

  test("the one difference: a handler that dies. Lesson 2 stores the defect as text, callTool its message alone", async () => {
    const dying = DEFAULT_TOOLS.replace(
      "    Effect.sync(() => {\n      notes.push(note)\n      return `Saved. ${notes.length} notes so far.`\n    }),",
      "    Effect.die(new Error(`the note pad is full: ${note}`)),",
    )
    expect(dying).not.toBe(DEFAULT_TOOLS)
    const script: Script = [
      { _tag: "Calls", pieces: [], calls: [{ name: "remember", params: { note: "milk" } }] },
      { _tag: "Answers", pieces: ["I could not save it."] },
    ]
    const failure = (run: Awaited<ReturnType<typeof onThePage>>) => run.conversation.flatMap((record) => (record.message?._tag === "ToolResult" ? [{ ...record.message, id: String(record.message.id) }] : []))
    const byHand = await onThePage(toolsLesson, TOOLS_AGENT, script, ["Remember milk."], dying)
    const base = await onThePage(baseLesson, BASE_AGENT, script, ["Remember milk."], dying)
    expect(failure(byHand)).toEqual([{ _tag: "ToolResult", id: "call-1-1", name: "remember", result: "Error: the note pad is full: milk", isFailure: true }])
    expect(failure(base)).toEqual([{ _tag: "ToolResult", id: "call-1-1", name: "remember", result: "the note pad is full: milk", isFailure: true }])
    // Either way it is an answer the model reads, and the turn goes on to its reply.
    expect(byHand.prompts[1]?.at(-1)).toEqual({ role: "tool", text: "→ failed: \"Error: the note pad is full: milk\"" })
    expect(base.prompts[1]?.at(-1)).toEqual({ role: "tool", text: "→ failed: \"the note pad is full: milk\"" })
    expect(base.told.at(-1)).toEqual(byHand.told.at(-1))
    expect(base.told.at(-1)).toMatchObject({ _tag: "Reply", text: "I could not save it." })
  })

  test("type-checks as TypeScript, with lesson 2's chat, memory and tools", () => {
    const at = new URL("./typed/", dir)
    mkdirSync(at, { recursive: true })
    writeFileSync(new URL("./agent.ts", at), moduleOf(BASE_AGENT))
    writeFileSync(new URL("./chat.ts", at), CHAT)
    writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
    writeFileSync(new URL("./tools.ts", at), toolsModuleOf(DEFAULT_TOOLS))
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})
