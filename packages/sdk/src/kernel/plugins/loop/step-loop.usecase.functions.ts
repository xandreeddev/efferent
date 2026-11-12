import { Effect } from "effect"
import type { AssistantMessage } from "@xandreed/core/kernel"
import { ToolsNotRun } from "./loop.entity.js"

/** The model asked for tools and this cut runs none: the turn fails with what it asked for. */
export const toolsNotInThisCut = (message: AssistantMessage) =>
  Effect.fail(new ToolsNotRun({
    tools: message.toolCalls.map((call) => call.name),
    message: "the model asked for tools, and this loop runs none",
  }))
