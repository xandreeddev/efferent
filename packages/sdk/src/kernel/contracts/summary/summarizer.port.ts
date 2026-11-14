import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { Message } from "@xandreed/core/kernel"
import type { SummaryFailed } from "./summarizer.entity.js"

/**
 * What a summary memory asks to shorten old turns: the summary so far, if
 * there is one, and the messages to fold into it, to a new summary's text.
 * No kernel plugin calls a model (ADR 0004); the host provides the
 * summarizer, over the model it picked or any other.
 *
 * @public
 */
export class Summarizer extends Context.Service<Summarizer, {
  readonly summarize: (input: {
    readonly earlier: Option.Option<string>
    readonly messages: ReadonlyArray<Message>
  }) => Effect.Effect<string, SummaryFailed>
}>()("@xandreed/sdk/kernel/Summarizer") {}
