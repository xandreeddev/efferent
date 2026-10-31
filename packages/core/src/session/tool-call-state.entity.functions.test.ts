import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { ConversationId, ToolCallId } from "../domain/message.entity.js"
import { InvocationId, RunId, RunOrdinal } from "../domain/run.entity.js"
import { EntryId } from "../memory/memory-log.entity.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import type { TurnEvent } from "../turn/turn-event.entity.js"
import { draftOfEntry, draftOfTurnEvent } from "./session-event.entity.functions.js"
import type { SessionDraft, SessionLogEvent } from "./session-log.entity.js"
import { toolCallStatesOf } from "./tool-call-state.entity.functions.js"
import { ToolCallState } from "./tool-call-state.entity.js"

const session = ConversationId.make("00000000-0000-4000-8000-0000000007ca")
const callId = ToolCallId.make("provider:call")
const invocationId = InvocationId.make("run-1:call:0")
const requested = (turn = 1, providerExecuted = false): LogEntry => ({
  id: EntryId.make(`run-${turn}:1`), runId: RunId.make(`run-${turn}`), turn, step: 1, at: 10,
  body: { _tag: "Message", message: { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName: "lookup", input: { query: "encoded" }, providerExecuted }] } },
})
const completed = (turn = 1): LogEntry => ({
  id: EntryId.make(`run-${turn}:2`), runId: RunId.make(`run-${turn}`), turn, step: 1, at: 20,
  body: { _tag: "ToolResult", toolCallId: callId, toolName: "lookup", encoded: { rows: 1 }, isError: false, view: "one row", viewVersion: "1", subjects: [], artifacts: [], pinned: false },
})
const started = (withId = true): Extract<TurnEvent, { readonly _tag: "tool.started" }> => ({
  _tag: "tool.started", step: 1, invocationId, ...(withId ? { toolCallId: callId } : {}), tool: "lookup", input: { query: "decoded" }, labels: {}, stage: Option.none(),
})
const returned = (withId = true): Extract<TurnEvent, { readonly _tag: "tool.completed" }> => ({
  _tag: "tool.completed", step: 1, invocationId, ...(withId ? { toolCallId: callId } : {}), tool: "lookup", input: { query: "decoded" }, ok: true, result: { rows: 1 }, encoded: { rows: 1 }, durationMs: 1, labels: {}, stage: Option.none(),
})
const memory = (entry: LogEntry): Effect.Effect<SessionDraft, Schema.SchemaError> => draftOfEntry(entry).pipe(Effect.map(Option.getOrThrow))
const bus = (event: TurnEvent, turn = 1): Effect.Effect<SessionDraft, Schema.SchemaError> => draftOfTurnEvent(turn, event).pipe(Effect.map(Option.getOrThrow))
const journal = (...drafts: ReadonlyArray<Effect.Effect<SessionDraft, Schema.SchemaError>>): Effect.Effect<ReadonlyArray<SessionLogEvent>, Schema.SchemaError> =>
  Effect.forEach(drafts, (draft, index) => draft.pipe(Effect.map((draft) => ({ ...draft, session, seq: index + 1, at: (index + 1) * 10 }))))

describe("toolCallStatesOf", () => {
  test("every durable prefix distinguishes requested, admitted, returned and recorded results without claiming an incomplete call is safe to retry", async () => {
    const events = await Effect.runPromise(journal(memory(requested()), bus(started()), bus(returned()), memory(completed())))
    const prefixes = await Effect.runPromise(Effect.forEach([1, 2, 3, 4], (length) => toolCallStatesOf(events.slice(0, length))))
    expect(prefixes.map((states) => states.map((state) => state._tag))).toEqual([["Requested"], ["Started"], ["Returned"], ["Completed"]])
    expect(prefixes[1]?.[0]).toMatchObject({ toolCallId: callId, input: { query: "encoded" }, started: { invocationId, seq: 2, input: { query: "decoded" } } })
    expect(prefixes[2]?.[0]).toMatchObject({ returned: { invocationId, seq: 3, ok: true } })
    expect(prefixes[3]?.[0]).toMatchObject({ result: { entry: "run-1:2", seq: 4, encoded: { rows: 1 }, isError: false } })
    prefixes.flat().forEach((state) => expect(Schema.is(ToolCallState)(state)).toBe(true))
  })

  test("a refused call remains refused when its failed result is recorded", async () => {
    const refusal: TurnEvent = { _tag: "tool.refused", step: 1, invocationId, toolCallId: callId, tool: "lookup", input: {}, reason: "denied", message: "Use the allowed source" }
    const result = completed()
    const events = await Effect.runPromise(journal(memory(requested()), bus(refusal), memory({ ...result, body: { ...result.body as Extract<LogEntry["body"], { _tag: "ToolResult" }>, isError: true, encoded: { error: "PolicyDenied", message: "Use the allowed source" } } })))
    const states = await Effect.runPromise(toolCallStatesOf(events))
    expect(states).toMatchObject([{ _tag: "Refused", invocationId, refusedSeq: 2, reason: "denied", message: "Use the allowed source", result: Option.some({ entry: "run-1:2", seq: 3, encoded: { error: "PolicyDenied", message: "Use the allowed source" }, isError: true }) }])
    expect(Schema.is(ToolCallState)(states[0])).toBe(true)
  })

  test("older lifecycle records lacking the provider id never prove that a particular request started", async () => {
    const events = await Effect.runPromise(journal(memory(requested()), bus(started(false)), bus(returned(false)), memory(completed())))
    const partial = await Effect.runPromise(toolCallStatesOf(events.slice(0, 3)))
    const complete = await Effect.runPromise(toolCallStatesOf(events))
    expect(partial.map((state) => state._tag)).toEqual(["Requested"])
    expect(complete).toMatchObject([{ _tag: "Completed", started: Option.none(), returned: Option.none() }])
  })

  test("the earlier format-3 order, with lifecycle events before the assistant message, still correlates by id", async () => {
    const events = await Effect.runPromise(journal(bus(started()), bus(returned()), memory(requested()), memory(completed())))
    expect(await Effect.runPromise(toolCallStatesOf(events))).toMatchObject([{ _tag: "Completed", requestedSeq: 3, started: Option.some({ invocationId, seq: 1, input: { query: "decoded" } }), returned: Option.some({ invocationId, seq: 2, ok: true }) }])
  })

  test("provider-executed calls are the provider's; reused ids in another turn have independent state", async () => {
    const events = await Effect.runPromise(journal(memory(requested(1)), bus(started()), memory(requested(2)), memory(completed(2)), memory(requested(3, true))))
    expect((await Effect.runPromise(toolCallStatesOf(events))).map((state) => [state.turn, state._tag])).toEqual([[1, "Started"], [2, "Completed"]])
  })

  test("a provider id reused in another step never changes the earlier result", async () => {
    const firstResult = completed()
    const secondRequest = { ...requested(), id: EntryId.make("run-1:3"), step: 2 }
    const secondResult = { ...completed(), id: EntryId.make("run-1:4"), step: 2, body: { ...firstResult.body as Extract<LogEntry["body"], { _tag: "ToolResult" }>, encoded: "second" } }
    const events = await Effect.runPromise(journal(memory(requested()), memory(firstResult), memory(secondRequest), memory(secondResult)))
    expect((await Effect.runPromise(toolCallStatesOf(events))).map((state) => [state.step, state._tag === "Completed" ? state.result.encoded : "missing"])).toEqual([[1, { rows: 1 }], [2, "second"]])
  })

  test("run boundaries disambiguate the old lifecycle-before-assistant order when a later Turn.run reuses an id and step", async () => {
    const boundary = (run: number): TurnEvent => ({ _tag: "step.started", step: 1, run: RunOrdinal.make(run), planned: false, activeTools: ["lookup"] })
    const secondRequest = { ...requested(), id: EntryId.make("run-1:3") }
    const secondResult = { ...completed(), id: EntryId.make("run-1:4") }
    const events = await Effect.runPromise(journal(
      bus(boundary(0)), bus(started()), bus(returned()), memory(requested()), memory(completed()),
      bus(boundary(1)), bus({ ...started(), invocationId: InvocationId.make("run-1:call:1") }), bus({ ...returned(), invocationId: InvocationId.make("run-1:call:1") }), memory(secondRequest), memory(secondResult),
    ))
    const states = await Effect.runPromise(toolCallStatesOf(events))
    expect(states.map((state) => [Number(state.run), state._tag, state._tag === "Completed" ? Option.map(state.started, (started) => Number(started.seq)) : Option.none()])).toEqual([[0, "Completed", Option.some(2)], [1, "Completed", Option.some(7)]])
  })

  test("without run boundaries, reused ids in the same step never receive ambiguous lifecycle evidence", async () => {
    const secondRequest = { ...requested(), id: EntryId.make("run-1:3") }
    const secondResult = { ...completed(), id: EntryId.make("run-1:4") }
    const events = await Effect.runPromise(journal(
      bus(started()), bus(returned()), memory(requested()), memory(completed()),
      bus({ ...started(), invocationId: InvocationId.make("run-1:call:1") }), bus({ ...returned(), invocationId: InvocationId.make("run-1:call:1") }), memory(secondRequest), memory(secondResult),
    ))
    expect((await Effect.runPromise(toolCallStatesOf(events))).map((state) => state._tag === "Completed" ? [state._tag, Option.isNone(state.started), Option.isNone(state.returned)] : [state._tag])).toEqual([["Completed", true, true], ["Completed", true, true]])
  })

  test("a broken relevant journal row fails decoding rather than disappearing", async () => {
    const events = await Effect.runPromise(journal(memory(requested()), bus(started())))
    const broken = events.map((event) => event.kind === "tool.started" ? { ...event, data: { ...event.data, invocationId: 1 } } : event)
    const failure = await Effect.runPromise(Effect.result(toolCallStatesOf(broken)))
    expect(failure._tag === "Failure" ? failure.failure._tag : "success").toBe("SchemaError")
  })
})


test("explicit run ordinals keep interleaved same-id results separate and omit ambiguous lifecycle evidence", async () => {
  const first = requested()
  const firstBody = first.body as Extract<LogEntry["body"], { _tag: "Message" }>
  const firstResult = completed()
  const resultBody = firstResult.body as Extract<LogEntry["body"], { _tag: "ToolResult" }>
  const second = { ...first, id: EntryId.make("run-1:3"), body: { ...firstBody, run: RunOrdinal.make(1) } }
  const events = await Effect.runPromise(journal(
    memory({ ...first, body: { ...firstBody, run: RunOrdinal.make(0) } }),
    memory(second), bus(started()), bus({ ...started(), invocationId: InvocationId.make("run-1:call:1") }),
    bus({ ...returned(), invocationId: InvocationId.make("run-1:call:1") }),
    memory({ ...firstResult, id: EntryId.make("run-1:4"), body: { ...resultBody, run: RunOrdinal.make(1), encoded: "second" } }),
    bus(returned()), memory({ ...firstResult, body: { ...resultBody, run: RunOrdinal.make(0), encoded: "first" } }),
  ))
  const partial = await Effect.runPromise(toolCallStatesOf(events.slice(0, 5)))
  expect(partial.map((state) => [Number(state.run), state._tag])).toEqual([[0, "Requested"], [1, "Requested"]])
  const all = await Effect.runPromise(toolCallStatesOf(events))
  expect(all.map((state) => [Number(state.run), state._tag === "Completed" ? state.result.encoded : "missing"])).toEqual([[0, "first"], [1, "second"]])
  expect(all.every((state) => state._tag === "Completed" && Option.isNone(state.started))).toBe(true)
})

describe("intercepted call facts", () => {
  const requestIn = (ordinal: number, index: number): LogEntry => ({ ...requested(), id: EntryId.make(`run-1:${index}`), body: { ...requested().body as Extract<LogEntry["body"], { _tag: "Message" }>, run: RunOrdinal.make(ordinal) } })
  const interception = (ordinal: number, id: InvocationId, decision: Extract<TurnEvent, { _tag: "tool.intercepted" }>["phase"]): TurnEvent => ({
    _tag: "tool.intercepted", source: "loop", tool: "lookup", toolCallId: callId, invocationId: id, step: 1,
    run: Option.some({ id: RunId.make("run-1"), turn: 1, ordinal: RunOrdinal.make(ordinal) }), phase: decision,
  })
  test("full-run audit identity disambiguates Returned while a sibling reuses the provider id", async () => {
    const second = InvocationId.make("run-1:call:1")
    const events = await Effect.runPromise(journal(
      memory(requestIn(0, 1)), bus(interception(0, invocationId, { _tag: "Before", decision: { _tag: "Rewrite", input: { query: "effective" } } })), bus(started()),
      memory(requestIn(1, 3)), bus(interception(1, second, { _tag: "Before", decision: { _tag: "Respond", kind: "Success" } })), bus(returned()),
    ))
    const states = await Effect.runPromise(toolCallStatesOf(events))
    expect(states.map((state) => [state.run, state._tag])).toEqual([[RunOrdinal.make(0), "Returned"], [RunOrdinal.make(1), "Requested"]])
    expect(states[0]).toMatchObject({ input: { query: "encoded" }, returned: { invocationId } })
  })

  test("synthetic Completed retains result metadata without inventing handler lifecycle", async () => {
    const result: LogEntry = { ...completed(), body: { ...completed().body as Extract<LogEntry["body"], { _tag: "ToolResult" }>, run: RunOrdinal.make(0), interception: { invocationId, effectiveInput: null } } }
    const events = await Effect.runPromise(journal(memory(requestIn(0, 1)), bus(interception(0, invocationId, { _tag: "Before", decision: { _tag: "Respond", kind: "Success" } })), memory(result)))
    const [state] = await Effect.runPromise(toolCallStatesOf(events))
    expect(state).toMatchObject({ _tag: "Completed", started: Option.none(), returned: Option.none(), result: { interception: { invocationId, effectiveInput: null } } })
    expect(Schema.is(ToolCallState)(state)).toBe(true)
  })

  test("malformed intercepted facts fail decoding rather than being silently ignored", async () => {
    const events = await Effect.runPromise(journal(memory(requestIn(0, 1))))
    const invalid = { ...events[0]!, seq: 2, kind: "tool.intercepted", data: { invocationId, tool: "lookup", step: 1, run: null, phase: { _tag: "After", decision: { _tag: "Replace", kind: "invalid" } } } }
    expect((await Effect.runPromise(toolCallStatesOf([...events, invalid]).pipe(Effect.result)))._tag).toBe("Failure")
  })
})

test("a loop-source audit identifies the root while nested direct calls reuse its public identity", async () => {
  const nested = InvocationId.make("run-1:call:1")
  const request = { ...requested(), body: { ...requested().body as Extract<LogEntry["body"], { _tag: "Message" }>, run: RunOrdinal.make(0) } }
  const audit = (id: InvocationId): TurnEvent => ({ _tag: "tool.intercepted", source: id === invocationId ? "loop" : "direct", step: 1, invocationId: id, toolCallId: callId, tool: "lookup", run: Option.some({ id: RunId.make("run-1"), turn: 1, ordinal: RunOrdinal.make(0) }), phase: { _tag: "Before", decision: { _tag: "Allow" } } })
  const events = await Effect.runPromise(journal(memory(request), bus(audit(invocationId)), bus(started()), bus(audit(nested)), bus({ ...started(), invocationId: nested }), bus({ ...returned(), invocationId: nested }), bus(returned())))
  expect((await Effect.runPromise(toolCallStatesOf(events)))[0]).toMatchObject({ _tag: "Returned", started: Option.some({ invocationId }), returned: { invocationId } })
  const result: LogEntry = { ...completed(), body: { ...completed().body as Extract<LogEntry["body"], { _tag: "ToolResult" }>, run: RunOrdinal.make(0), interception: { invocationId } } }
  const memoryDraft = await Effect.runPromise(memory(result))
  const [settled] = await Effect.runPromise(toolCallStatesOf([...events, { ...memoryDraft, session, seq: events.length + 1, at: 80 }]))
  expect(settled).toMatchObject({ _tag: "Completed", started: Option.some({ invocationId }), returned: Option.some({ invocationId }), result: { interception: { invocationId } } })
})

test("direct or absent audit source never supplies positive root lifecycle evidence", async () => {
  await Effect.runPromise(Effect.forEach([{}, { source: "direct" as const }], (source) => Effect.gen(function* () {
    const request = { ...requested(), body: { ...requested().body as Extract<LogEntry["body"], { _tag: "Message" }>, run: RunOrdinal.make(0) } }
    const audit: TurnEvent = { _tag: "tool.intercepted", ...source, tool: "lookup", invocationId, toolCallId: callId, step: 1, run: Option.some({ id: RunId.make("run-1"), turn: 1, ordinal: RunOrdinal.make(0) }), phase: { _tag: "Before", decision: { _tag: "Allow" } } }
    const events = yield* journal(memory(request), bus(audit), bus(started()), bus(returned()))
    expect((yield* toolCallStatesOf(events))[0]?._tag).toBe("Requested")
  }), { concurrency: 1 }))
})
