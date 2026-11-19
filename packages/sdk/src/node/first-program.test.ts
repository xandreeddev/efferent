// The first program a reader writes, as the README, the docs site's getting started and the release notes show it:
// a journal in a folder, sessions, a model that charges a ledger, a memory and a tool, and the host's own loop. Run
// here over a fake `fetch` shaped like an OpenAI-compatible stream, in a folder of its own, twice, as two runs of
// the program would.
import { describe, expect, test } from "bun:test"
import { Config, ConfigProvider, Effect, Layer, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { kernel, ModelSpend, modelSpendMemory, Sessions, userMessage } from "@xandreed/core"
import type { SessionId } from "@xandreed/core"
import { callTool, flatMemory, Memory, modelAnswer, recoverTurns, sessions, turnsOf } from "../index.js"
import { directoryJournal, openAiCompatibleModel } from "./index.js"
import { scratch } from "./testing.js"

// #region first-program
// A tool: what it does, what it takes and what it gives. It is code, offered with every call and never stored.
const Add = Tool.make("add", {
  description: "Add two numbers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
})
const tools = Toolkit.make(Add)
const toolsLive = tools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })

// The model, over any OpenAI-compatible endpoint, its key read from the environment. Each call holds its worst
// case in the ledger before it is sent and is settled at what it cost: together they stay under ten cents.
const MODEL = "gpt-5-mini"
const model = Layer.unwrap(Effect.map(Config.Redacted("OPENAI_API_KEY"), (apiKey) => openAiCompatibleModel({
  model: MODEL,
  baseUrl: "https://api.openai.com/v1",
  apiKey,
  maxOutputTokens: 1024,
  // OpenAI's reasoning models take the cap as max_completion_tokens and refuse the older max_tokens.
  outputField: "max_completion_tokens",
  spend: { prices: { [MODEL]: { input: 0.25, output: 2 } }, caps: { total: 0.1 } },
})))

// One turn, the host's own loop: the message is stored, then the model answers or asks for tools, whose results are
// stored before it is asked again. `modelAnswer` and `callTool` each store what they produce.
const turn = (conversation: SessionId, message: string) => Effect.scoped(Effect.gen(function* () {
  const memory = yield* Memory
  const toolkit = yield* tools
  const session = yield* (yield* Sessions).open(conversation)
  yield* session.append(userMessage(message))
  for (let step = 1; step <= 4; step++) {
    const prompt = Prompt.make([{ role: "system", content: "Use a tool when it helps." }, ...(yield* memory.context(session))])
    const stream = LanguageModel.streamText({ prompt, toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred" })
    const answer = yield* modelAnswer(stream, session)
    if (answer.toolCalls.length === 0) return answer.text
    for (const call of answer.toolCalls) yield* callTool(toolkit, call, session)
  }
  return "I stopped after 4 steps."
}))

// The program: close a turn a killed run left open, then go on with the conversation the folder holds, or start one.
const program = (message: string) => Effect.gen(function* () {
  yield* recoverTurns
  const conversations = yield* Sessions
  const [first] = yield* conversations.list
  const conversation = first === undefined ? yield* conversations.create({ owner: "first-program" }) : first.id
  return yield* turn(conversation, message)
})

// The parts, each a layer whose type says what it needs. The journal is a folder, so the next run remembers.
const agent = (directory: string) => Layer.mergeAll(flatMemory, toolsLive, model).pipe(
  Layer.provideMerge(sessions()),
  Layer.provideMerge(directoryJournal({ directory })),
  Layer.provideMerge(Layer.merge(kernel(), modelSpendMemory)),
)
// #endregion first-program

const sse = (chunks: ReadonlyArray<unknown>) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
const delta = (d: unknown, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] })

/** An endpoint that asks for `add` when the last message is the person's, and answers once a result follows it. */
const endpoint = () => {
  const sent: Array<{ readonly messages: number; readonly authorization: string | null }> = []
  const fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body: unknown = JSON.parse(await new Response(init?.body ?? "").text())
    const messages = typeof body === "object" && body !== null && "messages" in body && Array.isArray(body.messages) ? body.messages : []
    sent.push({ messages: messages.length, authorization: new Headers(init?.headers).get("authorization") })
    const last: unknown = messages.at(-1)
    const asked = typeof last === "object" && last !== null && "role" in last && last.role === "user"
    return new Response(asked
      ? sse([delta({ tool_calls: [{ index: 0, id: `c${sent.length}`, type: "function", function: { name: "add", arguments: "{\"a\":2,\"b\":3}" } }] }, "tool_calls"), { choices: [], usage: { prompt_tokens: 40, completion_tokens: 8, cost: 0.0002 } }])
      : sse([delta({ content: "It is 5." }, "stop"), { choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.0001 } }]),
    { status: 200, headers: { "content-type": "text/event-stream" } })
  }, { preconnect: () => {} })
  return { fetch, sent }
}

const configured = ConfigProvider.fromEnv({ env: { OPENAI_API_KEY: "test-key" } })

/** One run of the program over the folder: a process that starts, takes one message and ends. */
const runIn = (directory: string, fetch: ReturnType<typeof endpoint>["fetch"], message: string) =>
  Effect.gen(function* () {
    const reply = yield* program(message)
    const conversations = yield* Sessions
    const [first] = yield* conversations.list
    const turns = first === undefined ? [] : turnsOf((yield* conversations.read(first.id)).events)
    return { reply, turns: turns.length, steps: turns.map((one) => one.steps.length), settled: Math.round((yield* (yield* ModelSpend).totals).settled * 1e6) / 1e6 }
  }).pipe(
    Effect.provide(agent(directory)),
    Effect.provideService(ConfigProvider.ConfigProvider, configured),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  )

describe("the first program", () => {
  test("a run answers with a tool, and the next run goes on with the conversation the folder holds", async () => {
    const ran = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const directory = yield* scratch
      const first = endpoint()
      const one = yield* runIn(directory, first.fetch, "What is 2 + 3?")
      const second = endpoint()
      const two = yield* runIn(directory, second.fetch, "And 2 + 3 again?")
      return { one, two, sent: [first.sent, second.sent] }
    })))
    expect(ran.one).toEqual({ reply: "It is 5.", turns: 1, steps: [2], settled: 0.0003 })
    // The second run is a new process's: a ledger of its own, and the first turn read back from the folder.
    expect(ran.two).toEqual({ reply: "It is 5.", turns: 2, steps: [2, 2], settled: 0.0003 })
    // The second run's first request holds the first turn (its message, the call, the result and the answer) and its own message.
    expect(ran.sent.map((run) => run.map((one) => one.messages))).toEqual([[2, 4], [6, 8]])
    expect(ran.sent.flat().every((one) => one.authorization === "Bearer test-key")).toBe(true)
  })
})

/*
 * The documents quote the program: the README and the docs site's getting started, each a `ts` fence that holds,
 * after its imports, exactly the region above; and the changelog's pending notes while they show it.
 */
describe("the documents that show the first program", () => {
  const root = `${import.meta.dir}/../../../..`
  const region = async () => {
    const lines = (await Bun.file(import.meta.path).text()).split("\n")
    return lines.slice(lines.indexOf("// #region first-program") + 1, lines.indexOf("// #endregion first-program")).join("\n")
  }
  const fencesOf = (text: string) => Array.from(text.matchAll(/^```ts\n([\s\S]*?)\n```$/gm), (match) => (match[1] ?? "").replace(/^(?:import [^\n]*\n)+\n/, ""))

  test("the README and getting started quote it exactly", async () => {
    const program = await region()
    for (const file of ["README.md", "packages/website/src/content/docs/getting-started.md"]) {
      expect({ file, quoted: fencesOf(await Bun.file(`${root}/${file}`).text()).includes(program) }).toEqual({ file, quoted: true })
    }
  })

  test("the changelog's pending notes quote it exactly when they show a program", async () => {
    const changelog = await Bun.file(`${root}/CHANGELOG.md`).text()
    const start = changelog.indexOf("\n## Unreleased\n")
    const pending = changelog.slice(start, changelog.indexOf("\n## ", start + 1))
    const fences = fencesOf(pending)
    if (fences.length > 0) expect(fences.includes(await region())).toBe(true)
  })
})
