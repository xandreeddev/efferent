import { expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { harnessError } from "../harness/harness-code.entity.functions.js"
import { SessionLogError } from "../session/session-log.entity.js"
import { BeforeToolDecision, AfterToolDecision, ToolInterceptAudit, ToolResultInterception } from "./tool-interceptor.entity.js"
import { toolInterceptError } from "./tool-interceptor.entity.functions.js"
import { InvocationId } from "./run.entity.js"

test("interceptor decisions distinguish explicit success/failure without inspecting result fields", async () => {
  expect(BeforeToolDecision.discriminants).toEqual(["Allow", "Deny", "Rewrite", "Respond"])
  expect(AfterToolDecision.discriminants).toEqual(["Keep", "Replace"])
  const value = { _tag: "Respond", outcome: { _tag: "Success", encoded: { error: "business data", message: "still success" } } } as const
  expect(await Effect.runPromise(Schema.decodeUnknownEffect(BeforeToolDecision)(value))).toEqual(value)
  expect(Option.isNone(Schema.decodeUnknownOption(BeforeToolDecision, { onExcessProperty: "error" })({ _tag: "Rewrite", input: null, tool: "retarget" }))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(AfterToolDecision, { onExcessProperty: "error" })({ _tag: "Replace", outcome: { _tag: "Failure", encoded: null, extra: true } }))).toBe(true)
})

test("audit projections omit encoded synthetic answers while rewrite null remains an input", () => {
  expect(Schema.decodeUnknownOption(ToolInterceptAudit)({ _tag: "Before", decision: { _tag: "Rewrite", input: null } })).toEqual(Option.some({ _tag: "Before", decision: { _tag: "Rewrite", input: null } }))
  expect(Option.isSome(Schema.decodeUnknownOption(ToolInterceptAudit)({ _tag: "After", decision: { _tag: "Replace", kind: "Success" } }))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(ToolInterceptAudit, { onExcessProperty: "error" })({ _tag: "Before", decision: { _tag: "Respond", outcome: { _tag: "Success", encoded: "not duplicated" } } }))).toBe(true)
})

test("result metadata distinguishes missing effective input from explicit null", async () => {
  const invocationId = InvocationId.make("run:call:1")
  expect(await Effect.runPromise(Schema.encodeEffect(ToolResultInterception)({ invocationId }))).toEqual({ invocationId })
  expect(await Effect.runPromise(Schema.encodeEffect(ToolResultInterception)({ invocationId, effectiveInput: null }))).toEqual({ invocationId, effectiveInput: null })
  expect(Option.isNone(Schema.decodeUnknownOption(ToolResultInterception)({ invocationId, effectiveInput: undefined }))).toBe(true)
})

test("interceptor failure text is exact and original TurnError identity survives", () => {
  const cause = new Error("foreign interceptor fixture")
  expect(toolInterceptError(cause)).toEqual(harnessError("tool.intercept", "The tool interceptor could not finish the call.", cause))
  const original = new SessionLogError({ code: "store.io", message: "original ACK" })
  expect(toolInterceptError(original)).toBe(original)
})

test("interception audit is one reserved nonmemory journal fact with no synthetic answer bytes", async () => {
  const { ToolInterceptedEvent } = await import("../turn/turn-event.entity.js")
  const { draftOfTurnEvent, entriesOfEvents, journalSchemaOf } = await import("../session/session-event.entity.functions.js")
  const { JOURNAL_KINDS, MEMORY_KINDS, RESERVED_KINDS } = await import("../session/session-event.entity.js")
  const { ConversationId, ToolCallId } = await import("./message.entity.js")
  const { RunId, RunOrdinal } = await import("./run.entity.js")
  const event = { _tag: "tool.intercepted" as const, tool: "read", toolCallId: ToolCallId.make("call"), invocationId: InvocationId.make("r:call:1"), step: 0,
    run: Option.some({ id: RunId.make("r"), turn: 1, ordinal: RunOrdinal.make(0) }), phase: { _tag: "Before" as const, decision: { _tag: "Respond" as const, kind: "Success" as const } } }
  const draft = Option.getOrThrow(await Effect.runPromise(draftOfTurnEvent(1, event)))
  expect(draft.data).toEqual({ tool: "read", toolCallId: "call", invocationId: "r:call:1", step: 0, run: { id: "r", turn: 1, ordinal: 0 }, phase: { _tag: "Before", decision: { _tag: "Respond", kind: "Success" } } })
  const row = { ...draft, session: ConversationId.make("00000000-0000-4000-8000-000000000029"), seq: 1, at: 0 }
  const schema = Option.getOrThrow(journalSchemaOf("tool.intercepted"))
  expect(await Effect.runPromise(Schema.decodeUnknownEffect(schema)(draft.data))).toMatchObject({ tool: "read", run: event.run, phase: event.phase })
  expect(Schema.is(ToolInterceptedEvent)(event)).toBe(true)
  expect(await Effect.runPromise(entriesOfEvents([row]))).toEqual([])
  expect(JOURNAL_KINDS.filter((kind) => kind === "tool.intercepted")).toHaveLength(1)
  expect(RESERVED_KINDS.filter((kind) => kind === "tool.intercepted")).toHaveLength(1)
  expect(MEMORY_KINDS.includes("tool.intercepted")).toBe(false)
})
