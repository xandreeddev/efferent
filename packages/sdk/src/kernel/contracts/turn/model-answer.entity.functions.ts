import { Effect, Match, Option, Predicate, Stream } from "effect"
import type { Response } from "effect/ai"
import { assistantMessage } from "@xandreed/core/kernel"
import type { OpenSession, Usage } from "@xandreed/core/kernel"
import { CurrentTurn } from "./current-turn.port.js"
import { ModelAnswerFailed } from "./model-answer.entity.js"
import { runningTurn } from "./running-turn.entity.functions.js"
import type { ModelToolCall } from "./tool-call.entity.functions.js"

/**
 * What a model answered in one call: its text, the tools it asked for, and,
 * when the provider reported them, what the call cost and the model that
 * answered.
 *
 * @public
 */
export interface Answered {
  readonly text: string
  readonly toolCalls: ReadonlyArray<ModelToolCall>
  readonly usage: Option.Option<Usage>
  readonly model: Option.Option<string>
}

/** The provider's report, when it counted both what it read and what it wrote. */
const usageOf = (reported: Response.Usage): Option.Option<Usage> =>
  reported.inputTokens.total === undefined || reported.outputTokens.total === undefined
    ? Option.none()
    : Option.some({
      inputTokens: reported.inputTokens.total,
      outputTokens: reported.outputTokens.total,
      ...(reported.inputTokens.cacheRead === undefined ? {} : { cachedInputTokens: reported.inputTokens.cacheRead }),
    })

/** What a stream's error says: its own message, the error itself when it is text, or that the stream reported one. */
const messageOf = (error: unknown): string =>
  Predicate.hasProperty(error, "message") && Predicate.isString(error.message) ? error.message
    : Predicate.isString(error) ? error
      : "the model's stream reported an error"

const nothing: Answered = { text: "", toolCalls: [], usage: Option.none(), model: Option.none() }

/**
 * Read one call's answer from the model's stream, in the turn it belongs to,
 * and store it: the text (each piece handed to `onText` as it arrives), the
 * tool calls as they came, and the usage and the model when the provider
 * reported them, as one `conversation.assistant.message`. The turn is
 * provided as `CurrentTurn` while the stream runs, so a wrapper of the model
 * reaches the session its call is for. A stream that reports an error fails
 * with `ModelAnswerFailed` and stores nothing. The stream is the host's: it
 * calls the model with its own prompt, tools and options.
 *
 * @public
 */
export const modelAnswer = <E, R, E2 = never, R2 = never>(
  stream: Stream.Stream<Response.AnyPart, E, R>,
  session: OpenSession,
  options: { readonly onText?: (piece: string) => Effect.Effect<void, E2, R2> } = {},
) =>
  stream.pipe(
    Stream.runFoldEffect((): Answered => nothing, (answer, part) => Match.value(part).pipe(
      Match.discriminator("type")("text-delta", ({ delta }) => Effect.as(options.onText === undefined ? Effect.void : options.onText(delta), { ...answer, text: answer.text + delta })),
      Match.discriminator("type")("tool-call", ({ id, name, params }) => Effect.succeed({ ...answer, toolCalls: [...answer.toolCalls, { id, name, params }] })),
      Match.discriminator("type")("error", ({ error }) => Effect.fail(new ModelAnswerFailed({ message: messageOf(error), cause: error }))),
      Match.discriminator("type")("finish", ({ usage }) => Effect.succeed({ ...answer, usage: usageOf(usage) })),
      Match.discriminator("type")("response-metadata", ({ modelId }) => Effect.succeed({ ...answer, model: Option.fromNullishOr(modelId) })),
      Match.orElse(() => Effect.succeed(answer)),
    )),
    Effect.provideService(CurrentTurn, runningTurn(session)),
    Effect.tap((answer) => session.append(assistantMessage(answer.text, {
      toolCalls: answer.toolCalls,
      ...Option.match(answer.usage, { onNone: () => ({}), onSome: (usage) => ({ usage }) }),
      ...Option.match(answer.model, { onNone: () => ({}), onSome: (model) => ({ model }) }),
    }))),
  )
