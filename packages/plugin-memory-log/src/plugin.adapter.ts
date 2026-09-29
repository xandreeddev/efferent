import { Effect, Layer, Schema } from "effect"
import { definePlugin, encodeAppend, entriesOfPayload, HarnessError, MemoryLog } from "@xandreed/core"

const storage = (message: string) => new HarnessError({ code: "memory.log", message })

export const MemoryLogConfig = Schema.Struct({ event: Schema.NonEmptyString })
export type MemoryLogConfig = typeof MemoryLogConfig.Type
export const memoryLogDefaults: MemoryLogConfig = { event: "memory.entries" }

/**
 * The memory log stored in the conversation's own journal: one
 * `memory.entries` event per append, entries as canonical JSON with their
 * ids inside — any host journal works, whatever its sequence numbering.
 */
export const memoryLogPlugin = definePlugin({
  id: "@xandreed/plugin-memory-log", version: "0.7.0-next.1", scope: "runtime",
  config: MemoryLogConfig, defaults: memoryLogDefaults,
  provides: [MemoryLog],
  layer: ({ event }) => Layer.succeed(MemoryLog, MemoryLog.of({
    open: (_conversation, io) => Effect.succeed({
      read: io.read([event]).pipe(
        Effect.flatMap((events) => Effect.forEach(events.filter((stored) => stored.name === event), (stored) => entriesOfPayload(stored.data).pipe(
          Effect.mapError((error) => storage(`undecodable memory entries: ${error.message}`)),
        ))),
        Effect.map((groups) => groups.flat()),
      ),
      append: (entries) => entries.length === 0 ? Effect.void : encodeAppend(entries).pipe(
        Effect.mapError((error) => storage(error.message)),
        Effect.flatMap((data) => io.append({ name: event, runId: entries[0]!.runId, data: { ...data } })),
      ),
    }),
  })),
})
/** The memory log as a typed layer: provides MemoryLog. */
export const MemoryLogLive = memoryLogPlugin.live
export default memoryLogPlugin
