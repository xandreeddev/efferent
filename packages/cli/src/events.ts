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
  // Internal drain sentinel: offered by a mode AFTER its run completes so the
  // consumer fiber exits its loop having rendered everything before it —
  // deterministic, no sleep, no interruption racing a half-rendered event.
  // Never serialized to stdout/stderr/RPC.
  | { readonly type: "flush" }
  | { readonly type: "turn_start"; readonly turnIndex: number }
  | {
      readonly type: "assistant_message"
      readonly turnIndex: number
      readonly text: string
      readonly reasoning?: string
      readonly usage?: TokenUsage
      /** Set for sub-agent narration: the run's context-tree node id. Carries a
       *  core `ContextNodeId` deliberately widened to `string` — `AgentEvent` is
       *  the cross-mode WIRE vocabulary (serialized to JSONL in json mode), so the
       *  brand stays in the domain and the transport stays a plain string. */
      readonly nodeId?: string
    }
  | {
      readonly type: "tool_call_start"
      readonly turnIndex: number
      /** Provider tool-call id — pairs start↔end exactly (two same-named calls in
       *  one turn share a name but not an id). May be empty (provider omitted it). */
      readonly id: string
      readonly toolName: string
      readonly args: unknown
      /** Set for sub-agent inner calls: the run's context-tree node id. */
      readonly nodeId?: string
    }
  | {
      readonly type: "tool_call_end"
      readonly turnIndex: number
      readonly id: string
      readonly toolName: string
      readonly ok: boolean
      readonly result: unknown
      /** Set for sub-agent inner calls: the run's context-tree node id. */
      readonly nodeId?: string
    }
  | {
      readonly type: "subagent_start"
      readonly name: string
      readonly task: string
      readonly nodeId?: string
      /** The parent node's id — nests this run under its enclosing sub-agent. */
      readonly parentNodeId?: string
    }
  | {
      readonly type: "subagent_end"
      readonly name: string
      readonly nodeId?: string
      readonly ok: boolean
      readonly summary: string
      readonly filesChanged: ReadonlyArray<string>
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number }
    }
  | { readonly type: "skill_load"; readonly name: string }
  | {
      /** A helper-tier call ran inside the loop (e.g. a headroom middle-summary). */
      readonly type: "helper_usage"
      readonly role: "fast" | "cheap"
      readonly usage: TokenUsage
    }
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
      ...(event.subAgentNodeId !== undefined ? { nodeId: event.subAgentNodeId } : {}),
    }).pipe(Effect.asVoid),
  onBeforeToolCall: extraBeforeTool
    ? (event) =>
        Effect.gen(function* () {
          yield* Queue.offer(queue, {
            type: "tool_call_start",
            turnIndex: event.turnIndex,
            id: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            ...(event.subAgentNodeId !== undefined ? { nodeId: event.subAgentNodeId } : {}),
          })
          return yield* extraBeforeTool(event)
        })
    : (event) =>
        Queue.offer(queue, {
          type: "tool_call_start",
          turnIndex: event.turnIndex,
          id: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          ...(event.subAgentNodeId !== undefined ? { nodeId: event.subAgentNodeId } : {}),
        }).pipe(Effect.as({ action: "continue" as const })),
  onAfterToolCall: (event) =>
    Queue.offer(queue, {
      type: "tool_call_end",
      turnIndex: event.turnIndex,
      id: event.toolCallId,
      toolName: event.toolName,
      ok: event.ok,
      result: event.result,
      ...(event.subAgentNodeId !== undefined ? { nodeId: event.subAgentNodeId } : {}),
    }).pipe(Effect.asVoid),
  onSubAgentStart: (event) =>
    Queue.offer(queue, {
      type: "subagent_start",
      name: event.name,
      task: event.task,
      ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
      ...(event.parentNodeId !== undefined ? { parentNodeId: event.parentNodeId } : {}),
    }).pipe(Effect.asVoid),
  onSubAgentEnd: (event) =>
    Queue.offer(queue, {
      type: "subagent_end",
      name: event.name,
      ok: event.ok,
      summary: event.summary,
      filesChanged: event.filesChanged,
      ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
      ...(event.usage !== undefined ? { usage: event.usage } : {}),
    }).pipe(Effect.asVoid),
  onSkillLoad: (event) =>
    Queue.offer(queue, {
      type: "skill_load",
      name: event.name,
    }).pipe(Effect.asVoid),
  onHelperUsage: (event) =>
    Queue.offer(queue, {
      type: "helper_usage",
      role: event.role,
      usage: event.usage,
    }).pipe(Effect.asVoid),
  onAgentEnd: (event) =>
    Queue.offer(queue, {
      type: "agent_end",
      finalText: event.finalText,
      messages: event.messages,
    }).pipe(Effect.asVoid),
})
