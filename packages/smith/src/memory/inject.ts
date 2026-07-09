import { Effect, Option, Order } from "effect"
import type { MemoryRecord } from "./domain.js"
import { foldMemory } from "./domain.js"
import { memoryLedgerPath, readMemoryLedger } from "./ledger.js"

/**
 * The read side: fold the ledger, prune the stale low-trust tail, render a
 * BOUNDED block for the briefs. The ledger keeps everything; only the VIEW
 * forgets — a fact that was never corroborated and hasn't been touched in
 * months stops spending context.
 */

const MAX_INJECTED = 12
const BLOCK_CAP_CHARS = 2_000
const STALE_MS = 90 * 24 * 60 * 60 * 1000
const MIN_CORROBORATION_WHEN_STALE = 2

const byTrust: Order.Order<MemoryRecord> = Order.combineAll([
  Order.mapInput(Order.reverse(Order.number), (r: MemoryRecord) => r.corroboration),
  Order.mapInput(Order.reverse(Order.string), (r: MemoryRecord) => r.updatedAt),
])

/** The injectable view: trusted-first, stale-uncorroborated pruned, bounded. */
export const renderMemoryBlock = (
  records: ReadonlyArray<MemoryRecord>,
  now: Date,
): string => {
  const fresh = records.filter(
    (record) =>
      record.corroboration >= MIN_CORROBORATION_WHEN_STALE ||
      now.getTime() - Date.parse(record.updatedAt) < STALE_MS,
  )
  if (fresh.length === 0) return ""
  const lines = [...fresh]
    .sort((a, b) => byTrust(a, b))
    .slice(0, MAX_INJECTED)
    .map((record) => `- [${record.topic}] ${record.statement} (seen ${record.corroboration}×)`)
  const body = [
    "## Workspace memory (curated from past sessions — verify before relying on it)",
    ...lines,
  ].join("\n")
  return body.length <= BLOCK_CAP_CHARS ? body : `${body.slice(0, BLOCK_CAP_CHARS)}…`
}

/** The brief splice: `None` when the workspace has no injectable memory. */
export const loadWorkspaceMemory = (cwd: string): Effect.Effect<Option.Option<string>> =>
  readMemoryLedger(memoryLedgerPath(cwd)).pipe(
    Effect.map((events) => {
      const rendered = renderMemoryBlock(foldMemory(events), new Date())
      return rendered.length > 0 ? Option.some(rendered) : Option.none<string>()
    }),
  )
