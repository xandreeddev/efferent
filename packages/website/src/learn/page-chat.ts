// The chat a lesson's program is given: the service chat.ts declares, as
// the page builds it. Its shape is chat.ts's word for word (lessons'
// program tests run the shown file); here its conversation and its queue are
// the page's, built once, so they outlive every rebuild of the program.
import { Context } from "effect"
import type { Effect, Stream } from "effect"
import type { SessionId } from "@xandreed/core/kernel"

export class Chat extends Context.Service<Chat, {
  readonly session: SessionId
  readonly messages: Stream.Stream<string>
  readonly stream: (piece: string) => Effect.Effect<void>
  readonly reply: (text: string) => Effect.Effect<void>
  readonly fail: (error: unknown) => Effect.Effect<void>
  readonly status: (text: string) => Effect.Effect<void>
}>()("lesson/Chat") {}
