// What the context inspector draws, worked out from three things and nothing else:
//   - the journal (every event the session recorded, in order),
//   - the context report (one row per model request: tokens by layer),
//   - the requests the model was actually sent (captured per turn, run and step).
// Pure: no DOM, no framework services, so it is tested on its own.
import { Option } from "effect"
import type { CapturedMessage, CapturedRequest } from "./capture.ts"

/** The slice of a journal event this model reads. */
export interface JournalEvent {
  readonly seq: number
  readonly kind: string
  readonly turn: Option.Option<number>
  readonly data: unknown
}

/** The slice of a context-report row this model reads. */
export interface ReportRow {
  readonly seq: number
  readonly turn: number
  readonly run: number
  readonly step: number
  readonly system: { readonly tokens: number }
  readonly tools: { readonly tokens: number }
  readonly built: Option.Option<{ readonly estimatedTokens: number; readonly reservedTokens: number; readonly budgetTokens: number; readonly compactions: number }>
}

export interface JournalEntry {
  /** The journal sequence number of the event that holds it. */
  readonly seq: number
  readonly turn: number
  readonly role: "you" | "agent"
  readonly text: string
  /** ~3 characters a token: the framework's own estimate. */
  readonly tokens: number
}

export interface Drop {
  readonly seq: number
  readonly throughTurn: number
}

export type Layer = {
  readonly kind: "system" | "ledger" | "past" | "current"
  readonly role: string
  readonly text: string
  readonly tokens: number
  /** The same as in the previous request, up to here: a provider's prompt cache could reuse it. */
  readonly reusable: boolean
}

export type EntryStatus = "current" | "shown" | "dropped" | "reply"

export interface EntryView {
  readonly entry: JournalEntry
  readonly status: EntryStatus
  /** Its own turn failed before a request was made. A later request still carries the message as history. */
  readonly turnFailed: boolean
}

export interface RequestView {
  readonly index: number
  readonly turn: number
  readonly step: number
  readonly seq: number
  /** Absent when the request was not captured (it could not be shown). */
  readonly layers: ReadonlyArray<Layer>
  readonly entries: ReadonlyArray<EntryView>
  /** What the model answered to this request: output, so it is not part of the request's own tokens. */
  readonly reply: Option.Option<JournalEntry>
  readonly messageTokens: number
  readonly reservedTokens: number
  readonly usedTokens: number
  readonly budgetTokens: number
  readonly over: boolean
  readonly compactions: number
  /** Against the previous request; absent for the first. */
  readonly prefix: Option.Option<{ readonly layers: number; readonly tokens: number; readonly of: number }>
}

export interface InspectorModel {
  readonly journal: ReadonlyArray<JournalEntry>
  readonly drops: ReadonlyArray<Drop>
  readonly requests: ReadonlyArray<RequestView>
}

const estimate = (text: string): number => Math.ceil(text.length / 3)

const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.flatMap((part: { type?: string; text?: string }) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("")
}

const dataOf = (event: JournalEvent): Record<string, unknown> =>
  typeof event.data === "object" && event.data !== null ? (event.data as Record<string, unknown>) : {}

/** Split `total` over `weights` so the parts sum to it exactly (largest remainder). */
export const allocate = (total: number, weights: ReadonlyArray<number>): ReadonlyArray<number> => {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (weights.length === 0) return []
  if (sum === 0) return weights.map(() => 0)
  const exact = weights.map((w) => (w / sum) * total)
  const parts = exact.map(Math.floor)
  let left = total - parts.reduce((a, b) => a + b, 0)
  const order = exact.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest)
  for (const { index } of order) {
    if (left <= 0) break
    parts[index] = (parts[index] ?? 0) + 1
    left -= 1
  }
  return parts
}

/** Journal entries (what was said) and drops (what the window forgot), in journal order. */
export const journalOf = (events: ReadonlyArray<JournalEvent>): { entries: ReadonlyArray<JournalEntry>; drops: ReadonlyArray<Drop> } => {
  const entries: JournalEntry[] = []
  const drops: Drop[] = []
  for (const event of events) {
    const data = dataOf(event)
    const turn = Option.getOrElse(event.turn, () => 0)
    if (event.kind === "turn.started") {
      const text = String((data.userMessage as { text?: unknown } | undefined)?.text ?? "")
      entries.push({ seq: event.seq, turn, role: "you", text, tokens: estimate(text) })
    } else if (event.kind === "memory.message") {
      const message = (data.body as { message?: { role?: string; content?: unknown } } | undefined)?.message
      if (message?.role === "assistant") {
        const text = textOfContent(message.content)
        entries.push({ seq: event.seq, turn, role: "agent", text, tokens: estimate(text) })
      }
    } else if (event.kind === "memory.compaction") {
      const action = (data.body as { action?: { _tag?: string; throughTurn?: number } } | undefined)?.action
      if (action?._tag === "DropTurns" && typeof action.throughTurn === "number") drops.push({ seq: event.seq, throughTurn: action.throughTurn })
    }
  }
  return { entries, drops }
}

const sameMessage = (a: CapturedMessage, b: CapturedMessage): boolean => a.role === b.role && a.text === b.text

/** How many leading messages two requests share, never past the volatile tail and only when the tools match. */
const sharedMessages = (previous: CapturedRequest, current: CapturedRequest): number => {
  if (previous.tools.join("|") !== current.tools.join("|")) return 0
  let shared = 0
  while (shared < previous.messages.length && shared < current.messages.length) {
    const a = previous.messages[shared]!
    const b = current.messages[shared]!
    if (!sameMessage(a, b) || a.volatile || b.volatile) break
    shared += 1
  }
  return shared
}

const isLedger = (message: CapturedMessage): boolean => message.role === "user" && message.text.startsWith("[Host note:")

export const inspectorOf = (input: {
  readonly events: ReadonlyArray<JournalEvent>
  readonly rows: ReadonlyArray<ReportRow>
  readonly captures: ReadonlyMap<string, CapturedRequest>
}): InspectorModel => {
  const { entries, drops } = journalOf(input.events)
  const rows = [...input.rows].sort((a, b) => a.seq - b.seq)
  const sentTurns = new Set(rows.map((row) => row.turn))

  const requests: RequestView[] = []
  rows.forEach((row, index) => {
    const captured = input.captures.get(`${row.turn}:${row.run}:${row.step}`)
    const built = Option.getOrUndefined(row.built)
    const reserved = built?.reservedTokens ?? row.system.tokens + row.tools.tokens
    const messages = captured?.messages ?? []
    const body = messages.filter((m, i) => !(i === 0 && m.role === "system"))
    const messageTokens = built?.estimatedTokens ?? body.reduce((sum, m) => sum + estimate(m.text), 0)
    const tokens = allocate(messageTokens, body.map((m) => m.text.length + 8))

    const first = messages[0]
    const layers: Layer[] = []
    if (first?.role === "system") layers.push({ kind: "system", role: "system", text: first.text, tokens: row.system.tokens, reusable: false })
    body.forEach((message, i) => {
      const isLast = i === body.length - 1
      layers.push({
        kind: isLedger(message) ? "ledger" : isLast && message.role === "user" ? "current" : "past",
        role: message.role, text: message.text, tokens: tokens[i] ?? 0, reusable: false,
      })
    })

    // The reusable prefix: the leading layers identical to the previous request's.
    const previous = index > 0 ? input.captures.get(`${rows[index - 1]!.turn}:${rows[index - 1]!.run}:${rows[index - 1]!.step}`) : undefined
    const shared = captured && previous ? sharedMessages(previous, captured) : 0
    const marked = layers.map((layer, i) => ({ ...layer, reusable: i < shared }))
    const prefixTokens = marked.filter((layer) => layer.reusable).reduce((sum, layer) => sum + layer.tokens, 0)
    const total = marked.reduce((sum, layer) => sum + layer.tokens, 0)

    const entryViews: EntryView[] = entries
      .filter((entry) => entry.seq < row.seq)
      .map((entry): EntryView => {
        const turnFailed = !sentTurns.has(entry.turn)
        if (entry.turn === row.turn && entry.role === "you") return { entry, status: "current", turnFailed }
        const dropped = drops.some((drop) => drop.seq < row.seq && drop.throughTurn >= entry.turn)
        return { entry, status: dropped ? "dropped" : "shown", turnFailed }
      })

    // The first agent message the journal got after this request and before the next one.
    const until = rows[index + 1]?.seq ?? Number.POSITIVE_INFINITY
    const reply = entries.find((entry) => entry.role === "agent" && entry.turn === row.turn && entry.seq > row.seq && entry.seq < until)

    requests.push({
      index, turn: row.turn, step: row.step, seq: row.seq,
      layers: marked,
      entries: reply ? [...entryViews, { entry: reply, status: "reply", turnFailed: false }] : entryViews,
      reply: Option.fromNullishOr(reply),
      messageTokens, reservedTokens: reserved, usedTokens: messageTokens + reserved,
      budgetTokens: built?.budgetTokens ?? 0,
      over: built !== undefined && messageTokens + reserved > built.budgetTokens,
      compactions: built?.compactions ?? 0,
      prefix: captured && previous ? Option.some({ layers: shared, tokens: prefixTokens, of: total }) : Option.none(),
    })
  })
  return { journal: entries, drops, requests }
}
