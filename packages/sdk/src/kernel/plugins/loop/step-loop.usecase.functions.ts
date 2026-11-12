import { Effect } from "effect"
import { resolveRequest } from "@xandreed/core/kernel"
import type { AssistantMessage, ModelRequest, OpenSession } from "@xandreed/core/kernel"
import { ToolsNotRun } from "./loop.entity.js"

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
