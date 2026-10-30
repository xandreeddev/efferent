import { describe, expect, test } from "bun:test"
import { Context, Effect, Option, Tracer } from "effect"
import { ConversationId, ConversationMemory, entryId, estimateMessageTokens, HarnessError, renderLog, RunContext, RunId, ToolCallId, toolParametersSchema, UserMessage } from "@xandreed/core"
import type { LogBody, LogEntry, LogHandle, ToolViews } from "@xandreed/core"
import { memoryWindowPlugin, RECALL_PAGE_CHARS, recallCapability, recallPage, spillPreview, WINDOW_STRATEGY, windowPolicy } from "./plugin.adapter.js"

const config = {
  compactPreviousTurn: true, turnContext: "current" as const, replies: true, spillMinChars: 100, previewChars: 20, ledgerTurnChars: 40,
  digestOnWriteChars: 0, digests: true, media: "none" as const, maxImages: 8, maxMediaChars: 20_000_000,
}
const views: ToolViews = {
  view: (_tool, encoded) => Effect.succeed({ text: String(encoded), version: "1", subjects: [], artifacts: [], pinned: false }),
  compact: (_tool, encoded) => Effect.succeed(Option.some(`(compact ${String(encoded).length})`)),
  digest: () => Effect.succeed(Option.none()),
}
const at = (seq: number, turn: number, body: LogBody): LogEntry => ({ id: entryId(RunId.make(`run-${turn}`), seq), runId: RunId.make(`run-${turn}`), turn, step: 0, at: seq, body })
const result = (seq: number, turn: number, view: string, toolName = "lookup"): LogEntry => at(seq, turn, {
  _tag: "ToolResult", toolCallId: ToolCallId.make(`c${seq}`), toolName, isError: false, encoded: view, view, viewVersion: "1", subjects: [], artifacts: [], pinned: false,
})
const call = (seq: number, turn: number, id: number): LogEntry => at(seq, turn, { _tag: "Message", message: { role: "assistant", content: [{ type: "tool-call", toolCallId: ToolCallId.make(`c${id}`), toolName: "lookup", input: {} }] } })
const log = (big: string): ReadonlyArray<LogEntry> => [
  at(0, 1, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "first question" }) }), call(1, 1, 2), result(2, 1, big),
  at(3, 1, { _tag: "TurnEnded", outcome: "completed", reply: Option.some("first answer") }),
  at(4, 2, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "second question" }) }), call(5, 2, 6), result(6, 2, big),
]
const policy = windowPolicy(config)
const render = (entries: ReadonlyArray<LogEntry>) => renderLog(entries, { ...policy.render, stepContext: "tail", strategy: WINDOW_STRATEGY.id, currentTurn: 2, currentRun: RunId.make("run-2") })
const maintain = (entries: ReadonlyArray<LogEntry>, budgetTokens: number, phase: "turn-start" | "step" = "turn-start") =>
  Effect.runPromise(Effect.result(policy.maintain({ entries, signal: { phase, lastUsage: Option.none(), budgetTokens, views }, turn: 2, runId: RunId.make("run-2"), render })))

describe("window memory policy", () => {
  test("at turn start, earlier tool results switch to their compact views", async () => {
    const decided = await maintain(log("x".repeat(500)), 100_000)
    expect(decided).toMatchObject({ _tag: "Success", success: { actions: [{ _tag: "CompactViews", entries: ["run-1:2"], texts: ["(compact 500)"] }], digest: [] } })
  })
  test("under pressure it spills the current turn's largest result, then drops old turns, then fails", async () => {
    const entries = log("x".repeat(3_000))
    const tokens = estimateMessageTokens(render(entries))
    const spilled = await maintain(entries, tokens - 500, "step")
    expect(spilled).toMatchObject({ _tag: "Success", success: { actions: [{ _tag: "Spill", entry: "run-2:6" }] } })
    const dropped = await maintain(entries, 400, "step")
    expect(dropped).toMatchObject({ _tag: "Success", success: { actions: [{ _tag: "Spill" }, { _tag: "DropTurns", throughTurn: 1 }] } })
    const impossible = await maintain(entries, 5, "step")
    expect(impossible).toMatchObject({ _tag: "Failure", failure: { code: "context.budget" } })
  })
})

describe("reading a spilled result back", () => {
  const recall = recallCapability.tools[0]!
  const stored = result(2, 1, "x".repeat(RECALL_PAGE_CHARS + 500))
  // The registry erases a handler's requirements; this one needs only the run's memory.
  const recalled = (params: { readonly locator: string; readonly offset?: number }) => Effect.runPromise(Effect.result(recall.handler(params).pipe(
    Effect.provideService(RunContext, RunContext.of({ memory: { resolve: (id: string) => Effect.succeed(Option.some(stored).pipe(Option.filter((entry) => entry.id === id))) } } as never)),
  ) as Effect.Effect<unknown, unknown>))

  test("the preview says how many characters it left out and the offset to read them from, never a negative count", () => {
    expect(spillPreview(stored, "abcdef", 4)).toBe(`abcd\n[… 2 more characters kept out of context; call recall_context with locator "run-1:2" and offset 4 to read them]`)
    expect(spillPreview(stored, "abc", 10)).toBe(`abc\n[… 0 more characters kept out of context; call recall_context with locator "run-1:2" and offset 3 to read them]`)
  })

  test("recall_context says what it returns and how to page", () => {
    expect(recall.tool.description).toBe(`Read an earlier result that was shortened to save context, by the locator its shortened form shows. Returns at most ${RECALL_PAGE_CHARS} characters from offset (0 by default); when more remain, the reply ends with the offset to pass next.`)
    expect(toolParametersSchema(recall.tool)).toMatchObject({
      properties: {
        locator: { type: "string", description: "The locator the shortened result shows." },
        offset: { description: "The first character to return; 0 by default." },
      },
      required: ["locator"],
    })
  })

  test("a result comes back a page at a time, each page ending with the offset of the next", async () => {
    expect(recallPage("run-1:2", "abcdef", 2)).toBe("cdef")
    expect(await recalled({ locator: "run-1:2" })).toMatchObject({ _tag: "Success", success: `${"x".repeat(RECALL_PAGE_CHARS)}\n[… 500 more characters; call recall_context with locator "run-1:2" and offset ${RECALL_PAGE_CHARS}]` })
    expect(await recalled({ locator: "run-1:2", offset: RECALL_PAGE_CHARS })).toMatchObject({ _tag: "Success", success: "x".repeat(500) })
    expect(await recalled({ locator: "run-1:2", offset: RECALL_PAGE_CHARS + 500 })).toMatchObject({ _tag: "Failure", failure: { error: "OffsetOutOfRange" } })
    expect(await recalled({ locator: "run-9:9" })).toMatchObject({ _tag: "Failure", failure: { error: "UnknownLocator" } })
  })

  test("a recalled page is never spilled again: under pressure the other results are", async () => {
    // The recalled page is the largest result of the turn, which would be spilled first.
    const entries = [...log("x".repeat(3_000)), call(7, 2, 8), result(8, 2, "y".repeat(4_000), "recall_context")]
    const decided = await maintain(entries, estimateMessageTokens(render(entries)) - 500, "step")
    expect(decided).toMatchObject({ _tag: "Success", success: { actions: [{ _tag: "Spill", entry: "run-2:6" }] } })
  })
})

describe("spans", () => {
  test("opening a session is a memory.open span under the caller's, failed when the log cannot be read", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({ span: (options) => { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const built = yield* memoryWindowPlugin.build(config, Context.empty())
      const memory = Context.get(built as Context.Context<ConversationMemory>, ConversationMemory)
      const conversation = ConversationId.make("00000000-0000-4000-8000-0000000005c1")
      const readable: LogHandle = { read: Effect.succeed(log("x")), append: () => Effect.void }
      const unreadable: LogHandle = { ...readable, read: Effect.fail(new HarnessError({ code: "memory.log", message: "the log is gone" })) }
      yield* memory.open({ conversation, runId: RunId.make("run-2"), log: readable }).pipe(Effect.withSpan("host.turn"))
      yield* Effect.exit(memory.open({ conversation, runId: RunId.make("run-2"), log: unreadable }))
    })).pipe(Effect.withTracer(tracer)))
    expect(spans.map((span) => [span.name, span.status._tag === "Ended" ? span.status.exit._tag : "open"])).toEqual([
      ["host.turn", "Success"], ["memory.open", "Success"], ["memory.open", "Failure"],
    ])
    expect(Option.map(spans[1]!.parent, (parent) => parent.spanId)).toEqual(Option.some(spans[0]!.spanId))
  })
})
