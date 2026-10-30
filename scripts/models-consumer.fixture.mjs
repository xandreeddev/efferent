// The models plugin with storage "memory", on Node, in a process of its own
// (scripts/verify-packages.ts): HOME and the working directory are fresh
// empty directories, and they must still be empty after two turns, a login,
// a role edit, a logout, the catalog and a utility call.
import { readdirSync } from "node:fs"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { Prompt } from "effect/ai"
import { mediaFromBase64, mediaLabel, ModelCatalog, ProviderId, Sessions, SessionLogMemoryLive, TurnAdmissionOpen, UserMessage, UtilityLlm } from "@xandreed/core"
import { toPromptMessages } from "@xandreed/core/internal"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { AuthStore, modelsPlugin, SettingsStore } from "@xandreed/plugin-models"
import { promptWithImageLabels, toChatMessages } from "@xandreed/plugin-models/compat"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"

const fail = (message) => { console.error(`models consumer: ${message}`); process.exit(1) }
const home = process.env.HOME ?? ""
const cwd = process.cwd()
const entries = (directory) => readdirSync(directory)
if (homedir() !== home) fail(`homedir() is ${homedir()}, not the fresh HOME`)
if (entries(home).length > 0 || entries(cwd).length > 0) fail("HOME or the working directory is not empty at the start")

// A chat-completions endpoint that records each request's Authorization header and model.
const seen = []
const server = createServer((request, response) => {
  const chunks = []
  request.on("data", (chunk) => chunks.push(chunk))
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    seen.push({ auth: request.headers.authorization ?? null, model: body.model })
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: `answered ${body.model}` } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const url = `http://127.0.0.1:${server.address().port}/v1`

const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsPluginLive({ ownership: { mode: "process" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: modelsPlugin, options: {
      storage: "memory", model: "stub:first", fastModel: "stub:fast",
      endpoints: { stub: { url } },
      credentialEnv: { stub: "MODELS_FIXTURE_KEY" },
      credentials: { opencode: { type: "api_key", key: Redacted.make("opencode-fixture-key") } },
    } }],
    limits: { streaming: false, maxSteps: 2 },
    workspace: cwd,
  })
  const view = yield* sessions.create({ owner: "consumer" })
  const address = { id: view.header.id, owner: "consumer" }
  const turn = (runId, during) => agent.turn({ turn: { session: address, userMessage: new UserMessage({ text: runId }), runId }, services: Context.make(Sessions, sessions) },
    (current) => Effect.gen(function* () {
      const run = yield* current.run({})
      yield* during(yield* Effect.context())
      return { outcome: run.outcome, reply: Option.some(run.text) }
    }))
  const first = yield* turn("run-1", (services) => Effect.gen(function* () {
    yield* Context.getUnsafe(services, AuthStore).set(ProviderId.make("stub"), { type: "api_key", key: Redacted.make("login-key") })
    yield* Context.getUnsafe(services, SettingsStore).setRole("general", Option.some("stub:second"))
  }))
  const second = yield* turn("run-2", (services) => Effect.gen(function* () {
    yield* Context.getUnsafe(services, UtilityLlm).complete("a title")
    const catalog = yield* Context.getUnsafe(services, ModelCatalog).list
    if (!catalog.some((entry) => entry.selection === "opencode:glm-5.2")) yield* Effect.die("the catalog does not list the opencode models")
    yield* Context.getUnsafe(services, AuthStore).remove(ProviderId.make("opencode"))
  }))
  return [first, second].map((outcome) => Option.getOrNull(outcome.reply))
})))
server.close()

const expected = [
  { auth: "Bearer env-fixture-key", model: "first" },
  { auth: "Bearer login-key", model: "second" },
  { auth: "Bearer login-key", model: "fast" },
]
if (JSON.stringify(result) !== JSON.stringify(["answered first", "answered second"])) fail(`replies ${JSON.stringify(result)}`)
if (JSON.stringify(seen) !== JSON.stringify(expected)) fail(`requests ${JSON.stringify(seen)}`)
if (entries(home).length > 0 || entries(cwd).length > 0) fail(`memory storage wrote to disk: HOME has ${JSON.stringify(entries(home))}, the working directory ${JSON.stringify(entries(cwd))}`)

// A tool result's image on Node: an image_url part in a captioned user message on an endpoint that reads images, a label line on one that does not.
const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const pixel = Effect.runSync(mediaFromBase64(pixelPng, { name: "shot.png" }))
const shotPrompt = Prompt.make(toPromptMessages([
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "screenshot", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "screenshot", output: "home", isError: false, media: [pixel] }] },
]))
const withImages = toChatMessages(shotPrompt, { images: true })
const imageMessage = JSON.stringify(withImages.at(-1))
if (!imageMessage.includes("Images returned by screenshot (call c1):") || !imageMessage.includes(`data:image/png;base64,${pixelPng}`)) fail(`the tool's image was sent as ${imageMessage.slice(0, 200)}`)
const labelled = JSON.stringify(toChatMessages(promptWithImageLabels(shotPrompt)))
if (labelled.includes(pixelPng) || !labelled.includes(mediaLabel(pixel))) fail(`a route without images was sent ${labelled.slice(0, 200)}`)
console.log("On Node, the models plugin with storage \"memory\" ran two turns, a login, a role edit, a logout, the catalog and a utility call, and left a fresh HOME and working directory empty; a tool's image went out as an image_url part, or as its label line where images are not read")
process.exit(0)
