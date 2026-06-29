import type { Tool } from "@effect/ai"
import { Effect } from "effect"
import type { ContextNodeId } from "../entities/AgentContext.js"
import type { AgentGateEvent, AgentHooks } from "../entities/AgentHooks.js"
import type { AgentMessage, ConversationId } from "../entities/Conversation.js"
<<<<<<< Updated upstream
||||||| Stash base
import { ContextTreeStore } from "../ports/ContextTreeStore.js"
=======
import { parseModel, contextWindowFor } from "../entities/Model.js"
import { ContextTreeStore } from "../ports/ContextTreeStore.js"
>>>>>>> Stashed changes
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
    const toolTimeoutMs =
      settings.toolTimeoutMs !== undefined ? settings.toolTimeoutMs : undefined

    const { provider, modelId } = parseModel(settings.model)
    const contextWindow = contextWindowFor(provider, modelId)

    // Persist each turn's tail the moment it lands (incremental persistence) — so
    // the session is restorable to its last completed turn, and a mid-run nav/state
    // read sees real history, not just memory. A persist failure is a defect (can't
    // safely continue without durable history).
    const persistTail = (msgs: ReadonlyArray<AgentMessage>) =>
      Effect.forEach(msgs, (m) => store.append(input.conversationId, m)).pipe(Effect.orDie)

    const autoHandoffPct =
      settings.autoHandoffPct !== undefined ? settings.autoHandoffPct : undefined

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
        ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
        ...(autoHandoffPct !== undefined ? { autoHandoffPct } : {}),
        contextWindow,
        ...(input.extraHooks !== undefined ? { hooks: input.extraHooks } : {}),
      }).pipe(
        Effect.locally(RunContextRef, {
          rootConversationId: input.conversationId,
          parentNodeId: null,
          depth: 0,
          tokenPool,
          prompt: input.config.prompt,
          contextWindow,
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
          ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
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

    // Snapshot node IDs before the run so the gate can distinguish new nodes.
    const beforeIds = new Set<ContextNodeId>(
      (yield* listTreeSafe(input.conversationId)).map((n) => n.id),
    )

    // ── First attempt ───────────────────────────────────────────────────────
    let result = yield* runOneAttempt(input.messages)

    // ── Mandatory swarm gate (auto-loop) ────────────────────────────────────
    // When the user says "execute everything now" we don't just trust the
    // model — we gate the objective through the Opus verifier. If the gate
    // says "needs_work" we distill learnings, append feedback, and retry
    // (bounded). This closes the loop on fleet quality.
    if (input.workspaceDir !== undefined && settings.autoLoop !== false) {
      const maxAttempts = settings.maxLoopAttempts ?? 3
<<<<<<< Updated upstream
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
||||||| Stash base
      let attempt = 1
      let gating = true
      while (gating) {
        const freshNodes = yield* settleNewNodes(input.conversationId, nodeIdsBefore)
        // No sub-agents this run → the gate is the swarm case only; nothing to do.
        if (freshNodes.length === 0) break
=======
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const fresh = yield* settleNewNodes(input.conversationId, beforeIds)
        // No sub-agents this run → nothing to gate; proceed normally.
        if (fresh.length === 0) break
>>>>>>> Stashed changes

<<<<<<< Updated upstream
        // RUN AGAIN — feed the gate's reasons back as the next turn, then re-gate.
        yield* persistTail([step.feedback])
        result = yield* runOneAttempt([...result.messages, step.feedback])
        attempt++
||||||| Stash base
        const filesChanged = Array.from(new Set(freshNodes.flatMap((n) => n.filesChanged)))
        const verdict = yield* verifier
          .gate({
            task: input.mission ?? input.promptLabel,
            summary: result.finalText,
            filesChanged,
            repoDir,
          })
          .pipe(Effect.either)

        if (Either.isLeft(verdict)) {
          // No verdict was possible (no `claude` / verifier error). Surface it —
          // never a silent pass — but don't spin on a broken gate.
          yield* emitGate(input, {
            verdict: "unavailable",
            reasons: [verdict.left.message],
            attempt,
            filesChanged,
          })
          break
        }

        const v = verdict.right
        if (v.verdict === "sound") {
          yield* emitGate(input, { verdict: "sound", reasons: [], attempt, filesChanged })
          break
        }

        // needs_work / blocked — the deliverable is NOT accepted as-is.
        yield* emitGate(input, { verdict: v.verdict, reasons: v.reasons, attempt, filesChanged })
        if (v.verdict === "blocked" || attempt >= maxAttempts) {
          gating = false
          break
        }

        // LEARN — mine + Opus-verify reusable skills/memories/constraints from this
        // failed attempt so they persist for future runs. Fail-soft by construction
        // (`runAutoDistill` never fails); gated by the same `autoDistill` knob.
        if (settings.autoDistill !== false) {
          yield* runAutoDistill({
            conversationId: input.conversationId,
            repoDir,
            existing: [],
          })
        }

        // RUN AGAIN — feed the gate's concrete reasons back as the next turn so the
        // swarm fixes them (not a blind re-send), then re-gate.
        const feedback: AgentMessage = {
          role: "user",
          content:
            "The independent verifier reviewed the swarm's work and it is NOT acceptable yet. " +
            "Address each issue below, then the work will be re-checked:\n" +
            v.reasons.map((r) => `- ${r}`).join("\n"),
        }
        yield* persistTail([feedback])
        result = yield* runOneAttempt([...result.messages, feedback])
        attempt++
=======
        const gateResult = yield* verifier
          .gate({
            task: input.mission ?? input.promptLabel,
            summary: result.finalText,
            filesChanged: fresh.flatMap((n) => n.filesChanged ?? []),
            repoDir: input.workspaceDir,
          })
          .pipe(
            Effect.map((v) => ({ ...v, available: true as const })),
            Effect.catchAll((e) =>
              Effect.succeed({
                verdict: "unavailable" as const,
                reasons: [e.message],
                available: false as const,
              }),
            ),
          )

        yield* emitGate(input, {
          attempt,
          maxAttempts,
          verdict: gateResult.verdict,
          reasons: gateResult.reasons,
          filesChanged: fresh.flatMap((n) => n.filesChanged ?? []),
        })

        if (gateResult.verdict === "sound") break
        if (gateResult.verdict === "blocked" || !gateResult.available) break
        if (attempt >= maxAttempts) break

        // needs_work → learn + retry
        if (gateResult.verdict === "needs_work") {
          const feedback =
            `The objective needs more work. ${gateResult.reasons.join("; ")}`
          yield* store.append(input.conversationId, {
            role: "user",
            content: feedback,
          })
          const active2 = yield* store.listActive(input.conversationId)
          const checkpoint2 = yield* store.getLatestCheckpoint(input.conversationId)
          const prefix2: ReadonlyArray<AgentMessage> =
            checkpoint2 !== undefined ? [handoffToMessage(checkpoint2.summary)] : []

          // Turn-boundary distillation: mine the just-finished conversation for
          // reusable lessons before the retry starts. Fail-soft — a distiller
          // error must never abort the gate-driven retry.
          if (settings.autoDistill !== false) {
            yield* runAutoDistill({
              conversationId: input.conversationId,
              repoDir: input.workspaceDir,
              existing: [],
            }).pipe(Effect.catchAll(() => Effect.void))
          }

          result = yield* runOneAttempt([...prefix2, ...active2])
          continue
        }

        // Any other verdict → stop
        break
>>>>>>> Stashed changes
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
