import type { Tool } from "@effect/ai"
import { Duration, Effect } from "effect"
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
 * Detect whether the conversation ends mid-tool-call: the last message is an
 * assistant with tool-call parts and no matching tool-result follows it. This
 * happens when a crash occurred after the model emitted the call but before the
 * handler finished and persisted the result. On resume the model would otherwise
 * see an unmatched call and retry it — dangerous for non-idempotent operations.
 */
const lastMessageHasPendingToolCalls = (
  msgs: ReadonlyArray<AgentMessage>,
): boolean => {
  const last = msgs[msgs.length - 1]
  if (last === undefined || last.role !== "assistant") return false
  const toolCalls = (last.content as ReadonlyArray<{ type?: string }>).filter(
    (p) => p.type === "tool-call",
  )
  return toolCalls.length > 0
}

/**
 * Synthetic message injected on resume when the last turn was interrupted
 * mid-tool-call. Tells the model the result is unknown and it must verify
 * state before retrying — prevents blind re-execution of non-idempotent ops.
 */
const interruptedToolCallMessage = (toolNames: ReadonlyArray<string>): AgentMessage => ({
  role: "user",
  content:
    `[System note: the previous turn was interrupted while executing ` +
    `${toolNames.join(", ")}. The result of that tool call is unknown — ` +
    `it may have partially completed, fully completed, or not run at all. ` +
    `Before calling the same tool again, verify the current state of the ` +
    `workspace rather than assuming the previous call failed.]`,
})

/**
 * Persistence retry policy: 3 attempts with exponential backoff (200ms → 400ms → 800ms).
 * A transient DB hiccup (SQLite lock, network blip to Postgres) should not kill a
 * running fleet — we retry, then continue in-memory with the conversation marked
 * "at risk" so the human knows durability is compromised.
 */
const PERSIST_RETRIES = 3
const PERSIST_BASE_MS = 200

const persistWithRetry = <E>(
  eff: Effect.Effect<ReadonlyArray<number>, E>,
): Effect.Effect<
  { positions: ReadonlyArray<number>; atRisk: boolean },
  never
> =>
  Effect.gen(function* () {
    let lastError: unknown
    for (let i = 0; i < PERSIST_RETRIES; i++) {
      const result = yield* eff.pipe(
        Effect.map((positions) => ({ positions, atRisk: false as const })),
        Effect.catchAll((e) => {
          lastError = e
          return Effect.succeed({ positions: [] as ReadonlyArray<number>, atRisk: true as const })
        }),
      )
      if (!result.atRisk) return result
      if (i < PERSIST_RETRIES - 1) {
        yield* Effect.sleep(Duration.millis(PERSIST_BASE_MS * 2 ** i))
      }
    }
    yield* Effect.logWarning(
      `persist failed after ${PERSIST_RETRIES} attempts — continuing in-memory. ` +
        `Error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
    return { positions: [] as ReadonlyArray<number>, atRisk: true }
  })

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
    // read sees real history, not just memory. Retries on transient failure; if
    // the store stays down we continue in-memory and warn rather than killing the fleet.
    const persistTail = (msgs: ReadonlyArray<AgentMessage>) =>
      persistWithRetry(Effect.forEach(msgs, (m) => store.append(input.conversationId, m))).pipe(
        Effect.tap(({ atRisk }) => {
          if (atRisk) {
            return Effect.logWarning(
              `conversation ${input.conversationId} is running AT RISK — ` +
                `turn tail was not persisted to the store. A crash now would lose ` +
                `${msgs.length} message(s) from this turn.`,
            )
          }
          return Effect.void
        }),
        Effect.map(({ positions }) => positions),
      )

    const result = yield* runAgentLoop({
      system: input.config.prompt.text,
      messages: input.messages,
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
        ...(toolResultMaxChars !== undefined ? { toolResultMaxChars } : {}),
        ...(input.config.compression !== undefined ? { compression: input.config.compression } : {}),
        pinnedModels: {
          general: input.pinnedGeneral ?? settings.model,
          code: settings.codeModel ?? input.pinnedGeneral ?? settings.model,
          fast: settings.fastModel ?? input.pinnedGeneral ?? settings.model,
        },
        ...(input.mission !== undefined ? { mission: input.mission } : {}),
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

    const allMessages: ReadonlyArray<AgentMessage> = [...prefix, ...active]

    // Crash-recovery safety: if the last turn was interrupted mid-tool-call,
    // inject a synthetic user message warning the model not to blindly retry.
    const resumeMessages = lastMessageHasPendingToolCalls(allMessages)
      ? (() => {
          const last = allMessages[allMessages.length - 1]!
          const toolNames = (last.content as ReadonlyArray<{ type?: string; toolName?: string }>)
            .filter((p) => p.type === "tool-call")
            .map((p) => p.toolName ?? "unknown")
          return [...allMessages, interruptedToolCallMessage(toolNames)]
        })()
      : allMessages

    return yield* driveLoop({
      config,
      conversationId,
      messages: resumeMessages,
      extraHooks,
      workspaceDir,
      pinnedGeneral,
      promptLabel: "[resume in-flight turn]",
      mission: undefined,
    })
  })
