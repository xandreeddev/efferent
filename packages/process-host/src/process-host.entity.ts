import { Schema } from "effect"
import type { Context, Effect, Option, Scope } from "effect"
import { ProcessErrorCode, ProcessEventMode, ProcessRequestId } from "./process-protocol.entity.js"
import { RunId, SessionAddress } from "@xandreed/core"
import type {
  ProcessActivity, SessionLog, SessionLogError, Sessions, ShutdownOptions, ShutdownReport,
  Tasks, Turn, TurnError, TurnOutcome, TurnRunner, TurnServices,
} from "@xandreed/core"

/** Services captured from the same host scope as every direct, queued and task turn. @public */
export interface ProcessBinding {
  readonly runner: TurnRunner
  readonly services: Context.Context<never>
  readonly use: (turn: Turn) => Effect.Effect<TurnOutcome, TurnError, TurnServices | Scope.Scope>
  readonly sessions: Context.Service.Shape<typeof Sessions>
  readonly tasks: Option.Option<Context.Service.Shape<typeof Tasks>>
  readonly activity: Effect.Effect<ProcessActivity, SessionLogError>
  readonly shutdown: (options: ShutdownOptions) => Effect.Effect<ShutdownReport>
}

/** Install both wrappers before constructing the host's Sessions, Agent and bridges. @public */
export interface ProcessObservers {
  readonly sessionLog: (inner: Context.Service.Shape<typeof SessionLog>) => Context.Service.Shape<typeof SessionLog>
  readonly turnRunner: (inner: TurnRunner) => TurnRunner
}

const Positive = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))

/** Bounded command admission; transport byte and native write limits belong to StdioPeerLive. @public */
export const ProcessHostConfig = Schema.Struct({
  owners: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty())).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  events: ProcessEventMode,
  maxBegins: Positive.check(Schema.isLessThanOrEqualTo(64)),
  maxShortCommands: Positive.check(Schema.isLessThanOrEqualTo(256)),
  controlCapacity: Positive.check(Schema.isLessThanOrEqualTo(64)),
  handshakeTimeoutMs: Positive,
  shutdown: Schema.Struct({ deadlineMs: Count, reserveMs: Count }).check(Schema.makeFilter((value) =>
    value.reserveMs <= value.deadlineMs || "shutdown reserve must not exceed the deadline")),
})
export type ProcessHostConfig = typeof ProcessHostConfig.Type

/** @public */
export const processHostDefaults: Omit<ProcessHostConfig, "owners"> = {
  events: "projection", maxBegins: 8, maxShortCommands: 32, controlCapacity: 8,
  handshakeTimeoutMs: 10_000, shutdown: { deadlineMs: 25_000, reserveMs: 2_000 },
}

/** The parent supplies setup and explicitly owns startup reconciliation/takeover policy. @public */
export interface ProcessHostOptions<E = never> extends Partial<Omit<ProcessHostConfig, "owners" | "shutdown">> {
  readonly owners: ProcessHostConfig["owners"]
  readonly shutdown?: Partial<ProcessHostConfig["shutdown"]>
  readonly setup: (observe: ProcessObservers) => Effect.Effect<ProcessBinding, E, Scope.Scope>
  /** A native signal or an embedding host's stop request; it may complete before setup. */
  readonly stop?: Effect.Effect<void>
  /** Runs once before shutdown/teardown can block, so the native edge can start its hard timer. */
  readonly onStopping?: Effect.Effect<void>
}

/** No native exit occurs in serveProcess; a signal before setup has no shutdown report. @public */
export interface ProcessHostResult {
  readonly reason: "shutdown" | "eof" | "signal"
  readonly report: Option.Option<ShutdownReport>
}

/** Safe host failure; raw causes remain local and are never sent as wire messages. @public */
export class ProcessHostError extends Schema.TaggedError<ProcessHostError>()("ProcessHostError", {
  reason: Schema.Literals(["Config", "Protocol", "Setup", "Peer", "Runtime"]),
  code: ProcessErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Internal bounded command identity; no model messages or attachment bytes are retained here. */
export const ProcessActiveRequest = Schema.Struct({
  requestId: ProcessRequestId,
  lane: Schema.Literals(["begin", "short", "control"]),
  begin: Schema.OptionFromNullOr(Schema.Struct({ session: SessionAddress, runId: RunId, turn: Schema.OptionFromNullOr(Positive) })),
})
export type ProcessActiveRequest = typeof ProcessActiveRequest.Type

/** The dispatcher transitions this aggregate atomically, then performs side effects. */
export const ProcessDispatchState = Schema.Union([
  Schema.TaggedStruct("AwaitingHello", { requests: Schema.Array(ProcessActiveRequest) }),
  Schema.TaggedStruct("Starting", { requests: Schema.Array(ProcessActiveRequest) }),
  Schema.TaggedStruct("Open", { requests: Schema.Array(ProcessActiveRequest) }),
  Schema.TaggedStruct("Stopping", { requests: Schema.Array(ProcessActiveRequest) }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ProcessDispatchState = typeof ProcessDispatchState.Type
