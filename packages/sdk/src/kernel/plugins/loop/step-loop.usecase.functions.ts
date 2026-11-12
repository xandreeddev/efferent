import { Effect } from "effect"
import { resolveRequest } from "../../contracts/loop/request.entity.functions.js"
import type { AssistantMessage, OpenSession } from "@xandreed/core/kernel"
import type { ModelRequest } from "../../contracts/loop/request.entity.js"
import { EmptyMessage, ToolsNotRun } from "./loop.entity.js"

/**
 * The request memory built, with its pointers turned back into the exact
 * messages the model is sent. A pointer that names no earlier record
 * bearing a message refuses the request, before anything of it is stored.
 */
export const resolve = (session: OpenSession, request: ModelRequest) =>
  Effect.flatMap(session.journal, (journal) => Effect.fromResult(resolveRequest(journal, request)))

/** The model asked for tools and this cut runs none: the turn fails with what it asked for. */
export const toolsNotInThisCut = (message: AssistantMessage) =>
  Effect.fail(new ToolsNotRun({
    tools: message.toolCalls.map((call) => call.name),
    message: "the model asked for tools, and this loop runs none",
  }))

/** Whether a message holds no text: a turn needs some. */
export const isEmpty = (message: string): boolean => message.trim().length === 0

/** A message of no text is refused before the turn opens. */
export const emptyMessage = Effect.fail(new EmptyMessage({ message: "a turn needs a message that is not empty" }))
