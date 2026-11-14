import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { assistantMessage, Core, kernel, Sessions, toolResult, userMessage } from "@xandreed/core/kernel"
import type { KernelEvent, SessionId, StoredEvent } from "@xandreed/core/kernel"
import { CurrentTurn, flatMemory, inProcessJournal, Memory, progressEvent, scriptedModel, sessions, showView, TableView, ViewId, viewProgress, viewsOf } from "./index.js"
import type { ModelScript } from "./index.js"

/*
 * What the UI shows is a record tagged ui (ADR 0009): a tool appends a view
 * through the turn its call runs in, a client folds the journal's views
 * (`viewsOf`), and no memory sends a view, so the model never sees one.
 * `docs/kernel.md` quotes the tool.
 */

// #region show-tool
// A tool that shows a table. Its parameters are what the model chose; its result is a few words, not the table.
const Show = Tool.make("show", {
  description: "Show the user a table. Give it an id; showing again under the same id replaces it.",
  parameters: Schema.Struct({ id: ViewId, title: Schema.String, columns: Schema.Array(Schema.String), rows: Schema.Array(Schema.Array(Schema.String)) }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
  // The turn its call runs in, to append the view, and Core, to publish its progress.
  dependencies: [CurrentTurn, Core],
})
const tools = Toolkit.make(Show)

const toolsLive = tools.toLayer({
  show: ({ id, title, columns, rows }) => Effect.gen(function* () {
    const session = yield* CurrentTurn
    const core = yield* Core
    // Progress for whoever watches; a watcher that fails is a bug of the host's, not the model's mistake.
    yield* Effect.orDie(core.publish(viewProgress(session, id, 0, rows.length)))
    // The view is checked as it is built: a row with the wrong number of cells is the model's mistake, returned to it.
    const table = yield* Effect.mapError(Schema.decodeUnknownEffect(TableView)({ _tag: "Table", title, columns, rows }), (error) => error.message)
    yield* Effect.orDie(session.append(showView(id, table)))
    yield* Effect.orDie(core.publish(viewProgress(session, id, rows.length, rows.length)))
    return `shown as ${id}`
  }),
})
// #endregion show-tool

/** The same tool, the wrong way: the table goes back to the model as the tool's result, and stays in every later request. */
const toolsReturningTheTable = tools.toLayer({
  show: ({ columns, rows }) => Effect.succeed([columns, ...rows].map((row) => row.join(" | ")).join("\n")),
})

const run = (script: ModelScript, messages: ReadonlyArray<string>, handlers: Layer.Layer<Tool.HandlersFor<typeof tools.tools>> = toolsLive) => Effect.gen(function* () {
  const { model, calls } = yield* scriptedModel(script)
  const heard = yield* Ref.make<ReadonlyArray<KernelEvent>>([])
  const turn = (conversation: SessionId, message: string) => Effect.scoped(Effect.gen(function* () {
    const memory = yield* Memory
    const llm = yield* LanguageModel.LanguageModel
    const toolkit = yield* tools
    const session = yield* (yield* Sessions).open(conversation)
    yield* session.append(userMessage(message))
    for (let step = 1; step <= 3; step++) {
      const prompt = Prompt.make([{ role: "system", content: "Show tables when asked." }, ...(yield* memory.context(session))])
      const parts = yield* Stream.runCollect(llm.streamText({ prompt, toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred" }))
      const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")
      const asked = parts.flatMap((part) => (part.type === "tool-call" ? [part] : []))
      yield* session.append(assistantMessage(text, { toolCalls: asked }))
      if (asked.length === 0) return text
      for (const call of asked) {
        const result = yield* toolkit.handle(call.name as "show", call.params as never).pipe(
          Effect.flatMap(Stream.runLast),
          Effect.map(Option.match({ onNone: () => toolResult(call, null), onSome: (last) => toolResult(call, last.encodedResult, last.isFailure) })),
          Effect.provideService(CurrentTurn, session),
        )
        yield* session.append(result)
      }
    }
    return "stopped"
  }))
  const journal = yield* Effect.gen(function* () {
    const core = yield* Core
    yield* core.on(progressEvent, (event) => Ref.update(heard, (all) => [...all, event]), { wait: true, name: "watcher" })
    const all = yield* Sessions
    const conversation = yield* all.create({ owner: "test" })
    yield* Effect.forEach(messages, (message) => turn(conversation, message), { concurrency: 1, discard: true })
    return (yield* all.read(conversation)).events
  }).pipe(Effect.provide(Layer.merge(model, handlers)))
  return { calls: yield* calls, journal, heard: yield* Ref.get(heard) }
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(flatMemory, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel())))))

const squares = { id: "squares", title: "Squares", columns: ["n", "n²"], rows: [["1", "1"], ["2", "4"], ["3", "9"]] }
const showSquares: ModelScript = [
  { _tag: "Calls", pieces: [], calls: [{ name: "show", params: squares }] },
  { _tag: "Answers", pieces: ["Done."] },
]
const names = (journal: ReadonlyArray<StoredEvent>) => journal.map((event): string => event.name)

describe("what the UI shows is a record tagged ui", () => {
  test("a tool appends a view in the turn its call runs in, between the call and its result, and a client folds it", async () => {
    const { journal, heard } = await Effect.runPromise(run(showSquares, ["Show me squares."]))
    expect(names(journal).slice(2, 5)).toEqual(["conversation.assistant.message", "plugin.render.view", "conversation.tool.result"])
    expect(journal.find((event) => event.name === "plugin.render.view")?.tags.map(String)).toEqual(["ui"])
    expect(viewsOf(journal).map(({ id, view }) => ({ id: String(id), view }))).toEqual([{ id: "squares", view: { _tag: "Table", title: "Squares", columns: ["n", "n²"], rows: squares.rows } }])
    // Progress is live: heard by whoever listens, never stored.
    expect(heard.map((event) => event.data)).toEqual([{ id: "squares", done: 0, total: 3 }, { id: "squares", done: 3, total: 3 }])
    expect(names(journal)).not.toContain("plugin.render.progress")
  })

  test("the model never sees the view: the next prompt holds the call and its few words, and none of the cells", async () => {
    const { calls } = await Effect.runPromise(run(showSquares, ["Show me squares."]))
    expect(calls[1]?.slice(-2)).toEqual([
      { role: "assistant", text: `show(${JSON.stringify(squares)})` },
      { role: "tool", text: "→ \"shown as squares\"" },
    ])
    expect(calls[1]?.some((message) => message.role !== "assistant" && message.text.includes("n²"))).toBe(false)
  })

  test("the wrong way, the table returned as the tool's result, is sent to the model in every later request", async () => {
    const { calls, journal } = await Effect.runPromise(run([...showSquares, { _tag: "Answers", pieces: ["Hi."] }], ["Show me squares.", "Hello."], toolsReturningTheTable))
    expect(calls[2]?.some((message) => message.role === "tool" && message.text.includes("n | n²"))).toBe(true)
    expect(viewsOf(journal)).toEqual([])
  })

  test("showing again under the same id replaces the view, which keeps its first place", async () => {
    const { journal } = await Effect.runPromise(run([
      { _tag: "Calls", pieces: [], calls: [{ name: "show", params: squares }, { name: "show", params: { ...squares, id: "cubes", title: "Cubes", columns: ["n", "n³"], rows: [["2", "8"]] } }] },
      { _tag: "Calls", pieces: [], calls: [{ name: "show", params: { ...squares, rows: [["4", "16"]] } }] },
      { _tag: "Answers", pieces: ["Done."] },
    ], ["Show me squares and cubes, then four squared."]))
    const shown = viewsOf(journal)
    expect(shown.map((one) => String(one.id))).toEqual(["squares", "cubes"])
    expect(shown[0]?.view).toEqual({ _tag: "Table", title: "Squares", columns: ["n", "n²"], rows: [["4", "16"]] })
    expect(shown[0]!.firstSeq < shown[1]!.firstSeq && shown[0]!.seq > shown[1]!.seq).toBe(true)
  })

  test("a table whose rows do not match its columns is refused, returned to the model as a failed result, and nothing is shown", async () => {
    const { journal } = await Effect.runPromise(run([
      { _tag: "Calls", pieces: [], calls: [{ name: "show", params: { ...squares, rows: [["1"]] } }] },
      { _tag: "Answers", pieces: ["Sorry."] },
    ], ["Show me squares."]))
    expect(viewsOf(journal)).toEqual([])
    const result = journal.find((event) => event.name === "conversation.tool.result")?.message
    expect(result?._tag === "ToolResult" && result.isFailure).toBe(true)
  })
})
