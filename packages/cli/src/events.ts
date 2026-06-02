import { Effect, Queue } from "effect"
import type {
  AgentHooks,
  AgentMessage,
  TokenUsage,
} from "@efferent/core"

/**
 * Mode-agnostic event vocabulary the loop emits via hooks. Each mode
 * (tui / print / json / rpc) subscribes to the same queue and renders
 * accordingly. Modeled loosely on Pi's AgentEventSink.
 */
export type AgentEvent =
  | { readonly type: "turn_start"; readonly turnIndex: number }
  | {
      readonly type: "assistant_message"
      readonly turnIndex: number
      readonly text: string
      readonly reasoning?: string
      readonly usage?: TokenUsage
    }
  | {
      readonly type: "tool_call_start"
      readonly turnIndex: number
      readonly toolName: string
      readonly args: unknown
    }
  | {
      readonly type: "tool_call_end"
      readonly turnIndex: number
      readonly toolName: string
      readonly ok: boolean
      readonly result: unknown
    }
  | {
      readonly type: "subagent_start"
      readonly name: string
      readonly task: string
    }
  | {
      readonly type: "subagent_end"
      readonly name: string
      readonly ok: boolean
      readonly summary: string
      readonly filesChanged: ReadonlyArray<string>
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number }
    }
  | { readonly type: "skill_load"; readonly name: string }
  | {
      readonly type: "agent_end"
      readonly finalText: string
      readonly messages: ReadonlyArray<AgentMessage>
    }
  | { readonly type: "error"; readonly message: string }

/**
 * Wire the agent loop's hooks to a queue. Modes consume the queue.
 * `extraBeforeTool` lets the caller layer additional `onBeforeToolCall`
 * logic (e.g. safety prompts) on top of plain event emission.
 */
export const makeEventHooks = <R = never>(
  queue: Queue.Queue<AgentEvent>,
  extraBeforeTool?: AgentHooks<R>["onBeforeToolCall"],
): AgentHooks<R> => ({
  onTurnStart: (event) =>
    Queue.offer(queue, {
      type: "turn_start",
      turnIndex: event.turnIndex,
    }).pipe(Effect.asVoid),
  onAssistantMessage: (event) =>
    Queue.offer(queue, {
      type: "assistant_message",
      turnIndex: event.turnIndex,
      text: event.text,
      ...(event.reasoning !== undefined && event.reasoning.length > 0
        ? { reasoning: event.reasoning }
        : {}),
      ...(event.usage !== undefined ? { usage: event.usage } : {}),
    }).pipe(Effect.asVoid),
  onBeforeToolCall: extraBeforeTool
    ? (event) =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, {
            type: "tool_call_start",
            turnIndex: event.turnIndex,
            toolName: event.toolName,
            args: event.args,
          })
          return yield* extraBeforeTool(event)
        })
    : (event) =>
        Queue.offer(queue, {
          type: "tool_call_start",
          turnIndex: event.turnIndex,
          toolName: event.toolName,
          args: event.args,
        }).pipe(Effect.as({ action: "continue" as const })),
  onAfterToolCall: (event) =>
    Queue.offer(queue, {
      type: "tool_call_end",
      turnIndex: event.turnIndex,
      toolName: event.toolName,
      ok: event.ok,
      result: event.result,
    }).pipe(Effect.asVoid),
  onSubAgentStart: (event) =>
    Queue.offer(queue, {
      type: "subagent_start",
      name: event.name,
      task: event.task,
    }).pipe(Effect.asVoid),
  onSubAgentEnd: (event) =>
    Queue.offer(queue, {
      type: "subagent_end",
      name: event.name,
      ok: event.ok,
      summary: event.summary,
      filesChanged: event.filesChanged,
      ...(event.usage !== undefined ? { usage: event.usage } : {}),
    }).pipe(Effect.asVoid),
  onSkillLoad: (event) =>
    Queue.offer(queue, {
      type: "skill_load",
      name: event.name,
    }).pipe(Effect.asVoid),
  onAgentEnd: (event) =>
    Queue.offer(queue, {
      type: "agent_end",
      finalText: event.finalText,
      messages: event.messages,
    }).pipe(Effect.asVoid),
})
