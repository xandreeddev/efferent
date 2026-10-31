import { Schema, Struct } from "effect"
import {
  ConversationId,
  HarnessCode,
  InboxItemId,
  InvocationId,
  JsonObject,
  ProcessActivity,
  QueuedInput,
  RunId,
  RunKey,
  SessionAddress,
  ShutdownReport,
  StepStatus,
  StreamPartId,
  TaskQuestion,
  TaskQuestionId,
  TaskRef,
  TokenUsage,
  ToolCallId,
  ToolRefusalReason,
  TurnEndReason,
  TurnEvent,
  TurnOrigin,
  TurnOutcomeKind,
  UserMessage,
} from "@xandreed/core"

/** The supported wire protocol; stored journal formats have their own version. @public */
export const PROCESS_PROTOCOL_VERSION = 1

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const Positive = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))

/** Correlates an outstanding command; durable idempotence belongs to framework input/key identities. @public */
export const ProcessRequestId = Schema.Trimmed.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_.:-]+$/),
).pipe(Schema.brand("ProcessRequestId"))
export type ProcessRequestId = typeof ProcessRequestId.Type

/** Full progress exports all JSON-compatible event content and must be selected explicitly. @public */
export const ProcessEventMode = Schema.Literals(["projection", "full"])
export type ProcessEventMode = typeof ProcessEventMode.Type

const Input = QueuedInput.mapFields(Struct.omit(["delivery"]))

/** Version 1 requests. The parent host creates sessions and supplies the Agent and its services. @public */
export const ProcessCommand = Schema.Union([
  Schema.TaggedStruct("hello", { requestId: ProcessRequestId, protocolVersion: Positive }),
  Schema.TaggedStruct("begin", {
    requestId: ProcessRequestId,
    session: SessionAddress,
    runId: RunId,
    userMessage: UserMessage,
    key: Schema.optionalKey(Schema.String),
    command: Schema.optionalKey(JsonObject),
    meta: Schema.optionalKey(JsonObject),
    resumes: Schema.optionalKey(Positive),
    takeOver: Schema.optionalKey(Schema.Boolean),
    timeLimitMs: Schema.optionalKey(Positive),
  }),
  Schema.TaggedStruct("send", { requestId: ProcessRequestId, session: SessionAddress, input: Input }),
  Schema.TaggedStruct("steer", { requestId: ProcessRequestId, session: SessionAddress, input: Input }),
  Schema.TaggedStruct("answer", {
    requestId: ProcessRequestId,
    parent: SessionAddress,
    taskId: ConversationId,
    questionId: TaskQuestionId,
    text: TaskQuestion.fields.text,
  }),
  Schema.TaggedStruct("cancel", { requestId: ProcessRequestId, session: SessionAddress, turn: Positive }),
  Schema.TaggedStruct("ping", { requestId: ProcessRequestId }),
  Schema.TaggedStruct("shutdown", { requestId: ProcessRequestId, deadlineMs: Schema.optionalKey(Count) }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ProcessCommand = typeof ProcessCommand.Type

const ToolIdentity = {
  step: Count,
  invocationId: InvocationId,
  toolCallId: Schema.optionalKey(ToolCallId),
  tool: Schema.String,
}

/** UI progress with explicit field selection; decoded tool values and provider failures are excluded. */
export const ProcessProjection = Schema.Union([
  Schema.TaggedStruct("step.started", { step: Count, run: RunKey, planned: Schema.Boolean }),
  Schema.TaggedStruct("step.ended", { step: Count, run: RunKey, status: StepStatus }),
  Schema.TaggedStruct("assistant.delta", { step: Count, id: StreamPartId, delta: Schema.String }),
  Schema.TaggedStruct("assistant.message", { step: Count, run: RunKey, text: Schema.String }),
  Schema.TaggedStruct("tool.started", ToolIdentity),
  Schema.TaggedStruct("tool.completed", { ...ToolIdentity, ok: Schema.Boolean }),
  Schema.TaggedStruct("tool.refused", { ...ToolIdentity, reason: ToolRefusalReason }),
  Schema.TaggedStruct("tool.progress", { ...ToolIdentity, text: Schema.String }),
  Schema.TaggedStruct("stream.fallback", { step: Count, run: RunKey }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ProcessProjection = typeof ProcessProjection.Type

/** Bus lifecycle events are provisional; only acknowledged SessionLog rows produce lifecycle frames. */
export const ProcessFullEvent = Schema.Union([
  TurnEvent.cases["step.started"],
  TurnEvent.cases["tool.started"],
  TurnEvent.cases["tool.refused"],
  TurnEvent.cases["tool.progress"],
  TurnEvent.cases["tool.completed"],
  TurnEvent.cases["step.ended"],
  TurnEvent.cases["completion.evaluated"],
  TurnEvent.cases["skills.activated"],
  TurnEvent.cases["context.built"],
  TurnEvent.cases["decision.recorded"],
  TurnEvent.cases["assistant.message"],
  TurnEvent.cases["assistant.delta"],
  TurnEvent.cases["stream.fallback"],
  TurnEvent.cases.host,
  TurnEvent.cases["model.called"],
  TurnEvent.cases["tool.intercepted"],
])

const FullProgress = Schema.toEncoded(ProcessFullEvent).check(Schema.makeFilter(Schema.is(Schema.JsonObject)))

/** The mode stays explicit in every progress frame. */
export const ProcessProgress = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("projection"), event: ProcessProjection }),
  Schema.Struct({ mode: Schema.Literal("full"), event: FullProgress }),
]).pipe(Schema.toTaggedUnion("mode"))
export type ProcessProgress = typeof ProcessProgress.Type

/** The real TurnRunner result; this command reply is separate from durable turn.ended evidence. */
export const ProcessTurnResult = Schema.Struct({
  outcome: TurnOutcomeKind,
  reply: Schema.OptionFromNullOr(Schema.String),
  usage: TokenUsage,
  pending: Schema.optionalKey(Count),
})
export type ProcessTurnResult = typeof ProcessTurnResult.Type

const TurnIdentity = { session: SessionAddress, turn: Positive }
const Correlation = { requestId: Schema.optionalKey(ProcessRequestId) }
const Journal = Schema.Struct({ seq: Positive, at: Schema.Finite })

/** Owned transport/host failures. Framework codes are optional metadata, never raw error messages. */
export const ProcessErrorCode = HarnessCode.pick([
  "protocol.handshake", "protocol.version", "protocol.sequence", "protocol.invalid",
  "host.busy", "host.owner", "host.stopping", "host.unsupported", "host.command", "host.setup", "host.runtime", "host.peer",
])
export type ProcessErrorCode = typeof ProcessErrorCode.Type

/** Version 1 output. Lifecycle identity and journal cursors carry no admitted message or failure text. @public */
export const ProcessEvent = Schema.Union([
  Schema.TaggedStruct("hello", { requestId: ProcessRequestId, protocolVersion: Schema.Literals([PROCESS_PROTOCOL_VERSION]) }),
  Schema.TaggedStruct("turn.started", {
    ...Correlation,
    ...TurnIdentity,
    runId: RunId,
    origin: TurnOrigin,
    input: Schema.optionalKey(InboxItemId),
    task: Schema.optionalKey(TaskRef),
    resumes: Schema.optionalKey(Positive),
    journal: Journal,
  }),
  Schema.TaggedStruct("turn.event", { ...Correlation, ...TurnIdentity, runId: RunId, progress: ProcessProgress }),
  Schema.TaggedStruct("turn.ended", {
    ...Correlation,
    ...TurnIdentity,
    reason: TurnEndReason,
    failureCode: Schema.optionalKey(Schema.String),
    journal: Journal,
  }),
  Schema.TaggedStruct("begin.result", { requestId: ProcessRequestId, result: ProcessTurnResult }),
  Schema.TaggedStruct("queued", {
    requestId: ProcessRequestId,
    command: Schema.Literals(["send", "steer"]),
    enqueued: Schema.Boolean,
    pending: Count,
  }),
  Schema.TaggedStruct("answered", { requestId: ProcessRequestId, accepted: Schema.Literals([true]), enqueued: Schema.Boolean }),
  Schema.TaggedStruct("cancelled", { requestId: ProcessRequestId, cancelled: Schema.Boolean, pending: Count }),
  Schema.TaggedStruct("pong", { requestId: ProcessRequestId, activity: ProcessActivity }),
  Schema.TaggedStruct("shutdown", { ...Correlation, report: ShutdownReport }),
  Schema.TaggedStruct("error", {
    ...Correlation,
    code: ProcessErrorCode,
    message: Schema.String,
    fatal: Schema.Boolean,
    frameworkCode: Schema.optionalKey(Schema.String),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ProcessEvent = typeof ProcessEvent.Type
