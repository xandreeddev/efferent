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

const writeJson = (event: AgentEvent): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(JSON.stringify(event) + "\n")
  })

const consumeEvents = (queue: Queue.Queue<AgentEvent>) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue)
      if (event.type === "flush") return // drain sentinel — never emitted
      yield* writeJson(event)
    }
  })

const decodeConversationId = Schema.decodeUnknown(ConversationId)

export interface JsonModeInput {
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

export const runJsonMode = (
  input: JsonModeInput,
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
    const consumer = yield* Effect.forkDaemon(consumeEvents(queue))

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
    const rootKey = String(cid)
    const drainHooks = withInboxDrain(hooks, runtime.bus, rootKey)

    const runTurn = (p: string) =>
      runAgent(config, cid, p, drainHooks, input.cwd).pipe(
        Effect.catchAll((err) =>
          Effect.gen(function* () {
            const msg =
              typeof err === "object" && err !== null && "message" in err
                ? String((err as { message: unknown }).message)
                : String(err)
            yield* Queue.offer(queue, { type: "error", message: msg })
            return { finalText: "", messages: [], newTail: [] } as AgentResult
          }),
        ),
      )

    // Headless auto-block: wait for an outstanding fleet and let the root
    // synthesize (see fleetCompletion.ts). Layers wrap the whole loop so the
    // fleet's forkDaemon fibers survive between turns.
    yield* runtime.bus.markRunning(rootKey, "root")
    yield* runFleetToCompletion({
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

    // Learn for next runs: mine + persist reusable lessons, emitted as a final
    // `learned` event on the stream (gated/bounded/fail-soft in headlessDistill)
    // — the self-improving loop's "learn" step on the headless json path.
    const learned = yield* headlessDistill({
      conversationId: cid,
      repoDir: input.cwd,
      skills: input.skills,
      memory: input.memory,
    })
    if (learned.length > 0) {
      yield* Queue.offer(queue, {
        type: "learned",
        lessons: learned.map((r) => ({ name: r.candidate.name, kind: r.candidate.kind })),
      })
    }

    // Deterministic drain: the run is done, so a sentinel is strictly the last
    // event; joining the consumer guarantees agent_end (and every trailing tool
    // event) hit stdout before the process exits. No sleep, no race.
    yield* Queue.offer(queue, { type: "flush" })
    yield* Fiber.join(consumer)
  })
