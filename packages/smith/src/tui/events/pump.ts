import { Chunk, Effect, Queue } from "effect"
import type { SmithEvent } from "../../domain/SmithEvent.js"

/**
 * Drain the smith event queue into the store in FLUSHES: up to 64 events per
 * take, adjacent same-chunk deltas coalesced, one Solid batch per flush —
 * a token stream renders at frame cadence instead of one frame per delta
 * (the renderer already caps at 30fps; this keeps the reducer work bounded).
 */

type AgentDelta = Extract<SmithEvent, { readonly type: "agent" }> & {
  readonly event: {
    readonly type: "assistant_delta"
    readonly turnIndex: number
    readonly channel: "text" | "reasoning"
    readonly id: string
    readonly delta: string
  }
}

const asDelta = (event: SmithEvent): AgentDelta | undefined =>
  event.type === "agent" && event.event.type === "assistant_delta"
    ? (event as AgentDelta)
    : undefined

/** Merge ADJACENT deltas of the same (turn, channel, id) — order-safe by
 *  construction (only neighbors merge; nothing crosses a non-delta event). */
export const coalesceDeltas = (
  events: ReadonlyArray<SmithEvent>,
): ReadonlyArray<SmithEvent> =>
  events.reduce((acc: ReadonlyArray<SmithEvent>, event) => {
    const previous = acc[acc.length - 1]
    const incoming = asDelta(event)
    const standing = previous === undefined ? undefined : asDelta(previous)
    if (
      incoming !== undefined &&
      standing !== undefined &&
      standing.event.turnIndex === incoming.event.turnIndex &&
      standing.event.channel === incoming.event.channel &&
      standing.event.id === incoming.event.id
    ) {
      const merged: SmithEvent = {
        ...standing,
        event: { ...standing.event, delta: standing.event.delta + incoming.event.delta },
      }
      return [...acc.slice(0, -1), merged]
    }
    return [...acc, event]
  }, [])

export const runEventPump = (
  queue: Queue.Queue<SmithEvent>,
  reduceBatch: (events: ReadonlyArray<SmithEvent>) => void,
): Effect.Effect<never> =>
  Effect.forever(
    Effect.flatMap(Queue.takeBetween(queue, 1, 64), (events) =>
      Effect.sync(() => reduceBatch(coalesceDeltas(Chunk.toReadonlyArray(events)))),
    ),
  )
