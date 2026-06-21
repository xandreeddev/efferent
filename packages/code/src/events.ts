import { Effect, Queue } from "effect"
import type { AgentHooks } from "@xandreed/sdk-core"

// The `AgentEvent` union now lives in `@xandreed/sdk-core` as a `Schema.Union`
// (`entities/AgentEvent.ts`) — both the loop's hooks and the daemon's HTTP/SSE
// wire need it. Re-exported here so the loop side (`makeEventHooks` + every
// `import … from "../../events.js"` consumer) is unchanged.
import { AgentEvent } from "@xandreed/sdk-core"
export { AgentEvent }

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
