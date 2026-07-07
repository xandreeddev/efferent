import { homedir } from "node:os"
import { Effect, Layer, Option, Ref } from "effect"
import type { LanguageModel } from "@effect/ai"
import { Implementor, ImplementorError } from "@xandreed/foundry"
import type { WorkspacePath } from "@xandreed/foundry"
import {
  Approval,
  buildScopeRuntime,
  codeModelDistinct,
  coderAgentConfig,
  coderPrompt,
  ContextTreeStore,
  ConversationStore,
  discoverInstructionFiles,
  discoverScopeTree,
  FileSystem,
  Http,
  loadAgents,
  loadMemory,
  loadSkills,
  loadTools,
  makeAgentEventHooks,
  renderInstructionsSection,
  runAgent,
  runFleetToCompletion,
  SettingsStore,
  Shell,
  stripLeads,
  TerminalSession,
  UtilityLlm,
  Verifier,
  WebSearch,
  withInboxDrain,
} from "@xandreed/sdk-core"
import type { AgentHooks, AgentResult, ConversationId } from "@xandreed/sdk-core"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { capturePath } from "./filesTouched.js"
import { renderRetryBrief, renderTaskBrief } from "./prompt.js"

/**
 * Everything one implementor attempt needs at runtime — captured as a
 * `Context` when the Layer builds, so `Implementor.implement` itself stays
 * `R = never` (the port has no requirement channel by design).
 */
export type ImplementorServices =
  | FileSystem
  | Shell
  | Http
  | WebSearch
  | TerminalSession
  | ContextTreeStore
  | ConversationStore
  | SettingsStore
  | UtilityLlm
  | Approval
  | Verifier
  | LanguageModel.LanguageModel

const EMPTY_RESULT: AgentResult = { finalText: "", messages: [], newTail: [] }

export interface EfferentImplementorOptions {
  /** The workspace the coder works in — the same dir the gates snapshot. */
  readonly cwd: string
  /** The smith event sink; the coder's AgentEvents ride it as `{type:"agent"}`. */
  readonly publish: (event: SmithEvent) => Effect.Effect<void>
}

/**
 * The efferent coder agent as foundry's `Implementor` — the agent in the
 * factory. Each forge run gets ONE persisted conversation (SQLite via
 * `ConversationStore`, exactly like the CLI): attempt 1 opens it with the
 * task brief; every later attempt continues the SAME conversation with the
 * gate feedback as the next user prompt — cache-warm, full context, and every
 * message in the DB where you'd expect it. The receipt's `ref`
 * (`"conversation:<id>"`) links the persisted `FactoryRun` artifact back to
 * that conversation.
 *
 * The roster is the DIRECT one (`stripLeads` — no coordinator): the root codes
 * hands-on on the GENERAL role, and with a distinct code model configured
 * (smith's default) the prompt's delegation policy routes code-heavy pieces to
 * `role:"code"` sub-agents. A spawning turn is driven through
 * `runFleetToCompletion`, so an attempt only returns once its fleet settled.
 *
 * Error mapping: only INFRA failures (a provider hard error that survived the
 * headless retry ladder, a defect) become `ImplementorError` — forge retries
 * those twice, and each retry is a paid run. A finished-but-weak turn returns
 * a normal receipt: the gates are the judge.
 */
export const makeEfferentImplementorLive = (
  options: EfferentImplementorOptions,
): Layer.Layer<Implementor, never, ImplementorServices> =>
  Layer.scoped(
    Implementor,
    Effect.gen(function* () {
      const context = yield* Effect.context<ImplementorServices>()
      const store = yield* ConversationStore
      const settings = yield* (yield* SettingsStore).get()

      // The REAL coder config, built once per forge session — the same recipe
      // as the CLI's discoverWorkspace, direct roster.
      const home = homedir()
      const skills = yield* loadSkills(options.cwd, home)
      const memory = yield* loadMemory(options.cwd, home)
      const agents = stripLeads(yield* loadAgents(options.cwd, home))
      const tools = yield* loadTools(options.cwd, home)
      const instructionFiles = yield* discoverInstructionFiles(options.cwd, home)
      const prompt = coderPrompt(
        options.cwd,
        new Date(),
        skills,
        instructionFiles,
        agents,
        tools,
        "smith",
        memory,
        codeModelDistinct(settings),
      )
      const rootScope = yield* discoverScopeTree(options.cwd, (_children, body) =>
        body !== undefined && body.trim().length > 0
          ? `${prompt.text}\n\n# Project scope\n\n${body}`
          : prompt.text,
      )

      const filesRef = yield* Ref.make<ReadonlyArray<WorkspacePath>>([])
      const eventHooks = makeAgentEventHooks((event) =>
        options.publish({ type: "agent", event }),
      )
      const hooks: AgentHooks = {
        ...eventHooks,
        onAfterToolCall: (event) =>
          Ref.update(filesRef, (all) =>
            Option.match(capturePath(event, options.cwd), {
              onNone: () => all,
              onSome: (path) => (all.includes(path) ? all : [...all, path]),
            }),
          ).pipe(Effect.zipRight(eventHooks.onAfterToolCall?.(event) ?? Effect.void)),
      }

      const runtime = buildScopeRuntime(
        rootScope,
        {
          skills,
          memory,
          agents,
          tools,
          instructions: renderInstructionsSection(instructionFiles),
          allowBash: settings.allowBash,
        },
        hooks,
      )
      const config = coderAgentConfig(rootScope, runtime, prompt)
      const handlers = yield* Layer.build(runtime.handlerLayer)

      const conversationRef = yield* Ref.make(Option.none<ConversationId>())
      const conversation = Effect.gen(function* () {
        const existing = yield* Ref.get(conversationRef)
        if (Option.isSome(existing)) return existing.value
        const fresh = yield* store.create(options.cwd)
        yield* Ref.set(conversationRef, Option.some(fresh))
        return fresh
      })

      return Implementor.of({
        implement: (input) =>
          Effect.gen(function* () {
            yield* Ref.set(filesRef, [])
            const cid = yield* conversation.pipe(
              Effect.mapError(
                (cause) =>
                  new ImplementorError({
                    attempt: input.attempt,
                    message: `conversation store: ${String(cause)}`,
                  }),
              ),
            )
            const brief = Option.match(input.feedback, {
              onNone: () => renderTaskBrief(input.spec),
              onSome: renderRetryBrief,
            })
            const failureRef = yield* Ref.make(Option.none<string>())
            const remember = (cause: unknown) =>
              Ref.update(failureRef, (prev) =>
                Option.isSome(prev) ? prev : Option.some(String(cause)),
              ).pipe(Effect.as(EMPTY_RESULT))
            const runTurn = (turnPrompt: string) =>
              runAgent(
                config,
                cid,
                turnPrompt,
                withInboxDrain(hooks, runtime.bus, String(cid)),
                options.cwd,
                undefined,
                "headless",
              ).pipe(Effect.catchAll(remember), Effect.catchAllDefect(remember))

            // The turn's prose is not the deliverable — the workspace state the
            // gates snapshot is; the run is driven for its side effects.
            yield* runFleetToCompletion({
              bus: runtime.bus,
              rootKey: String(cid),
              firstPrompt: brief,
              runTurn,
            }).pipe(Effect.provide(handlers), Effect.provide(context))

            const failure = yield* Ref.get(failureRef)
            if (Option.isSome(failure)) {
              return yield* Effect.fail(
                new ImplementorError({ attempt: input.attempt, message: failure.value }),
              )
            }
            return {
              filesTouched: [...(yield* Ref.get(filesRef))].sort(),
              ref: Option.some(`conversation:${cid}`),
            }
          }).pipe(
            Effect.withSpan("smith.implement", {
              attributes: { "attempt.n": input.attempt },
            }),
          ),
      })
    }),
  )
