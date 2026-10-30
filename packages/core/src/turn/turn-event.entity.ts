import { Schema } from "effect"
import { DecisionRecord } from "../decision-record.entity.js"
import { InvocationId, RunId, RunKey } from "../domain/run.entity.js"
import { ToolCallId } from "../domain/message.entity.js"
import { TokenUsage } from "../domain/token-usage.entity.js"
import { StepStatus, TurnOutcomeKind } from "../domain/turn-vocabulary.entity.js"
import { ActivationSource, EntryId } from "../memory/memory-log.entity.js"
import { JsonObject } from "../session/session-log.entity.js"
import { UserMessage } from "./user-message.entity.js"

/**
 * The typed events of one turn — the single vocabulary plugins publish and
 * hosts subscribe to. `_tag` IS the event name. Publication is inline (see
 * `TurnEvents`), so a subscriber's state is visible to whatever runs next.
 */

const Labels = Schema.Record(Schema.String, Schema.String)

/** What the host's completion policy decided after one step. */
export const CompletionVerdict = Schema.Struct({
  complete: Schema.Boolean,
  /** Task tags to await before the verdict is evaluated once more. */
  awaiting: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty())),
  /** Host facts behind the verdict, as JSON, journaled with it. */
  facts: JsonObject,
})
export type CompletionVerdict = typeof CompletionVerdict.Type

export const TurnStartedEvent = Schema.TaggedStruct("turn.started", {
  runId: RunId,
  turn: Schema.Int,
  userMessage: UserMessage,
  /** The host's metadata the turn was begun with (`{}` when none was given). */
  meta: JsonObject,
  /** The earlier turn this one resumes, only when it resumes one. */
  resumes: Schema.optionalKey(Schema.Int),
}).annotate({
  description: "Published once per turn when memory takes the user's message as turn `turn` (`TurnMemory.persistMessage`; `Agent.turn` runs it before the host's `use`). `runId` names the run, `userMessage` is what the user said (as the session stored it: its images, inline as base64, normalised), `meta` is the host's metadata the turn was begun with (`{}` when none was given; never shown to the model), and `resumes`, present only on a turn that resumes an earlier one, is that turn's number. Not journaled from the bus: the session stored its own `turn.started` when the turn began, with `meta` and `resumes` only when they were given. A subscription made in `use` never sees it; one in the host's per-turn layer or a session plugin does.",
})

export const StepStartedEvent = Schema.TaggedStruct("step.started", {
  step: Schema.Int,
  /** The run of the turn the step belongs to (`StepRequest.run`): 0 for its first run. */
  run: RunKey,
  /** Step zero of a host-planned batch: no provider call. */
  planned: Schema.Boolean,
  activeTools: Schema.Array(Schema.String),
}).annotate({
  description: "Published by the step loop as each step starts. `run` is the run of the turn the step belongs to (0 for the turn's first run, one up for each later `Turn.run`; a record written before runs were counted reads 0), as on `step.ended`, `assistant.message`, `completion.evaluated`, `context.built` and `stream.fallback`: a step is named by its turn, run and step. `planned` is true for step 0 of a host-planned batch, which makes no provider call; `activeTools` are the tool names the step offers the model. Journaled as `step.started`.",
})

export const ToolStartedEvent = Schema.TaggedStruct("tool.started", {
  step: Schema.Int,
  invocationId: InvocationId,
  tool: Schema.String,
  input: Schema.Unknown,
  labels: Labels,
  stage: Schema.OptionFromNullOr(Schema.String),
}).annotate({
  description: "Published by the tool registry just before a tool's handler runs. `invocationId` (`<runId>:call:<n>`) pairs it with its `tool.progress` and `tool.completed`; `input` is the decoded parameters; `labels` and `stage` come from the tool's annotations. A refused call (inactive, forbidden, denied, over a limit) publishes `tool.refused` instead, and no other `tool.*` event; `step.ended.results` lists every recorded result, refused calls included. Journaled as `tool.started`, input included.",
})

/** Why the tool registry refused a call before its handler ran. */
export const ToolRefusalReason = Schema.Literals(["inactive", "forbidden", "denied", "call-limit", "tool-call-limit"])
export type ToolRefusalReason = typeof ToolRefusalReason.Type

export const ToolRefusedEvent = Schema.TaggedStruct("tool.refused", {
  step: Schema.Int,
  invocationId: InvocationId,
  tool: Schema.String,
  /** The decoded parameters. Not journaled. */
  input: Schema.Unknown,
  reason: ToolRefusalReason,
  /** What the model is told, as the call's failed result. */
  message: Schema.String,
}).annotate({
  description: "Published by the tool registry when it refuses a call before the handler runs, in place of `tool.started`: the tool is not active (`inactive`: not loaded, or not available in this conversation), the turn lacks a permission it needs (`forbidden`), the host's `ActionPolicy` denied it (`denied`), the turn's call limit is reached (`call-limit`) or the tool's own (`tool-call-limit`). `invocationId` is minted for the call as for any other (the refused call takes its `<runId>:call:<n>`); `message` is what the model receives as the call's failed result, which `step.ended.results` lists as not ok. The model is offered only active tools, so `inactive` comes from a call made through the handlers directly (a host's, another tool's); `forbidden` also from a tool an earlier turn activated whose permission this turn lacks. Journaled as `tool.refused` without `input`.",
})

export const ToolCompletedEvent = Schema.TaggedStruct("tool.completed", {
  step: Schema.Int,
  invocationId: InvocationId,
  tool: Schema.String,
  input: Schema.Unknown,
  ok: Schema.Boolean,
  /** The decoded value the handler returned (or failed with). Not journaled. */
  result: Schema.Unknown,
  /** The wire form of `result`, as the model receives it. */
  encoded: Schema.Unknown,
  /** From just after `tool.started` to the handler's exit, the wait for the tool's read or write lane included. */
  durationMs: Schema.Number,
  labels: Labels,
  stage: Schema.OptionFromNullOr(Schema.String),
}).annotate({
  description: "Published by the tool registry when a handler returned or failed (`ok`). `result` is the decoded value, `encoded` its wire form as the model receives it. `durationMs` runs from just after `tool.started` to the handler's exit, so it includes any wait for the tool's read or write lane. Journaled as `tool.completed` without `input`, `result` and `encoded`: memory keeps the call and its result (`memory.message`, `memory.tool-result`).",
})

/**
 * What a running tool reports before it completes: a command's output as it
 * arrives (`stdout`, `stderr`), or a step of a long job (`status`).
 * Transient: shown live, never journaled; `tool.completed` carries the
 * result. A handler publishes it with `publishToolProgress`.
 */
export const ToolProgressEvent = Schema.TaggedStruct("tool.progress", {
  step: Schema.Int,
  invocationId: InvocationId,
  tool: Schema.String,
  channel: Schema.Literals(["stdout", "stderr", "status"]),
  text: Schema.String,
}).annotate({
  description: "Published by `publishToolProgress` from inside a tool handler, between that call's `tool.started` and `tool.completed` (same `step`, `invocationId` and `tool`). `channel` is stdout or stderr for a command's output as it arrives, status for anything else the tool reports; `text` is that output or message. Transient: never journaled; `tool.completed` carries the result.",
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
  run: RunKey,
  status: StepStatus,
  /** The step's recorded tool results, in log order. */
  results: Schema.Array(StepResult),
}).annotate({
  description: "Published by the step loop once per step, after the step's tail is recorded and before its completion is evaluated; nothing is recorded under the step after it (the loop's corrective, nudge or steer is the next step's). `status` is how the step's own call, tools and tail came out: completed, failed, cancelled, or malformed (a response the model could not form, a tool that does not exist or parameters that do not decode: the loop answers it with a corrective turn, and the step has no `assistant.message` and no `completion.evaluated`); a completion that fails afterwards fails the run, not the step. `results` are the step's recorded tool results (memory entry, tool call id, tool, ok), in log order, refused calls included. Journaled as `step.ended` (records with status malformed are not read by 0.14 and older).",
})

export const CompletionEvaluatedEvent = Schema.TaggedStruct("completion.evaluated", {
  step: Schema.Int,
  run: RunKey,
  verdict: CompletionVerdict,
}).annotate({
  description: "Published by the step loop after `step.ended`, with the verdict of the host's completion policy for that step; none after a malformed step. A verdict that awaits tasks is evaluated again once they finish, publishing a second event. Journaled as `completion.evaluated`.",
})

export const SkillsActivatedEvent = Schema.TaggedStruct("skills.activated", {
  skills: Schema.Array(Schema.String),
  tools: Schema.Array(Schema.String),
  source: ActivationSource,
}).annotate({
  description: "Published by the tool registry when skills (and their tools) become active: always-on skills, the intent matcher, the model's `load_skill`, or the host. Not journaled from the bus: memory records the activation as `memory.skills`.",
})

export const ContextBuiltEvent = Schema.TaggedStruct("context.built", {
  step: Schema.Int,
  turn: Schema.Int,
  run: RunKey,
  strategy: Schema.String,
  strategyVersion: Schema.String,
  fingerprint: Schema.String,
  systemFingerprint: Schema.String,
  estimatedTokens: Schema.Int,
  reservedTokens: Schema.Int,
  /** The run's token budget for the whole request; memory was given `budgetTokens - reservedTokens` for the messages. */
  budgetTokens: Schema.Int,
  compactions: Schema.Int,
  activeTools: Schema.Array(Schema.String),
}).annotate({
  description: "Published before each provider call, once the step's context is built (none for a planned step 0). It carries the memory strategy and its version, the context and system-prompt fingerprints, the token estimate of the messages, the tokens reserved for the system prompt and tool schemas, the run's `budgetTokens` (the whole request's; memory compacted the messages toward `budgetTokens - reservedTokens`), how many compactions the build applied, and the active tools. Journaled as `context.built` (records written before 0.14.0 have no `budgetTokens`); the full request is journaled beside it as `request.prepared`.",
})

export const DecisionRecordedEvent = Schema.TaggedStruct("decision.recorded", {
  record: DecisionRecord,
}).annotate({
  description: "Published by `recordDecision`, for example when `turn.tools.select` or `apply` records the skill selection: the decision record holds the candidates, the policy version and what was chosen. Journaled as `decision.recorded`.",
})

export const AssistantMessageEvent = Schema.TaggedStruct("assistant.message", {
  step: Schema.Int,
  run: RunKey,
  text: Schema.String,
  reasoning: Schema.String,
  model: Schema.OptionFromNullOr(Schema.String),
  toolCalls: Schema.Array(Schema.Struct({ id: Schema.String, tool: Schema.String, input: Schema.Unknown })),
  usage: TokenUsage,
}).annotate({
  description: "Published by the step loop once per provider response, after that step's tools ran and its tail is recorded: the text, the reasoning, the model, the tool calls and the token usage (input with its cache reads and writes inside, output with its reasoning inside). A host-planned step 0 carries zero usage. Journaled only as `step.usage` (step, run, model, usage): the content itself is memory's `memory.message`.",
})

/** A streamed increment — transient: never journaled, restated by assistant.message. */
export const AssistantDeltaEvent = Schema.TaggedStruct("assistant.delta", {
  step: Schema.Int,
  channel: Schema.Literals(["text", "reasoning", "tool-params"]),
  id: Schema.String,
  delta: Schema.String,
}).annotate({
  description: "Published by the step loop for each streamed increment while `limits.streaming` is on (the default), on channel text, reasoning or tool-params; `id` groups the increments of one content part. Transient: never journaled, and restated in full by `assistant.message`. A stream that falls back to a non-streamed call (`stream.fallback`) publishes none.",
})

export const StreamFallbackEvent = Schema.TaggedStruct("stream.fallback", {
  step: Schema.Int,
  run: RunKey,
  /** The stream's error or defect as text, cut to 300 characters. */
  message: Schema.String,
}).annotate({
  description: "Published by the step loop when a streamed provider call fails before its first part: the step is answered by a non-streamed call instead, and so is every later step of the run. Once per run at most. `message` is the stream's error as text, cut to 300 characters; it can quote the provider's error. A stream that fails after its first part fails the step instead (its tools may have run). A refusal over an image (an `InvalidRequestError` that names one) is no stream failure: it has no fallback; the turn omits the images and sends the step again (`StepRequest.onMediaRejected`), or the step fails. Journaled as `stream.fallback`.",
})

export const TurnEndedEvent = Schema.TaggedStruct("turn.ended", {
  runId: RunId,
  turn: Schema.Int,
  outcome: TurnOutcomeKind,
  reply: Schema.OptionFromNullOr(Schema.String),
  /** The turn's usage: its `assistant.message` usage summed (`RunContext.usage`). */
  usage: TokenUsage,
}).annotate({
  description: "Published once when the turn's reply is recorded (`TurnMemory.persistReply`, from `guardTurn`), also when the turn fails, with outcome failed; `usage` is the turn's usage, the usage of its `assistant.message` events summed (`RunContext.usage`). Under `Agent.turn` it is published after `use`, the host's per-turn layer and the turn-dependent plugins have closed, and their subscriptions with them: only a subscription whose scope is still open sees it, such as one made with `Scope.provide(observerScope)` over the caller's outer scope, or one registered around `TurnLive` by a host composing the turn itself. Otherwise read the `TurnResult` `Agent.turn` returns (its `usage` is the same total), or the stored `turn.reply` and `turn.ended`, and `turnUsageOf` over the stored events. Not journaled from the bus: memory stores `turn.reply` and the session its own `turn.ended` (reason and failure, no usage), both in the turn's closing commit, after its reactions: a reaction that fails fails the turn, its stored reply then failed (this event is not published again).",
})

/** An application's own event (see `defineHostEvent`); `name` is the host's namespace. */
export const HostEvent = Schema.TaggedStruct("host", {
  name: Schema.Trimmed.check(Schema.isNonEmpty()),
  data: JsonObject,
}).annotate({
  description: "An application's own event (`defineHostEvent`), published by the host's code, tools or tasks. `name` is the host's namespace and `data` the payload as its schema encodes it, as JSON (`defineHostEvent` writes it through JSON text, so `undefined` fields are dropped and a value JSON cannot hold fails the publish with `events.encode`). Journaled under `name` as its kind; a name in `RESERVED_KINDS` fails the publish with `events.reserved`.",
})

export const TurnEvent = Schema.Union(
  [TurnStartedEvent,
  StepStartedEvent,
  ToolStartedEvent,
  ToolRefusedEvent,
  ToolProgressEvent,
  ToolCompletedEvent,
  StepEndedEvent,
  CompletionEvaluatedEvent,
  SkillsActivatedEvent,
  ContextBuiltEvent,
  DecisionRecordedEvent,
  AssistantMessageEvent,
  AssistantDeltaEvent,
  StreamFallbackEvent,
  TurnEndedEvent,
  HostEvent],
).pipe(Schema.toTaggedUnion("_tag"))
export type TurnEvent = typeof TurnEvent.Type
export type TurnEventName = TurnEvent["_tag"]
export type TurnEventOf<Name extends TurnEventName> = Extract<TurnEvent, { readonly _tag: Name }>

/** Events that exist only for live rendering and are never journaled. */
export const TransientTurnEvents: ReadonlyArray<TurnEventName> = ["assistant.delta", "tool.progress"]

/**
 * Every bus event's name, in the union's order (its tags, as the union
 * lists them). All of them are reserved (`RESERVED_KINDS`): a host event may
 * not take one, whether the journal stores the bus event under that name or
 * not.
 */
export const TURN_EVENT_NAMES: ReadonlyArray<TurnEventName> = TurnEvent.discriminants
