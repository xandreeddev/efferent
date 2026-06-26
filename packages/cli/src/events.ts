import { Effect, Queue } from "effect"
import type { AgentHooks } from "@xandreed/sdk-core"

// The `AgentEvent` union now lives in `@xandreed/sdk-core` as a `Schema.Union`
// (`entities/AgentEvent.ts`) — both the loop's hooks and the daemon's HTTP/SSE
// wire need it. Re-exported here so the loop side (`makeEventHooks` + every
// `import … from "../../events.js"` consumer) is unchanged.
import { AgentEvent } from "@xandreed/sdk-core"
export { AgentEvent }

/**
 * Wire the agent loop's hooks to a **publish** sink — the single point every
 * `AgentEvent` flows through. `makeEventHooks` (Queue sink, for the legacy
 * single-consumer modes) and the daemon's per-session `EventLedger` (PubSub
 * fan-out) both build on this, so the event-construction logic lives once.
 * `extraBeforeTool` lets the caller layer additional `onBeforeToolCall` logic
 * (e.g. safety prompts) on top of plain emission.
 */
export const makeAgentEventHooks = <R = never>(
  publish: (event: AgentEvent) => Effect.Effect<void>,
  extraBeforeTool?: AgentHooks<R>["onBeforeToolCall"],
): AgentHooks<R> => ({
  onTurnStart: (event) =>
    publish({
      type: "turn_start",
      turnIndex: event.turnIndex,
    }),
  onUserMessage: (event) =>
    publish({
      type: "user_message",
      turnIndex: event.turnIndex,
      text: event.text,
      ...(event.position !== undefined ? { position: event.position } : {}),
      ...(event.subAgentNodeId !== undefined ? { nodeId: event.subAgentNodeId } : {}),
    }),
  onAssistantMessage: (event) =>
    publish({
      type: "assistant_message",
      turnIndex: event.turnIndex,
      text: event.text,
      ...(event.reasoning !== undefined && event.reasoning.length > 0
        ? { reasoning: event.reasoning }
        : {}),
      ...(event.usage !== undefined ? { usage: event.usage } : {}),
      ...(event.position !== undefined ? { position: event.position } : {}),
      ...(event.subAgentNodeId !== undefined ? { nodeId: event.subAgentNodeId } : {}),
      ...(event.subAgentRole !== undefined ? { subAgentRole: event.subAgentRole } : {}),
    }),
  onBeforeToolCall: extraBeforeTool
    ? (event) =>
        Effect.gen(function* () {
          yield* publish({
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
        publish({
          type: "tool_call_start",
          turnIndex: event.turnIndex,
          id: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          ...(event.subAgentNodeId !== undefined ? { nodeId: event.subAgentNodeId } : {}),
        }).pipe(Effect.as({ action: "continue" as const })),
  onAfterToolCall: (event) =>
    publish({
      type: "tool_call_end",
      turnIndex: event.turnIndex,
      id: event.toolCallId,
      toolName: event.toolName,
      ok: event.ok,
      result: event.result,
      ...(event.subAgentNodeId !== undefined ? { nodeId: event.subAgentNodeId } : {}),
    }),
  onSubAgentStart: (event) =>
    publish({
      type: "subagent_start",
      name: event.name,
      task: event.task,
      ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
      ...(event.parentNodeId !== undefined ? { parentNodeId: event.parentNodeId } : {}),
      ...(event.role !== undefined ? { role: event.role } : {}),
    }),
  onSubAgentEnd: (event) =>
    publish({
      type: "subagent_end",
      name: event.name,
      ok: event.ok,
      summary: event.summary,
      filesChanged: event.filesChanged,
      ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
      ...(event.usage !== undefined ? { usage: event.usage } : {}),
    }),
  onSkillLoad: (event) =>
    publish({
      type: "skill_load",
      name: event.name,
    }),
  onHelperUsage: (event) =>
    publish({
      type: "helper_usage",
      role: event.role,
      usage: event.usage,
    }),
  onAgentEnd: (event) =>
    publish({
      type: "agent_end",
      finalText: event.finalText,
      messages: event.messages,
    }),
})

/**
 * Wire the agent loop's hooks to a queue. Modes consume the queue. A thin
 * adapter over {@link makeAgentEventHooks} with a Queue sink.
 */
export const makeEventHooks = <R = never>(
  queue: Queue.Queue<AgentEvent>,
  extraBeforeTool?: AgentHooks<R>["onBeforeToolCall"],
): AgentHooks<R> =>
  makeAgentEventHooks<R>(
    (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
    extraBeforeTool,
  )
