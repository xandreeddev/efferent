import { Tool, Toolkit } from "@effect/ai"
import { Failure } from "@xandreed/core"
import { UiOutputProposal, UiOutputReceipt } from "./domain/ui-output.entity.js"

export const RenderComponent = Tool.make("render_component", {
  description: "Publish one complete, evidence-backed component using an exact approved release. Returns its durable canvas revision and chat anchor. Use only catalog props and evidence IDs returned by domain tools. Never emit code, HTML or guessed race facts. Reuse operationId only to retry the identical call. Plain answers need no component.",
  parameters: UiOutputProposal.fields,
  success: UiOutputReceipt,
  failure: Failure,
  failureMode: "return",
})
export const uiOutputToolkit = Toolkit.make(RenderComponent)
