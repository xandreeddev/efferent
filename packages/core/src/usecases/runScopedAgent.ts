import { Effect, Ref } from "effect"
import type { AgentHooks } from "../entities/AgentHooks.js"
import type { AgentMessage } from "../entities/Conversation.js"
import type { ScopedAgentConfig } from "../entities/ScopedAgent.js"
import { FileSystem } from "../ports/FileSystem.js"
import { Llm, LlmError } from "../ports/Llm.js"
import { Shell } from "../ports/Shell.js"
import { runAgentLoop } from "./agentLoop.js"
import { buildScopedCodingTools } from "./buildScopedCodingTools.js"

export interface ScopedAgentResult {
  /** Final assistant message — the sub-agent's one-line summary of what changed. */
  readonly summary: string
  /** Files the sub-agent wrote, as reported by write_file / edit_file successes. */
  readonly filesChanged: ReadonlyArray<string>
}

/**
 * Run a scoped sub-agent on a focused task.
 *
 * Ephemeral by design — calls `runAgentLoop` directly, NOT `runAgent`,
 * so we skip:
 *   - `ConversationStore.append` (no persistence; no DB churn per
 *     delegation)
 *   - `LlmCache.snapshot` (no provider-side cache for the sub-agent's
 *     ephemeral conversation)
 *
 * The sub-agent gets a fresh context window:
 *   - System prompt = the SCOPE.md-driven prompt baked into `config`
 *   - Messages     = `[{ role: "user", content: task }]` — no prior history
 *   - Tools        = `buildScopedCodingTools({ rootDir, displayRoot })`
 *
 * File changes are captured via a local `onAfterToolCall` hook that
 * watches successful `write_file`/`edit_file` calls — no parent-facing
 * hook fires, so the parent's TUI sees nothing while the sub-agent
 * runs (one opaque tool pill).
 */
export const runScopedAgent = (
  config: ScopedAgentConfig,
  task: string,
): Effect.Effect<ScopedAgentResult, LlmError, FileSystem | Shell | Llm> =>
  Effect.gen(function* () {
    const filesChangedRef = yield* Ref.make<ReadonlyArray<string>>([])
    const tools = buildScopedCodingTools({
      rootDir: config.rootDir,
      displayRoot: config.displayRoot,
    })

    const localHooks: AgentHooks<FileSystem | Shell> = {
      onAfterToolCall: (event) =>
        Effect.gen(function* () {
          if (!event.ok) return
          if (event.toolName !== "write_file" && event.toolName !== "edit_file") {
            return
          }
          const result = event.result
          if (typeof result !== "object" || result === null) return
          const path = (result as { path?: unknown }).path
          if (typeof path !== "string") return
          yield* Ref.update(filesChangedRef, (arr) =>
            arr.includes(path) ? arr : [...arr, path],
          )
        }),
    }

    const initialMessages: ReadonlyArray<AgentMessage> = [
      { role: "user", content: task },
    ]

    const loopResult = yield* runAgentLoop({
      system: config.systemPrompt,
      messages: initialMessages,
      tools,
      hooks: localHooks,
    })

    const filesChanged = yield* Ref.get(filesChangedRef)
    return {
      summary: loopResult.finalText,
      filesChanged,
    }
  })
