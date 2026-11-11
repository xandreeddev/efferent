// The lesson runtime: the real framework, running in the page. Everything the
// learner sees is `Agent.define` and `agent.turn` from @xandreed/sdk.
import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Schema, Scope } from "effect"
import { LanguageModel } from "effect/ai"
import { Agent, RunId, Sessions, SessionLogMemoryLive, TurnAdmissionOpen, UserMessage } from "@xandreed/sdk"
import type { TurnEvent } from "@xandreed/sdk"
import { contextReportOf, ConversationMemory, definePlugin, ledgerOf, openLogSession } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { onRequest } from "./capture.ts"
import type { CapturedRequest } from "./capture.ts"
import type { LoadedModel } from "./models/types.ts"

const OWNER = "learner"

/** Every option Agent.define takes; it ignores any other key without a word. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "plugins", "bindings", "capabilities", "services", "turnServices", "system", "cacheKeyPrefix", "workspace",
  "limits", "budgetTokens", "captureTraceContent", "maxEventDepth", "spanMeta", "shutdown",
])

export type BuildResult =
  | { readonly ok: true; readonly plugins: ReadonlyArray<string>; readonly system: string; readonly warnings: ReadonlyArray<string>; readonly restarted: boolean }
  | { readonly ok: false; readonly message: string }

export interface TurnResult {
  readonly outcome: string
  readonly text: string
  readonly steps: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface SendHandlers {
  readonly onEvent: (event: TurnEvent) => void
}

type DefineOptions = Parameters<typeof Agent.define>[0]
type AgentOf = Effect.Success<ReturnType<typeof Agent.define>>

/** The names a memory plugin is made of (the tiny plugin's code may use these). */
const tinyScope = { Schema, definePlugin, ConversationMemory, openLogSession, ledgerOf, Layer, Effect, Option }

/** Evaluate a JavaScript expression against a fixed set of names only. */
const evaluate = (source: string, names: Record<string, unknown>): unknown => {
  const keys = Object.keys(names)
  return new Function(...keys, `"use strict"; return (${source}\n)`)(...keys.map((key) => names[key]))
}

/** Evaluate the learner's `tinyMemory` factory. */
export const evaluateTiny = (source: string): unknown => evaluate(source, tinyScope)

/** Evaluate the learner's agent config; `tinyMemory` is the learner's own plugin factory, when they wrote one. */
export const evaluateConfig = (source: string, tinyMemory: unknown = undefined): unknown =>
  evaluate(source, { LanguageModel, stepLoopPlugin, memoryWindowPlugin, toolDiscoveryPlugin, tinyMemory })

const messageOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") return cause.message
  return String(cause)
}

export class LessonRuntime {
  private agent: Option.Option<{ readonly agent: AgentOf; readonly scope: Scope.Closeable; readonly plugins: ReadonlyArray<string>; readonly system: string }> = Option.none()
  private sessionId = ""
  private model: Option.Option<LoadedModel> = Option.none()
  private running: Option.Option<Fiber.Fiber<unknown, unknown>> = Option.none()

  /** What the model was sent, keyed by the turn, run and step of the `context.built` event that preceded each request. */
  private readonly captures = new Map<string, CapturedRequest>()
  private captureKey = ""
  private readonly stopCapture: () => void

  private constructor(private readonly root: Scope.Closeable, private readonly sessions: Context.Service.Shape<typeof Sessions>) {
    this.stopCapture = onRequest((request) => { this.captures.set(this.captureKey, request) })
  }

  static async create(): Promise<LessonRuntime> {
    const root = await Effect.runPromise(Scope.make())
    const layer = SessionsLive(sessionsDefaults).pipe(
      Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
    )
    const built = await Effect.runPromise(Layer.build(layer).pipe(Effect.provideService(Scope.Scope, root)))
    const runtime = new LessonRuntime(root, Context.get(built, Sessions))
    await runtime.reset()
    return runtime
  }

  setModel(model: LoadedModel): void {
    this.model = Option.some(model)
  }

  /** Define the agent from the learner's config; the previous agent is shut down. */
  async rebuild(source: string, tinySource = ""): Promise<BuildResult> {
    let config: unknown
    try {
      let tiny: unknown
      if (source.includes("tinyMemory")) {
        try {
          tiny = evaluateTiny(tinySource)
        } catch (error) {
          return { ok: false, message: `tiny-memory.ts is not valid JavaScript: ${messageOf(error)}` }
        }
      }
      config = evaluateConfig(source, tiny)
    } catch (error) {
      return { ok: false, message: `Your config is not valid JavaScript: ${messageOf(error)}` }
    }
    if (typeof config !== "object" || config === null) return { ok: false, message: "The config must be an object: { system, plugins, limits, ... }" }
    const next = await Effect.runPromise(Scope.make())
    // The learner's object is plain JavaScript; Agent.define checks it at run time and refuses what does not fit.
    const options: DefineOptions = { plugins: [], ...(config as Partial<DefineOptions>), turnServices: [LanguageModel.LanguageModel] }
    const defined = await Effect.runPromiseExit(
      Agent.define(options).pipe(
        Effect.provideService(Scope.Scope, next),
      ),
    )
    if (Exit.isFailure(defined)) {
      await Effect.runPromise(Scope.close(next, Exit.void))
      return { ok: false, message: messageOf(Cause.squash(defined.cause)) }
    }
    const previous = this.agent
    const record = config as { readonly system?: unknown; readonly plugins?: ReadonlyArray<unknown> }
    this.agent = Option.some({
      agent: defined.value as AgentOf, scope: next,
      plugins: (record.plugins ?? []).map(pluginName),
      system: typeof record.system === "string" ? record.system : "",
    })
    if (Option.isSome(previous)) await Effect.runPromise(Scope.close(previous.value.scope, Exit.void))
    const unknown = Object.keys(config as object).filter((key) => !KNOWN_KEYS.has(key))
    const plugins = Option.getOrElse(this.agent, () => ({ plugins: [] as ReadonlyArray<string> })).plugins
    // A session's memory entries belong to the strategy that wrote them: a different strategy starts a new conversation.
    const restarted = Option.isSome(previous) && memoryOf(previous.value.plugins) !== memoryOf(plugins)
    if (restarted) await this.reset()
    return {
      ok: true,
      plugins,
      system: typeof record.system === "string" ? record.system : "",
      restarted,
      warnings: unknown.map((key) => `"${key}" is not an Agent.define option, so it was ignored. Did you mean one of: ${[...KNOWN_KEYS].join(", ")}?`),
    }
  }

  /** A new, empty conversation. */
  async reset(): Promise<void> {
    this.captures.clear()
    this.captureKey = ""
    const view = await Effect.runPromise(this.sessions.create({ owner: OWNER }))
    this.sessionId = view.header.id
  }

  /** The session's journal and the context report read from it alone. */
  async inspect() {
    const events = await Effect.runPromise(this.sessions.read({ id: this.sessionId as never, owner: OWNER }))
    const report = await Effect.runPromise(contextReportOf(events, { largest: 100 }))
    return { events, report, captures: new Map(this.captures) as ReadonlyMap<string, CapturedRequest> }
  }

  get ready(): boolean {
    return Option.isSome(this.agent) && Option.isSome(this.model)
  }

  async send(text: string, handlers: SendHandlers): Promise<TurnResult> {
    if (Option.isNone(this.agent) || Option.isNone(this.model)) throw new Error("Pick a model and build the agent first.")
    const { agent } = this.agent.value
    const loaded = this.model.value
    const sessions = this.sessions
    const sessionId = this.sessionId
    let steps = 0
    // `function*` below has no `this`: the runtime's capture key is set through this arrow.
    const stamp = (key: string) => { this.captureKey = key }
    const turn = agent.turn(
      {
        turn: {
          session: { id: sessionId as never, owner: OWNER },
          userMessage: new UserMessage({ text }),
          runId: RunId.make(crypto.randomUUID()),
        },
        services: Context.merge(Context.make(LanguageModel.LanguageModel, loaded.model), Context.make(Sessions, sessions)),
      },
      (t) => Effect.gen(function* () {
        yield* t.events.subscribe((event) => Option.some(event), (event) => Effect.sync(() => {
          if (event._tag === "context.built") stamp(captureKeyOf(event.turn, event.run, event.step))
          handlers.onEvent(event)
        }))
        const result = yield* t.run({})
        steps = result.steps
        return { outcome: result.outcome, reply: result.outcome === "waiting" ? Option.none<string>() : Option.some(result.text) }
      }),
    )
    const fiber = Effect.runFork(turn)
    this.running = Option.some(fiber as Fiber.Fiber<unknown, unknown>)
    const exit = await Effect.runPromise(Fiber.await(fiber))
    this.running = Option.none()
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) return { outcome: "stopped", text: "", steps: 0, inputTokens: 0, outputTokens: 0 }
      throw new Error(messageOf(Cause.squash(exit.cause)))
    }
    const done = exit.value as { outcome: string; reply: Option.Option<string>; usage: { inputTokens: unknown; outputTokens: unknown } }
    return {
      outcome: done.outcome, text: Option.getOrElse(done.reply, () => ""), steps,
      inputTokens: tokenCount(done.usage.inputTokens), outputTokens: tokenCount(done.usage.outputTokens),
    }
  }

  /** Stop the turn in flight; the model is told to stop first so its stream ends. */
  stop(): void {
    if (Option.isSome(this.model)) this.model.value.interrupt()
    if (Option.isSome(this.running)) Effect.runFork(Fiber.interrupt(this.running.value))
  }

  async dispose(): Promise<void> {
    this.stopCapture()
    if (Option.isSome(this.agent)) await Effect.runPromise(Scope.close(this.agent.value.scope, Exit.void))
    await Effect.runPromise(Scope.close(this.root, Exit.void))
  }
}

/** The key joining a captured request to its row of the context report. */
export const captureKeyOf = (turn: number, run: number, step: number): string => `${turn}:${run}:${step}`

/** Which plugin supplies the agent's memory, by id. */
const memoryOf = (plugins: ReadonlyArray<string>): string => plugins.find((id) => /memory/.test(id)) ?? ""

const pluginName = (entry: unknown): string => {
  const plugin = typeof entry === "object" && entry !== null && "plugin" in entry ? (entry as { plugin: unknown }).plugin : entry
  return typeof plugin === "object" && plugin !== null && "id" in plugin && typeof plugin.id === "string" ? plugin.id : "plugin"
}

/** TokenUsage fields are numbers, or `{ total }` objects on some paths. */
const tokenCount = (value: unknown): number =>
  typeof value === "number" ? value
    : typeof value === "object" && value !== null && "total" in value && typeof value.total === "number" ? value.total : 0
