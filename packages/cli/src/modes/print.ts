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
  UtilityLlm,
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
import { renderInstructionsSection, type InstructionFile } from "../usecases/discoverInstructionFiles.js"
import { runFleetToCompletion, withInboxDrain } from "./fleetCompletion.js"
import { headlessDistill } from "./headlessDistill.js"
import type { ToolDefinition } from "@xandreed/sdk-core"
import type { AgentEvent } from "../events.js"
import { makeEventHooks } from "../events.js"
import {
  foldOutcomeEvent,
  initialOutcomeFold,
  outcomeExitCode,
  outcomeNotes,
  type OutcomeFold,
} from "./outcome.js"
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

const consumeEvents = (
  queue: Queue.Queue<AgentEvent>,
  foldBox: { current: OutcomeFold },
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue)
      if (event.type === "flush") return // drain sentinel — never rendered
      // Honesty fold: exit code + caveat notes derive from the full stream.
      foldBox.current = foldOutcomeEvent(foldBox.current, event)
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
        case "subagent_end": {
          const outcome = event.outcome ?? (event.ok ? "ok" : "error")
          if (outcome !== "ok") {
            const colour = outcome === "partial" ? ansi.fgYellow : ansi.fgRed
            yield* writeStderr(
              `${colour}[agent ${outcome}] ${event.name}${event.reason !== undefined ? ` (${event.reason})` : ""}${ansi.reset}`,
            )
          }
          break
        }
        case "gate":
          if (event.verdict === "unavailable" || event.verdict === "blocked") {
            yield* writeStderr(
              `${ansi.fgBrightRed}[gate] ${event.verdict}: ${event.reasons.join("; ")}${ansi.reset}`,
            )
          }
          break
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
  readonly instructionFiles: ReadonlyArray<InstructionFile>
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
  | UtilityLlm
> =>
  Effect.gen(function* () {
    const conversationIdRaw =
      input.resumeConversationId ?? crypto.randomUUID()
    const cid = yield* decodeConversationId(conversationIdRaw).pipe(
      Effect.orDie,
    )
    const queue = yield* Queue.unbounded<AgentEvent>()
    const foldBox = { current: initialOutcomeFold }
    const consumer = yield* Effect.forkDaemon(consumeEvents(queue, foldBox))

    const hooks = makeEventHooks(queue)
    const runtime = buildScopeRuntime(
      input.rootScope,
      {
        skills: input.skills,
        memory: input.memory,
        agents: input.agents,
        tools: input.tools,
        instructions: renderInstructionsSection(input.instructionFiles),
        allowBash: input.allowBash,
      },
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
      // Supervised-fleet teardown: on EVERY exit path (done, error, Ctrl-C)
      // interrupt + AWAIT the fleet fibers so each records killed(shutdown) —
      // and so live fibers can't keep the process alive past the run.
      Effect.ensuring(runtime.bus.shutdown().pipe(Effect.ignore)),
    )

    // Deterministic drain: sentinel + join (the run is done, nothing else
    // produces), so every trailing event renders before the final text.
    yield* Queue.offer(queue, { type: "flush" })
    yield* Fiber.join(consumer)

    process.stdout.write(result.finalText + "\n")

    // Headless honesty: the exit code + stderr caveats carry the run's real
    // outcome (the old print mode exited 0 no matter what died inside).
    const fold = foldBox.current
    for (const note of outcomeNotes(fold)) {
      yield* writeStderr(`${ansi.fgYellow}[outcome] ${note}${ansi.reset}`)
    }
    process.exitCode = outcomeExitCode(fold)

    // Learn for next runs: the answer is already on stdout, so distillation runs
    // after delivery (gated/bounded/fail-soft in headlessDistill). It delays exit,
    // not the answer — and closes the self-improving loop on the headless path.
    const learned = yield* headlessDistill({
      conversationId: cid,
      repoDir: input.cwd,
      skills: input.skills,
      memory: input.memory,
    })
    if (learned.length > 0) {
      yield* writeStderr(
        `${ansi.fgGreen}learned ${learned.length} reusable ${learned.length === 1 ? "lesson" : "lessons"} for next time: ${learned.map((r) => r.candidate.name).join(", ")}${ansi.reset}`,
      )
    }
  })
