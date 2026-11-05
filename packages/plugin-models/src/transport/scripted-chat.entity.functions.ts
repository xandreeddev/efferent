import { Array as Arr, Match, Option, Predicate, Result } from "effect"
import type { Schema } from "effect"
import { SCRIPTED_CHUNK_SIZE } from "./scripted-chat.entity.js"
import type { ScriptedFinishReason, ScriptedReply, ScriptedRequest, ScriptedStep, ScriptedText, ScriptedUsage } from "./scripted-chat.entity.js"

/**
 * The OpenAI chat-completions wire a scripted reply is sent as: a body for a
 * settled request, `data:` chunks for a streamed one. Pure: the adapter
 * sends what these build.
 */

/** A scripted text's fragments: a string split every `size` characters (code points, so no character is cut), an array as it is. */
export const fragmentsOf = (text: ScriptedText, size: number): ReadonlyArray<string> =>
  typeof text === "string" ? Arr.chunksOf(Array.from(text), size).map((characters) => characters.join("")) : text

/** A scripted text whole: its fragments joined. */
export const wholeText = (text: ScriptedText): string => typeof text === "string" ? text : text.join("")

/** The finish reason a reply ends on: its own, else `tool_calls` when it makes a call and `stop` when it does not. */
export const finishReasonOf = (reply: ScriptedReply): ScriptedFinishReason =>
  reply.finishReason ?? ((reply.toolCalls ?? []).length > 0 ? "tool_calls" : "stop")

/** A scripted usage on the wire, `total_tokens` their sum. */
export const usageOnWire = (usage: ScriptedUsage): Schema.JsonObject => ({
  prompt_tokens: usage.promptTokens,
  completion_tokens: usage.completionTokens,
  total_tokens: usage.promptTokens + usage.completionTokens,
  ...(usage.cachedTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: usage.cachedTokens } }),
  ...(usage.reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
})

/** The model a request names, echoed in what answers it. */
const modelOf = (request: ScriptedRequest): string => typeof request.body["model"] === "string" ? request.body["model"] : "scripted"

/** The fields every body and chunk answering `request` opens with. */
const envelope = (request: ScriptedRequest, object: string): Schema.JsonObject =>
  ({ id: `scripted-${request.index}`, object, created: 0, model: modelOf(request) })

/** The settled body answering `request` with `reply`: one choice holding the whole text, reasoning and calls. */
export const completionBody = (request: ScriptedRequest, reply: ScriptedReply): Schema.JsonObject => {
  const calls = reply.toolCalls ?? []
  return {
    ...envelope(request, "chat.completion"),
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: reply.text === undefined ? null : wholeText(reply.text),
        ...(reply.reasoning === undefined ? {} : { reasoning_content: wholeText(reply.reasoning) }),
        ...(calls.length === 0 ? {} : {
          tool_calls: calls.map((call) => ({
            ...(call.id === undefined ? {} : { id: call.id }),
            type: "function",
            function: { name: call.name, arguments: wholeText(call.arguments) },
          })),
        }),
      },
      finish_reason: finishReasonOf(reply),
    }],
    ...(reply.usage === undefined ? {} : { usage: usageOnWire(reply.usage) }),
  }
}

/**
 * The `data:` chunks answering `request` with `reply`, in the order they are
 * sent: the assistant role, the reasoning fragments, the text fragments,
 * then for each call a chunk naming it (its id, when it has one, and its
 * name) and one per arguments fragment, under the call's wire `index`; then
 * the finish reason, the usage when the reply reports one (a chunk with no
 * choices, as `stream_options.include_usage` asks), and `[DONE]`. Each
 * element is one whole SSE event.
 */
export const streamEvents = (request: ScriptedRequest, reply: ScriptedReply): ReadonlyArray<string> => {
  const size = reply.chunkSize ?? SCRIPTED_CHUNK_SIZE
  const head = envelope(request, "chat.completion.chunk")
  const chunk = (delta: Schema.JsonObject, finish: string | null = null): Schema.JsonObject =>
    ({ ...head, choices: [{ index: 0, delta, finish_reason: finish }] })
  const fragments = (text: ScriptedText | undefined) => text === undefined ? [] : fragmentsOf(text, size)
  const chunks: ReadonlyArray<Schema.JsonObject> = [
    chunk({ role: "assistant" }),
    ...fragments(reply.reasoning).map((fragment) => chunk({ reasoning_content: fragment })),
    ...fragments(reply.text).map((fragment) => chunk({ content: fragment })),
    ...(reply.toolCalls ?? []).flatMap((call, index) => [
      chunk({ tool_calls: [{ index, ...(call.id === undefined ? {} : { id: call.id }), type: "function", function: { name: call.name, arguments: "" } }] }),
      ...fragmentsOf(call.arguments, size).map((fragment) => chunk({ tool_calls: [{ index, function: { arguments: fragment } }] })),
    ]),
    chunk({}, finishReasonOf(reply)),
    ...(reply.usage === undefined ? [] : [{ ...head, choices: [], usage: usageOnWire(reply.usage) }]),
  ]
  return [...chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`), "data: [DONE]\n\n"]
}

/** Why no step answers a request: a step's `when` failed, or no available step accepts it. */
export type StepRefusal =
  | { readonly _tag: "WhenFailed"; readonly step: number; readonly cause: unknown }
  | { readonly _tag: "Unmatched" }

const unmatched: Result.Result<number, StepRefusal> = Result.fail({ _tag: "Unmatched" })

/** Whether `step` answers `request`: it does when it has no `when` or its `when` accepts it; a `when` that throws refuses the request. */
const accepts = (step: ScriptedStep, index: number, request: ScriptedRequest): Result.Result<number, StepRefusal> => {
  const when = step.when
  if (when === undefined) return Result.succeed(index)
  return Result.try({ try: () => when(request), catch: (cause): StepRefusal => ({ _tag: "WhenFailed", step: index, cause }) }).pipe(
    Result.flatMap((accepted) => accepted ? Result.succeed(index) : unmatched),
  )
}

/** Whether a step is still available: not used yet, or `repeat`. */
const available = (step: ScriptedStep, index: number, used: ReadonlyArray<number>): boolean => step.repeat === true || !used.includes(index)

/**
 * The step that answers `request`: the first, in script order, that is
 * available (not in `used`, or `repeat`) and whose `when` accepts it. A
 * `when` that throws refuses the request rather than skipping its step.
 */
export const pickStep = (
  script: ReadonlyArray<ScriptedStep>,
  used: ReadonlyArray<number>,
  request: ScriptedRequest,
): Result.Result<number, StepRefusal> =>
  Arr.reduce(script, unmatched, (found, step, index) =>
    Result.isFailure(found) && Predicate.isTagged(found.failure, "Unmatched") && available(step, index, used) ? accepts(step, index, request) : found)

/** The steps still available, by their position in the script; a `repeat` step never runs out. */
export const remainingSteps = (script: ReadonlyArray<ScriptedStep>, used: ReadonlyArray<number>): ReadonlyArray<number> =>
  script.flatMap((step, index) => available(step, index, used) ? [index] : [])

/** What the endpoint says when it refuses a request: which request, why, and which steps were left. */
export const refusalMessage = (request: ScriptedRequest, refusal: Option.Option<StepRefusal>, remaining: ReadonlyArray<number>): string => {
  const left = remaining.length === 0 ? "no step left" : `steps left: ${remaining.join(", ")}`
  const why = Option.match(refusal, {
    onNone: () => "its body is not a JSON object",
    onSome: (found) => Match.valueTags(found, {
      WhenFailed: ({ step, cause }) => `the when of step ${step} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      Unmatched: () => "no step matched it",
    }),
  })
  return `scripted chat completions: request ${request.index} (${request.url}) was not answered: ${why} (${left})`
}

/** The OpenAI error body a refused request is answered with. */
export const refusalBody = (message: string): Schema.JsonObject =>
  ({ error: { type: "invalid_request_error", code: "scripted_request_unmatched", message } })
