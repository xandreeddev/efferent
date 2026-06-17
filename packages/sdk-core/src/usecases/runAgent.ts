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
    yield* store.append(conversationId, userMsg)

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

    // Persist exactly what the loop appended (model responses + any synthetic
    // correctives it injected) — reported explicitly by the loop, never
    // reconstructed by index arithmetic on the transformable buffer.
    for (const m of result.newTail) {
      yield* store.append(conversationId, m)
    }

    return result
  })
