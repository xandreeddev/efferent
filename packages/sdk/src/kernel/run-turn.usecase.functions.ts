import { Effect } from "effect"
import type { Exit } from "effect"
import { liveEvent, outcomeOf, recordedEvent, ToolsNotRun, turnEnded } from "@xandreed/core/kernel"
import type { Agent, AssistantMessage, EventDraft, OpenSession, Reply } from "@xandreed/core/kernel"

/**
 * Append an event to the session's journal, then publish it live.
 *
 * @public
 */
export const record = (agent: Agent, session: OpenSession, event: EventDraft) =>
  session.record(event).pipe(Effect.flatMap((stored) => agent.events.publish(recordedEvent(session, stored))))

/** Record each event, in order. */
export const recordEach = (agent: Agent, session: OpenSession, events: ReadonlyArray<EventDraft>) =>
  Effect.forEach(events, (event) => record(agent, session, event), { concurrency: 1, discard: true })

/**
 * Publish an event live and store nothing.
 *
 * @public
 */
export const emit = (agent: Agent, session: OpenSession, event: EventDraft) => agent.events.publish(liveEvent(session, event))

/** Record `core.turn.ended` with the outcome of the turn, then close the session, whether or not the record was stored. */
export const endTurn = <E>(agent: Agent, session: OpenSession, exit: Exit.Exit<Reply, E>) =>
  record(agent, session, turnEnded(outcomeOf(exit))).pipe(
    Effect.exit,
    Effect.flatMap((recorded) => Effect.andThen(agent.sessions.close(session), recorded)),
  )

/** The model asked for tools and this agent runs none: the turn fails with what it asked for. */
export const toolsNotInThisCut = (message: AssistantMessage) =>
  Effect.fail(new ToolsNotRun({
    reason: "ToolsNotInThisCut",
    tools: message.toolCalls.map((call) => call.name),
    message: "the model asked for tools, and this agent runs none",
  }))
