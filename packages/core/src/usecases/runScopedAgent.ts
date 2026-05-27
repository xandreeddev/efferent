import { Effect, Ref } from "effect"
import type {
  AgentAfterToolCallEvent,
  AgentHooks,
} from "../entities/AgentHooks.js"
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
 * When `parentHooks` is provided, three things happen:
 *   - `onSubAgentStart` fires before the inner loop, `onSubAgentEnd`
 *     fires after (with files changed + ok flag).
 *   - The sub-agent's inner tool calls fire the parent's
 *     `onBeforeToolCall` / `onAfterToolCall`, so the TUI's side pane
 *     can show what the sub-agent is doing live. We deliberately do
 *     NOT forward `onTurnStart`/`onAssistantMessage`/`onAgentEnd` —
 *     those belong to the outer loop only.
 *   - `onSubAgentStart`/`onSubAgentEnd`/`onSkillLoad` also pass through
 *     so nested sub-agents stay visible.
 */
export const runScopedAgent = <R = never>(
  config: ScopedAgentConfig,
  task: string,
  parentHooks?: AgentHooks<R>,
): Effect.Effect<ScopedAgentResult, LlmError, FileSystem | Shell | Llm | R> =>
  Effect.gen(function* () {
    if (parentHooks?.onSubAgentStart) {
      yield* parentHooks.onSubAgentStart({ name: config.name, task })
    }

    const filesChangedRef = yield* Ref.make<ReadonlyArray<string>>([])
    const tools = buildScopedCodingTools({
      rootDir: config.rootDir,
      displayRoot: config.displayRoot,
    })

    const trackFiles = (event: AgentAfterToolCallEvent) =>
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
      })

    const parentAfter = parentHooks?.onAfterToolCall
    const innerHooks: AgentHooks<R | FileSystem | Shell> = {
      ...(parentHooks?.onBeforeToolCall !== undefined
        ? { onBeforeToolCall: parentHooks.onBeforeToolCall }
        : {}),
      onAfterToolCall:
        parentAfter !== undefined
          ? (e) =>
              Effect.gen(function* () {
                yield* parentAfter(e)
                yield* trackFiles(e)
              })
          : trackFiles,
      ...(parentHooks?.onSubAgentStart !== undefined
        ? { onSubAgentStart: parentHooks.onSubAgentStart }
        : {}),
      ...(parentHooks?.onSubAgentEnd !== undefined
        ? { onSubAgentEnd: parentHooks.onSubAgentEnd }
        : {}),
      ...(parentHooks?.onSkillLoad !== undefined
        ? { onSkillLoad: parentHooks.onSkillLoad }
        : {}),
    }

    const initialMessages: ReadonlyArray<AgentMessage> = [
      { role: "user", content: task },
    ]

    const emitEnd = (ok: boolean, summary: string) =>
      parentHooks?.onSubAgentEnd !== undefined
        ? Effect.gen(function* () {
            const filesChanged = yield* Ref.get(filesChangedRef)
            yield* parentHooks.onSubAgentEnd!({
              name: config.name,
              ok,
              summary,
              filesChanged,
            })
          })
        : Effect.void

    return yield* runAgentLoop({
      system: config.systemPrompt,
      messages: initialMessages,
      tools,
      hooks: innerHooks,
    }).pipe(
      Effect.tap((res) => emitEnd(true, res.finalText)),
      Effect.tapError(() => emitEnd(false, "")),
      Effect.flatMap((res) =>
        Effect.gen(function* () {
          const filesChanged = yield* Ref.get(filesChangedRef)
          return {
            summary: res.finalText,
            filesChanged,
          } satisfies ScopedAgentResult
        }),
      ),
    )
  })
