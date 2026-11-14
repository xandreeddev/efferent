import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { assistantMessage, Core, kernel, Sessions, userMessage } from "@xandreed/core/kernel"
import type { KernelEvent, SessionId, StoredEvent } from "@xandreed/core/kernel"
import { callTool, CurrentTurn, flatMemory, inProcessJournal, Memory, progressEvent, scriptedModel, sessions, showView, ViewId, viewProgress, viewsOf } from "./index.js"
import type { ModelScript } from "./index.js"

/*
 * What the UI shows is a record tagged ui (ADR 0009): a tool appends a view
 * through the turn its call runs in, a client folds the journal's views
 * (`viewsOf`), and no memory sends a view, so the model never sees one.
 * `docs/kernel.md` quotes the tool.
 */

// #region show-tool
// A tool that works out a table and shows it. The model asks in a few words; the rows are the tool's own work.
const Squares = Tool.make("squares", {
  description: "Show the user the squares from 1 to upTo, as a table. Give it an id: showing again under that id replaces it.",
  parameters: Schema.Struct({ id: ViewId, upTo: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })) }),
  success: Schema.String,
  // The turn its call runs in, to append the view, and Core, to publish its progress.
  dependencies: [CurrentTurn, Core],
})
const tools = Toolkit.make(Squares)

const toolsLive = tools.toLayer({
  squares: ({ id, upTo }) => Effect.gen(function* () {
    const session = yield* CurrentTurn
    const core = yield* Core
    const rows: Array<ReadonlyArray<string>> = []
    for (let n = 1; n <= upTo; n++) {
      rows.push([String(n), String(n * n)])
      // How far it got: live, for whoever watches, never stored.
      yield* Effect.orDie(core.publish(viewProgress(session, id, n, upTo)))
    }
    // The table it worked out, stored as a view tagged ui. No memory sends it: the model never sees the rows.
    yield* Effect.orDie(session.append(showView(id, { _tag: "Table", title: "Squares", columns: ["n", "n²"], rows })))
    // What the model reads: a few words.
    return `shown as ${id}`
  }),
})
// #endregion show-tool

/** The same tool, the wrong way: the table goes back to the model as the tool's result, and stays in every later request. */
const toolsReturningTheTable = tools.toLayer({
  squares: ({ upTo }) => Effect.succeed(["n | n²", ...Array.from({ length: upTo }, (_, i) => `${i + 1} | ${(i + 1) ** 2}`)].join("\n")),
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
        const result = yield* callTool(toolkit, call, session)
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

const showSquares: ModelScript = [
  { _tag: "Calls", pieces: [], calls: [{ name: "squares", params: { id: "squares", upTo: 3 } }] },
  { _tag: "Answers", pieces: ["Done."] },
]
const names = (journal: ReadonlyArray<StoredEvent>) => journal.map((event): string => event.name)
/** Whether any message of a prompt, whoever's, holds a cell header of the table. */
const holdsTheTable = (prompt: ReadonlyArray<{ readonly text: string }> | undefined) => (prompt ?? []).some((message) => message.text.includes("n²"))

describe("what the UI shows is a record tagged ui", () => {
  test("a tool appends the view it worked out in the turn its call runs in, between the call and its result, and a client folds it", async () => {
    const { journal, heard } = await Effect.runPromise(run(showSquares, ["Show me squares."]))
    expect(names(journal).slice(2, 5)).toEqual(["conversation.assistant.message", "plugin.render.view", "conversation.tool.result"])
    expect(journal.find((event) => event.name === "plugin.render.view")?.tags.map(String)).toEqual(["ui"])
    expect(viewsOf(journal).map(({ id, view }) => ({ id: String(id), view }))).toEqual([{ id: "squares", view: { _tag: "Table", title: "Squares", columns: ["n", "n²"], rows: [["1", "1"], ["2", "4"], ["3", "9"]] } }])
    // Progress is live: heard by whoever listens, never stored.
    expect(heard.map((event) => event.data)).toEqual([1, 2, 3].map((done) => ({ id: "squares", done, total: 3 })))
    expect(names(journal)).not.toContain("plugin.render.progress")
  })

  test("the model never sees the view: no message of the next prompt, whoever's, holds the table; the call and a few words do", async () => {
    const { calls } = await Effect.runPromise(run(showSquares, ["Show me squares."]))
    expect(calls[1]?.slice(-2)).toEqual([
      { role: "assistant", text: "squares({\"id\":\"squares\",\"upTo\":3})" },
      { role: "tool", text: "→ \"shown as squares\"" },
    ])
    expect(holdsTheTable(calls[1])).toBe(false)
  })

  test("the wrong way, the table returned as the tool's result, is sent to the model in every later request", async () => {
    const { calls, journal } = await Effect.runPromise(run([...showSquares, { _tag: "Answers", pieces: ["Hi."] }], ["Show me squares.", "Hello."], toolsReturningTheTable))
    expect(holdsTheTable(calls[2])).toBe(true)
    expect(viewsOf(journal)).toEqual([])
  })

  test("showing again under the same id replaces the view, which keeps its first place", async () => {
    const { journal } = await Effect.runPromise(run([
      { _tag: "Calls", pieces: [], calls: [{ name: "squares", params: { id: "small", upTo: 2 } }, { name: "squares", params: { id: "other", upTo: 1 } }] },
      { _tag: "Calls", pieces: [], calls: [{ name: "squares", params: { id: "small", upTo: 4 } }] },
      { _tag: "Answers", pieces: ["Done."] },
    ], ["Show me squares, then more."]))
    const shown = viewsOf(journal)
    expect(shown.map((one) => String(one.id))).toEqual(["small", "other"])
    expect(shown[0]?.view._tag === "Table" && shown[0].view.rows.length).toBe(4)
    expect(shown[0]!.firstSeq < shown[1]!.firstSeq && shown[0]!.seq > shown[1]!.seq).toBe(true)
  })

  test("a call the model got wrong is refused, returned to it as a failed result, and nothing is shown", async () => {
    const { journal } = await Effect.runPromise(run([
      { _tag: "Calls", pieces: [], calls: [{ name: "squares", params: { id: "squares", upTo: 500 } }] },
      { _tag: "Answers", pieces: ["Sorry."] },
    ], ["Show me squares."]))
    expect(viewsOf(journal)).toEqual([])
    const result = journal.find((event) => event.name === "conversation.tool.result")?.message
    expect(result?._tag === "ToolResult" && result.isFailure).toBe(true)
  })
})
