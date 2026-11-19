import { Clock, Effect, Layer, Option, Ref, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { JOURNAL_FORMAT, Journal, JournalStorage, kernel, SessionId, Sessions, TurnNumber, userMessage } from "@xandreed/core/kernel"
import {
  Approval, approve, callTool, curate, Curator, CurrentTurn, factHandlers, factTools, knowledgeSession, Memory, modelAnswer, scriptedModel, sessions,
  Summarizer, summaryMemory, turnSource, turnsOf, withFacts,
} from "@xandreed/sdk/kernel"
import type { ModelScript } from "@xandreed/sdk/kernel"
import { directoryJournal } from "@xandreed/sdk/kernel/node"

/*
 * Records the journals a kernel host stores, for the journal compatibility
 * test (`packages/sdk/src/kernel/node/journal-compat.test.ts`): historical
 * evidence of what this release stored, which later releases of the same
 * journal format (`JOURNAL_FORMAT`) replay and others refuse unchanged. The
 * recording is deterministic: a scripted model, curator and summarizer, a
 * fixed clock, and session ids minted from a counter, so it holds no time,
 * path or machine of the recording.
 *
 * The host's program runs over the durable directory journal
 * (`directoryJournal`), in a folder under `.artifacts/` removed after, and the
 * fixture is every session the store then holds, as `JournalStorage.read`
 * gives it: its header and its events.
 *
 * The normal release command writes `journal-<version>.json`, using the
 * packages' shared version, and never replaces an existing release fixture.
 * `--unreleased` writes the explicitly developmental `journal-unreleased.json`;
 * only `--unreleased --force` may replace that development fixture. The
 * compatibility test reads every fixture in that folder.
 *
 * Coverage: four turns of one conversation, each a host's loop of
 * `modelAnswer` and `callTool` over a summary memory wrapped by `withFacts`:
 * a tool call and its result; a fact remembered (`rememberFact`, stored in
 * the memory session); a tool that asks first, approved for good
 * (`plugin.approval.decided`); and a long message after which the memory
 * folds the earlier turns into a summary (`plugin.summary.summarized`). Each
 * turn is then kept by the curation step (`curate`) in the knowledge session:
 * a source curated into entities and memories, one memory ending another.
 */

const root = join(import.meta.dir, "..")
const packageVersion = (JSON.parse(await readFile(join(root, "packages/core/package.json"), "utf8")) as { readonly version: string }).version
const unreleased = process.argv.includes("--unreleased")
const force = process.argv.includes("--force")
if (force && !unreleased) {
  console.error("--force requires --unreleased; release fixtures cannot be overwritten.")
  process.exit(1)
}
const version = unreleased ? "unreleased" : packageVersion
const target = join(root, "packages/sdk/fixtures", `journal-${version}.json`)
if (existsSync(target) && !(unreleased && force)) {
  console.error(`${relative(root, target)} exists: ${unreleased ? "pass --unreleased --force to refresh this development fixture" : "a released fixture cannot be overwritten"}.`)
  process.exit(1)
}

/* ── fixed time ── */

const epoch = 1_767_225_600_000
const realClock = Clock.Clock.defaultValue()
const fixedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => epoch,
  currentTimeMillis: Effect.succeed(epoch),
  currentTimeNanosUnsafe: () => BigInt(epoch) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(epoch) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(epoch) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(BigInt(epoch) * 1_000_000n),
  sleep: (duration) => realClock.sleep(duration),
}

/* ── the host's tools ── */

const Lookup = Tool.make("lookup", {
  description: "Look a record up by its name.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
})
const ClearNotes = Tool.make("clearNotes", {
  description: "Delete every note.",
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Approval, CurrentTurn],
})
const tools = Toolkit.merge(Toolkit.make(Lookup, ClearNotes), factTools)
const toolsLive = Layer.mergeAll(
  Toolkit.make(Lookup, ClearNotes).toLayer({
    lookup: ({ name }) => Effect.succeed(`${name}: a teapot, kept on the second shelf.`),
    clearNotes: () => Effect.as(approve({ action: "notes.clear", detail: "Delete all 3 notes." }), "Deleted 3 notes."),
  }),
  factHandlers,
)

/* ── the scripted parts: the model, the person who approves, the summarizer and the curator ── */

const script: ModelScript = [
  { _tag: "Calls", pieces: [], calls: [{ name: "lookup", params: { name: "alpha" } }] },
  { _tag: "Answers", pieces: ["Alpha is a teapot, ", "kept on the second shelf."] },
  { _tag: "Calls", pieces: [], calls: [{ name: "rememberFact", params: { fact: "The user prefers green tea." } }] },
  { _tag: "Answers", pieces: ["Noted: you prefer green tea."] },
  { _tag: "Calls", pieces: [], calls: [{ name: "clearNotes", params: {} }] },
  { _tag: "Answers", pieces: ["Your notes are cleared."] },
  { _tag: "Answers", pieces: ["Enjoy the trip to Porto."] },
]
const approval = Layer.succeed(Approval, Approval.of({ ask: () => Effect.succeed({ _tag: "ApprovedAlways" as const }) }))
const summarizer = Layer.succeed(Summarizer, Summarizer.of({
  summarize: ({ earlier, messages }) => Effect.succeed(`${Option.getOrElse(earlier, () => "")}The user looked up alpha, said they prefer green tea and cleared their notes (${messages.length} messages).`),
}))
/** What a model would answer for each source, by its id, asked to extract or to review. */
const replies: Readonly<Record<string, string>> = {
  s1: `{"entities":[{"key":"a","name":"alpha","kind":"thing"}],"aliases":[],"memories":[{"kind":"fact","text":"alpha is a teapot.","about":["a"],"quote":"Look up alpha","by":"user","on":null,"ends":[],"why":null}],"restates":[],"forget":[]}`,
  s2: `{"entities":[],"aliases":[],"memories":[{"kind":"preference","text":"The user prefers green tea.","about":["n1"],"quote":"I prefer green tea","by":"user","on":null,"ends":[],"why":null}],"restates":[],"forget":[]}`,
  s3: `{"entities":[],"aliases":[],"memories":[],"restates":[],"forget":[]}`,
  s4: `{"entities":[{"key":"p","name":"Porto","kind":"place"}],"aliases":[],"memories":[{"kind":"fact","text":"The user travels to Porto next week.","about":["n1","p"],"quote":"I travel to Porto next week","by":"user","on":null,"ends":[],"why":null},{"kind":"preference","text":"The user prefers black tea now.","about":["n1"],"quote":"I prefer black tea now","by":"user","on":null,"ends":["m2"],"why":"changed"}],"restates":[],"forget":[]}`,
}
const curator = Layer.succeed(Curator, Curator.of({
  curate: ({ job }) => Effect.succeed(replies[job.source] ?? "{}"),
}))

/* ── the host's program ── */

const SYSTEM = "You keep a person's notes. Use a tool when it helps."
const MAX_STEPS = 4

/** One turn: the model answers, or asks for tools; their results are stored, and the model is asked again. */
const turn = (conversation: SessionId, message: string) => Effect.scoped(Effect.gen(function* () {
  const memory = yield* Memory
  const model = yield* LanguageModel.LanguageModel
  const toolkit = yield* tools
  const session = yield* (yield* Sessions).open(conversation)
  yield* session.append(userMessage(message))
  for (let step = 1; step <= MAX_STEPS; step++) {
    const prompt = Prompt.make([{ role: "system", content: SYSTEM }, ...(yield* memory.context(session))])
    const answer = yield* modelAnswer(model.streamText({ prompt, toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred" }), session)
    if (answer.toolCalls.length === 0) return answer.text
    for (const call of answer.toolCalls) yield* callTool(toolkit, call, session)
  }
  return `I stopped after ${MAX_STEPS} steps.`
}))

/** After a turn is answered: the turn as a source, kept by the curation step in the knowledge session. */
const keep = (conversation: SessionId, turn: TurnNumber) => Effect.gen(function* () {
  const said = turnSource(turnsOf((yield* (yield* Sessions).read(conversation)).events), turn)
  if (Option.isNone(said)) return yield* Effect.die(`turn ${turn} of the recording holds no message`)
  yield* curate(yield* knowledgeSession, { said: said.value.said, context: said.value.context, at: epoch, from: { session: conversation, turn } })
})

const messages = [
  "Look up alpha for me.",
  "Remember that I prefer green tea.",
  "Clear my notes, please.",
  `I travel to Porto next week, and I prefer black tea now. ${"Here is the plan for each day of the trip, in order. ".repeat(12)}`,
]

const record = (directory: string) => Effect.gen(function* () {
  const minted = yield* Ref.make(0)
  const mintId = Effect.map(Ref.updateAndGet(minted, (count) => count + 1), (count) => SessionId.make(`00000000-0000-4000-8000-${count.toString(16).padStart(12, "0")}`))
  const { model } = yield* scriptedModel(script)
  const store = sessions({ mintId }).pipe(Layer.provideMerge(directoryJournal({ directory })), Layer.provideMerge(kernel()))
  const memory = withFacts({ limit: 5 })(summaryMemory({ budgetTokens: 250, keepTurns: 0 }).pipe(Layer.provide(summarizer)))
  return yield* Effect.gen(function* () {
    const all = yield* Sessions
    const conversation = yield* all.create({ owner: "fixture" })
    yield* Effect.forEach(messages, (message, index) => Effect.andThen(turn(conversation, message), keep(conversation, TurnNumber.make(index + 1))), { concurrency: 1, discard: true })
    const storage = yield* JournalStorage
    const headers = yield* storage.list
    return yield* Effect.forEach(headers, (header) => storage.read(header.id), { concurrency: 1 })
  }).pipe(Effect.provide(Layer.mergeAll(memory, toolsLive, model, approval, curator).pipe(Layer.provideMerge(store))))
}).pipe(Effect.scoped, Effect.provideService(Clock.Clock, fixedClock))

const scratchRoot = join(root, ".artifacts")
await mkdir(scratchRoot, { recursive: true })
const scratch = await mkdtemp(join(scratchRoot, "record-journal-"))
const journals = await Effect.runPromise(record(join(scratch, "journal"))).finally(() => rm(scratch, { recursive: true, force: true }))
const fixture = {
  format: 2,
  version,
  description: unreleased
    ? "Development kernel journals, recorded by scripts/record-journal-fixture.ts --unreleased; not a released-version fixture."
    : "Kernel journals as this version stores them, recorded by scripts/record-journal-fixture.ts. Later versions of its journal format must read them.",
  /** The journal format this version writes (`JOURNAL_FORMAT`): a later kernel of the same format replays it, any other refuses it. */
  journalFormat: JOURNAL_FORMAT,
  sessions: Schema.encodeSync(Schema.Array(Journal))(journals),
}
const text = `${JSON.stringify(fixture, null, 2)}\n`
if (/\/home\/|\/Users\/|[A-Z]:\\\\/.test(text)) {
  console.error("The recording holds an absolute path; nothing was written.")
  process.exit(1)
}
await mkdir(join(target, ".."), { recursive: true })
await writeFile(target, text, { flag: unreleased && force ? "w" : "wx" })
const names = new Set(journals.flatMap((journal) => journal.events.map((event) => event.name)))
console.log(`Recorded ${journals.reduce((sum, journal) => sum + journal.events.length, 0)} events of ${names.size} names in ${journals.length} sessions to ${relative(root, target)}`)
