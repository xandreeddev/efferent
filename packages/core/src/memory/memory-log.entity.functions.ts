import { Array as Arr, Effect, Option, Order, Predicate, Schema } from "effect"
import { elideMediaData, IMAGE_TOKEN_ESTIMATE, mediaAt, mediaLabel, mediaSlotsOf } from "../domain/media.entity.functions.js"
import { MEDIA_LIMITS } from "../domain/media.entity.js"
import type { Media } from "../domain/media.entity.js"
import type { AgentMessage, ToolResultPart, UserContentPart } from "../domain/message.entity.js"
import { RunId } from "../domain/run.entity.js"
import { handoffToMessage } from "../loop/mapping.js"
import { clippedMarker, clipTo } from "../turn/model-text.js"
import { attachmentsOf, userMessageText } from "../turn/user-message.entity.functions.js"
import type { UserMessage } from "../turn/user-message.entity.js"
import type { ArtifactRef, BuiltContext, CompactionAction, EntryId, LogBody, LogEntry, Subject } from "./memory-log.entity.js"
import { EntryId as EntryIdSchema } from "./memory-log.entity.js"

/** Key-sorted JSON: identical values always serialize to identical bytes. */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value)) ?? "null"

const byKey = Order.mapInput(Order.String, ([key]: readonly [string, unknown]) => key)

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : Predicate.isObject(value)
      ? Object.fromEntries(Arr.sort(Object.entries(value), byKey).flatMap(([key, field]) =>
        field === undefined ? [] : [[key, sortKeys(field)] as const]))
      : value

/** FNV-1a (32 bit) plus length — pure, stable across processes and runtimes. */
export const fingerprintOf = (text: string): string => {
  const hash = Array.from(text).reduce((h, ch) => Math.imul((h ^ ch.charCodeAt(0)) >>> 0, 16777619) >>> 0, 2166136261)
  return `${hash.toString(16).padStart(8, "0")}${text.length.toString(16)}`
}

/** A deliberately conservative estimate for mixed prose and JSON. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3)

/**
 * The messages' tokens, estimated: each message's JSON as text, with an
 * image counted as `IMAGE_TOKEN_ESTIMATE` tokens instead of its base64.
 */
export const estimateMessageTokens = (messages: ReadonlyArray<AgentMessage>): number =>
  messages.reduce((sum, message) => sum + estimateTokens(canonicalJson(elideMediaData(message))) + mediaSlotsOf(message).length * IMAGE_TOKEN_ESTIMATE, 0)

export const entryId = (runId: RunId, index: number): EntryId => EntryIdSchema.make(`${runId}:${index}`)

/** Recorded digests by result entry; the latest digest of an entry wins. */
const digestsOf = (entries: ReadonlyArray<LogEntry>): ReadonlyMap<string, string> =>
  new Map(entries.flatMap((entry) => entry.body._tag === "ToolDigest" ? [[String(entry.body.entry), entry.body.text] as const] : []))

/**
 * What a strategy decided for one render: only its own compactions apply,
 * except `OmitMedia`, which applies whatever strategy recorded it (an image
 * a provider refused stays refused).
 */
interface Applied {
  readonly views: ReadonlyMap<string, string>
  readonly cutTurn: number
  readonly preamble: Option.Option<AgentMessage>
  readonly ids: ReadonlyArray<EntryId>
  /** Entries whose images are label lines. */
  readonly omitted: ReadonlySet<string>
}

const appliedCompactions = (entries: ReadonlyArray<LogEntry>, strategy: string): Applied =>
  entries.reduce((applied: Applied, entry): Applied => {
    if (entry.body._tag !== "Compaction") return applied
    const action: CompactionAction = entry.body.action
    const ids = [...applied.ids, entry.id]
    if (action._tag === "OmitMedia") return { ...applied, ids, omitted: new Set([...applied.omitted, ...action.entries.map(String)]) }
    if (entry.body.strategy !== strategy) return applied
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
  }, { views: new Map(), cutTurn: 0, preamble: Option.none(), ids: [], omitted: new Set<string>() })

/** The calls whose results are recorded on their own: a tool the provider ran has its result in the message itself. */
const toolCallIds = (message: AgentMessage): ReadonlyArray<string> =>
  message.role === "assistant" ? message.content.flatMap((part) => part.type === "tool-call" && part.providerExecuted !== true ? [part.toolCallId] : []) : []

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
  readonly currentRun: RunId
  /** Turn contexts are shown for the current turn only, or for every kept turn. */
  readonly turnContext: "current" | "all"
  /** Append the host's delivered reply when the model's own text differs. */
  readonly replies: boolean
  /** The current step's context closes the messages ("tail") or rides in the system prompt ("none"). */
  readonly stepContext: "tail" | "none"
  /** Show recorded tool digests in place of the results they digest. */
  readonly digests: boolean
  /**
   * How images reach the model: a user's attachments and the images tool
   * results return (each result's slots, while it shows the view it was
   * written with). The current turn's are sent as images first: its
   * attachments in order, then its tool results' images, newest result
   * first and a whole result at a time, while they fit. `none` shows every
   * earlier turn's image as a `mediaLabel` line; `inline` sends earlier
   * turns' images too, newest turn first and a whole turn at a time, while
   * they fit. Together they stay within `maxImages` images (and never more
   * than `MEDIA_LIMITS.requestImages`) and `maxChars` base64 characters; an
   * image left out is a label line. With the memory plugins' defaults a
   * message's own images always fit; `maxChars: 0` sends none (text only).
   * An `ArtifactRef` is a reference line after its result's text in both
   * modes, at most `maxImages` of them.
   */
  readonly media: { readonly mode: "none" | "inline"; readonly maxImages: number; readonly maxChars: number }
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

/** An image of the log: the entry whose message or result holds it and its position there. */
const imageKey = (entry: LogEntry, index: number): string => `${entry.id}#${index}`

/** One image a render may send, by its key. */
interface LogImage {
  readonly key: string
  readonly media: Media
}

interface InlineChoice {
  readonly chosen: ReadonlySet<string>
  readonly images: number
  readonly chars: number
  /** A group did not fit: nothing after it is sent inline. */
  readonly full: boolean
}

const noneChosen: InlineChoice = { chosen: new Set<string>(), images: 0, chars: 0, full: false }

const charsOf = (images: ReadonlyArray<LogImage>): number => images.reduce((sum, image) => sum + image.media.data.length, 0)

/** What one render decided before it folds: the compactions and digests that apply, the turns it keeps, the images it sends. */
interface MediaPlan {
  readonly applied: Applied
  readonly digests: ReadonlyMap<string, string>
  readonly kept: (entry: LogEntry) => boolean
  /** The images an entry may send: none once its turn is dropped, its images omitted, or (a result) its view rewritten. */
  readonly imagesOf: (entry: LogEntry) => ReadonlyArray<LogImage>
  readonly inline: ReadonlySet<string>
}

/**
 * The images a render sends as images: the current turn's attachments, in
 * order, each while it fits; its tool results' images, newest result first,
 * a whole result at a time; then, in `inline` mode, each earlier kept
 * turn's, newest first, a whole turn at a time. The first that does not fit
 * ends the choice. At most `maxImages` of them, never more than
 * `MEDIA_LIMITS.requestImages` (a provider shrinks or refuses the images of a
 * request that carries many), within `maxChars`. Earlier turns' images
 * change only when a turn starts or the current turn's no longer leave room.
 */
const mediaPlan = (entries: ReadonlyArray<LogEntry>, options: RenderOptions): MediaPlan => {
  const applied = appliedCompactions(entries, options.strategy)
  const digests = options.digests ? digestsOf(entries) : new Map<string, string>()
  const kept = (entry: LogEntry): boolean => entry.turn > applied.cutTurn
  const imagesOf = (entry: LogEntry): ReadonlyArray<LogImage> => {
    const body = entry.body
    if (!kept(entry) || applied.omitted.has(entry.id)) return []
    if (body._tag === "TurnStarted") return attachmentsOf(body.userMessage).map((media, index) => ({ key: imageKey(entry, index), media }))
    if (body._tag !== "ToolResult" || body.isError || applied.views.has(entry.id) || digests.has(entry.id)) return []
    return (body.media ?? []).flatMap((slot, index) => Option.toArray(Option.map(mediaAt(body.encoded, slot), (media) => ({ key: imageKey(entry, index), media }))))
  }
  const maxImages = Math.min(options.media.maxImages, MEDIA_LIMITS.requestImages)
  const take = (choice: InlineChoice, group: ReadonlyArray<LogImage>): InlineChoice =>
    choice.full ? choice
      : choice.images + group.length <= maxImages && choice.chars + charsOf(group) <= options.media.maxChars ? {
        ...choice, chosen: new Set([...choice.chosen, ...group.map((image) => image.key)]), images: choice.images + group.length, chars: choice.chars + charsOf(group),
      }
        : { ...choice, full: true }
  const current = entries.filter((entry) => entry.turn === options.currentTurn)
  const attachments = current.flatMap((entry) => entry.body._tag === "TurnStarted" ? imagesOf(entry).map((image) => [image]) : [])
  const results = current.flatMap((entry) => entry.body._tag === "ToolResult" ? [imagesOf(entry)] : []).filter((group) => group.length > 0).reverse()
  const older = options.media.mode === "none" ? [] : entries.flatMap((entry) => entry.turn < options.currentTurn ? imagesOf(entry).map((image) => ({ turn: entry.turn, image })) : [])
  const earlier = [...new Set(older.map((item) => item.turn))].sort((left, right) => right - left)
    .map((turn) => older.filter((item) => item.turn === turn).map((item) => item.image))
  const inline = [...attachments, ...results, ...earlier].reduce(take, noneChosen).chosen
  return { applied, digests, kept, imagesOf, inline }
}

/**
 * The user's message as the model is sent it: its text alone when it has no
 * image; otherwise the images sent as images first, then one text part with
 * the text and a label line for each image left out (no empty text part).
 * With no image sent, it is its text and labels as one string.
 */
const userMessageContent = (entry: LogEntry, message: UserMessage, inline: ReadonlySet<string>): AgentMessage => {
  const images = attachmentsOf(message)
  const sent = images.flatMap((media, index): ReadonlyArray<Media> => inline.has(imageKey(entry, index)) ? [media] : [])
  if (sent.length === 0) return userRoleMessage(userMessageText(message))
  const text = [message.text, ...images.flatMap((media, index) => inline.has(imageKey(entry, index)) ? [] : [mediaLabel(media)])]
    .filter((line) => line.length > 0).join("\n")
  const parts: ReadonlyArray<UserContentPart> = [...sent, ...(text.length === 0 ? [] : [{ type: "text" as const, text }])]
  return { role: "user", content: parts }
}

/**
 * A tool result as the model is sent it: the text it shows (its write-time
 * view, a compaction's, a digest's or a spill's preview), the write-time
 * lines of the images it never sends (`mediaNotes`, unless that text holds
 * them already, as the view does), a label line for each of its images not
 * sent this time, then its artifacts' reference lines; the images sent ride
 * as `media`. A result without images renders exactly as before.
 */
const toolResultPart = (entry: LogEntry, body: Extract<LogBody, { readonly _tag: "ToolResult" }>, text: string, options: RenderOptions, inline: ReadonlySet<string>): ToolResultPart => {
  const images = (body.media ?? []).map((slot, index) => ({ key: imageKey(entry, index), slot, media: mediaAt(body.encoded, slot) }))
  const sent = images.flatMap((image) => inline.has(image.key) ? Option.toArray(image.media) : [])
  const notes = (body.mediaNotes ?? []).filter((line) => !text.includes(line))
  const labels = [...notes, ...images.flatMap((image) => inline.has(image.key) ? [] : [mediaLabel(Option.getOrElse(image.media, () => image.slot))])]
  const shown = labels.length === 0 ? text : [text, ...labels].filter((line) => line.length > 0).join("\n")
  return {
    type: "tool-result", toolCallId: body.toolCallId, toolName: body.toolName,
    output: `${shown}${artifactLines(body.artifacts, options.media.maxImages)}`, isError: body.isError,
    ...(sent.length === 0 ? {} : { media: sent }),
  }
}

export const renderLog = (entries: ReadonlyArray<LogEntry>, options: RenderOptions): ReadonlyArray<AgentMessage> => {
  const { applied, digests, kept, inline } = mediaPlan(entries, options)
  const pinned: ReadonlySet<string> = new Set(entries.flatMap((entry) => entry.body._tag === "ToolResult" && entry.body.pinned ? [String(entry.body.toolCallId)] : []))
  const stepContext = options.stepContext === "none" ? [] : entries.filter((entry) => entry.body._tag === "StepContext" && entry.runId === options.currentRun).slice(-1)
  const initial: RenderState = { out: [], lastText: new Map() }
  const body = entries.reduce((state: RenderState, entry): RenderState => {
    const b: LogBody = entry.body
    if (b._tag === "TurnStarted") return kept(entry) ? { ...state, out: [...state.out, userMessageContent(entry, b.userMessage, inline)] } : state
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
      const message: AgentMessage = { role: "tool", content: [toolResultPart(entry, b, text, options, inline)] }
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

/**
 * The entries whose images a render sends as images (a user's attachments,
 * a tool result's): what an `OmitMedia` compaction names after a provider
 * refused that request. Empty when the render sends no image.
 */
export const entriesSendingMedia = (entries: ReadonlyArray<LogEntry>, options: RenderOptions): ReadonlyArray<EntryId> => {
  const { imagesOf, inline } = mediaPlan(entries, options)
  return entries.flatMap((entry) => imagesOf(entry).some((image) => inline.has(image.key)) ? [entry.id] : [])
}

/**
 * The rebuild of one request, with its fingerprint: the hash of the
 * messages' canonical JSON, each image's `data` replaced by its fingerprint
 * (`elideMediaData`), so a text-only context hashes as it always did.
 */
export const buildContext = (entries: ReadonlyArray<LogEntry>, options: RenderOptions): BuiltContext => {
  const messages = renderLog(entries, options)
  return {
    messages,
    fingerprint: fingerprintOf(canonicalJson(messages.map(elideMediaData))),
    estimatedTokens: estimateMessageTokens(messages),
    compactions: appliedCompactions(entries, options.strategy).ids,
    through: Option.fromNullishOr(entries.at(-1)?.id),
  }
}

/** The latest step context recorded by this run, if any. */
export const stepContextOf = (entries: ReadonlyArray<LogEntry>, runId: RunId): Option.Option<string> =>
  Option.fromNullishOr(entries.flatMap((entry) => entry.body._tag === "StepContext" && entry.runId === runId ? [entry.body.text] : []).at(-1))

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

/** A compact user/assistant transcript for classifiers: user messages (an image as its label line) and replies only. */
export const referenceTranscript = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<AgentMessage> =>
  entries.flatMap((entry): ReadonlyArray<AgentMessage> => {
    if (entry.body._tag === "TurnStarted") return [userRoleMessage(userMessageText(entry.body.userMessage))]
    if (entry.body._tag === "TurnEnded") {
      return Option.match(entry.body.reply, { onNone: () => [], onSome: (text) => text.length === 0 ? [] : [{ role: "assistant", content: [{ type: "text", text }] }] })
    }
    return []
  })

/**
 * The full-fidelity transcript: messages with every tool result's encoded
 * value. Images are left out: a user's image is its label line, an image in
 * an encoded value has its `data` replaced by its fingerprint.
 */
export const rawTranscript = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<AgentMessage> =>
  mergeToolMessages(entries.flatMap((entry): ReadonlyArray<AgentMessage> => {
    if (entry.body._tag === "TurnStarted") return [userRoleMessage(userMessageText(entry.body.userMessage))]
    if (entry.body._tag === "Message") return [entry.body.message]
    if (entry.body._tag === "ToolResult") {
      return [{ role: "tool", content: [{ type: "tool-result", toolCallId: entry.body.toolCallId, toolName: entry.body.toolName, output: elideMediaData(entry.body.encoded), isError: entry.body.isError }] }]
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
    Option.match(query.text, { onNone: () => true, onSome: (text) => canonicalJson(elideMediaData(entry.body)).toLowerCase().includes(text.toLowerCase()) }))
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
  id: EntryIdSchema.make(`pending:${index}`), runId: RunId.make(""), turn: 0, step: 0, at: 0,
  body: { _tag: "Compaction", strategy: strategy.id, version: strategy.version, action },
})

const clipText = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max)}…`

/** One transcript entry: its label, then its text with every further line indented, so no line inside it can pass for another entry. */
const transcriptEntry = (label: string, text: string): string => `${label}: ${text.replaceAll("\n", "\n  ")}`

/**
 * A compact, human-readable transcript of the given turns for summaries:
 * user messages, assistant text, each tool result clipped to `caps.result`
 * (with a counted marker), and replies; each entry starts a line, and its
 * further lines are indented. It is never longer than `caps.total`: over
 * it, the first entry (its text clipped to about a quarter of the cap) is
 * followed by a counted marker of what was left out and the newest entries
 * that fit (the end of the newest one, when even it does not).
 */
export const digestTranscript = (entries: ReadonlyArray<LogEntry>, caps: { readonly result: number; readonly total: number }): string => {
  const parts = entries.flatMap((entry): ReadonlyArray<readonly [label: string, text: string]> => {
    const body = entry.body
    if (body._tag === "TurnStarted") return [["User", userMessageText(body.userMessage)]]
    if (body._tag === "Message") return Option.toArray(Option.map(assistantText(body.message), (text) => ["Assistant", text] as const))
    if (body._tag === "ToolResult") return [[`Tool ${body.toolName}${body.isError ? " (failed)" : ""}`, clipTo(body.view, caps.result)]]
    if (body._tag === "TurnEnded") return Option.toArray(Option.map(body.reply, (reply) => ["Reply", reply] as const))
    return []
  })
  const lines = parts.map(([label, text]) => transcriptEntry(label, text))
  const joined = lines.join("\n")
  if (joined.length <= caps.total) return joined
  const head = Option.match(Option.fromNullishOr(parts[0]), {
    onNone: () => "",
    onSome: ([label, text]) => transcriptEntry(label, clipTo(text, Math.floor(caps.total / 4) - label.length - 2)),
  })
  const rest = lines.slice(1)
  const restChars = rest.join("\n").length
  // What the newest entries may take: the cap less the head, the marker (at its longest) and two line breaks.
  const room = Math.max(0, caps.total - head.length - clippedMarker(restChars).length - 2)
  const fit = rest.reduceRight<{ readonly kept: number; readonly chars: number; readonly open: boolean }>((state, line) => {
    const chars = state.chars + line.length + (state.kept === 0 ? 0 : 1)
    return state.open && chars <= room ? { kept: state.kept + 1, chars, open: true } : { ...state, open: false }
  }, { kept: 0, chars: 0, open: true })
  const tail = fit.kept > 0 ? rest.slice(rest.length - fit.kept).join("\n") : room === 0 ? "" : (rest.at(-1) ?? "").slice(-room)
  // Only a cap shorter than the marker itself needs the last cut.
  return [head, clippedMarker(restChars - tail.length), ...(tail.length === 0 ? [] : [tail])].join("\n").slice(0, caps.total)
}

/** A generic ledger of condensed turns: what was asked, what was replied, what was found. */
export const ledgerOf = (entries: ReadonlyArray<LogEntry>, throughTurn: number, perTurnChars: number): string => {
  const kept = entries.filter((entry) => entry.turn <= throughTurn)
  const turns = [...new Set(kept.map((entry) => entry.turn))].sort((left, right) => left - right)
  const lines = turns.flatMap((turn) => {
    const inTurn = kept.filter((entry) => entry.turn === turn)
    const asked = inTurn.flatMap((entry) => entry.body._tag === "TurnStarted" ? [userMessageText(entry.body.userMessage)] : []).at(0)
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
