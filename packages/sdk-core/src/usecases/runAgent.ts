import type { Tool } from "@effect/ai"
import { Effect } from "effect"
import type { AgentHooks } from "../entities/AgentHooks.js"
import type { AgentMessage, ConversationId } from "../entities/Conversation.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { SettingsStore } from "../ports/SettingsStore.js"
import { recordError } from "../telemetry/metrics.js"
import { agentSpanAttributes, runSpanName } from "../telemetry/spanNames.js"
import { runAgentLoop } from "./agentLoop.js"
import { handoffToMessage } from "./promptMapping.js"
import { RunContextRef } from "./runContext.js"
import { DEFAULT_SUB_AGENT_TOKEN_BUDGET, makeTokenPool } from "./tokenBudget.js"
import type { AgentConfig } from "./agentConfig.js"

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
  /** Per-fleet pinned main model (`"<provider>:<modelId>"`), seeded onto
   *  `RunContext.modelOverride` so the router uses THIS fleet's model rather than
   *  the global default — the structural fix for "changing the default breaks a
   *  running fleet". Absent ⇒ the session's main model. */
  modelOverride?: string,
) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const settingsStore = yield* SettingsStore
    const settings = yield* settingsStore.get()

    yield* store.ensure(conversationId, workspaceDir)

    // The model loads only the active window — the real messages after the
    // latest handoff — with the handoff summary standing in for everything
    // folded away. `prefix` is in-memory only (never persisted); the original
    // messages stay in the store (browsable via `list`).
    const checkpoint = yield* store.getLatestCheckpoint(conversationId)
    const active = yield* store.listActive(conversationId)
    const prefix: ReadonlyArray<AgentMessage> =
      checkpoint !== undefined ? [handoffToMessage(checkpoint.summary)] : []

    const userMsg: AgentMessage = { role: "user", content: userPrompt }
    const userPosition = yield* store.append(conversationId, userMsg)
    // Emit the user message through the hook stream the moment it's persisted,
    // carrying its absolute position — so the rail's user line rides the same
    // keyed event stream as everything else (no client-side reconstruction) and
    // reconciles with any optimistic line by position.
    if (extraHooks?.onUserMessage) {
      yield* extraHooks.onUserMessage({ turnIndex: 0, text: userPrompt, position: userPosition })
    }

    // Mark the turn in flight (best-effort): a daemon restart reads this to
    // auto-resume a turn interrupted by a crash. Cleared on completion below.
    yield* store.markPending(conversationId, userPrompt).pipe(Effect.ignore)

    // Persist each turn's tail the moment it lands (incremental persistence) —
    // so the session is restorable to its last completed turn, and a mid-run
    // nav/state read sees real history, not just what's in memory. A persist
    // failure is a defect (can't safely continue without durable history),
    // mirroring the old end-of-run append's failure semantics.
    const persistTail = (msgs: ReadonlyArray<AgentMessage>) =>
      Effect.forEach(msgs, (m) => store.append(conversationId, m)).pipe(Effect.orDie)

    // One shared spend pool for every sub-agent this turn may spawn — fresh
    // per top-level run, so a prior turn's spend never starves this one.
    const tokenPool = yield* makeTokenPool(
      settings.subAgentTokenBudget ?? DEFAULT_SUB_AGENT_TOKEN_BUDGET,
    )

    const toolResultMaxChars =
      settings.toolResultMaxTokens !== undefined ? settings.toolResultMaxTokens * 4 : undefined

    const result = yield* runAgentLoop({
      system: config.prompt.text,
      messages: [...prefix, ...active, userMsg],
      toolkit: config.toolkit,
      maxSteps: settings.maxSteps,
      onTail: persistTail,
      ...(toolResultMaxChars !== undefined ? { toolResultMaxChars } : {}),
      ...(extraHooks !== undefined ? { hooks: extraHooks } : {}),
    }).pipe(
      // Seed the run context so the generic `run_agent` tool tags spawned
      // context-tree nodes with this conversation (and a null parent — top-level
      // spawns are tree roots; each spawn re-seeds for its own children).
      Effect.locally(RunContextRef, {
        rootConversationId: conversationId,
        parentNodeId: null,
        depth: 0,
        tokenPool,
        prompt: config.prompt,
        ...(settings.subAgentMaxSteps !== undefined
          ? { subAgentMaxSteps: settings.subAgentMaxSteps }
          : {}),
        ...(toolResultMaxChars !== undefined ? { toolResultMaxChars } : {}),
        // The agent's compression policy rides RunContext so the whole sub-agent
        // subtree inherits it; the loop falls back to Compaction.default() when absent.
        ...(config.compression !== undefined ? { compression: config.compression } : {}),
        ...(modelOverride !== undefined ? { modelOverride } : {}),
      }),
      // A failed run marks its span errored (the conversation drill-down lists
      // failed messages; RED reads `agent_errors_total{kind="run"}`), then
      // re-raises — observe-only, the caller's failure path is unchanged.
      Effect.tapErrorCause(() =>
        Effect.annotateCurrentSpan({ error: true }).pipe(
          Effect.zipRight(recordError("run", "failed")),
        ),
      ),
      Effect.withSpan(runSpanName(), {
        attributes: {
          ...agentSpanAttributes("run", conversationId),
          "agent.model": settings.model,
          // A short, readable anchor so the per-conversation trace list is
          // scannable in Grafana (full prompt lives in the persisted message).
          "agent.prompt": userPrompt.slice(0, 120),
        },
      }),
      Effect.annotateLogs({ conversationId }),
    )

    // The loop already persisted each turn's tail as it landed (via
    // `onTail` → `persistTail`), so there's no end-of-run bulk append. Clear
    // the in-flight marker now that the turn completed (best-effort).
    yield* store.clearPending(conversationId).pipe(Effect.ignore)

    return result
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
  /** Per-fleet pinned main model (see {@link runAgent}). */
  modelOverride?: string,
) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const settingsStore = yield* SettingsStore
    const settings = yield* settingsStore.get()

    yield* store.ensure(conversationId, workspaceDir)

    const checkpoint = yield* store.getLatestCheckpoint(conversationId)
    const active = yield* store.listActive(conversationId)
    // Nothing to resume (e.g. the marker outlived its messages) — clear + bail.
    if (active.length === 0) {
      yield* store.clearPending(conversationId).pipe(Effect.ignore)
      return undefined
    }
    const prefix: ReadonlyArray<AgentMessage> =
      checkpoint !== undefined ? [handoffToMessage(checkpoint.summary)] : []

    const tokenPool = yield* makeTokenPool(
      settings.subAgentTokenBudget ?? DEFAULT_SUB_AGENT_TOKEN_BUDGET,
    )
    const toolResultMaxChars =
      settings.toolResultMaxTokens !== undefined ? settings.toolResultMaxTokens * 4 : undefined

    const persistTail = (msgs: ReadonlyArray<AgentMessage>) =>
      Effect.forEach(msgs, (m) => store.append(conversationId, m)).pipe(Effect.orDie)

    const result = yield* runAgentLoop({
      system: config.prompt.text,
      messages: [...prefix, ...active],
      toolkit: config.toolkit,
      maxSteps: settings.maxSteps,
      onTail: persistTail,
      ...(toolResultMaxChars !== undefined ? { toolResultMaxChars } : {}),
      ...(extraHooks !== undefined ? { hooks: extraHooks } : {}),
    }).pipe(
      Effect.locally(RunContextRef, {
        rootConversationId: conversationId,
        parentNodeId: null,
        depth: 0,
        tokenPool,
        prompt: config.prompt,
        ...(settings.subAgentMaxSteps !== undefined
          ? { subAgentMaxSteps: settings.subAgentMaxSteps }
          : {}),
        ...(toolResultMaxChars !== undefined ? { toolResultMaxChars } : {}),
        ...(config.compression !== undefined ? { compression: config.compression } : {}),
        ...(modelOverride !== undefined ? { modelOverride } : {}),
      }),
      Effect.tapErrorCause(() =>
        Effect.annotateCurrentSpan({ error: true }).pipe(
          Effect.zipRight(recordError("run", "failed")),
        ),
      ),
      Effect.withSpan(runSpanName(), {
        attributes: {
          ...agentSpanAttributes("run", conversationId),
          "agent.model": settings.model,
          "agent.prompt": "[resume in-flight turn]",
        },
      }),
      Effect.annotateLogs({ conversationId }),
    )

    yield* store.clearPending(conversationId).pipe(Effect.ignore)
    return result
  })
