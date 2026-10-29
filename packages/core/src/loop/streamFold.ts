import { Effect, Option, Stream } from "effect"
import type { Schema } from "effect"
import { Response } from "effect/ai"

/**
 * Folds a `streamText` part stream into the SETTLED turn shape `step()`
 * reads — after this fold the loop's turn body is identical code on both
 * paths, so replay ≡ live for final events by construction.
 *
 * - Streamed text/reasoning chunks occupy ORDERED SLOTS at the position
 *   their start/first-delta arrived; deltas append in place (and fan out
 *   through `onDelta` for live rendering).
 * - A chunk keeps its provider metadata, merged from its start, every delta
 *   (empty ones included) and its end the way effect/ai merges a streamed
 *   block's: an Anthropic thinking signature arrives on an empty delta, a
 *   redacted thinking block on a start with no text, OpenAI's `itemId` and
 *   `encryptedContent` on the start and end. The settled part carries the
 *   same metadata the non-streamed response's does, so the stored history
 *   and its replay do not depend on the path.
 * - A chunk with neither text nor metadata is dropped (content-part
 *   identity).
 * - Every settled part (tool-call, tool-result, finish, provider extras)
 *   passes through at its arrival position unchanged — metadata included,
 *   so the router's model stamp and the usage fold read exactly what the
 *   non-streaming path reads.
 * - `finishReason`/`usage` lift off the finish part (the last one carrying
 *   usage wins, matching `extractUsage`'s scan).
 */

export interface StreamDelta {
  readonly channel: "text" | "reasoning" | "tool-params"
  readonly id: string
  readonly delta: string
  /** The tool being called — set on `tool-params` deltas only. */
  readonly toolName?: string
}

/** Structurally what the loop reads off a `GenerateTextResponse`; `usage`
 *  is absent when no finish part carried one. */
export interface FoldedTurn {
  readonly content: ReadonlyArray<unknown>
  readonly finishReason: string
  readonly usage?: unknown
}

type Metadata = Response.ProviderMetadata

interface Chunk {
  readonly kind: "chunk"
  readonly channel: "text" | "reasoning"
  readonly id: string
  readonly text: string
  readonly metadata: Metadata
}

type Entry = Chunk | { readonly kind: "part"; readonly part: unknown }

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

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** effect/ai's merge of a streamed block's metadata: per provider, the later
 *  part's fields over the earlier ones; a value that is not an object
 *  replaces the earlier one. */
const mergeMetadata = (earlier: Metadata, later: Metadata): Metadata =>
  Object.entries(later).reduce(
    (merged: Metadata, [provider, fields]) => {
      const before = merged[provider]
      return {
        ...merged,
        [provider]: isJsonObject(before) && isJsonObject(fields) ? { ...before, ...fields } : fields,
      }
    },
    earlier,
  )

const isChunk = (channel: "text" | "reasoning", id: string) => (entry: Entry): entry is Chunk =>
  entry.kind === "chunk" && entry.channel === channel && entry.id === id

/** The chunk `id` of `channel` — opened in the next slot when unseen — with
 *  `delta` appended and `metadata` merged in. */
const extendChunk = (
  entries: ReadonlyArray<Entry>,
  channel: "text" | "reasoning",
  id: string,
  delta: string,
  metadata: Metadata,
): ReadonlyArray<Entry> => {
  const matches = isChunk(channel, id)
  const opened: ReadonlyArray<Entry> = entries.some(matches)
    ? entries
    : [...entries, { kind: "chunk", channel, id, text: "", metadata: {} }]
  return opened.map((e) =>
    matches(e) ? { ...e, text: e.text + delta, metadata: mergeMetadata(e.metadata, metadata) } : e,
  )
}

const entryParts = (entry: Entry): ReadonlyArray<unknown> => {
  if (entry.kind === "part") return [entry.part]
  return entry.text.length > 0 || Object.keys(entry.metadata).length > 0
    ? [Response.makePart(entry.channel, { text: entry.text, metadata: entry.metadata })]
    : []
}

export const foldStreamParts = <E, R, R2 = never>(
  parts: Stream.Stream<unknown, E, R>,
  onDelta: (delta: StreamDelta) => Effect.Effect<void, never, R2>,
): Effect.Effect<FoldedTurn, E, R | R2> =>
  Stream.runFoldEffect(
    parts,
    (): FoldState => ({
      entries: [],
      finishReason: Option.none(),
      usage: Option.none(),
    }),
    (state: FoldState, part): Effect.Effect<FoldState, never, R2> => {
      const p = part as {
        readonly type?: string
        readonly id?: string
        readonly name?: string
        readonly delta?: string
        readonly reason?: string
        readonly usage?: unknown
        readonly metadata?: Metadata
      }
      const type = p.type ?? ""
      // Tool argument streaming: fan the deltas for incremental admission
      // AND keep the parts passing through as settled entries (the settled
      // content is byte-identical to the non-streamed path). The start part
      // carries the tool name; deltas share the call id.
      if (type === "tool-params-start" || type === "tool-params-delta") {
        const id = p.id ?? "tool-params-1"
        const fan = onDelta({
          channel: "tool-params",
          id,
          delta: type === "tool-params-delta" ? p.delta ?? "" : "",
          ...(type === "tool-params-start" && p.name !== undefined ? { toolName: p.name } : {}),
        })
        return fan.pipe(
          Effect.as({
            ...state,
            entries: [...state.entries, { kind: "part", part } as Entry],
          }),
        )
      }
      const channel = CHANNEL_BY_TYPE[type]
      if (channel !== undefined) {
        const id = p.id ?? `${channel}-1`
        const delta = type.endsWith("-delta") ? p.delta ?? "" : ""
        const next = { ...state, entries: extendChunk(state.entries, channel, id, delta, p.metadata ?? {}) }
        return delta.length > 0
          ? onDelta({ channel, id, delta }).pipe(Effect.as(next))
          : Effect.succeed(next)
      }
      if (type === "finish") {
        // Mirror extractUsage's preference: the FIRST finish's reason wins
        // (a trailing usage-only finish has no meaningful reason), while a
        // usage-CARRYING finish wins for usage.
        const usage = p.usage as
          | { readonly inputTokens?: { readonly total?: number }; readonly outputTokens?: { readonly total?: number } }
          | undefined
        const carriesUsage = usage?.inputTokens?.total !== undefined || usage?.outputTokens?.total !== undefined
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
    Effect.map((state): FoldedTurn => ({
      content: state.entries.flatMap(entryParts),
      finishReason: Option.getOrElse(state.finishReason, () => "unknown"),
      ...Option.match(state.usage, { onNone: () => ({}), onSome: (usage) => ({ usage }) }),
    })),
  )
