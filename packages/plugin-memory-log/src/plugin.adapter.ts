import { Effect, Layer, Schema } from "effect"
import { definePlugin, encodeAppend, entriesOfEvent, HarnessError, MemoryLog } from "@xandreed/core"

const storage = (message: string) => new HarnessError({ code: "memory.log", message })

/**
 * The memory log stored in the run journal itself: one `memory.entries`
 * event per append, bodies as canonical JSON. Any host journal works —
 * the Harness's session store or an application's own event log.
 */
export const memoryLogPlugin = definePlugin({
  id: "@xandreed/plugin-memory-log", version: "0.4.0", scope: "runtime",
  config: Schema.Struct({ event: Schema.NonEmptyString }), defaults: { event: "memory.entries" },
  provides: [MemoryLog],
  layer: ({ event }) => Layer.succeed(MemoryLog, MemoryLog.of({
    open: (_conversation, io) => Effect.succeed({
      read: io.history(-1, [event]).pipe(
        Effect.flatMap((events) => Effect.forEach(events.filter((stored) => stored.name === event), (stored) => entriesOfEvent(stored).pipe(
          Effect.mapError((error) => storage(`undecodable memory entry at ${stored.seq}: ${error.message}`)),
        ))),
        Effect.map((groups) => groups.flat()),
      ),
      append: (runId, at, bodies) => encodeAppend(at, bodies).pipe(
        Effect.mapError((error) => storage(error.message)),
        Effect.flatMap((data) => io.publish({ name: event, runId, data: { ...data } })),
        Effect.flatMap((stored) => entriesOfEvent(stored).pipe(Effect.mapError((error) => storage(error.message)))),
      ),
    }),
  })),
})
export default memoryLogPlugin
