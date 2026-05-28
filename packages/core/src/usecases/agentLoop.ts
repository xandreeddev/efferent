import { LanguageModel, Prompt, type Tool, type Toolkit } from "@effect/ai"
import { Effect } from "effect"
import type { AgentHooks } from "../entities/AgentHooks.js"
import type { AgentMessage, AgentResult } from "../entities/Conversation.js"
import {
  extractUsage,
  responseToAgentMessages,
  responseToolCalls,
  responseToolResults,
  toPromptMessages,
} from "./promptMapping.js"

/**
 * Provider-agnostic agent loop on `@effect/ai`. `@effect/ai` resolves the
 * tool calls within a single `generateText` (its handlers are our Effects),
 * but it does NOT iterate across turns — so iteration is ours: we re-invoke
 * with the growing message buffer until the model stops requesting tools or
 * `maxSteps` is hit.
 *
 * Each turn the response's content parts become the `AgentMessage` tail
 * (carrying `thought_signature` through `providerOptions`); the prior hook
 * vocabulary (`onTurnStart` / tool events / `onAssistantMessage`) is emitted
 * from the resolved response so existing drivers render unchanged.
 */

export interface RunAgentLoopInput<
  Tools extends Record<string, Tool.Any>,
  R,
> {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly toolkit: Toolkit.Toolkit<Tools>
  readonly maxSteps?: number
  readonly hooks?: AgentHooks<R>
}

export const runAgentLoop = <Tools extends Record<string, Tool.Any>, R>(
  input: RunAgentLoopInput<Tools, R>,
) =>
  Effect.gen(function* () {
    const hooks = input.hooks
    const maxSteps = input.maxSteps ?? 20
    let messages: ReadonlyArray<AgentMessage> = input.messages
    let finalText = ""
    let turnIndex = 0

    while (turnIndex < maxSteps) {
      if (hooks?.onTransformContext) {
        messages = yield* hooks.onTransformContext(messages)
      }
      if (hooks?.onTurnStart) {
        yield* hooks.onTurnStart({ turnIndex, messages })
      }

      const prompt = Prompt.make([
        { role: "system", content: input.system },
        ...toPromptMessages(messages),
      ] as never)

      const res = yield* LanguageModel.generateText({
        prompt,
        toolkit: input.toolkit,
      })

      const content = res.content as ReadonlyArray<unknown>
      messages = [...messages, ...responseToAgentMessages(content)]

      const text = res.text
      if (text.length > 0) finalText = text
      const toolCalls = responseToolCalls(content)

      // Re-emit the legacy hook vocabulary from the resolved response so
      // the CLI's execution tree / token gauge keep working unchanged.
      if (hooks?.onBeforeToolCall) {
        for (const tc of toolCalls) {
          yield* hooks.onBeforeToolCall({
            turnIndex,
            toolName: tc.toolName,
            args: tc.args,
          })
        }
      }
      if (hooks?.onAfterToolCall) {
        for (const tr of responseToolResults(content)) {
          yield* hooks.onAfterToolCall({
            turnIndex,
            toolName: tr.toolName,
            args: {},
            ok: tr.ok,
            result: tr.result,
          })
        }
      }
      if (hooks?.onAssistantMessage) {
        yield* hooks.onAssistantMessage({
          turnIndex,
          text,
          toolCalls,
          usage: extractUsage(res.usage, content),
        })
      }

      turnIndex++

      const wantsMore = res.finishReason === "tool-calls" && toolCalls.length > 0
      if (!wantsMore) break
      if (hooks?.onShouldStopAfterTurn) {
        const stop = yield* hooks.onShouldStopAfterTurn({
          turnIndex,
          finishReason: res.finishReason,
        })
        if (stop) break
      }
    }

    if (hooks?.onAgentEnd) {
      yield* hooks.onAgentEnd({ messages, finalText })
    }

    return { finalText, messages } satisfies AgentResult as AgentResult
  })
