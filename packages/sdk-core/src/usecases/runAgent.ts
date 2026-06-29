import type { Tool } from "@effect/ai"
import { Effect } from "effect"
import type { ContextNodeId } from "../entities/AgentContext.js"
import type { AgentGateEvent, AgentHooks } from "../entities/AgentHooks.js"
import type { AgentMessage, ConversationId } from "../entities/Conversation.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { SettingsStore } from "../ports/SettingsStore.js"
import { recordError } from "../telemetry/metrics.js"
import { agentSpanAttributes, runSpanName } from "../telemetry/spanNames.js"
import { runAgentLoop } from "./agentLoop.js"
import { gateOnce, listTreeSafe, settleNewNodes } from "./gateLoop.js"
import { handoffToMessage } from "./promptMapping.js"
import { RunContextRef } from "./runContext.js"
import { DEFAULT_SUB_AGENT_TOKEN_BUDGET, makeTokenPool } from "./tokenBudget.js"
import type { AgentConfig } from "./agentConfig.js"

interface DriveLoopInput<Tools extends Record<string, Tool.Any>, R> {
  readonly config: AgentConfig<Tools>
  readonly conversationId: ConversationId
  readonly messages: ReadonlyArray<AgentMessage>
  readonly extraHooks: AgentHooks<R> | undefined
  readonly workspaceDir: string | undefined
  readonly pinnedGeneral: string | undefined
  /** Prompt label for the span (user prompt or "[resume in-flight turn]"). */
  readonly promptLabel: string
  /** Seeded onto RunContext.mission when present. */
  readonly mission: string | undefined
}

/** Emit a swarm-gate verdict through the caller's hook, if any (no-op otherwise). */
const emitGate = <Tools extends Record<string, Tool.Any>, R>(
  input: DriveLoopInput<Tools, R>,
  event: AgentGateEvent,
): Effect.Effect<void, never, R> => input.extraHooks?.onGateResult?.(event) ?? Effect.void

const driveLoop = <Tools extends Record<string, Tool.Any>, R>(
  input: DriveLoopInput<Tools, R>,
) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const settingsStore = yield* SettingsStore
    const settings = yield* settingsStore.get()

    yield* store.ensure(input.conversationId, input.workspaceDir)

    // One shared spend pool for every sub-agent this turn may spawn — fresh per
    // top-level run, so a prior turn's spend never starves this one.
    const tokenPool = yield* makeTokenPool(
      settings.subAgentTokenBudget ?? DEFAULT_SUB_AGENT_TOKEN_BUDGET,
    )

    const toolResultMaxChars =
      settings.toolResultMaxTokens !== undefined ? settings.toolResultMaxTokens * 4 : undefined

    // Persist each turn's tail the moment it lands (incremental persistence) — so
    // the session is restorable to its last completed turn, and a mid-run nav/state
    // read sees real history, not just memory. A persist failure is a defect (can't
    // safely continue without durable history).
    const persistTail = (msgs: ReadonlyArray<AgentMessage>) =>
      Effect.forEach(msgs, (m) => store.append(input.conversationId, m)).pipe(Effect.orDie)

    // One run of the loop over a message buffer — reused verbatim for the first
    // attempt AND each gate-driven retry, so a retry inherits the same pinned
    // models, shared token pool, compaction policy, and incremental persistence.
    const runOneAttempt = (messages: ReadonlyArray<AgentMessage>) =>
      runAgentLoop({
        system: input.config.prompt.text,
        messages,
        toolkit: input.config.toolkit,
        maxSteps: settings.maxSteps,
        onTail: persistTail,
        ...(toolResultMaxChars !== undefined ? { toolResultMaxChars } : {}),
        ...(input.extraHooks !== undefined ? { hooks: input.extraHooks } : {}),
      }).pipe(
        Effect.locally(RunContextRef, {
          rootConversationId: input.conversationId,
          parentNodeId: null,
          depth: 0,
          tokenPool,
          prompt: input.config.prompt,
          ...(settings.subAgentMaxSteps !== undefined
            ? { subAgentMaxSteps: settings.subAgentMaxSteps }
            : {}),
          ...(settings.subAgentMaxDepth !== undefined
            ? { subAgentMaxDepth: settings.subAgentMaxDepth }
            : {}),
          ...(settings.subAgentFetchBudget !== undefined
            ? { subAgentFetchBudget: settings.subAgentFetchBudget }
            : {}),
          ...(toolResultMaxChars !== undefined ? { toolResultMaxChars } : {}),
          ...(input.config.compression !== undefined ? { compression: input.config.compression } : {}),
          pinnedModels: {
            general: input.pinnedGeneral ?? settings.model,
            code: settings.codeModel ?? input.pinnedGeneral ?? settings.model,
            fast: settings.fastModel ?? input.pinnedGeneral ?? settings.model,
          },
          ...(input.mission !== undefined ? { mission: input.mission } : {}),
          // Thread the retry-notice sink down to the provider adapter (it runs
          // below the loop and can't see hooks) so a backoff surfaces live.
          ...(input.extraHooks?.onLlmRetry !== undefined
            ? { onLlmRetry: input.extraHooks.onLlmRetry }
            : {}),
          // Same for the background-process output sink (Shell adapter, below the loop).
          ...(input.extraHooks?.onBgOutput !== undefined
            ? { onBgOutput: input.extraHooks.onBgOutput }
            : {}),
        }),
        Effect.tapErrorCause(() =>
          Effect.annotateCurrentSpan({ error: true }).pipe(
            Effect.zipRight(recordError("run", "failed")),
          ),
        ),
        Effect.withSpan(runSpanName(), {
          attributes: {
            ...agentSpanAttributes("run", input.conversationId),
            "agent.model": settings.model,
            "agent.prompt": input.promptLabel.slice(0, 120),
          },
        }),
        Effect.annotateLogs({ conversationId: input.conversationId }),
      )

    // Snapshot the tree BEFORE the run so we can tell which sub-agent nodes THIS
    // run created (a resumed conversation already carries prior turns' nodes).
    const nodeIdsBefore: ReadonlySet<ContextNodeId> = new Set(
      (yield* listTreeSafe(input.conversationId)).map((n) => n.id),
    )

    let result = yield* runOneAttempt(input.messages)

    // ===== Mandatory swarm gate (the self-improving loop's enforcement point) =====
    // If THIS run used sub-agents, the objective is NOT done until the independent
    // Opus gate validates the deliverable. This lives in `driveLoop` — the one path
    // `runAgent`/`resumeAgent` (and thus every mode) funnels through — so it is
    // structurally impossible to fan out a swarm and skip verification. It depends
    // on NEITHER the model calling a tool NOR a coordinator; only `autoLoop`
    // (default on) gates it. Fail-closed: needs_work → LEARN (distill skills /
    // memories / constraints) → RUN AGAIN with the gate's reasons → re-gate, to
    // `maxLoopAttempts`. A genuinely unavailable verifier is surfaced LOUDLY (never
    // a silent pass) and does not loop. `repoDir` is required to ground the gate.
    if (settings.autoLoop !== false && input.workspaceDir !== undefined) {
      const repoDir = input.workspaceDir
      const maxAttempts = settings.maxLoopAttempts ?? 3
      let attempt = 1
      while (true) {
        const freshNodes = yield* settleNewNodes(input.conversationId, nodeIdsBefore)
        // The SAME gate the coordinator tier uses (`gateOnce`) — one decision in
        // one place. The root pass aggregates the WHOLE run's sub-agent subtree
        // (every node this run created), the final sign-off over already-gated
        // coordinator pieces.
        const step = yield* gateOnce({
          task: input.mission ?? input.promptLabel,
          summary: result.finalText,
          repoDir,
          conversationId: input.conversationId,
          freshNodes,
          attempt,
          maxAttempts,
          autoDistill: settings.autoDistill !== false,
        })
        if (step.kind === "no-subagents") break
        yield* emitGate(input, step.event)
        if (step.kind !== "retry") break

        // RUN AGAIN — feed the gate's reasons back as the next turn, then re-gate.
        yield* persistTail([step.feedback])
        result = yield* runOneAttempt([...result.messages, step.feedback])
        attempt++
      }
    }

    yield* store.clearPending(input.conversationId).pipe(Effect.ignore)
    return result
  })

/**
 * Run the agent for one user prompt against a chosen config.
 *
 *   1. Load persisted history; append the new user message (persist now).
 *   2. Drive the loop with `messages = stored + user`. `@effect/ai`'s
 *      `LanguageModel` and the toolkit's handler Layer are taken from
 *      context (provided by the driver's composition root).
 *   3. Persist the new tail.
 *
 * (Provider-side context caching is a follow-up — it rode on the removed
 * `LlmCache` port and will return via `@effect/ai-google`'s `cachedContent`.)
 */
export const runAgent = <Tools extends Record<string, Tool.Any>, R>(
  config: AgentConfig<Tools>,
  conversationId: ConversationId,
  userPrompt: string,
  extraHooks?: AgentHooks<R>,
  workspaceDir?: string,
  /** The GENERAL model to pin for this run (`"<provider>:<modelId>"`). It seeds
   *  `RunContext.pinnedModels.general`; `code`/`fast` are pinned from settings
   *  (falling back to it) — so the whole fleet's models are frozen at run start
   *  and a mid-run `/model` / `:set` can't move a running fleet. Absent ⇒ the
   *  session's main model. */
  pinnedGeneral?: string,
) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const settingsStore = yield* SettingsStore
    const settings = yield* settingsStore.get()

    yield* store.ensure(conversationId, workspaceDir)

    // Load only the active window — the real messages after the latest handoff —
    // with the handoff summary standing in for everything folded away. `prefix` is
    // in-memory only (never persisted); the originals stay in the store.
    const checkpoint = yield* store.getLatestCheckpoint(conversationId)
    const active = yield* store.listActive(conversationId)
    const prefix: ReadonlyArray<AgentMessage> =
      checkpoint !== undefined ? [handoffToMessage(checkpoint.summary)] : []

    const userMsg: AgentMessage = { role: "user", content: userPrompt }
    const userPosition = yield* store.append(conversationId, userMsg)
    // Emit the user message through the hook stream the moment it's persisted,
    // carrying its absolute position — so the rail's user line rides the same keyed
    // event stream as everything else and reconciles with any optimistic line.
    if (extraHooks?.onUserMessage) {
      yield* extraHooks.onUserMessage({ turnIndex: 0, text: userPrompt, position: userPosition })
    }

    // Mark the turn in flight (best-effort): a daemon restart reads this to
    // auto-resume a turn interrupted by a crash. Cleared on completion in driveLoop.
    yield* store.markPending(conversationId, userPrompt).pipe(Effect.ignore)

    return yield* driveLoop({
      config,
      conversationId,
      messages: [...prefix, ...active, userMsg],
      extraHooks,
      workspaceDir,
      pinnedGeneral,
      promptLabel: userPrompt,
      mission: userPrompt,
    })
  })

/**
 * **Resume** an in-flight turn after a crash — re-drive the loop over the
 * persisted history WITHOUT appending a new user prompt (it's already the tail
 * the interrupted turn was answering). The daemon's restorability path: on
 * restart, every conversation with a pending marker is re-driven through this.
 *
 * Idempotency rides on incremental persistence — tool *results* already landed
 * are in the record, so the model continues past them; only work strictly
 * mid-tool-call re-attempts (bounded by the same step/budget caps). Clears the
 * pending marker on completion. Returns undefined when there's nothing to
 * resume (no active messages).
 */
export const resumeAgent = <Tools extends Record<string, Tool.Any>, R>(
  config: AgentConfig<Tools>,
  conversationId: ConversationId,
  extraHooks?: AgentHooks<R>,
  workspaceDir?: string,
  /** The GENERAL model to pin for this run (see {@link runAgent}). */
  pinnedGeneral?: string,
) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const checkpoint = yield* store.getLatestCheckpoint(conversationId)
    const active = yield* store.listActive(conversationId)
    // Nothing to resume (e.g. the marker outlived its messages) — clear + bail.
    if (active.length === 0) {
      yield* store.clearPending(conversationId).pipe(Effect.ignore)
      return undefined
    }
    const prefix: ReadonlyArray<AgentMessage> =
      checkpoint !== undefined ? [handoffToMessage(checkpoint.summary)] : []

    return yield* driveLoop({
      config,
      conversationId,
      messages: [...prefix, ...active],
      extraHooks,
      workspaceDir,
      pinnedGeneral,
      promptLabel: "[resume in-flight turn]",
      mission: undefined,
    })
  })
