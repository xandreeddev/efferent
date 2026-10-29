import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import {
  AuthStore,
  ConversationId,
  definePlugin,
  ProviderId,
  SessionEnvironment,
  SessionLogMemoryLive,
  Sessions,
  SettingsStore,
  TurnAdmissionOpen,
  UserMessage,
} from "@xandreed/core"
import type { HarnessConfig, Plugin, Turn } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { HostCredentials, modelsPlugin } from "@xandreed/plugin-models"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { resolveGraph } from "@xandreed/runtime"
import { Agent } from "./agent.adapter.js"

/** A chat-completions endpoint that records each request's Authorization header and model. */
const chatServer = () => {
  const seen: Array<{ auth: string | null; model: unknown }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      const body = await request.json() as { readonly model?: unknown }
      seen.push({ auth: request.headers.get("authorization"), model: body.model })
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: `endpoint answered ${String(body.model)}` } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    },
  })
  return { seen, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const conversation = ConversationId.make("00000000-0000-4000-8000-0000000000aa")

const sessionsWith = Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  yield* sessions.create({ owner: "test", id: conversation })
  return sessions
})

const agentWith = (options: Readonly<Record<string, unknown>>, workspace: string) => Agent.define({
  plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: modelsPlugin, options }],
  limits: { streaming: false, maxSteps: 2 },
  workspace,
})

/** One turn's reply; `during` runs inside the turn, with the turn's services. */
const replyOf = (during: (services: Context.Context<never>) => Effect.Effect<void, unknown> = () => Effect.void) => (turn: Turn) => Effect.gen(function* () {
  const result = yield* turn.run({})
  yield* during(yield* Effect.context<never>()).pipe(Effect.orDie)
  return { outcome: result.outcome, reply: Option.some(result.text) }
})

const turnInput = (sessions: typeof Sessions.Service, runId: string, services: Context.Context<never> = Context.empty()) => ({
  turn: { session: { id: conversation, owner: "test" }, userMessage: new UserMessage({ text: `question ${runId}` }), runId },
  services: Context.merge(services, Context.make(Sessions, sessions)),
})

describe("the models plugin is built once per agent", () => {
  test("a credential stored and a role chosen in one turn are what the next turn uses, and no file is written", async () => {
    const server = chatServer()
    const workspace = mkdtempSync(join(tmpdir(), "efferent-sdk-models-"))
    const options = {
      storage: "memory", model: "stub:first",
      endpoints: { stub: { url: server.url } },
      credentials: { stub: { type: "api_key", key: Redacted.make("first-key") } },
    }
    const replies = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sessions = yield* sessionsWith
      const agent = yield* agentWith(options, workspace)
      const first = yield* agent.turn(turnInput(sessions, "run-1"), replyOf((services) => Effect.gen(function* () {
        yield* Context.getUnsafe(services, AuthStore).set(ProviderId.make("stub"), { type: "api_key", key: "in-memory-token" })
        yield* Context.getUnsafe(services, SettingsStore).setRole("general", Option.some("stub:second"))
      })))
      const second = yield* agent.turn(turnInput(sessions, "run-2"), replyOf())
      return { replies: [first, second].map((result) => Option.getOrNull(result.reply)), files: readdirSync(workspace) }
    })).pipe(Effect.ensuring(Effect.sync(() => {
      server.stop()
      rmSync(workspace, { recursive: true, force: true })
    }))))
    expect(replies).toEqual({ replies: ["endpoint answered first", "endpoint answered second"], files: [] })
    expect(server.seen).toEqual([{ auth: "Bearer first-key", model: "first" }, { auth: "Bearer in-memory-token", model: "second" }])
  })

  test("a turn's own LanguageModel wins over the plugin's", async () => {
    const server = chatServer()
    const reply = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sessions = yield* sessionsWith
      const agent = yield* agentWith({ storage: "memory", model: "stub:m", endpoints: { stub: { url: server.url } } }, ".")
      const own = yield* LanguageModel.make({
        generateText: () => Effect.succeed([{ type: "text", text: "the turn's model" }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } }] as never),
        streamText: () => Stream.die("not scripted") as never,
      })
      return (yield* agent.turn(turnInput(sessions, "run-own", Context.make(LanguageModel.LanguageModel, own)), replyOf())).reply
    })).pipe(Effect.ensuring(Effect.sync(server.stop))))
    expect(Option.getOrNull(reply)).toBe("the turn's model")
    expect(server.seen).toEqual([])
  })
})

describe("the models plugin's secrets", () => {
  const config = (options: Readonly<Record<string, unknown>>): HarnessConfig => ({ version: 1, plugins: [{ id: modelsPlugin.id, use: modelsPlugin.id, options }], system: "" })
  const refusals = [
    { label: "a plain-string API key", options: { storage: "memory", credentials: { anthropic: { type: "api_key", key: "sk-plain-secret-1" } } }, secret: "sk-plain-secret-1" },
    { label: "a plain-string OAuth token", options: { storage: "memory", credentials: { openai: { type: "oauth", access: "sk-plain-secret-2", refresh: Redacted.make("r"), expires: 1 } } }, secret: "sk-plain-secret-2" },
    { label: "a credential of an unknown type", options: { storage: "memory", credentials: { openai: { type: "apikey", key: "sk-plain-secret-3" } } }, secret: "sk-plain-secret-3" },
    { label: "a misspelt option", options: { storage: "memory", credential: { openai: "sk-plain-secret-4" } }, secret: "sk-plain-secret-4" },
    { label: "credentials as a string", options: { storage: "memory", credentials: "sk-plain-secret-5" }, secret: "sk-plain-secret-5" },
    { label: "a misspelt endpoint key", options: { endpoints: { gateway: { url: "http://127.0.0.1:1/v1", apikey: "sk-plain-secret-7" } } }, secret: "sk-plain-secret-7" },
    { label: "Redacted credentials under local storage", options: { credentials: { anthropic: { type: "api_key", key: Redacted.make("sk-redacted-secret-6") } } }, secret: "sk-redacted-secret-6" },
    { label: "a credential's misspelt key", options: { storage: "memory", credentials: { anthropic: { type: "api_key", apiKey: "sk-plain-secret-8" } } }, secret: "sk-plain-secret-8" },
    { label: "an extra field next to a Redacted key", options: { storage: "memory", credentials: { anthropic: { type: "api_key", key: Redacted.make("k"), extra: "sk-plain-secret-9" } } }, secret: "sk-plain-secret-9" },
    { label: "an extra token on an OAuth credential", options: { storage: "memory", credentials: { anthropic: { type: "oauth", access: Redacted.make("a"), refresh: Redacted.make("r"), expires: 1, idToken: "sk-plain-secret-10" } } }, secret: "sk-plain-secret-10" },
    { label: "a token where the expiry belongs", options: { storage: "memory", credentials: { anthropic: { type: "oauth", access: Redacted.make("a"), refresh: Redacted.make("r"), expires: "sk-plain-secret-11" } } }, secret: "sk-plain-secret-11" },
  ]

  refusals.map(({ label, options, secret }) => test(`${label} is refused by resolveGraph and Agent.define without the secret in the error`, async () => {
    const graph = await Effect.runPromise(Effect.flip(resolveGraph(config(options), [modelsPlugin], [SessionEnvironment.key])))
    expect(graph.code).toBe("config.options")
    expect(graph.message).not.toContain(secret)
    expect(JSON.stringify(graph)).not.toContain(secret)
    const defined = await Effect.runPromise(Effect.flip(Effect.scoped(agentWith(options, "."))))
    expect(defined.code).toBe("config.options")
    expect(`${defined.message} ${JSON.stringify(defined)} ${String(defined)}`).not.toContain(secret)
  }))

  test("a Redacted credential is accepted, and the agent's fingerprint does not depend on it", async () => {
    const fingerprints = await Effect.runPromise(Effect.scoped(Effect.forEach(["sk-one", "sk-two"], (key) =>
      agentWith({ storage: "memory", credentials: { anthropic: { type: "api_key", key: Redacted.make(key) } } }, ".").pipe(Effect.map((agent) => agent.fingerprint)))))
    expect(fingerprints[0]).toBe(fingerprints[1]!)
  })
})

describe("what the models plugin depends on", () => {
  const sessionProvider = (id: string, tag: { readonly key: string }, value: unknown): Plugin => definePlugin({
    id, version: "1", scope: "session", config: Schema.Struct({}), defaults: {}, provides: [tag],
    layer: () => Layer.succeedContext(Context.makeUnsafe<never>(new Map([[tag.key, value]]))),
  })

  test("a session-scoped plugin may not provide its SessionEnvironment or HostCredentials", async () => {
    const workspace = sessionProvider("test/workspace", SessionEnvironment, { workspace: "." })
    const credentials = sessionProvider("test/credentials", HostCredentials, { load: Effect.succeed(new Map()), save: () => Effect.void })
    const refused = await Effect.runPromise(Effect.forEach([workspace, credentials], (plugin) => Effect.flip(Effect.scoped(Agent.define({
      plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, plugin, { plugin: modelsPlugin, options: { storage: "memory" } }],
    })))))
    expect(refused.map((error) => error.message)).toEqual([
      `${modelsPlugin.id}: runtime plugins cannot depend on session service ${SessionEnvironment.key}`,
      `${modelsPlugin.id}: runtime plugins cannot depend on session service ${HostCredentials.key}`,
    ])
  })
})
