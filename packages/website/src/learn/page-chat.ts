// The chat a lesson's program is given: the service each lesson's chat.ts
// declares, as the page builds it. Its shape is the widest of them (lessons'
// program tests run the shown files; lesson 1's has no `drain`, and only
// lesson 17's reads `inputs`); here its conversation and its queue are the
// page's, built once, so they outlive every rebuild of the program.
import { Context } from "effect"
import type { Effect, Stream } from "effect"
import type { SessionId } from "@xandreed/core/kernel"
import type { TaskReport } from "@xandreed/sdk/kernel"

/**
 * What waits in the chat's one queue: a message the person sent, or a task's report (lesson 17, ADR 0018), in the
 * order they came.
 */
export type ChatInput = { readonly _tag: "Message"; readonly text: string } | { readonly _tag: "Report"; readonly report: TaskReport }

export class Chat extends Context.Service<Chat, {
  readonly session: SessionId
  /** The person's messages, one at a time. A report a program that reads only these takes is passed over. */
  readonly messages: Stream.Stream<string>
  /** Every message waiting now, taken at once; the reports waiting stay in the queue, in their order. */
  readonly drain: Effect.Effect<ReadonlyArray<string>>
  /** What comes into the conversation (lesson 17): a message or a task's report, one at a time, in the order they came. */
  readonly inputs: Stream.Stream<ChatInput>
  readonly stream: (piece: string) => Effect.Effect<void>
  readonly reply: (text: string) => Effect.Effect<void>
  readonly fail: (error: unknown) => Effect.Effect<void>
  readonly status: (text: string) => Effect.Effect<void>
}>()("lesson/Chat") {}
