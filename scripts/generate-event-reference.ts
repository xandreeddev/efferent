import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { JsonSchema, Option, Schema, SchemaAST } from "effect"
import { JOURNAL_KINDS, journalSchemaOf, RECORDED_ELSEWHERE, RESERVED_KINDS, TransientTurnEvents, TurnEvent } from "@xandreed/core"
import type { TurnEventName } from "@xandreed/core"
import { encodeSocketFrame, encodeSse, FeedHeartbeat, FeedReady, FeedRecord, renderFeedDefaults, sseHeaders, ssePreamble } from "@xandreed/plugin-render"
import { deliveryId, TASK_CANCELLED, TASK_RESULT, TASK_STARTED, TaskCancelled, TaskResult, TaskStarted } from "@xandreed/plugin-tasks"
import { turnBeginCodes } from "@xandreed/sdk"

/*
 * The event reference: what a turn publishes on its bus, what a session's
 * journal stores, and the codes and frames a host serves them with. Payloads,
 * descriptions, the reserved kinds and the begin codes come from the code;
 * the writers, sensitivity, HTTP statuses and error-code meanings below are
 * kept by hand, and this script fails when one no longer matches the code.
 * Writes docs/event-reference.json, docs/event-reference.md and the website page.
 */

const root = join(import.meta.dir, "..")
const failures: Array<string> = []
const fail = (message: string) => failures.push(message)

/* ── hand-kept facts, checked against the code ── */

/** Who writes each journal kind, and what a host must treat as sensitive in it. */
const JOURNAL: Readonly<Record<string, { readonly writer: string; readonly sensitive: string }>> = {
  "turn.started": { writer: "plugin-sessions, when `Sessions.begin` opens the turn", sensitive: "The user's message (its images, inline as base64, included), the host's command and the host's metadata (`meta`), when given." },
  "memory.system": { writer: "Memory, when the turn's system prompt (or a variant) changes", sensitive: "The full system prompt text." },
  "memory.section": { writer: "Memory: `turn.context(…)` and turn-tier prompt sections", sensitive: "Turn sections: the host's context for this turn, as the model sees it." },
  "memory.step": { writer: "Memory: the step policy's step context", sensitive: "Step context text." },
  "memory.message": { writer: "Memory: the step loop's recorded messages", sensitive: "User and assistant text, reasoning, tool call inputs." },
  "memory.tool-result": { writer: "Memory: the step loop's recorded tool results", sensitive: "Tool output, encoded and as the model saw it." },
  "memory.digest": { writer: "Memory: a digester (`plugin-memory-digest`)", sensitive: "Tool output, digested." },
  "memory.skills": { writer: "Memory: the tool registry's skill activations", sensitive: "None: skill and tool names." },
  "memory.compaction": { writer: "Memory: the memory strategy's compactions (window, summary)", sensitive: "Conversation text: summaries and compact views." },
  "turn.reply": { writer: "Memory, when the turn's reply is recorded (`TurnMemory.persistReply`)", sensitive: "The assistant's reply." },
  "step.started": { writer: "The turn's bus (stored from `step.started`)", sensitive: "None: tool names." },
  "step.ended": { writer: "The turn's bus (stored from `step.ended`)", sensitive: "None: entry ids and tool names." },
  "step.usage": { writer: "The turn's bus (stored from `assistant.message`)", sensitive: "None: model name and token counts." },
  "tool.started": { writer: "The turn's bus (stored from `tool.started`)", sensitive: "Tool input." },
  "tool.refused": { writer: "The turn's bus (stored from `tool.refused`)", sensitive: "The refusal message, which may name missing permissions or quote the host's denial; the input is left out." },
  "tool.completed": { writer: "The turn's bus (stored from `tool.completed`)", sensitive: "None: input and result are left out." },
  "completion.evaluated": { writer: "The turn's bus (stored from `completion.evaluated`)", sensitive: "The host's facts behind the verdict." },
  "context.built": { writer: "The turn's bus (stored from `context.built`)", sensitive: "None: fingerprints, counts and tool names." },
  "decision.recorded": { writer: "The turn's bus (stored from `decision.recorded`)", sensitive: "Candidate descriptions; the context itself only as a hash." },
  "stream.fallback": { writer: "The turn's bus (stored from `stream.fallback`)", sensitive: "The stream's error text, which may quote the provider's error." },
  "request.prepared": { writer: "The turn, before each provider call (`TurnMemory.prepareRequest`)", sensitive: "The full system prompt text and every active tool declaration (and step context in `system` mode)." },
  "turn.ended": { writer: "plugin-sessions: the turn writer's `end` (`Agent.turn` and `Sessions.drain` end with `turnEndingOf` the turn's exit), the writer's scope, `Sessions.cancel`, or a reap", sensitive: "Failure messages, which may quote errors." },
  "inbox.queued": { writer: "plugin-sessions: `Sessions.deliver` (a task's result, a host's item)", sensitive: "The item's content and source." },
  "inbox.dropped": { writer: "plugin-sessions: the end of the last turn that took the item and failed", sensitive: "None: the item id." },
}

/** Where a bus event recorded elsewhere ends up. */
const RECORDED_AS: Readonly<Record<string, string>> = {
  "turn.started": "the session's own `turn.started`, written when the turn began",
  "turn.ended": "memory's `turn.reply` and the session's own `turn.ended`",
  "skills.activated": "memory's `memory.skills`",
}

/** A suggested HTTP status for each begin code, for a host that serves turns over HTTP. */
const BEGIN_HTTP: Readonly<Record<string, { readonly status: string; readonly meaning: string }>> = {
  AttachmentRejected: { status: "400", meaning: "An attachment of the user's message is not an image the framework takes (not base64, not a PNG, JPEG, GIF or WebP, over the size or pixel limits, too large together; see `MEDIA_LIMITS`). `Agent.turn` checks before it calls `Sessions.begin`: nothing was opened. The `HarnessError` carries the reason only in its message; a host that wants it typed (to answer 413 for `TooLarge` and `TooLargeTogether`, or name the attachment by its `index`) runs `normalizeUserMessage` from `@xandreed/core` on the message first and branches on `AttachmentRejected.reason`." },
  SessionBusy: { status: "409", meaning: "Another turn is open in the session. Retry after it ends, or queue the message." },
  TurnDuplicate: { status: "200 once that turn ended, 409 while it is open", meaning: "The key was begun before with the same message, command and `resumes`: that turn is the answer, so serve its result instead of running again (`Sessions.lookup(address, key)` finds it)." },
  KeyConflict: { status: "409", meaning: "The key was begun before with another message, command or `resumes` (the key `resume:<n>` begun again without `resumes` conflicts)." },
  NothingPending: { status: "204", meaning: "An inbox turn found nothing to take (inbox turns only)." },
  NotResumable: { status: "409", meaning: "The turn named in `resumes` cannot be resumed: `missing` (no such turn in the session, or `resumes` is not a whole number of at least 1), `inbox` (an inbox turn), `superseded` (a user's turn began after it, other than a resume of it that failed, was cancelled or was interrupted) or `finished` (it ended completed, partial or failed). Only the last user's turn, ended cancelled or interrupted, can be; a resume that failed is tried again with a new key." },
  TurnRefused: { status: "429 for a quota or rate, 403 when not allowed, 503 while draining before a shutdown", meaning: "The host's `TurnAdmission` refused the turn; nothing was opened or counted." },
  SessionMissing: { status: "404", meaning: "No such session for this owner." },
  SessionLogError: { status: "503", meaning: "The session store failed. Retry later." },
}

interface ErrorCode { readonly code: string; readonly where: string; readonly meaning: string }

/**
 * Common codes a turn fails with or stores, and where they come from. Every
 * code the packages raise in one of `OWNED_PREFIXES` must be listed here (or
 * in `TASK_CODES`); other plugins' own codes may be.
 */
const ERROR_CODES: ReadonlyArray<ErrorCode> = [
  { code: "turn.closed", where: "`Agent.turn`, the turn writer", meaning: "Someone else closed the turn (cancelled, reaped, the session removed); its later writes are refused." },
  { code: "turn.failed", where: "stored `turn.ended` failure (`turnEndingOf`)", meaning: "The turn failed with a typed error that has no `code` of its own; the message is `<_tag>: <message>`, or the error as text (reason failed)." },
  { code: "turn.defect", where: "stored `turn.ended` failure (`turnEndingOf`)", meaning: "The turn died with a defect, an unexpected error; the message is the defect as text (reason failed). `Agent.turn` and `Sessions.drain` first turn a `HarnessError` carried as a defect back into a failure, so it keeps its own code; a runner calling `turnEndingOf` itself does the same with `harnessDefectsAsFailures`." },
  { code: "turn.interrupted", where: "stored `turn.ended` failure", meaning: "The turn was interrupted before it ended: its body (`turnEndingOf`), the scope its writer lived in, or its begin after the opening commit (reason interrupted)." },
  { code: "turn.unended", where: "stored `turn.ended` failure", meaning: "The turn's scope closed, without an interruption, before anyone tried to end the turn (reason failed). An end that was tried but could not be stored is tried again by the scope with that same ending, not this code." },
  { code: "turn.lease", where: "stored `turn.ended` failure", meaning: "The turn's holder stopped writing and another instance reaped it (reason interrupted)." },
  { code: "turn.budget", where: "a run of the step loop (`turn.run`, `runTurnLoop`)", meaning: "The run's `budgetTokens` (the policy's, else the agent's) is not an integer of at least 1." },
  { code: "config.budget", where: "`Agent.define`", meaning: "The agent's `budgetTokens` is not an integer of at least 1." },
  { code: "turn.unstarted", where: "the turn's memory", meaning: "Memory was asked to record, or for the turn's number, before the user's message was taken." },
  { code: "turn.persisted", where: "`TurnMemory.persistMessage`", meaning: "The user's message was taken twice in one turn." },
  { code: "turn.numbering", where: "the turn's memory", meaning: "Memory numbered the user's message differently from the turn the session stored." },
  { code: "events.reserved", where: "publishing a host event", meaning: "The host event's name is one of the reserved kinds." },
  { code: "events.depth", where: "publishing an event", meaning: "Reactions nested deeper than `maxEventDepth` (8 by default)." },
  { code: "events.background", where: "a background subscription", meaning: "A background handler died with a defect; the turn fails when the bus drains." },
  { code: "events.encode", where: "a host event's `make` / `publish`", meaning: "The payload did not encode with the host event's schema." },
  { code: "service.missing", where: "`Agent.turn`", meaning: "A service the turn needs is not provided by the agent's plugins or the turn's services." },
  { code: "config.graph", where: "`Agent.define`", meaning: "The plugin graph cannot be built (a missing provider, a cycle, a misplaced turn-dependent plugin)." },
  { code: "config.options", where: "`Agent.define`, activating a plugin", meaning: "A plugin's options did not decode with its schema." },
  { code: "plugin.activation", where: "activating a plugin (a session plugin's, every turn)", meaning: "The plugin's layer failed to build with an error that is not a `HarnessError` (one that is keeps its own code: `skills.duplicate`, `skills.root`, ...)." },
  { code: "plugin.defect", where: "activating a plugin (a session plugin's, every turn)", meaning: "The plugin's layer died with a defect while it was built." },
  { code: "tools.duplicate", where: "building the tool registry", meaning: "Two capabilities define a tool of the same name." },
  { code: "skills.duplicate", where: "building the tool registry", meaning: "Two capabilities define a skill with the same id (a host's and a skills directory's: set the directory's `idPrefix`)." },
  { code: "skills.tools", where: "building the tool registry", meaning: "A skill names a tool no capability registers." },
  { code: "skills.files", where: "`skillsFromFiles`; `@xandreed/plugin-workspace` skills directory (`strict`)", meaning: "A skills tree has an issue: a `SKILL.md` without frontmatter or description, an id already used, a reference over the size limit. The message names each file." },
  { code: "skills.root", where: "`@xandreed/plugin-workspace` skills directory", meaning: "A `required` skills root does not exist, or a root or a file in it cannot be read." },
  { code: "skills.limit", where: "`collectSkillFiles`; `@xandreed/plugin-workspace` skills directory", meaning: "A skills root holds more files (`maxFiles`) or text (`maxBytes`) than allowed, or the roots more skills than `maxSkills`." },
  { code: "tools.opened", where: "`openTurnTools`", meaning: "The turn's tools were opened twice." },
  { code: "tools.unavailable", where: "the turn's tools", meaning: "The tools were used before `openTurnTools` opened them." },
  { code: "loop.model", where: "the step loop", meaning: "The turn's services carry no `LanguageModel`." },
  { code: "loop.failed", where: "the step loop", meaning: "The loop failed with an error that is not a `HarnessError` (the model call's own error, for example); the message is that error's text." },
  { code: "request.encode", where: "the turn, before each provider call", meaning: "The request header did not encode." },
  { code: "request.missing", where: "before each provider call", meaning: "No stored `request.prepared` header for the step." },
  { code: "request.decode", where: "before each provider call", meaning: "The step's stored `request.prepared` header did not decode." },
  { code: "request.descriptor", where: "before each provider call", meaning: "The model's descriptor (provider, model and settings) did not decode." },
  { code: "request.diverged", where: "before each provider call", meaning: "The request about to be sent differs from the one rebuilt from its stored header and memory." },
  { code: "request.model", where: "`@xandreed/plugin-models`", meaning: "The selected model could not be resolved or described." },
  { code: "request.memory", where: "`replayModelRequest`", meaning: "The memory events before a stored request did not decode." },
  { code: "memory.log", where: "the turn", meaning: "Stored memory events did not decode, or memory could not be stored." },
  { code: "context.budget", where: "each step of a run; `@xandreed/plugin-memory-window`", meaning: "At a step, the system prompt and the active tools' schemas leave nothing of the context budget (`budgetTokens`); with the window strategy, also when the current turn alone does not fit the budget memory is given: the whole budget at the turn's start, what they leave at each step." },
  { code: "session.log", where: "the turn writer", meaning: "The session store failed during the turn." },
  { code: "session.contended", where: "the turn writer, plugin-sessions", meaning: "Too many conflicting writes to the session in a row." },
  { code: "session.state", where: "the turn writer", meaning: "The session's state, kept in its head, did not decode." },
  { code: "session.encode", where: "the turn writer", meaning: "The turn's closing `turn.ended` did not encode." },
]

/** The failure codes of a task's result or status (`@xandreed/plugin-tasks`). */
const TASK_CODES: ReadonlyArray<ErrorCode> = [
  { code: "task.turn", where: "a task's result failure", meaning: "The task's turn failed, or died with an error that is not a `HarnessError` (a `HarnessError` keeps its own code)." },
  { code: "task.refused", where: "a task's result failure", meaning: "The host would not admit the task's turn." },
  { code: "task.deadline", where: "a task's result or the parent's reaction", meaning: "The task runner's deadline cut the work." },
  { code: "task.lost", where: "a task's status", meaning: "The task's turn stopped without a result." },
  { code: "task.removed", where: "a task's status", meaning: "The task's session was removed with its parent." },
]

/** The namespaces whose every raised code the reference lists. */
const OWNED_PREFIXES: ReadonlyArray<string> = ["turn.", "events.", "request.", "loop.", "tools.", "task."]

/* ── payload schemas, summarized ── */

type Json = { readonly [key: string]: unknown }

const jsonSchemaOf = (schema: Schema.Top): Json => {
  const document = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(schema))
  return { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07, ...document.schema, ...(Object.keys(document.definitions).length > 0 ? { definitions: document.definitions } : {}) }
}

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const arrayOf = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : []

/** A JSON schema as a short type: `string`, `integer`, `"a" | "b"`, `Array<…>`, `Record<string, …>`, `{ a, b }`. */
const typeOf = (schema: unknown, definitions: Json): string => {
  if (!isJson(schema)) return "unknown"
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.split("/").at(-1) ?? ""
    return typeOf(definitions[name], definitions)
  }
  if (Array.isArray(schema.anyOf)) {
    const members = schema.anyOf.filter((member) => !(isJson(member) && Array.isArray(member.enum) && member.enum.includes("NaN")))
    return [...new Set(members.map((member) => typeOf(member, definitions)))].join(" | ")
  }
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ")
  if (schema.type === "array") return `Array<${typeOf(schema.items, definitions)}>`
  if (schema.type === "object" && isJson(schema.properties)) return `{ ${Object.keys(schema.properties).join(", ")} }`
  if (schema.type === "object" && isJson(schema.additionalProperties)) return `Record<string, ${typeOf(schema.additionalProperties, definitions)}>`
  if (schema.type === "object") return "object"
  return typeof schema.type === "string" ? schema.type : "unknown"
}

interface Field { readonly name: string; readonly type: string; readonly required: boolean }

const fieldsOf = (schema: Json): ReadonlyArray<Field> => {
  const definitions = isJson(schema.definitions) ? schema.definitions : {}
  const properties = isJson(schema.properties) ? schema.properties : {}
  const required = arrayOf(schema.required)
  return Object.entries(properties).filter(([name]) => name !== "_tag").map(([name, property]) => ({ name, type: typeOf(property, definitions), required: required.includes(name) }))
}

/* ── the reference ── */

const bus = TurnEvent.members.map((member) => {
  const name: TurnEventName = member.fields._tag.schema.literal
  const description = SchemaAST.resolveDescription(member.ast) ?? ""
  if (description.trim().length === 0) fail(`TurnEvent member ${name} has no description annotation`)
  const schema = jsonSchemaOf(member)
  const transient = TransientTurnEvents.includes(name)
  const kind = name === "assistant.message" ? "step.usage" : name
  const storedSchema = journalSchemaOf(kind)
  const stored = transient ? { as: "transient" as const }
    : RECORDED_ELSEWHERE.has(name) ? { as: "recorded-elsewhere" as const, where: RECORDED_AS[name] ?? "" }
      : name === "host" ? { as: "host" as const }
        : Option.match(storedSchema, {
          onNone: () => { fail(`${name} is stored as ${kind}, which has no journal schema`); return { as: "kind" as const, kind, omitted: [] } },
          onSome: (journal) => {
            const keep = new Set(fieldsOf(jsonSchemaOf(journal)).map((field) => field.name))
            return { as: "kind" as const, kind, omitted: fieldsOf(schema).map((field) => field.name).filter((field) => !keep.has(field)) }
          },
        })
  if (stored.as === "recorded-elsewhere" && stored.where.length === 0) fail(`${name} is recorded elsewhere, but RECORDED_AS does not say where`)
  return { name, description, transient, stored, fields: fieldsOf(schema), schema }
})

const journal = JOURNAL_KINDS.map((kind) => {
  const facts = JOURNAL[kind]
  if (facts === undefined) fail(`Journal kind ${kind} has no writer and sensitivity entry in scripts/generate-event-reference.ts`)
  if (!RESERVED_KINDS.includes(kind)) fail(`Journal kind ${kind} is not reserved`)
  const schema: Json = Option.match(journalSchemaOf(kind), { onNone: (): Json => { fail(`Journal kind ${kind} has no journal schema (journalSchemaOf)`); return {} }, onSome: jsonSchemaOf })
  const properties = isJson(schema.properties) ? schema.properties : {}
  const body = isJson(properties.body) ? fieldsOf({ ...properties.body, definitions: isJson(schema.definitions) ? schema.definitions : {} }) : []
  return { kind, writer: facts?.writer ?? "", sensitive: facts?.sensitive ?? "", fields: fieldsOf(schema), body, schema }
})
Object.keys(JOURNAL).filter((kind) => !JOURNAL_KINDS.includes(kind)).forEach((kind) => fail(`${kind} has a writer entry but is not a journal kind`))
const busNames = new Set<string>(bus.map((event) => event.name))
RESERVED_KINDS.filter((kind) => !JOURNAL_KINDS.includes(kind) && !busNames.has(kind)).forEach((kind) => fail(`Reserved kind ${kind} is neither a journal kind nor a bus event's name`))

const beginCodes = Object.entries(turnBeginCodes).map(([tag, code]) => {
  const http = BEGIN_HTTP[tag]
  if (http === undefined) fail(`Begin code ${code} (${tag}) has no suggested HTTP status`)
  return { tag, code, http: http?.status ?? "", meaning: http?.meaning ?? "" }
})
Object.keys(BEGIN_HTTP).filter((tag) => !(tag in turnBeginCodes)).forEach((tag) => fail(`BEGIN_HTTP names ${tag}, which is not a begin error`))

/** Every listed error code is still in a package's source, and every code raised in an owned namespace is listed. */
const sources = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true })
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")).map((entry) => join(entry.parentPath, entry.name))
}
const packages = (await readdir(join(root, "packages"))).filter((name) => !["website", "foundry"].includes(name))
const sourceText = (await Promise.all(packages.map(async (name) => {
  const files = await sources(join(root, "packages", name, "src")).then((found) => found, () => [])
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n")
}))).join("\n")
const listedCodes = [...ERROR_CODES, ...TASK_CODES]
listedCodes.filter((entry) => !sourceText.includes(`"${entry.code}"`)).forEach((entry) => fail(`Error code ${entry.code} is listed but no package source uses it`))
/** A raised code: `code: "a.b"`, or the packages' error helpers, `failure("a.b"`, `harness("a.b"` and `storage("a.b"`. */
const raised = new Set(Array.from(sourceText.matchAll(/(?:\bcode:\s*|\b(?:failure|harness|storage)\(\s*)"([a-z]+\.[a-z][a-z-]*)"/g), (match) => match[1] ?? ""))
const known = new Set([...listedCodes.map((entry) => entry.code), ...Object.values(turnBeginCodes)])
const unlistedCodes = [...raised].filter((raisedCode) => OWNED_PREFIXES.some((prefix) => raisedCode.startsWith(prefix)) && !known.has(raisedCode)).sort()
unlistedCodes.forEach((raisedCode) => fail(`Error code ${raisedCode} is raised in a package but not listed in ERROR_CODES or TASK_CODES`))

const sample = FeedRecord.make({ sequence: 42, event: "turn.reply", data: { outcome: "completed", reply: "Done." } })
const feed = {
  sse: {
    headers: sseHeaders,
    preamble: ssePreamble,
    record: encodeSse(sample),
    ready: encodeSse(FeedReady.make({})),
    heartbeat: encodeSse(FeedHeartbeat.make({})),
  },
  socket: {
    record: encodeSocketFrame(sample),
    ready: encodeSocketFrame(FeedReady.make({})),
    heartbeat: encodeSocketFrame(FeedHeartbeat.make({})),
    resume: JSON.stringify({ after: 41 }),
  },
  defaults: renderFeedDefaults,
}

const tasks = [
  { kind: TASK_STARTED, where: "the parent session", when: "`Tasks.start`: the task's instructions, mode and the starter's facts; its child session is created with it.", schema: jsonSchemaOf(TaskStarted) },
  { kind: TASK_RESULT, where: "the child session", when: "Before the child's turn ends (or outside a turn when the host refused it): the outcome, reply and failure.", schema: jsonSchemaOf(TaskResult) },
  { kind: TASK_CANCELLED, where: "the child, then the parent", when: "`Tasks.cancel`, while the task is pending or running; the first of a result and a cancellation ends the task.", schema: jsonSchemaOf(TaskCancelled) },
].map((record) => ({ ...record, fields: fieldsOf(record.schema) }))

if (failures.length > 0) {
  console.error(`The event reference is out of date with the code:\n${failures.map((line) => `- ${line}`).join("\n")}`)
  process.exit(1)
}

const reference = { reserved: RESERVED_KINDS, bus, journal, beginCodes, errorCodes: ERROR_CODES, feed, tasks: { records: tasks, codes: TASK_CODES, delivery: { id: deliveryId("<taskId>"), source: { kind: "task", taskId: "<taskId>", child: "<taskId>", status: "<status>" } } } }

/* ── markdown ── */

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ")
const code = (text: string) => `\`${text}\``
const table = (head: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n")
const fieldTable = (fields: ReadonlyArray<Field>) => fields.length === 0 ? "No fields." : table(["Field", "Type"], fields.map((field) => [code(field.name), code(field.type) + (field.required ? "" : " (optional)")]))
const storedText = (stored: (typeof bus)[number]["stored"]) =>
  stored.as === "transient" ? "Not stored (transient)"
    : stored.as === "recorded-elsewhere" ? `Recorded elsewhere: ${stored.where}`
      : stored.as === "host" ? "Under its `name`"
        : `${code(stored.kind)}${stored.omitted.length > 0 ? `, without ${stored.omitted.map(code).join(", ")}` : ""}`
const fence = (language: string, text: string) => `\`\`\`${language}\n${text}\n\`\`\``

const body = (links: { readonly framework: string }) => [
  `Generated by \`bun run docs:generate\` (\`scripts/generate-event-reference.ts\`) from the event and journal schemas; the full JSON schemas are in \`docs/event-reference.json\`. Writers, sensitivity, HTTP statuses and error-code meanings are kept by hand in that script, which fails when they no longer match the code.`,
  `There are two kinds of events. The **bus** carries a turn's typed events (\`TurnEvent\`) live, in process, to the turn's subscribers. The **journal** is the session's durable log: the turn's writer subscribes to the bus first and stores most bus events, memory stores its entries, and the sessions plugin stores the turn's start, end and the inbox. Another request or process reads the journal with \`Sessions.read\`; only the bus carries token deltas. See [the framework guide](${links.framework}) for how to subscribe.`,
  "## Bus events",
  "`_tag` is the event's name. Subscribe with `turn.events.subscribe`, `onEvent`, `onTool` or a host event's `on`.",
  table(["Event", "Transient", "Stored as"], bus.map((event) => [code(event.name), event.transient ? "yes" : "no", storedText(event.stored)])),
  ...bus.flatMap((event) => [`### ${code(event.name)}`, event.description, fieldTable(event.fields)]),
  "## Journal kinds",
  "Every event of a session's journal is `{ session, seq, turn, kind, at, data }`; `seq` is dense from 1 and is the cursor for `Sessions.read({ after })`. These are the kinds the framework writes. `journalSchemaOf(kind)` (from `@xandreed/core`) gives the schema of each kind's `data`. A host that exports, streams or redacts session events must treat the sensitive kinds like the conversation itself: `request.prepared`, `memory.system`, `memory.section` and `memory.step` hold the system prompt and the host's context.",
  table(["Kind", "Written by", "Sensitive content", "Fields"], journal.map((entry) => [code(entry.kind), entry.writer, entry.sensitive, entry.fields.map((field) => code(field.name)).join(", ")])),
  "A memory kind's `data` is `{ entry, runId, step, at, body }`: the memory entry's id, run, step and time, and its body without the `_tag` (the kind names it). Memory is rebuilt from these events by `entriesOfEvents`.",
  table(["Kind", "Body fields"], journal.filter((entry) => entry.body.length > 0).map((entry) => [code(entry.kind), entry.body.map((field) => `${code(field.name)}: ${code(field.type)}`).join(", ")])),
  "Any other kind is a host's or a plugin's own record (`defineHostEvent`, `Sessions.transact`, the tasks plugin's `task.*`).",
  "## Reserved kinds",
  "A host event, or a `Sessions.transact` draft, may not use these names: the publish fails with `events.reserved`, the transact with `ReservedKind`. They are the journal kinds above and every bus event's name (`TURN_EVENT_NAMES`), the ones the journal never stores under their own name included (`assistant.message`, `assistant.delta`, `tool.progress`, `skills.activated`, `host`). The list is matched exactly, not by prefix: other names in these namespaces are accepted, but a host should use its own namespace.",
  fence("text", RESERVED_KINDS.join("\n")),
  "## Begin codes",
  "When `Agent.turn` begins the turn itself and the turn cannot begin (`Sessions.begin` refuses it, or, for `AttachmentRejected`, `Agent.turn`'s own check of the attachments before it), the turn fails with a `HarnessError` whose `code` is one of these (`turnBeginCodes` from `@xandreed/sdk`). The HTTP status is a suggestion for a host serving turns over HTTP.",
  table(["Begin error", "Code", "Suggested HTTP status", "Meaning"], beginCodes.map((entry) => [code(entry.tag), code(entry.code), entry.http, entry.meaning])),
  "## Common turn error codes",
  `Besides the begin codes, these are common \`HarnessError\` codes a turn fails with, or that a stored \`turn.ended\` carries in \`failure.code\`. A failed turn's \`turn.ended\` carries the code of the error it failed with (one of these, a plugin's, or a host's own), else \`turn.failed\`, \`turn.defect\` or \`turn.interrupted\` (\`turnEndingOf\` from \`@xandreed/core\`), with the error's message cut to 500 characters; a closer that ends its writer itself stores its own code (plugin-tasks: \`task.turn\`, \`task.deadline\`). The list is not exhaustive: it has every code the packages raise under ${OWNED_PREFIXES.filter((prefix) => prefix !== "task.").map((prefix) => code(`${prefix}*`)).join(", ")} (the generator checks), but other plugins raise codes of their own (a memory strategy's, a store's), and a host's own errors keep their own codes.`,
  table(["Code", "Where", "Meaning"], ERROR_CODES.map((entry) => [code(entry.code), entry.where, entry.meaning])),
  "## Feed and socket frames",
  "`@xandreed/plugin-render` turns a journal into client frames (`RenderFeed`); the host's projection names each record's `event` and `data`, and its cursor is the journal's `seq`. Over SSE, each connection starts with the preamble; a record carries its sequence as the event id, so a reconnecting `EventSource` resumes with `Last-Event-ID`. One `ready` frame follows the backlog (the first poll that finds nothing new), then a heartbeat comment while the feed is idle. The feed ends after `maxDurationMs`, and the client reconnects with its cursor.",
  table(["Frame", "SSE", "WebSocket"], [
    ["preamble", code(JSON.stringify(feed.sse.preamble)), "none"],
    ["record", code(JSON.stringify(feed.sse.record)), code(feed.socket.record)],
    ["ready", code(JSON.stringify(feed.sse.ready)), code(feed.socket.ready)],
    ["heartbeat", code(JSON.stringify(feed.sse.heartbeat)), code(feed.socket.heartbeat)],
    ["resume", "the `Last-Event-ID` request header", `the client's first message, ${code(feed.socket.resume)}`],
  ]),
  "SSE response headers (`sseHeaders`):",
  fence("json", JSON.stringify(feed.sse.headers, null, 2)),
  "Feed defaults (`renderFeedDefaults`, in milliseconds):",
  fence("json", JSON.stringify(feed.defaults, null, 2)),
  "## Task records",
  `\`@xandreed/plugin-tasks\` records its own kinds (not reserved). A finished task is delivered to the parent's inbox once, as \`inbox.queued\` with the id ${code(reference.tasks.delivery.id)} and the source \`{ kind: "task", taskId, child, status }\`.`,
  table(["Kind", "Recorded in", "When"], tasks.map((record) => [code(record.kind), record.where, record.when])),
  ...tasks.flatMap((record) => [`### ${code(record.kind)}`, fieldTable(record.fields)]),
  "### Task failure codes",
  "The `code` of a task result's `failure`, or of a task's status, besides any `HarnessError` code the task's turn failed with.",
  table(["Code", "Where", "Meaning"], TASK_CODES.map((entry) => [code(entry.code), entry.where, entry.meaning])),
].join("\n\n")

await Bun.write(join(root, "docs/event-reference.json"), `${JSON.stringify(reference, null, 2)}\n`)
await Bun.write(join(root, "docs/event-reference.md"), `# Event reference\n\n${body({ framework: "framework.md#composable-agents-the-host-composes-the-turn" })}\n`)
await Bun.write(join(root, "packages/website/src/content/docs/concepts/event-reference.md"),
  `---\ntitle: Event reference\ndescription: Generated reference of turn events, session journal kinds, begin and error codes, and feed frames.\n---\n\n${body({ framework: "/docs/concepts/harness/" })}\n`)
console.log(`Generated the event reference: ${bus.length} bus events, ${journal.length} journal kinds, ${beginCodes.length} begin codes`)
