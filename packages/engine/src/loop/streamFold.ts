import { Effect, Option, Stream } from "effect"

/**
 * Folds a `streamText` part stream into the SETTLED turn shape `step()`
 * reads — after this fold the loop's turn body is identical code on both
 * paths, so replay ≡ live for final events by construction.
 *
 * - Streamed text/reasoning chunks occupy ORDERED SLOTS at the position
 *   their start/first-delta arrived; deltas append in place (and fan out
 *   through `onDelta` for live rendering); a chunk that accumulated nothing
 *   is dropped (content-part identity).
 * - Every settled part (tool-call, tool-result, finish, provider extras)
 *   passes through at its arrival position unchanged — metadata included,
 *   so the router's model stamp and the usage fold read exactly what the
 *   non-streaming path reads.
 * - `finishReason`/`usage` lift off the finish part (the last one carrying
 *   usage wins, matching `extractUsage`'s scan).
 */

export interface StreamDelta {
  readonly channel: "text" | "reasoning"
  readonly id: string
  readonly delta: string
}

/** Structurally what the loop reads off a `GenerateTextResponse`. */
export interface FoldedTurn {
  readonly content: ReadonlyArray<unknown>
  readonly finishReason: string
  readonly usage: unknown
}

type Entry =
  | {
      readonly kind: "chunk"
      readonly channel: "text" | "reasoning"
      readonly id: string
      readonly text: string
    }
  | { readonly kind: "part"; readonly part: unknown }

interface FoldState {
  readonly entries: ReadonlyArray<Entry>
  readonly finishReason: Option.Option<string>
  readonly usage: Option.Option<unknown>
}

const CHANNEL_BY_TYPE: Record<string, "text" | "reasoning"> = {
  "text-start": "text",
  "text-delta": "text",
  "text-end": "text",
  "reasoning-start": "reasoning",
  "reasoning-delta": "reasoning",
  "reasoning-end": "reasoning",
}

const openChunk = (
  entries: ReadonlyArray<Entry>,
  channel: "text" | "reasoning",
  id: string,
): ReadonlyArray<Entry> =>
  entries.some((e) => e.kind === "chunk" && e.channel === channel && e.id === id)
    ? entries
    : [...entries, { kind: "chunk", channel, id, text: "" }]

const appendDelta = (
  entries: ReadonlyArray<Entry>,
  channel: "text" | "reasoning",
  id: string,
  delta: string,
): ReadonlyArray<Entry> =>
  openChunk(entries, channel, id).map((e) =>
    e.kind === "chunk" && e.channel === channel && e.id === id
      ? { ...e, text: e.text + delta }
      : e,
  )

const entryParts = (entry: Entry): ReadonlyArray<unknown> => {
  if (entry.kind === "part") return [entry.part]
  return entry.text.length > 0 ? [{ type: entry.channel, text: entry.text }] : []
}

export const foldStreamParts = <E, R, R2 = never>(
  parts: Stream.Stream<unknown, E, R>,
  onDelta: (delta: StreamDelta) => Effect.Effect<void, never, R2>,
): Effect.Effect<FoldedTurn, E, R | R2> =>
  Stream.runFoldEffect(
    parts,
    {
      entries: [],
      finishReason: Option.none(),
      usage: Option.none(),
    } as FoldState,
    (state, part) => {
      const p = part as {
        readonly type?: string
        readonly id?: string
        readonly delta?: string
        readonly reason?: string
        readonly usage?: unknown
      }
      const type = p.type ?? ""
      const channel = CHANNEL_BY_TYPE[type]
      if (channel !== undefined) {
        const id = p.id ?? `${channel}-1`
        if (type.endsWith("-start")) {
          return Effect.succeed({ ...state, entries: openChunk(state.entries, channel, id) })
        }
        if (type.endsWith("-end")) {
          return Effect.succeed(state)
        }
        const delta = p.delta ?? ""
        const next = { ...state, entries: appendDelta(state.entries, channel, id, delta) }
        return delta.length > 0
          ? onDelta({ channel, id, delta }).pipe(Effect.as(next))
          : Effect.succeed(next)
      }
      if (type === "finish") {
        // Mirror extractUsage's preference: the FIRST finish's reason wins
        // (a trailing usage-only finish has no meaningful reason), while a
        // usage-CARRYING finish wins for usage.
        const usage = p.usage as
          | { readonly inputTokens?: number; readonly outputTokens?: number }
          | undefined
        const carriesUsage = usage?.inputTokens !== undefined || usage?.outputTokens !== undefined
        return Effect.succeed({
          entries: [...state.entries, { kind: "part", part } as Entry],
          finishReason: Option.orElse(state.finishReason, () =>
            Option.some(p.reason ?? "unknown"),
          ),
          usage: carriesUsage || Option.isNone(state.usage) ? Option.some(p.usage) : state.usage,
        })
      }
      return Effect.succeed({
        ...state,
        entries: [...state.entries, { kind: "part", part } as Entry],
      })
    },
  ).pipe(
    Effect.map((state) => ({
      content: state.entries.flatMap(entryParts),
      finishReason: Option.getOrElse(state.finishReason, () => "unknown"),
      usage: Option.getOrUndefined(state.usage),
    })),
  )
