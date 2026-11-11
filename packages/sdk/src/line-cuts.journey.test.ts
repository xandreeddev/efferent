import { describe, expect, test } from "bun:test"
import { LanguageModel, Prompt, Tool } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { ConversationId, defineCapability, defineSkill, defineTool, entriesOfEvents, Failure, RunId, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage, UtilityCompletion, UtilityLlm } from "@xandreed/core"
import type { Turn, TurnOutcome } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import type { AgentConfig } from "./agent.adapter.js"

/*
 * A host tool with no view returns a table of 1,000 rows, about 64,000
 * characters, each row starting with its identifier. With `cutAtLineBreaks`
 * the result is bounded as it is written after the last whole row within
 * 16,000 characters, from the first request that includes it, and the model
 * reads the rest with `recall_context`, a page after a page, each ending
 * after a whole row: no request shows half an identifier. Both memory
 * strategies are run. Without the option the same turn cuts the head at
 * 16,000 characters, inside a row.
 */

const FetchTable = Tool.make("fetch_table", {
  description: "Fetch a table by its name.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

/** A header and 1,000 rows of 41 to 87 characters: an identifier, then text of a length that differs from row to row. */
const table = (name: string): string =>
  "id | text | marks\n" + Array.from({ length: 1_000 }, (_, index) => `${name}-${String(index + 1).padStart(5, "0")} | ${"entry ".repeat(4 + (index * 5) % 7).trimEnd()} | ${"#".repeat((index * 3) % 11)}\n`).join("")

// No view: the model is shown the returned text as it is.
const host = defineCapability({
  id: "line-cuts-host", version: "1",
  tools: [defineTool({ tool: FetchTable, handler: ({ name }) => Effect.succeed(table(name)), annotations: { readOnly: true } })],
  skills: [defineSkill({ id: "core", summary: "Fetch tables.", tools: ["fetch_table"], always: true })],
})

const BOUND = 16_000
const RECALL_PAGE = 8_000
const BUDGET = 64_000

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, name: string, params: unknown): Part => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
const stop = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]
const encodePrompt = Schema.encodeSync(Prompt.Prompt)

/** A model request as the journey reads it: each message as the bytes sent, and the tool results in order. */
interface Seen {
  readonly messages: ReadonlyArray<string>
  readonly results: ReadonlyArray<{ readonly name: string; readonly result: unknown }>
}

/** The locator and offset the last line of a shortened result or of a page gives. */
const continuationOf = (result: unknown) => Option.map(Option.fromNullishOr(/locator "([^"]+)" and offset (\d+)(?: to read them)?\]$/.exec(String(result))), (found) => ({ locator: found[1] ?? "", offset: Number(found[2]) }))
/** The text of a shortened result or of a page, without its last line. */
const bodyOf = (result: unknown): string => {
  const text = String(result)
  return text.endsWith("]") && text.includes("\n[… ") ? text.slice(0, text.lastIndexOf("\n[… ")) : text
}

/** What a scripted model answers its request number `index` with, from what that request shows. */
type Script = (request: Seen, index: number) => Part

/** Reads on from whatever the last result it was shown names, until one names nothing. */
const readOn: Script = (request, index) => Option.match(continuationOf(request.results.at(-1)?.result), {
  onNone: () => stop("The table is read."),
  onSome: ({ locator, offset }) => call(`r${index}`, "recall_context", { locator, offset }),
})

/** A model that fetches the table, then answers each request as `script` says. */
const scripted = (seen: Ref.Ref<ReadonlyArray<Seen>>, script: Script) => Effect.gen(function* () {
  const served = yield* Ref.make(0)
  return yield* LanguageModel.make({
    generateText: (options) => Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(served, (value) => value + 1)
      const prompt = encodePrompt(options.prompt)
      const request: Seen = {
        messages: prompt.content.map((message) => JSON.stringify(message)),
        results: prompt.content.flatMap((message) => message.role === "tool" ? message.content.flatMap((part) => part.type === "tool-result" ? [{ name: part.name, result: part.result }] : []) : []),
      }
      yield* Ref.update(seen, (all) => [...all, request])
      return (index === 0 ? call("f1", "fetch_table", { name: "north" }) : script(request, index)) as never
    }),
    streamText: () => Stream.die("not scripted"),
  })
})

const runToStop = (turn: Turn) => turn.tools.select(turn.userMessage).pipe(
  Effect.andThen(turn.run({ limits: { requireCompletion: false } })),
  Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })),
)

const decodeBuilt = Schema.decodeUnknownSync(Schema.Struct({ estimatedTokens: Schema.Int, reservedTokens: Schema.Int, budgetTokens: Schema.Int, strategyVersion: Schema.String }))

/** One turn of a scripted model in a fresh session under `memory`: every request it saw, each step's `context.built`, the compactions and the table as stored. */
const runTurn = (memory: AgentConfig["plugins"][number], script: Script = readOn) => Effect.scoped(Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { id: ConversationId.make("00000000-0000-4000-8000-00001c07b4ea"), owner: "line-cuts-journey" }
  yield* sessions.create({ owner: address.owner, id: address.id })
  // The summary strategy reads a summarizer where its session opens; nothing in this turn passes its trigger.
  const utility = UtilityLlm.of({ complete: () => Effect.succeed(new UtilityCompletion({ text: "SUMMARY", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })) })
  const agent = yield* Agent.define({
    plugins: [memory, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [host],
    turnServices: [LanguageModel.LanguageModel, UtilityLlm],
    limits: { streaming: false, maxSteps: 12 },
    system: "Answer from the table.",
    budgetTokens: BUDGET,
  })
  const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
  const model = yield* scripted(seen, script)
  const outcome = yield* agent.turn({
    turn: { session: address, userMessage: new UserMessage({ text: "read the northern table" }), runId: RunId.make("run-1") },
    services: Context.mergeAll(Context.make(LanguageModel.LanguageModel, model), Context.make(UtilityLlm, utility), Context.make(Sessions, sessions)),
  }, runToStop)
  const stored = yield* sessions.read(address)
  const entries = yield* entriesOfEvents(stored)
  return {
    outcome: outcome.outcome,
    requests: yield* Ref.get(seen),
    built: stored.filter((event) => event.kind === "context.built").map((event) => decodeBuilt(event.data)),
    compactions: entries.flatMap((entry) => entry.body._tag === "Compaction" ? [{
      strategy: entry.body.strategy, version: entry.body.version,
      ...(entry.body.action._tag === "Spill" ? { spilled: String(entry.body.action.entry), preview: entry.body.action.preview } : { spilled: `not a spill: ${entry.body.action._tag}`, preview: "" }),
    }] : []),
    /** The stored view of the table, by its entry id: what a locator resolves to. */
    stored: entries.flatMap((entry) => entry.body._tag === "ToolResult" && entry.body.toolName === "fetch_table" ? [{ locator: String(entry.id), view: entry.body.view }] : []),
  }
}))

const north = table("north")
/** Where a piece asked for from `from`, `limit` characters long, ends when it is cut after its last whole row. Every row here is far shorter than a quarter of a piece. */
const rowEndWithin = (from: number, limit: number): number => from + limit >= north.length ? north.length : north.lastIndexOf("\n", from + limit - 1) + 1
interface Piece {
  readonly from: number
  readonly to: number
  /** The most characters the piece could hold: the bound for the head, a page after it. */
  readonly limit: number
}
/** The pieces a reader gets when each one is cut by `endOf`: the head within the bound, then a page at a time to the table's end. */
const piecesBy = (endOf: (from: number, limit: number) => number): { readonly head: Piece; readonly pages: ReadonlyArray<Piece> } => {
  const head = { from: 0, to: endOf(0, BOUND), limit: BOUND }
  const pages: Array<Piece> = []
  for (let from = head.to; from < north.length; from = endOf(from, RECALL_PAGE)) pages.push({ from, to: endOf(from, RECALL_PAGE), limit: RECALL_PAGE })
  return { head, pages }
}
const notice = (left: number, locator: string, offset: number) => `[… ${left} more characters kept out of context; call recall_context with locator "${locator}" and offset ${offset} to read them]`
const pageOf = (locator: string, piece: Piece): string => piece.to >= north.length ? north.slice(piece.from)
  : `${north.slice(piece.from, piece.to)}\n[… ${north.length - piece.to} more characters; call recall_context with locator "${locator}" and offset ${piece.to}]`

/** A returned failure as the model is shown it. */
const failureShown = (failure: { readonly error: string; readonly message: string }): string => JSON.stringify({ error: failure.error, message: failure.message })
const headShown = { error: "ResultShown", message: "That offset was inside the text this result showed when you asked, so nothing was returned. To read on, pass the offset its shortened form shows now, or offset 0 if it shows none." }
const pageRead = (next: number) => ({ error: "AlreadyRecalled", message: `The text from that offset is in a page you already read, shown above. To read on, pass offset ${next}.` })
/** The offset a model that follows a refusal passes next: the one the reply names, else the one the table's notice shows in the same request. */
const followed = (request: Seen): number => Number(/To read on, pass offset (\d+)\./.exec(String(request.results.at(-1)?.result))?.[1]
  ?? Option.getOrElse(Option.map(continuationOf(request.results[0]?.result), (found) => found.offset), () => -1))
/**
 * A model that asks for text it has: the last character of the table's shown
 * head, then, after reading the first page as the reply says, that page again
 * from its start, and later an offset inside it. It follows each refusal.
 */
const probing = (head: Piece): Script => (request, index) => {
  const locator = Option.getOrElse(Option.map(continuationOf(request.results[0]?.result), (found) => found.locator), () => "no locator shown")
  const offsets = [head.to - 1, followed(request), head.to, followed(request), head.to + 100, followed(request)]
  return index > offsets.length ? stop("Three pages are read.") : call(`r${index}`, "recall_context", { locator, offset: offsets[index - 1] })
}

const strategies = [
  { plugin: memoryWindowPlugin, strategy: "window", version: "4+cut-at-line-breaks" },
  { plugin: memorySummaryPlugin, strategy: "summary", version: "2" },
] as const

strategies.map(({ plugin, strategy, version }) => describe(`previews and pages cut at line breaks, under the ${strategy} strategy`, () => {
  // One turn serves the tests below: it is run when the first of them asks for it.
  const run = () => Effect.runPromise(runTurn({ plugin, options: { cutAtLineBreaks: true } }))
  let ran: ReturnType<typeof run> | undefined
  const turnOf = () => (ran ??= run())
  const { head, pages } = piecesBy(rowEndWithin)

  test("the table and its rows are what the journey needs: longer than the bound and two pages, with no row ending at a limit", () => {
    expect(north.length).toBeGreaterThan(BOUND + 2 * RECALL_PAGE)
    expect(pages.length).toBe(7)
    // Every piece but the last gives something up: its limit falls inside a row, never at a row's end.
    expect([head, ...pages].slice(0, -1).filter((piece) => !(piece.to < piece.from + piece.limit && north.charAt(piece.to - 1) === "\n"))).toEqual([])
    // And none gives up more than a row: every row is far shorter than a quarter of a piece.
    expect(Math.max(...[head, ...pages].slice(0, -1).map((piece) => piece.from + piece.limit - piece.to))).toBeLessThan(100)
  })

  test("the bounded head ends after a whole row from the first request that includes it, and no later request changes it", async () => {
    const turn = await turnOf()
    expect(turn.outcome).toBe("completed")
    // One request for the fetch, one for each page, and the one that stops.
    expect(turn.requests).toHaveLength(pages.length + 2)
    const [locator] = turn.stored.map((kept) => kept.locator)
    const shown = `${north.slice(0, head.to)}\n${notice(north.length - head.to, locator ?? "", head.to)}`
    expect(head.to).toBeLessThan(BOUND)
    expect(north.slice(0, head.to).endsWith("\n")).toBe(true)
    // The request after the fetch shows it so, and so does every request after that.
    expect(turn.requests.map((request) => request.results.filter((result) => result.name === "fetch_table").map((result) => result.result)))
      .toEqual([[], ...turn.requests.slice(1).map(() => [shown])])
    // The bound is the one compaction stored: the strategy's own spill, recorded as the result was written.
    expect(turn.compactions).toEqual([{ strategy, version, spilled: locator ?? "", preview: shown }])
    expect(new Set(turn.built.map((step) => step.strategyVersion))).toEqual(new Set([version]))
    // The stored result stays whole.
    expect(turn.stored.map((kept) => kept.view)).toEqual([north])
  })

  test("each request's messages are the one before it, byte for byte, with more after", async () => {
    const turn = await turnOf()
    const prefixes = turn.requests.slice(1).map((request, index) => {
      const earlier = turn.requests[index]?.messages ?? []
      return { grew: request.messages.length > earlier.length, same: earlier.every((message, at) => message === request.messages[at]) }
    })
    expect(prefixes).toEqual(turn.requests.slice(1).map(() => ({ grew: true, same: true })))
  })

  test("recall_context reads the rest in pages that each end after a whole row, and the head and the pages join to the table", async () => {
    const turn = await turnOf()
    const [locator] = turn.stored.map((kept) => kept.locator)
    const recalled = turn.requests.at(-1)?.results.filter((result) => result.name === "recall_context").map((result) => result.result) ?? []
    expect(recalled).toEqual(pages.map((piece) => pageOf(locator ?? "", piece)))
    // Every page but the last ends with a line break and is shorter than 8,000 characters; each starts with a row's identifier.
    expect(recalled.slice(0, -1).map((page) => ({ ended: bodyOf(page).endsWith("\n"), short: bodyOf(page).length < RECALL_PAGE })))
      .toEqual(recalled.slice(0, -1).map(() => ({ ended: true, short: true })))
    expect(recalled.every((page) => /^north-\d{5} \| /.test(String(page)))).toBe(true)
    const fetched = turn.requests.at(-1)?.results.find((result) => result.name === "fetch_table")?.result
    expect(`${bodyOf(fetched)}${recalled.map(bodyOf).join("")}`).toBe(north)
    // Every request fits the budget.
    expect(turn.built.every((step) => step.estimatedTokens + step.reservedTokens <= step.budgetTokens)).toBe(true)
  })

  test("a call for text the request shows is refused, inside the head and inside a page, and the offset each reply leads to is served", async () => {
    const turn = await Effect.runPromise(runTurn({ plugin, options: { cutAtLineBreaks: true } }, probing(head)))
    expect(turn.outcome).toBe("completed")
    const [locator] = turn.stored.map((kept) => kept.locator)
    const [first, second, third] = pages
    // The head's last character is refused, though it is below the 16,000 characters the bound would have shown: the head ends where its notice says.
    // The reply leads to the notice's offset, the first page. That page again is refused with its own end, where the second page is served;
    // an offset inside the first is then refused with the second's end, where the third is served. Every end is after a whole row.
    expect(turn.requests.at(-1)?.results.slice(1)).toEqual([
      { name: "recall_context", result: failureShown(headShown) },
      { name: "recall_context", result: pageOf(locator ?? "", first ?? head) },
      { name: "recall_context", result: failureShown(pageRead(first?.to ?? -1)) },
      { name: "recall_context", result: pageOf(locator ?? "", second ?? head) },
      { name: "recall_context", result: failureShown(pageRead(second?.to ?? -1)) },
      { name: "recall_context", result: pageOf(locator ?? "", third ?? head) },
    ])
    expect([first?.from, first?.to, second?.to, third?.to].map((offset) => north.charAt((offset ?? 0) - 1))).toEqual(["\n", "\n", "\n", "\n"])
  })
}))

test("without the option the same turn cuts the head at 16,000 characters and each page at 8,000, inside rows", async () => {
  const turn = await Effect.runPromise(runTurn(memoryWindowPlugin))
  expect(turn.outcome).toBe("completed")
  const [locator] = turn.stored.map((kept) => kept.locator)
  const { head, pages } = piecesBy((from, limit) => Math.min(from + limit, north.length))
  expect(head).toEqual({ from: 0, to: BOUND, limit: BOUND })
  const last = turn.requests.at(-1)?.results ?? []
  expect(last.filter((result) => result.name === "fetch_table").map((result) => result.result)).toEqual([`${north.slice(0, BOUND)}\n${notice(north.length - BOUND, locator ?? "", BOUND)}`])
  expect(last.filter((result) => result.name === "recall_context").map((result) => result.result)).toEqual(pages.map((piece) => pageOf(locator ?? "", piece)))
  // The head ends inside a row, and so does every page but the last: the next result starts with the rest of that row.
  expect([head, ...pages].slice(0, -1).filter((piece) => north.charAt(piece.to - 1) === "\n")).toEqual([])
  expect(turn.compactions.map((compaction) => compaction.version)).toEqual(["4"])
})
