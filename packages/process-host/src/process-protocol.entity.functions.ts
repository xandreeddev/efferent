import { Cause, Effect, Match, Option, Schema } from "effect"
import { TurnEndedData, TurnEvent, TurnStartedData } from "@xandreed/core"
import type { SessionAddress, SessionLogEvent } from "@xandreed/core"
import { ProcessPeerError } from "./process-peer.entity.js"
import {
  ProcessCommand,
  ProcessEvent,
  ProcessFullEvent,
  ProcessProgress,
} from "./process-protocol.entity.js"
import type { ProcessEventMode, ProcessProjection, ProcessRequestId } from "./process-protocol.entity.js"

const strict = { onExcessProperty: "error" } as const

/** Preserve interruptions; codec/foreign defects become one owned failure with no input text on the wire. */
const boundary = <A, E>(effect: Effect.Effect<A, E>, direction: "input" | "output"): Effect.Effect<A, ProcessPeerError> =>
  effect.pipe(Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
    ? Effect.failCause(Cause.fromReasons(cause.reasons.filter(Cause.isInterruptReason)))
    : Effect.fail(new ProcessPeerError({
      reason: direction === "input" ? "InvalidFrame" : "InvalidEvent",
      direction,
      message: direction === "input" ? "The process command is invalid" : "The process event could not be encoded",
      cause,
    }))))

const snapshotJson = (value: unknown) => Effect.try({ try: () => structuredClone(value), catch: (cause) => cause }).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.JsonObject)),
)

/** Decode one complete JSON command; native framing, byte limits and UTF8 belong to ProcessPeer. @public */
export const decodeProcessCommand = Effect.fnUntraced(function* (text: string): Effect.fn.Return<ProcessCommand, ProcessPeerError> {
  return yield* boundary(Effect.suspend(() => Schema.decodeUnknownEffect(Schema.fromJsonString(ProcessCommand))(text, strict)), "input")
})

const snapshotFullProgress = Effect.fnUntraced(function* (event: ProcessEvent): Effect.fn.Return<ProcessEvent, unknown> {
  return yield* ProcessEvent.matchOrElse(event, {
    "turn.event": (frame): Effect.Effect<ProcessEvent, unknown> => ProcessProgress.match(frame.progress, {
      projection: () => Effect.succeed(frame),
      full: (progress) => snapshotJson(progress.event).pipe(
        Effect.flatMap((snapshot) => Schema.decodeUnknownEffect(ProcessProgress.cases.full)({ mode: "full", event: snapshot }, strict)),
        Effect.map((snapshot) => ({ ...frame, progress: snapshot })),
      ),
    }),
  }, (frame): Effect.Effect<ProcessEvent, unknown> => Effect.succeed(frame))
})

/** Encode JSON without a line terminator. The peer admits and serializes writes before calling this helper. @public */
export const encodeProcessEvent = Effect.fnUntraced(function* (event: ProcessEvent): Effect.fn.Return<string, ProcessPeerError> {
  return yield* boundary(Effect.suspend(() => snapshotFullProgress(event).pipe(
    Effect.flatMap(Schema.encodeEffect(ProcessEvent)),
    Effect.flatMap(snapshotJson),
    Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))),
  )), "output")
})

const toolIdentity = (event: Extract<TurnEvent, { readonly _tag: "tool.started" | "tool.completed" | "tool.refused" | "tool.progress" }>) => ({
  step: event.step,
  invocationId: event.invocationId,
  ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
  tool: event.tool,
})

const projectionOf = (event: TurnEvent): Option.Option<ProcessProjection> => TurnEvent.matchOrElse(event, {
  "step.started": (value): Option.Option<ProcessProjection> => Option.some({ _tag: "step.started", step: value.step, run: value.run, planned: value.planned }),
  "step.ended": (value): Option.Option<ProcessProjection> => Option.some({ _tag: "step.ended", step: value.step, run: value.run, status: value.status }),
  "assistant.delta": (value): Option.Option<ProcessProjection> => value.channel === "text"
    ? Option.some({ _tag: "assistant.delta", step: value.step, id: value.id, delta: value.delta }) : Option.none(),
  "assistant.message": (value): Option.Option<ProcessProjection> => Option.some({ _tag: "assistant.message", step: value.step, run: value.run, text: value.text }),
  "tool.started": (value): Option.Option<ProcessProjection> => Option.some({ _tag: "tool.started", ...toolIdentity(value) }),
  "tool.completed": (value): Option.Option<ProcessProjection> => Option.some({ _tag: "tool.completed", ...toolIdentity(value), ok: value.ok }),
  "tool.refused": (value): Option.Option<ProcessProjection> => Option.some({ _tag: "tool.refused", ...toolIdentity(value), reason: value.reason }),
  "tool.progress": (value): Option.Option<ProcessProjection> => value.channel === "status"
    ? Option.some({ _tag: "tool.progress", ...toolIdentity(value), text: value.text }) : Option.none(),
  "stream.fallback": (value): Option.Option<ProcessProjection> => Option.some({ _tag: "stream.fallback", step: value.step, run: value.run }),
}, () => Option.none())

/** Field-selected UI progress by default, or an explicit JSON snapshot of full non-lifecycle content. @public */
export const processProgressOf = Effect.fnUntraced(function* (event: TurnEvent, mode: ProcessEventMode): Effect.fn.Return<Option.Option<ProcessProgress>, ProcessPeerError> {
  return yield* boundary(Effect.suspend(() => {
    if (TurnEvent.isAnyOf(["turn.started", "turn.ended"])(event)) return Effect.succeed(Option.none<ProcessProgress>())
    return Match.value(mode).pipe(
      Match.when("projection", () => Effect.succeed(Option.map(projectionOf(event), (projected): ProcessProgress => ({ mode: "projection", event: projected })))),
      Match.when("full", () => Schema.encodeEffect(ProcessFullEvent)(event).pipe(
        Effect.flatMap(snapshotJson),
        Effect.flatMap((snapshot) => Schema.decodeUnknownEffect(ProcessProgress.cases.full)({ mode: "full", event: snapshot }, strict)),
        Effect.map(Option.some),
      )),
      Match.exhaustive,
    )
  }), "output")
})

/** Project only actual acknowledged lifecycle rows; the caller filters the logical log's owner first. @public */
export const processLifecycleOf = Effect.fnUntraced(function* (
  session: SessionAddress,
  row: SessionLogEvent,
  requestId?: ProcessRequestId,
): Effect.fn.Return<Option.Option<ProcessEvent>, ProcessPeerError> {
  return yield* boundary(Effect.suspend(() => Effect.gen(function* () {
    if (row.kind !== "turn.started" && row.kind !== "turn.ended") return Option.none()
    const turn = yield* Schema.decodeUnknownEffect(ProcessEvent.cases["turn.ended"].fields.turn)(Option.getOrElse(row.turn, () => 0))
    const identity = { session, turn, ...(requestId === undefined ? {} : { requestId }), journal: { seq: row.seq, at: row.at } }
    const frame: ProcessEvent = row.kind === "turn.started"
      ? yield* Schema.decodeUnknownEffect(TurnStartedData)(row.data).pipe(Effect.map((data): ProcessEvent => ({
        _tag: "turn.started", ...identity, runId: data.runId, origin: data.origin,
        ...(data.input === undefined ? {} : { input: data.input }),
        ...(data.task === undefined ? {} : { task: data.task }),
        ...(data.resumes === undefined ? {} : { resumes: data.resumes }),
      })))
      : yield* Schema.decodeUnknownEffect(TurnEndedData)(row.data).pipe(Effect.map((data): ProcessEvent => ({
        _tag: "turn.ended", ...identity, reason: data.reason,
        ...Option.match(data.failure, { onNone: () => ({}), onSome: (failure) => ({ failureCode: failure.code }) }),
      })))
    return Option.some(yield* Schema.decodeUnknownEffect(ProcessEvent)(frame, strict))
  })), "output")
})
