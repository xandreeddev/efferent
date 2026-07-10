import { Option } from "effect"
import type { ConversationBlock } from "./conversation.js"

/**
 * `/query` — pane-local search over the conversation story. Pure machine:
 * hits are BLOCK INDEXES (the durable identity the renderer highlights and
 * the scrollbox jumps toward); cycling wraps. The key layer owns wiring
 * (ctrl+n / ctrl+p — plain n/N would type into the focused composer).
 */

export interface SearchState {
  readonly query: string
  readonly hits: ReadonlyArray<number>
  /** Index INTO hits (0-based). */
  readonly at: number
}

/** Every searchable string a block carries, joined. */
export const blockText = (block: ConversationBlock): string => {
  if (block.kind === "user" || block.kind === "error" || block.kind === "notice") {
    return block.text
  }
  if (block.kind === "reasoning" || block.kind === "assistant") return `${block.text} ${block.tag}`
  if (block.kind === "tool") return `${block.name} ${block.arg} ${block.result ?? ""}`
  return `${block.text} ${block.artifact}`
}

export const findHits = (
  blocks: ReadonlyArray<ConversationBlock>,
  query: string,
): ReadonlyArray<number> => {
  const needle = query.toLowerCase()
  return blocks.flatMap((block, index) =>
    blockText(block).toLowerCase().includes(needle) ? [index] : [],
  )
}

/** `None` when the query is empty or nothing matches. Starts at the LAST
 *  hit — the story reads bottom-up, so the nearest match comes first. */
export const startSearch = (
  blocks: ReadonlyArray<ConversationBlock>,
  query: string,
): Option.Option<SearchState> => {
  const trimmed = query.trim()
  if (trimmed.length === 0) return Option.none()
  const hits = findHits(blocks, trimmed)
  return hits.length === 0
    ? Option.none()
    : Option.some({ query: trimmed, hits, at: hits.length - 1 })
}

export const cycleSearch = (state: SearchState, direction: 1 | -1): SearchState => ({
  ...state,
  at: (state.at + direction + state.hits.length) % state.hits.length,
})

/** The current hit's block index, when a search is live. */
export const currentHit = (search: Option.Option<SearchState>): Option.Option<number> =>
  Option.flatMap(search, (s) => Option.fromNullable(s.hits[s.at]))

/** "hit 2/5 — ctrl+n/ctrl+p cycle · / clears" — the notice line. */
export const searchNotice = (state: SearchState): string =>
  `hit ${state.at + 1}/${state.hits.length} for "${state.query}" — ctrl+n/ctrl+p cycle · / clears`
