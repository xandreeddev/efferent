// A model stream built from a callback-style source (a Chrome stream reader, a
// WebLLM chunk iterator). Stop must never hang: cancelling is a plain call made
// from a finalizer, and nothing waits for the source to notice.
import { Cause, Effect, Queue, Stream } from "effect"
import { AiError } from "effect/ai"
import type { Usage } from "../prompt-map.ts"
import { streamDelta, streamEnd, streamFinish, streamStart } from "../prompt-map.ts"

export interface Sink {
  readonly push: (delta: string) => void
  /** The source finished (or was cancelled): close the stream cleanly. */
  readonly end: (usage: Usage) => void
  readonly fail: (error: unknown) => void
}

export const aiError = (module: string, method: string, error: unknown): AiError.AiError =>
  AiError.make({
    module, method,
    reason: new AiError.UnknownError({ description: error instanceof Error ? error.message : String(error) }),
  })

/**
 * `start` begins the source and returns its cancel. The stream ends when the
 * source calls `end` or `fail`, or when the consumer stops (the finalizer
 * cancels the source).
 */
export const modelStream = (module: string, start: (sink: Sink) => () => void) =>
  Stream.callback<ReturnType<typeof streamDelta> | typeof streamStart | typeof streamEnd | ReturnType<typeof streamFinish>, AiError.AiError>(
    (queue) => Effect.gen(function* () {
      let closed = false
      Queue.offerUnsafe(queue, streamStart)
      const cancel = start({
        push: (delta) => { if (!closed) Queue.offerUnsafe(queue, streamDelta(delta)) },
        end: (usage) => {
          if (closed) return
          closed = true
          Queue.offerUnsafe(queue, streamEnd)
          Queue.offerUnsafe(queue, streamFinish(usage))
          Queue.endUnsafe(queue)
        },
        fail: (error) => {
          if (closed) return
          closed = true
          Queue.failCauseUnsafe(queue, Cause.fail(aiError(module, "streamText", error)))
        },
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => { closed = true; cancel() }))
    }),
    { bufferSize: 4096 },
  )
