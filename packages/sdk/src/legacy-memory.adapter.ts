import { Effect, Schema } from "effect"
import { AgentMessage, draftOfEntry, EntryId, HarnessError, SessionEvent } from "@xandreed/core"
import type { SessionLogEvent, TurnWriter } from "@xandreed/core"

const failed = (error: { readonly message: string }) => new HarnessError({ code: "memory.legacy", message: error.message })

/** A read-only memory view of historical Harness message tails; source records are never rewritten. */
export const projectLegacyMemory = (events: ReadonlyArray<SessionLogEvent>, kinds: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<SessionLogEvent>, HarnessError> => {
  const nativeRuns = new Set(events.filter((event) => event.kind === "memory.message").map((event) => event.data.runId))
  const prompts = new Map(events.filter((event) => event.kind === "turn.started").map((event) => [event.data.runId, event.data.userMessage] as const))
  return Effect.forEach(events, (event): Effect.Effect<ReadonlyArray<SessionLogEvent>, HarnessError> => {
    if (event.kind !== "harness.event") return Effect.succeed(kinds.length === 0 || kinds.includes(event.kind) ? [event] : [])
    const decoded = Schema.decodeUnknownOption(SessionEvent)(event.data.event)
    if (decoded._tag === "None" || decoded.value.name !== "messages" || nativeRuns.has(decoded.value.runId)) return Effect.succeed(kinds.includes("harness.event") || kinds.length === 0 ? [event] : [])
    const original = kinds.includes("harness.event") ? [event] : []
    if (kinds.length > 0 && !kinds.includes("memory.message")) return Effect.succeed(original)
    const legacy = decoded.value
    return Schema.decodeUnknownEffect(Schema.Array(AgentMessage))(legacy.data.messages).pipe(
      Effect.mapError(failed),
      Effect.flatMap((messages) => Effect.forEach(messages, (message, index) => {
        const original = prompts.get(legacy.runId)
        const prompt = typeof original === "object" && original !== null && "text" in original ? original.text : original
        if (index === 0 && message.role === "user" && message.content === prompt) return Effect.succeed<ReadonlyArray<SessionLogEvent>>([])
        return draftOfEntry({
          id: EntryId.make(`legacy:${event.session}:${event.seq}:${index}`), runId: legacy.runId ?? `legacy:${event.session}`,
          turn: event.turn._tag === "Some" ? event.turn.value : 0, step: 0, at: event.at,
          body: { _tag: "Message", message },
        }).pipe(Effect.mapError(failed), Effect.map((draft) => draft._tag === "None" ? [] : [{ ...event, kind: draft.value.kind, data: draft.value.data }]))
      })),
      Effect.map((groups) => [...original, ...groups.flat()]),
    )
  }).pipe(Effect.map((groups) => groups.flat()))
}

/** Preserve admission/write identity and queue ownership; only historical memory reads are adapted. */
export const withLegacyMemory = (writer: TurnWriter): TurnWriter => ({
  ...writer,
  history: (kinds) => writer.history(kinds.length === 0 ? [] : [...new Set([...kinds, "harness.event"]) ]).pipe(Effect.flatMap((events) => projectLegacyMemory(events, kinds))),
  snapshot: (kinds, after) => after !== undefined ? writer.snapshot(kinds, after)
    : writer.snapshot(kinds.length === 0 ? [] : [...new Set([...kinds, "harness.event"]) ]).pipe(Effect.flatMap((events) => projectLegacyMemory(events, kinds))),
})
