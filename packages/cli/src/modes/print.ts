import { Effect, Queue, Schema, Fiber } from "effect"
import {
  ConversationId,
  ConversationStore,
  FileSystem,
  Llm,
  LlmCache,
  Shell,
  coderAgentConfig,
  runAgent,
  type Skill,
} from "@agent/core"
import type { AgentEvent } from "../events.js"
import { makeEventHooks } from "../events.js"
import { denyBashHook } from "../safetyHooks.js"
import { ansi } from "../tui/terminal.js"

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
  readonly allowBash: boolean
  readonly resumeConversationId?: string
}

export const runPrintMode = (
  input: PrintModeInput,
): Effect.Effect<
  void,
  never,
  FileSystem | Shell | Llm | LlmCache | ConversationStore
> =>
  Effect.gen(function* () {
    const conversationIdRaw =
      input.resumeConversationId ?? crypto.randomUUID()
    const cid = yield* decodeConversationId(conversationIdRaw).pipe(
      Effect.orDie,
    )
    const queue = yield* Queue.unbounded<AgentEvent>()
    const consumer = yield* Effect.forkDaemon(consumeEvents(queue))

    const hooks = makeEventHooks<FileSystem | Shell | ConversationStore | Llm>(
      queue,
      denyBashHook(input.allowBash),
    )

    const result = yield* runAgent(
      coderAgentConfig(input.cwd, input.skills),
      cid,
      input.prompt,
      hooks,
    ).pipe(
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

    yield* Effect.sleep("50 millis") // let queue drain
    yield* Fiber.interrupt(consumer)

    if (result !== undefined) {
      process.stdout.write(result.finalText + "\n")
    }
  })
