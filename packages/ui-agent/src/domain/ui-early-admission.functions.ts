import { Either, Option, Schema } from "effect"
import { PageManifestInput, UiBlock } from "./ui-page.entity.js"

/**
 * Streaming admission (the ui-latency plan's Phase 2): while `start_ui`'s
 * arguments are still streaming, extract the earliest ADMITTABLE shape —
 * the complete `page` object plus the first complete `criticalBlocks`
 * element — from the raw argument prefix. Everything here is fail-safe by
 * construction: a scan that does not complete or a value that does not
 * decode yields `none`, and the settled tool call remains the authority.
 */

export interface EarlyStart {
  readonly page: PageManifestInput
  readonly firstBlock: UiBlock
}

interface ScanState {
  readonly depth: number
  readonly inString: boolean
  readonly escaped: boolean
  readonly end: Option.Option<number>
}

/** End index (exclusive, relative to `from`) of the complete JSON value
 * starting at `from` — none while the buffer still ends inside it. String
 * and escape aware, so braces inside copy never confuse the depth. */
const scanValueEnd = (source: string, from: number): Option.Option<number> =>
  [...source.slice(from)].reduce<ScanState>(
    (state, ch, index) => {
      if (Option.isSome(state.end)) return state
      if (state.inString) {
        if (state.escaped) return { ...state, escaped: false }
        if (ch === "\\") return { ...state, escaped: true }
        if (ch === '"') return { ...state, inString: false }
        return state
      }
      if (ch === '"') return { ...state, inString: true }
      if (ch === "{" || ch === "[") return { ...state, depth: state.depth + 1 }
      if (ch === "}" || ch === "]") {
        return state.depth === 1
          ? { ...state, depth: 0, end: Option.some(index + 1) }
          : { ...state, depth: state.depth - 1 }
      }
      return state
    },
    { depth: 0, inString: false, escaped: false, end: Option.none() },
  ).end

const decodePage = Schema.decodeUnknownEither(PageManifestInput)
const decodeBlock = Schema.decodeUnknownEither(UiBlock)

const parseJson = (source: string): Option.Option<unknown> =>
  Option.getRight(Either.try(() => JSON.parse(source) as unknown))

/** The start (index of the opening brace/bracket) of the JSON value that
 * follows `"<key>"\s*:` at or after `from` — none if the key or its value
 * opener has not streamed yet. A false-positive match inside string copy is
 * harmless: the decode gate below rejects it and we wait for the settled
 * call. */
const valueStart = (source: string, key: string, opener: string, from: number): Option.Option<number> => {
  const match = new RegExp(`"${key}"\\s*:\\s*\\${opener}`).exec(source.slice(from))
  return match === null ? Option.none() : Option.some(from + match.index + match[0].length - 1)
}

export const extractEarlyStart = (argsPrefix: string): Option.Option<EarlyStart> =>
  Option.gen(function* () {
    const pageStart = yield* valueStart(argsPrefix, "page", "{", 0)
    const pageEnd = yield* scanValueEnd(argsPrefix, pageStart)
    const page = yield* parseJson(argsPrefix.slice(pageStart, pageStart + pageEnd)).pipe(
      Option.flatMap((value) => Option.getRight(decodePage(value))),
    )
    const blocksStart = yield* valueStart(argsPrefix, "criticalBlocks", "[", pageStart + pageEnd)
    const firstElementAt = argsPrefix.indexOf("{", blocksStart + 1)
    if (firstElementAt < 0) return yield* Option.none()
    const elementEnd = yield* scanValueEnd(argsPrefix, firstElementAt)
    const firstBlock = yield* parseJson(argsPrefix.slice(firstElementAt, firstElementAt + elementEnd)).pipe(
      Option.flatMap((value) => Option.getRight(decodeBlock(value))),
    )
    return { page, firstBlock }
  })

export interface EarlyPatch {
  readonly pageId: string
  readonly blocks: ReadonlyArray<UiBlock>
}

/** Every COMPLETE element of the `blocks` array so far, in order. Collection
 * stops at the first incomplete or non-decoding element — order-preserving,
 * so the session can upsert `blocks[admitted..]` as the stream grows. */
const collectBlocks = (source: string, from: number, acc: ReadonlyArray<UiBlock>): ReadonlyArray<UiBlock> => {
  const at = source.indexOf("{", from)
  if (at < 0) return acc
  return Option.match(scanValueEnd(source, at), {
    onNone: () => acc,
    onSome: (end) => Option.match(
      parseJson(source.slice(at, at + end)).pipe(Option.flatMap((value) => Option.getRight(decodeBlock(value)))),
      {
        onNone: () => acc,
        onSome: (block) => collectBlocks(source, at + end, [...acc, block]),
      },
    ),
  })
}

/** The composer's real streaming win: a `patch_ui` call carries 2-4 blocks
 * streaming for tens of seconds — each block can paint the moment its own
 * JSON completes. The `complete` flag is NEVER inferred from a prefix; only
 * the settled call may declare completion. */
export const extractEarlyPatch = (argsPrefix: string): Option.Option<EarlyPatch> =>
  Option.gen(function* () {
    const idMatch = /"pageId"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(argsPrefix)
    if (idMatch === null) return yield* Option.none()
    const blocksStart = yield* valueStart(argsPrefix, "blocks", "[", 0)
    const blocks = collectBlocks(argsPrefix, blocksStart + 1, [])
    if (blocks.length === 0) return yield* Option.none()
    return { pageId: idMatch[1] ?? "", blocks }
  })
