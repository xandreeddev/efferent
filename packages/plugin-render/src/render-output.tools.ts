import { Tool, Toolkit } from "effect/ai"
import { Failure } from "@xandreed/core"
import { UiOutputProposal, UiOutputReceipt } from "./domain/render-output.entity.js"

/** @public */
export const RenderComponent = Tool.make("render_component", {
  description: "Publish one complete, evidence-backed component using an exact approved release. Returns its durable canvas revision and chat anchor. Use only catalog props and evidence IDs returned by domain tools. Never emit code, HTML or guessed facts. Reuse operationId only to retry the identical call. Plain answers need no component.",
  parameters: UiOutputProposal,
  success: UiOutputReceipt,
  failure: Failure,
  failureMode: "return",
})
/** @public */
export const uiOutputToolkit = Toolkit.make(RenderComponent)
