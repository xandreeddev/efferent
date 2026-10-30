import { Effect, Match, Option, Stream } from "effect"
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

/** What the loop reads off a `GenerateTextResponse`; `usage` is absent when
 *  no finish part carried one. */
export interface FoldedTurn {
  readonly content: ReadonlyArray<Response.AnyPart>
  readonly finishReason: Response.FinishReason
  readonly usage?: Response.Usage
}

type Metadata = Response.ProviderMetadata

type Channel = "text" | "reasoning"

interface Chunk {
  readonly kind: "chunk"
  readonly channel: Channel
  readonly id: string
  readonly text: string
  readonly metadata: Metadata
}

type Entry = Chunk | { readonly kind: "part"; readonly part: Response.AnyPart }

interface FoldState {
  readonly entries: ReadonlyArray<Entry>
  readonly finishReason: Option.Option<Response.FinishReason>
  readonly usage: Option.Option<Response.Usage>
}

/** The parts of a streamed text or reasoning block: its start, deltas and end. */
type ChunkPart =
  | Response.TextStartPart
  | Response.TextDeltaPart
  | Response.TextEndPart
  | Response.ReasoningStartPart
  | Response.ReasoningDeltaPart
  | Response.ReasoningEndPart

const CHANNEL_BY_TYPE: { readonly [T in ChunkPart["type"]]: Channel } = {
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

const isChunk = (channel: Channel, id: string) => (entry: Entry): entry is Chunk =>
  entry.kind === "chunk" && entry.channel === channel && entry.id === id

/** The chunk `id` of `channel` — opened in the next slot when unseen — with
 *  `delta` appended and `metadata` merged in. */
const extendChunk = (
  entries: ReadonlyArray<Entry>,
  channel: Channel,
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

const entryParts = (entry: Entry): ReadonlyArray<Response.AnyPart> => {
  if (entry.kind === "part") return [entry.part]
  return entry.text.length > 0 || Object.keys(entry.metadata).length > 0
    ? [Response.makePart(entry.channel, { text: entry.text, metadata: entry.metadata })]
    : []
}

const carriesUsage = (usage: Response.Usage): boolean =>
  usage.inputTokens.total !== undefined || usage.outputTokens.total !== undefined

/** A part passed through as a settled entry at its arrival position. */
const settle = (state: FoldState, part: Response.AnyPart): FoldState => ({
  ...state,
  entries: [...state.entries, { kind: "part", part }],
})

/** A failure of `onDelta` fails the fold with it. */
export const foldStreamParts = <E, R, R2 = never, E2 = never>(
  parts: Stream.Stream<Response.AnyPart, E, R>,
  onDelta: (delta: StreamDelta) => Effect.Effect<void, E2, R2>,
): Effect.Effect<FoldedTurn, E | E2, R | R2> =>
  Stream.runFoldEffect(
    parts,
    (): FoldState => ({
      entries: [],
      finishReason: Option.none(),
      usage: Option.none(),
    }),
    (state: FoldState, part): Effect.Effect<FoldState, E2, R2> => {
      /** A text or reasoning chunk: extends its entry, and fans its delta out when it has one. */
      const chunk = (chunkPart: ChunkPart): Effect.Effect<FoldState, E2, R2> => {
        const channel = CHANNEL_BY_TYPE[chunkPart.type]
        const delta = "delta" in chunkPart ? chunkPart.delta : ""
        const next = { ...state, entries: extendChunk(state.entries, channel, chunkPart.id, delta, chunkPart.metadata) }
        return delta.length > 0
          ? onDelta({ channel, id: chunkPart.id, delta }).pipe(Effect.as(next))
          : Effect.succeed(next)
      }
      return Match.value(part).pipe(
        Match.discriminators("type")({
          // Tool argument streaming: fan the deltas for incremental admission
          // AND keep the parts passing through as settled entries (the settled
          // content is byte-identical to the non-streamed path). The start part
          // carries the tool name; deltas share the call id.
          "tool-params-start": (start): Effect.Effect<FoldState, E2, R2> =>
            onDelta({ channel: "tool-params", id: start.id, delta: "", toolName: start.name }).pipe(Effect.as(settle(state, start))),
          "tool-params-delta": (params): Effect.Effect<FoldState, E2, R2> =>
            onDelta({ channel: "tool-params", id: params.id, delta: params.delta }).pipe(Effect.as(settle(state, params))),
          "text-start": chunk,
          "text-delta": chunk,
          "text-end": chunk,
          "reasoning-start": chunk,
          "reasoning-delta": chunk,
          "reasoning-end": chunk,
          // Mirror extractUsage's preference: the FIRST finish's reason wins
          // (a trailing usage-only finish has no meaningful reason), while a
          // usage-CARRYING finish wins for usage.
          finish: (finish): Effect.Effect<FoldState, E2, R2> => Effect.succeed({
            entries: [...state.entries, { kind: "part", part: finish }],
            finishReason: Option.orElse(state.finishReason, () => Option.some(finish.reason)),
            usage: carriesUsage(finish.usage) || Option.isNone(state.usage) ? Option.some(finish.usage) : state.usage,
          }),
        }),
        // Every other part passes through as a settled entry.
        Match.orElse((other): Effect.Effect<FoldState, E2, R2> => Effect.succeed(settle(state, other))),
      )
    },
  ).pipe(
    Effect.map((state): FoldedTurn => ({
      content: state.entries.flatMap(entryParts),
      finishReason: Option.getOrElse(state.finishReason, (): Response.FinishReason => "unknown"),
      ...Option.match(state.usage, { onNone: () => ({}), onSome: (usage) => ({ usage }) }),
    })),
  )
