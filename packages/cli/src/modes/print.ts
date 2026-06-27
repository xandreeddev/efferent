import { LanguageModel } from "@effect/ai"
import { Effect, Queue, Schema, Fiber } from "effect"
import {
  ApprovalAllowAllLive,
  ContextTreeStore,
  ConversationId,
  ConversationStore,
  FileSystem,
  Http,
  SettingsStore,
  Shell,
  Verifier,
  WebSearch,
  runAgent,
  type AgentDefinition,
  type AgentResult,
  type Scope,
  type Memory,
  type Skill,
  buildScopeRuntime,
} from "@xandreed/sdk-core"
import { coderAgentConfig } from "../usecases/coderAgentConfig.js"
import { coderPrompt } from "../prompts/coder.js"
import { runFleetToCompletion, withInboxDrain } from "./fleetCompletion.js"
import type { ToolDefinition } from "@xandreed/sdk-core"
import type { AgentEvent } from "../events.js"
import { makeEventHooks } from "../events.js"
import { ansi } from "../terminal.js"

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n)}…`

const renderArgs = (args: unknown): string => {
  try {
    const text = JSON.stringify(args)
    return truncate(text, 200)
  } catch {
    return String(args)
  }
}

const writeStderr = (line: string): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stderr.write(line + "\n")
  })

const consumeEvents = (queue: Queue.Queue<AgentEvent>) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue)
      if (event.type === "flush") return // drain sentinel — never rendered
      switch (event.type) {
        case "tool_call_start":
          yield* writeStderr(
            `${ansi.fgYellow}[tool] ${event.toolName} ${ansi.dim}${renderArgs(
              event.args,
            )}${ansi.reset}`,
          )
          break
        case "tool_call_end": {
          const tag = event.ok
            ? `${ansi.fgGreen}done${ansi.reset}`
            : `${ansi.fgRed}failed${ansi.reset}`
          yield* writeStderr(`${ansi.dim}       ${tag}${ansi.reset}`)
          break
        }
        case "error":
          yield* writeStderr(`${ansi.fgBrightRed}[error] ${event.message}${ansi.reset}`)
          break
        default:
          break
      }
    }
  })

const decodeConversationId = Schema.decodeUnknown(ConversationId)

export interface PrintModeInput {
  readonly prompt: string
  readonly cwd: string
  readonly skills: ReadonlyArray<Skill>
  readonly memory: ReadonlyArray<Memory>
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly rootScope: Scope
  readonly allowBash: boolean
  readonly resumeConversationId?: string
}

export const runPrintMode = (
  input: PrintModeInput,
): Effect.Effect<
  void,
  never,
  | FileSystem
  | Http
  | Shell
  | LanguageModel.LanguageModel
  | ConversationStore
  | ContextTreeStore
  | SettingsStore
  | WebSearch
  | Verifier
> =>
  Effect.gen(function* () {
    const conversationIdRaw =
      input.resumeConversationId ?? crypto.randomUUID()
    const cid = yield* decodeConversationId(conversationIdRaw).pipe(
      Effect.orDie,
    )
    const queue = yield* Queue.unbounded<AgentEvent>()
    const consumer = yield* Effect.forkDaemon(consumeEvents(queue))

    const hooks = makeEventHooks(queue)
    const runtime = buildScopeRuntime(
      input.rootScope,
      { skills: input.skills, memory: input.memory, agents: input.agents, tools: input.tools, allowBash: input.allowBash },
      hooks,
    )

    const prompt = coderPrompt(input.cwd, new Date(), input.skills, [], input.agents, input.tools)
    const config = coderAgentConfig(input.rootScope, runtime, prompt)
    // The root gets an inbox (keyed by its conversation id) so a finished fleet
    // posts completions there; the synthesis turns drain it via withInboxDrain.
    const rootKey = String(cid)
    const drainHooks = withInboxDrain(hooks, runtime.bus, rootKey)

    // One root turn, error-handled so a failed turn can't break the completion
    // loop — emit the error as an event + stderr, return an empty result.
    const runTurn = (p: string) =>
      runAgent(config, cid, p, drainHooks, input.cwd).pipe(
        Effect.catchAll((err) =>
          Effect.gen(function* () {
            const msg =
              typeof err === "object" && err !== null && "message" in err
                ? String((err as { message: unknown }).message)
                : String(err)
            yield* Queue.offer(queue, { type: "error", message: msg })
            yield* writeStderr(`${ansi.fgBrightRed}agent error: ${msg}${ansi.reset}`)
            return { finalText: "", messages: [], newTail: [] } as AgentResult
          }),
        ),
      )

    // Headless auto-block: if the root delegated and left a fleet running, wait
    // for it to finish and give the root another turn to synthesize — looping
    // until nothing is outstanding. The service layers wrap the WHOLE loop (not a
    // single turn) so the fleet's forkDaemon fibers stay alive between turns.
    yield* runtime.bus.markRunning(rootKey, "root")
    const result = yield* runFleetToCompletion({
      bus: runtime.bus,
      rootKey,
      firstPrompt: input.prompt,
      runTurn,
    }).pipe(
      Effect.provide(runtime.handlerLayer),
      // Headless: --allow-bash already encodes the standing decision; the
      // Approval port answers allow-all behind that gate (no prompts in CI).
      Effect.provide(ApprovalAllowAllLive),
      Effect.ensuring(runtime.bus.markDone(rootKey)),
    )

    // Deterministic drain: sentinel + join (the run is done, nothing else
    // produces), so every trailing event renders before the final text.
    yield* Queue.offer(queue, { type: "flush" })
    yield* Fiber.join(consumer)

    process.stdout.write(result.finalText + "\n")
  })
