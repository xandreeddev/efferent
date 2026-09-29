import { Schema } from "effect"
import { DecisionRecord } from "../decision-record.entity.js"
import { ToolCallId } from "../domain/message.entity.js"
import { TokenUsage } from "../domain/token-usage.entity.js"
import { ActivationSource, EntryId } from "../memory/memory-log.entity.js"
import { UserMessage } from "./user-message.entity.js"

/**
 * The typed events of one turn — the single vocabulary plugins publish and
 * hosts subscribe to. `_tag` IS the event name. Publication is inline (see
 * `TurnEvents`), so a subscriber's state is visible to whatever runs next.
 */

const Labels = Schema.Record(Schema.String, Schema.String)
const Data = Schema.Record(Schema.String, Schema.Unknown)

/** What the host's completion policy decided after one step. */
export const CompletionVerdict = Schema.Struct({
  complete: Schema.Boolean,
  /** Task tags to await before the verdict is evaluated once more. */
  awaiting: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty())),
  /** Host facts behind the verdict, journaled with it. */
  facts: Data,
})
export type CompletionVerdict = typeof CompletionVerdict.Type

export const TurnStartedEvent = Schema.TaggedStruct("turn.started", {
  runId: Schema.String,
  turn: Schema.Int,
  userMessage: UserMessage,
})

export const StepStartedEvent = Schema.TaggedStruct("step.started", {
  step: Schema.Int,
  /** Step zero of a host-planned batch: no provider call. */
  planned: Schema.Boolean,
  activeTools: Schema.Array(Schema.String),
})

export const ToolStartedEvent = Schema.TaggedStruct("tool.started", {
  step: Schema.Int,
  invocationId: Schema.String,
  tool: Schema.String,
  input: Schema.Unknown,
  labels: Labels,
  stage: Schema.OptionFromNullOr(Schema.String),
})

export const ToolCompletedEvent = Schema.TaggedStruct("tool.completed", {
  step: Schema.Int,
  invocationId: Schema.String,
  tool: Schema.String,
  input: Schema.Unknown,
  ok: Schema.Boolean,
  /** The decoded value the handler returned (or failed with). Not journaled. */
  result: Schema.Unknown,
  /** The wire form of `result`, as the model receives it. */
  encoded: Schema.Unknown,
  durationMs: Schema.Number,
  labels: Labels,
  stage: Schema.OptionFromNullOr(Schema.String),
})

export const StepResult = Schema.Struct({
  entry: EntryId,
  toolCallId: ToolCallId,
  tool: Schema.String,
  ok: Schema.Boolean,
})
export type StepResult = typeof StepResult.Type

export const StepEndedEvent = Schema.TaggedStruct("step.ended", {
  step: Schema.Int,
  status: Schema.Literals(["completed", "failed", "cancelled"]),
  /** The step's recorded tool results, in log order. */
  results: Schema.Array(StepResult),
})

export const CompletionEvaluatedEvent = Schema.TaggedStruct("completion.evaluated", {
  step: Schema.Int,
  verdict: CompletionVerdict,
})

export const SkillsActivatedEvent = Schema.TaggedStruct("skills.activated", {
  skills: Schema.Array(Schema.String),
  tools: Schema.Array(Schema.String),
  source: ActivationSource,
})

export const ContextBuiltEvent = Schema.TaggedStruct("context.built", {
  step: Schema.Int,
  turn: Schema.Int,
  strategy: Schema.String,
  strategyVersion: Schema.String,
  fingerprint: Schema.String,
  systemFingerprint: Schema.String,
  estimatedTokens: Schema.Int,
  reservedTokens: Schema.Int,
  compactions: Schema.Int,
  activeTools: Schema.Array(Schema.String),
})

export const DecisionRecordedEvent = Schema.TaggedStruct("decision.recorded", {
  record: DecisionRecord,
})

export const AssistantMessageEvent = Schema.TaggedStruct("assistant.message", {
  step: Schema.Int,
  text: Schema.String,
  reasoning: Schema.String,
  model: Schema.OptionFromNullOr(Schema.String),
  toolCalls: Schema.Array(Schema.Struct({ id: Schema.String, tool: Schema.String, input: Schema.Unknown })),
  usage: TokenUsage,
})

/** A streamed increment — transient: never journaled, restated by assistant.message. */
export const AssistantDeltaEvent = Schema.TaggedStruct("assistant.delta", {
  step: Schema.Int,
  channel: Schema.Literals(["text", "reasoning", "tool-params"]),
  id: Schema.String,
  delta: Schema.String,
})

export const TurnEndedEvent = Schema.TaggedStruct("turn.ended", {
  runId: Schema.String,
  turn: Schema.Int,
  outcome: Schema.Literals(["completed", "partial", "failed"]),
  reply: Schema.OptionFromNullOr(Schema.String),
})

/** An application's own event (see `defineHostEvent`); `name` is the host's namespace. */
export const HostEvent = Schema.TaggedStruct("host", {
  name: Schema.Trimmed.check(Schema.isNonEmpty()),
  data: Data,
})

export const TurnEvent = Schema.Union(
  [TurnStartedEvent,
  StepStartedEvent,
  ToolStartedEvent,
  ToolCompletedEvent,
  StepEndedEvent,
  CompletionEvaluatedEvent,
  SkillsActivatedEvent,
  ContextBuiltEvent,
  DecisionRecordedEvent,
  AssistantMessageEvent,
  AssistantDeltaEvent,
  TurnEndedEvent,
  HostEvent],
)
export type TurnEvent = typeof TurnEvent.Type
export type TurnEventName = TurnEvent["_tag"]
export type TurnEventOf<Name extends TurnEventName> = Extract<TurnEvent, { readonly _tag: Name }>

/** Events that exist only for live rendering and are never journaled. */
export const TransientTurnEvents: ReadonlyArray<TurnEventName> = ["assistant.delta"]
