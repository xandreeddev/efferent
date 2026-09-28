import { Effect, Option, ParseResult, Schema } from "effect"
import type { AgentMessage, ToolResultPart } from "../domain/message.entity.js"
import { handoffToMessage } from "../loop/mapping.js"
import type { ArtifactRef, BuiltContext, CompactionAction, EntryId, LogBody, LogEntry, Subject } from "./memory-log.entity.js"
import { EntryId as EntryIdSchema, LogAppendPayload, LogEntry as LogEntrySchema } from "./memory-log.entity.js"

/** Key-sorted JSON: identical values always serialize to identical bytes. */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value)) ?? "null"

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
        const field = (value as Record<string, unknown>)[key]
        return field === undefined ? [] : [[key, sortKeys(field)] as const]
      }))
      : value

/** FNV-1a (32 bit) plus length — pure, stable across processes and runtimes. */
export const fingerprintOf = (text: string): string => {
  const hash = Array.from(text).reduce((h, ch) => Math.imul((h ^ ch.charCodeAt(0)) >>> 0, 16777619) >>> 0, 2166136261)
  return `${hash.toString(16).padStart(8, "0")}${text.length.toString(16)}`
}

/** A deliberately conservative estimate for mixed prose and JSON. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3)

export const estimateMessageTokens = (messages: ReadonlyArray<AgentMessage>): number =>
  messages.reduce((sum, message) => sum + estimateTokens(canonicalJson(message)), 0)

export const entryId = (runId: string, index: number): EntryId => EntryIdSchema.make(`${runId}:${index}`)

const EntriesJson = Schema.parseJson(Schema.Array(LogEntrySchema))

/** One append's entries → the canonical journal payload. */
export const encodeAppend = (entries: ReadonlyArray<LogEntry>): Effect.Effect<LogAppendPayload, ParseResult.ParseError> =>
  Schema.encode(Schema.Array(LogEntrySchema))(entries).pipe(
    Effect.map((encoded) => ({ v: 2 as const, entries: canonicalJson(encoded) })),
  )

/** A stored journal payload → its log entries (ids travel inside). */
export const entriesOfPayload = (data: unknown): Effect.Effect<ReadonlyArray<LogEntry>, ParseResult.ParseError> =>
  Schema.decodeUnknown(LogAppendPayload)(data).pipe(Effect.flatMap((payload) => Schema.decodeUnknown(EntriesJson)(payload.entries)))

/** Recorded digests by result entry; the latest digest of an entry wins. */
const digestsOf = (entries: ReadonlyArray<LogEntry>): ReadonlyMap<string, string> =>
  new Map(entries.flatMap((entry) => entry.body._tag === "ToolDigest" ? [[String(entry.body.entry), entry.body.text] as const] : []))

/** What a strategy decided for one render: only its own compactions apply. */
interface Applied {
  readonly views: ReadonlyMap<string, string>
  readonly cutTurn: number
  readonly preamble: Option.Option<AgentMessage>
  readonly ids: ReadonlyArray<EntryId>
}

const appliedCompactions = (entries: ReadonlyArray<LogEntry>, strategy: string): Applied =>
  entries.reduce((applied: Applied, entry): Applied => {
    if (entry.body._tag !== "Compaction" || entry.body.strategy !== strategy) return applied
    const action: CompactionAction = entry.body.action
    const ids = [...applied.ids, entry.id]
    if (action._tag === "CompactViews") {
      return { ...applied, ids, views: new Map([...applied.views, ...action.entries.map((id, index) => [id, action.texts[index] ?? ""] as const)]) }
    }
    if (action._tag === "Spill") return { ...applied, ids, views: new Map([...applied.views, [action.entry, action.preview]]) }
    if (action._tag === "DropTurns") {
      return action.throughTurn < applied.cutTurn ? { ...applied, ids } : {
        ...applied, ids, cutTurn: action.throughTurn,
        preamble: Option.some({ role: "user", content: `[Host note: earlier turns were condensed to free context.]\n\n${action.ledger}` }),
      }
    }
    return action.keepFromTurn - 1 < applied.cutTurn ? { ...applied, ids } : {
      ...applied, ids, cutTurn: action.keepFromTurn - 1, preamble: Option.some(handoffToMessage(action.summary)),
    }
  }, { views: new Map(), cutTurn: 0, preamble: Option.none(), ids: [] })

const toolCallIds = (message: AgentMessage): ReadonlyArray<string> =>
  message.role === "assistant" ? message.content.flatMap((part) => part.type === "tool-call" ? [part.toolCallId] : []) : []

const assistantText = (message: AgentMessage): Option.Option<string> => {
  if (message.role !== "assistant") return Option.none()
  const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")
  return text.length === 0 ? Option.none() : Option.some(text)
}

const mergeToolMessages = (messages: ReadonlyArray<AgentMessage>): ReadonlyArray<AgentMessage> =>
  messages.reduce((merged: ReadonlyArray<AgentMessage>, message) => {
    const last = merged[merged.length - 1]
    return last !== undefined && last.role === "tool" && message.role === "tool"
      ? [...merged.slice(0, -1), { role: "tool", content: [...last.content, ...message.content] }]
      : [...merged, message]
  }, [])

export interface RenderOptions {
  /** Only this strategy's compaction entries apply. */
  readonly strategy: string
  readonly currentTurn: number
  readonly currentRun: string
  /** Turn contexts are shown for the current turn only, or for every kept turn. */
  readonly turnContext: "current" | "all"
  /** Append the host's delivered reply when the model's own text differs. */
  readonly replies: boolean
  /** The current step's context closes the messages ("tail") or rides in the system prompt ("none"). */
  readonly stepContext: "tail" | "none"
  /** Show recorded tool digests in place of the results they digest. */
  readonly digests: boolean
  /**
   * How artifacts reach the model. `none`: a reference line after the
   * result's text. `inline` is reserved for image parts; messages carry text
   * only today, so it renders like `none`.
   */
  readonly media: { readonly mode: "none" | "inline"; readonly maxImages: number }
}

/** The reference lines a result's artifacts add to its text. */
export const artifactLines = (artifacts: ReadonlyArray<ArtifactRef>, maxImages: number): string => {
  if (artifacts.length === 0) return ""
  const shown = artifacts.slice(0, Math.max(0, maxImages))
  const more = artifacts.length - shown.length
  return [
    "",
    "Artifacts:",
    ...shown.map((artifact) => `- ${artifact.kind} ${artifact.id} (${artifact.mediaType})${Option.match(artifact.alt, { onNone: () => "", onSome: (alt) => `: ${alt}` })}`),
    ...(more > 0 ? [`- … ${more} more`] : []),
  ].join("\n")
}

/**
 * THE rebuild: a pure fold of the log into the messages the model sees.
 * Every strategy renders through this, differing only by the compaction
 * entries it recorded, so in-run and replayed requests are byte-identical.
 */
interface RenderState {
  readonly out: ReadonlyArray<AgentMessage>
  readonly lastText: ReadonlyMap<number, string>
}

const userRoleMessage = (content: string): AgentMessage => ({ role: "user", content })
const assistantMessage = (text: string): AgentMessage => ({ role: "assistant", content: [{ type: "text", text }] })

export const renderLog = (entries: ReadonlyArray<LogEntry>, options: RenderOptions): ReadonlyArray<AgentMessage> => {
  const applied = appliedCompactions(entries, options.strategy)
  const digests = options.digests ? digestsOf(entries) : new Map<string, string>()
  const pinned: ReadonlySet<string> = new Set(entries.flatMap((entry) => entry.body._tag === "ToolResult" && entry.body.pinned ? [String(entry.body.toolCallId)] : []))
  const kept = (entry: LogEntry): boolean => entry.turn > applied.cutTurn
  const stepContext = options.stepContext === "none" ? [] : entries.filter((entry) => entry.body._tag === "StepContext" && entry.runId === options.currentRun).slice(-1)
  const initial: RenderState = { out: [], lastText: new Map() }
  const body = entries.reduce((state: RenderState, entry): RenderState => {
    const b: LogBody = entry.body
    if (b._tag === "TurnStarted") return kept(entry) ? { ...state, out: [...state.out, userRoleMessage(b.userMessage.text)] } : state
    if (b._tag === "TurnContext") {
      return kept(entry) && (options.turnContext === "all" || entry.turn === options.currentTurn)
        ? { ...state, out: [...state.out, userRoleMessage(b.text)] } : state
    }
    if (b._tag === "Message") {
      const calls = toolCallIds(b.message)
      const pinnedExchange = calls.length > 0 && calls.every((id) => pinned.has(id))
      if (!kept(entry) && !pinnedExchange) return state
      const text = assistantText(b.message)
      return {
        out: [...state.out, b.message],
        lastText: Option.match(text, { onNone: () => state.lastText, onSome: (value) => new Map([...state.lastText, [entry.turn, value]]) }),
      }
    }
    if (b._tag === "ToolResult") {
      if (!kept(entry) && !b.pinned) return state
      const text = applied.views.get(entry.id) ?? digests.get(entry.id) ?? b.view
      const part: ToolResultPart = {
        type: "tool-result", toolCallId: b.toolCallId, toolName: b.toolName,
        output: `${text}${artifactLines(b.artifacts, options.media.maxImages)}`, isError: b.isError,
      }
      const message: AgentMessage = { role: "tool", content: [part] }
      return { ...state, out: [...state.out, message] }
    }
    if (b._tag === "TurnEnded" && options.replies && kept(entry)) {
      return Option.match(b.reply, {
        onNone: () => state,
        onSome: (reply): RenderState => reply.length === 0 || state.lastText.get(entry.turn) === reply ? state
          : { ...state, out: [...state.out, assistantMessage(reply)] },
      })
    }
    return state
  }, initial).out
  const tail: ReadonlyArray<AgentMessage> = stepContext.flatMap((entry) => entry.body._tag === "StepContext" ? [userRoleMessage(entry.body.text)] : [])
  return mergeToolMessages([...Option.toArray(applied.preamble), ...body, ...tail])
}

export const buildContext = (entries: ReadonlyArray<LogEntry>, options: RenderOptions): BuiltContext => {
  const messages = renderLog(entries, options)
  return {
    messages,
    fingerprint: fingerprintOf(canonicalJson(messages)),
    estimatedTokens: estimateMessageTokens(messages),
    compactions: appliedCompactions(entries, options.strategy).ids,
  }
}

/** The latest step context recorded by this run, if any. */
export const stepContextOf = (entries: ReadonlyArray<LogEntry>, runId: string): Option.Option<string> =>
  Option.fromNullable(entries.flatMap((entry) => entry.body._tag === "StepContext" && entry.runId === runId ? [entry.body.text] : []).at(-1))

/** The number of the latest started turn (turns count from 1). */
export const currentTurnOf = (entries: ReadonlyArray<LogEntry>): number =>
  entries.reduce((turn, entry) => entry.body._tag === "TurnStarted" ? Math.max(turn, entry.turn) : turn, 0)

/** Latest-wins subjects of the given kinds (every kind when empty). */
export const subjectsOf = (entries: ReadonlyArray<LogEntry>, kinds: ReadonlyArray<string>): ReadonlyArray<Subject> => {
  const all = entries.flatMap((entry) => entry.body._tag === "ToolResult" ? entry.body.subjects : [])
    .filter((subject) => kinds.length === 0 || kinds.includes(subject.kind))
  const latest = new Map(all.map((subject) => [`${subject.kind}\u0000${subject.id}`, subject] as const))
  return [...latest.values()]
}

/** Skills and tools activated so far, in activation order (only ever grows). */
export const activationsOf = (entries: ReadonlyArray<LogEntry>): { readonly skills: ReadonlyArray<string>; readonly tools: ReadonlyArray<string> } =>
  entries.reduce((active: { readonly skills: ReadonlyArray<string>; readonly tools: ReadonlyArray<string> }, entry) =>
    entry.body._tag !== "ToolsActivated" ? active : {
      skills: [...active.skills, ...entry.body.skills.filter((skill) => !active.skills.includes(skill))],
      tools: [...active.tools, ...entry.body.tools.filter((tool) => !active.tools.includes(tool))],
    }, { skills: [], tools: [] })

/** A compact user/assistant transcript for classifiers: user messages and replies only. */
export const referenceTranscript = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<AgentMessage> =>
  entries.flatMap((entry): ReadonlyArray<AgentMessage> => {
    if (entry.body._tag === "TurnStarted") return [userRoleMessage(entry.body.userMessage.text)]
    if (entry.body._tag === "TurnEnded") {
      return Option.match(entry.body.reply, { onNone: () => [], onSome: (text) => text.length === 0 ? [] : [{ role: "assistant", content: [{ type: "text", text }] }] })
    }
    return []
  })

/** The full-fidelity transcript: messages with every tool result's encoded value. */
export const rawTranscript = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<AgentMessage> =>
  mergeToolMessages(entries.flatMap((entry): ReadonlyArray<AgentMessage> => {
    if (entry.body._tag === "TurnStarted") return [userRoleMessage(entry.body.userMessage.text)]
    if (entry.body._tag === "Message") return [entry.body.message]
    if (entry.body._tag === "ToolResult") {
      return [{ role: "tool", content: [{ type: "tool-result", toolCallId: entry.body.toolCallId, toolName: entry.body.toolName, output: entry.body.encoded, isError: entry.body.isError }] }]
    }
    return []
  }))

export interface LogQuery {
  readonly kinds: ReadonlyArray<LogBody["_tag"]>
  readonly turns: Option.Option<{ readonly from: number; readonly to: number }>
  readonly tool: Option.Option<string>
  readonly subject: Option.Option<{ readonly kind: string; readonly id: Option.Option<string> }>
  readonly text: Option.Option<string>
  readonly limit: Option.Option<number>
}

export const emptyQuery: LogQuery = {
  kinds: [], turns: Option.none(), tool: Option.none(), subject: Option.none(), text: Option.none(), limit: Option.none(),
}

export const queryLog = (entries: ReadonlyArray<LogEntry>, query: LogQuery): ReadonlyArray<LogEntry> => {
  const matches = entries.filter((entry) =>
    (query.kinds.length === 0 || query.kinds.includes(entry.body._tag)) &&
    Option.match(query.turns, { onNone: () => true, onSome: (range) => entry.turn >= range.from && entry.turn <= range.to }) &&
    Option.match(query.tool, { onNone: () => true, onSome: (tool) => entry.body._tag === "ToolResult" && entry.body.toolName === tool }) &&
    Option.match(query.subject, {
      onNone: () => true,
      onSome: (wanted) => entry.body._tag === "ToolResult" && entry.body.subjects.some((subject) =>
        subject.kind === wanted.kind && Option.match(wanted.id, { onNone: () => true, onSome: (id) => subject.id === id })),
    }) &&
    Option.match(query.text, { onNone: () => true, onSome: (text) => canonicalJson(entry.body).toLowerCase().includes(text.toLowerCase()) }))
  return Option.match(query.limit, { onNone: () => matches, onSome: (limit) => matches.slice(-limit) })
}

/** Tool-call inputs by call id, from the log and an unrecorded tail. */
export const toolInputsOf = (entries: ReadonlyArray<LogEntry>, tail: ReadonlyArray<AgentMessage>): ReadonlyMap<string, unknown> => new Map([
  ...entries.flatMap((entry) => entry.body._tag === "Message" ? [entry.body.message] : []),
  ...tail,
].flatMap((message) => message.role === "assistant"
  ? message.content.flatMap((part) => part.type === "tool-call" ? [[String(part.toolCallId), part.input] as const] : [])
  : []))

/** Entry ids this strategy already rewrote (compact views or spills). */
export const rewrittenBy = (entries: ReadonlyArray<LogEntry>, strategy: string): ReadonlySet<string> => new Set(entries.flatMap((entry) =>
  entry.body._tag !== "Compaction" || entry.body.strategy !== strategy ? []
    : entry.body.action._tag === "CompactViews" ? entry.body.action.entries.map(String)
      : entry.body.action._tag === "Spill" ? [String(entry.body.action.entry)] : []))

/** A hypothetical compaction entry, for estimating a render before recording it. */
export const pendingCompaction = (strategy: { readonly id: string; readonly version: string }, action: CompactionAction, index: number): LogEntry => ({
  id: EntryIdSchema.make(`pending:${index}`), runId: "", turn: 0, step: 0, at: 0,
  body: { _tag: "Compaction", strategy: strategy.id, version: strategy.version, action },
})

const clipText = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max)}…`

/**
 * A compact, human-readable transcript of the given turns for digests and
 * ledgers: user messages, assistant text, each tool result clipped, and replies.
 * The head (the first request) always survives the cap.
 */
export const digestTranscript = (entries: ReadonlyArray<LogEntry>, caps: { readonly result: number; readonly total: number }): string => {
  const lines = entries.flatMap((entry): ReadonlyArray<string> => {
    const body = entry.body
    if (body._tag === "TurnStarted") return [`User: ${body.userMessage.text}`]
    if (body._tag === "Message") return Option.toArray(Option.map(assistantText(body.message), (text) => `Assistant: ${text}`))
    if (body._tag === "ToolResult") return [`Tool ${body.toolName}${body.isError ? " (failed)" : ""}: ${clipText(body.view, caps.result)}`]
    if (body._tag === "TurnEnded") return Option.toArray(Option.map(body.reply, (reply) => `Reply: ${reply}`))
    return []
  })
  const joined = lines.join("\n")
  if (joined.length <= caps.total) return joined
  const head = lines[0] ?? ""
  return `${head}\n[…earlier transcript clipped…]\n${lines.slice(1).join("\n").slice(-(caps.total - head.length))}`
}

/** A generic ledger of condensed turns: what was asked, what was replied, what was found. */
export const ledgerOf = (entries: ReadonlyArray<LogEntry>, throughTurn: number, perTurnChars: number): string => {
  const kept = entries.filter((entry) => entry.turn <= throughTurn)
  const turns = [...new Set(kept.map((entry) => entry.turn))].sort((left, right) => left - right)
  const lines = turns.flatMap((turn) => {
    const inTurn = kept.filter((entry) => entry.turn === turn)
    const asked = inTurn.flatMap((entry) => entry.body._tag === "TurnStarted" ? [entry.body.userMessage.text] : []).at(0)
    const reply = inTurn.flatMap((entry) => entry.body._tag === "TurnEnded" ? Option.toArray(entry.body.reply) : []).at(-1)
    return asked === undefined ? [] : [`- Asked: ${clipText(asked, perTurnChars)}${reply === undefined ? "" : ` — replied: ${clipText(reply, perTurnChars)}`}`]
  })
  const subjects = subjectsOf(kept, []).slice(-24).map((subject) => `${subject.kind} ${subject.id}${Option.match(subject.label, { onNone: () => "", onSome: (label) => ` (${label})` })}`)
  return [
    "Earlier in this conversation:",
    ...lines,
    ...(subjects.length === 0 ? [] : [`Known subjects: ${subjects.join("; ")}`]),
  ].join("\n")
}
