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
  WebSearch,
  buildScopeRuntime,
  coderAgentConfig,
  coderPrompt,
  runAgent,
  type Scope,
  type Skill,
} from "@efferent/core"
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
      { skills: input.skills, allowBash: input.allowBash },
      hooks,
    )

    const prompt = coderPrompt(input.cwd, new Date(), input.skills)
    const result = yield* runAgent(
      coderAgentConfig(input.rootScope, runtime, prompt),
      cid,
      input.prompt,
      hooks,
      input.cwd,
    ).pipe(
      Effect.provide(runtime.handlerLayer),
      // Headless: --allow-bash already encodes the standing decision; the
      // Approval port answers allow-all behind that gate (no prompts in CI).
      Effect.provide(ApprovalAllowAllLive),
      Effect.catchAll((err) =>
        Effect.gen(function* () {
          const msg =
            typeof err === "object" && err !== null && "message" in err
              ? String((err as { message: unknown }).message)
              : String(err)
          yield* Queue.offer(queue, { type: "error", message: msg })
          yield* writeStderr(
            `${ansi.fgBrightRed}agent error: ${msg}${ansi.reset}`,
          )
          return undefined
        }),
      ),
    )

    // Deterministic drain: sentinel + join (the run is done, nothing else
    // produces), so every trailing event renders before the final text.
    yield* Queue.offer(queue, { type: "flush" })
    yield* Fiber.join(consumer)

    if (result !== undefined) {
      process.stdout.write(result.finalText + "\n")
    }
  })
