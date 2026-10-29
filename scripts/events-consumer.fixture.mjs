// The events guide's HTTP recipe (docs/events.md) through the packed
// packages: scripts/verify-packages.ts writes the recipe's regions of
// packages/sdk/src/events-guide.test.ts, with the imports they use, to
// events-recipe.ts beside this file (the consumer's tsc compiles it), and
// runs this on Node (which strips its types), then on Bun. With a scripted,
// streaming model: a session is created, a turn streams from `started`
// through its text deltas to `done`, its retry under the same
// Idempotency-Key gets the stored answer, the journal route serves the
// turn's records from cursor 0 until `ready`, and /ping is idle afterwards.
import { Effect, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { SessionLogMemoryLive } from "@xandreed/core"
import { decodeSse } from "@xandreed/plugin-render"
import { createSessionRoute, eventsRoute, pingRoute, startHost, turnRoute } from "./events-recipe.ts"

const runtime = typeof Bun === "undefined" ? `Node ${process.versions.node}` : `Bun ${Bun.version}`
const fail = (message) => { console.error(`events recipe (${runtime}): ${message}`); process.exit(1) }

const usage = { inputTokens: { total: 20 }, outputTokens: { total: 5 } }
const model = await Effect.runPromise(LanguageModel.make({
  generateText: () => Effect.succeed([{ type: "text", text: "Hello there." }, { type: "finish", reason: "stop", usage }]),
  streamText: () => Stream.fromIterable([
    { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Hello " }, { type: "text-delta", id: "t", delta: "there." },
    { type: "text-end", id: "t" }, { type: "finish", reason: "stop", usage },
  ]),
}))
const host = await startHost({ log: SessionLogMemoryLive, model, feed: { pollMs: 10, maxPollMs: 40, heartbeatMs: 10_000, maxDurationMs: 5_000 } })

const owner = "consumer"
const work = []
const waitUntil = (promise) => { work.push(promise) }
const post = (path, body, headers = {}) =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
const framesOf = (text) => text.split("\n\n").filter((block) => block.startsWith("event: ")).map((block) => {
  const [event, data] = block.split("\n").map((line) => line.slice(line.indexOf(": ") + 2))
  return { event, data: JSON.parse(data) }
})
const decoder = new TextDecoder()
const readUntil = (reader, done, text = "") => done(text) ? Promise.resolve(text)
  : reader.read().then((chunk) => chunk.done ? text : readUntil(reader, done, text + decoder.decode(chunk.value, { stream: true })))

const created = await createSessionRoute(host, owner, post("/sessions", {}))
if (created.status !== 201) fail(`creating a session answered ${created.status}`)
const { id } = await created.json()

// A follower of the session's journal, reading from before the turn begins, as a second tab would.
const controller = new AbortController()
const feed = await eventsRoute(host, owner, id, new Request(`http://localhost/sessions/${id}/events`, { signal: controller.signal }), waitUntil)
const reader = feed.body.getReader()
const backlog = await readUntil(reader, (seen) => seen.includes("event: ready"))
const following = readUntil(reader, (seen) => seen.includes("event: turn.ended"), backlog)

const turns = `/sessions/${id}/turns`
const streamed = await turnRoute(host, owner, id, post(turns, { text: "hi" }, { "idempotency-key": "k-1" }), waitUntil)
if (streamed.headers.get("content-type") !== "text/event-stream; charset=utf-8") fail(`the turn answered ${streamed.status} ${streamed.headers.get("content-type")}`)
const frames = framesOf(await streamed.text())
const names = frames.map((frame) => frame.event).join(" ")
if (names !== "started step delta delta message step done") fail(`the turn streamed ${names}`)
const text = frames.filter((frame) => frame.event === "delta").map((frame) => frame.data.text).join("")
if (text !== "Hello there." || frames.at(-1).data.outcome !== "completed") fail(`the turn streamed ${JSON.stringify(frames)}`)

const retried = await turnRoute(host, owner, id, post(turns, { text: "hi" }, { "idempotency-key": "k-1" }), waitUntil)
const answer = await retried.json()
if (retried.status !== 200 || answer.reply !== "Hello there." || answer.turn !== 1) fail(`the retry answered ${retried.status} ${JSON.stringify(answer)}`)

const journal = await following
controller.abort()
const kinds = decodeSse(journal).map((frame) => frame._tag === "FeedRecord" ? frame.event : frame._tag).join(" ")
if (kinds !== "FeedReady turn.started memory.message turn.reply turn.ended") fail(`the journal route sent ${kinds}`)

await Promise.all(work)
const ping = await (await pingRoute(host)).json()
if (ping.busy !== false) fail(`/ping says ${JSON.stringify(ping)} once the turn has ended`)
console.log(`The events guide's HTTP recipe streamed a turn while its journal was followed over SSE, and replayed its retry, on ${runtime}`)
