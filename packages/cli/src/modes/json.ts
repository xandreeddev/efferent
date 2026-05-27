import { Effect, Queue, Schema, Fiber } from "effect"
import {
  ConversationId,
  ConversationStore,
  FileSystem,
  Llm,
  Shell,
  coderAgentConfig,
  runAgent,
} from "@agent/core"
import type { AgentEvent } from "../events.js"
import { makeEventHooks } from "../events.js"
import { denyBashHook } from "../safetyHooks.js"

const writeJson = (event: AgentEvent): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(JSON.stringify(event) + "\n")
  })

const consumeEvents = (queue: Queue.Queue<AgentEvent>) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue)
      yield* writeJson(event)
    }
  })

const decodeConversationId = Schema.decodeUnknown(ConversationId)

export interface JsonModeInput {
  readonly prompt: string
  readonly cwd: string
  readonly allowBash: boolean
  readonly resumeConversationId?: string
}

export const runJsonMode = (
  input: JsonModeInput,
): Effect.Effect<void, never, FileSystem | Shell | Llm | ConversationStore> =>
  Effect.gen(function* () {
    const conversationIdRaw =
      input.resumeConversationId ?? crypto.randomUUID()
    const cid = yield* decodeConversationId(conversationIdRaw).pipe(
      Effect.orDie,
    )
    const queue = yield* Queue.unbounded<AgentEvent>()
    const consumer = yield* Effect.forkDaemon(consumeEvents(queue))

    const hooks = makeEventHooks<FileSystem | Shell | ConversationStore | Llm>(
      queue,
      denyBashHook(input.allowBash),
    )

    yield* runAgent(
      coderAgentConfig(input.cwd),
      cid,
      input.prompt,
      hooks,
    ).pipe(
      Effect.catchAll((err) =>
        Effect.gen(function* () {
          const msg =
            typeof err === "object" && err !== null && "message" in err
              ? String((err as { message: unknown }).message)
              : String(err)
          yield* Queue.offer(queue, { type: "error", message: msg })
        }),
      ),
    )

    yield* Effect.sleep("50 millis")
    yield* Fiber.interrupt(consumer)
  })
