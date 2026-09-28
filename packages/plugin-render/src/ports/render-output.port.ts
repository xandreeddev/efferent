import { Context } from "effect"
import type { Effect } from "effect"
import type { uiOutputToolkit } from "../render-output.tools.js"
import type { UiOutputError, UiOutputProposal, UiOutputReceipt, UiOutputScope } from "../domain/render-output.entity.js"

/** Exact release lookup + prop schema + evidence/permissions. Fail closed. */
export class UiOutputAdmission extends Context.Service<UiOutputAdmission, {
  readonly validate: (scope: UiOutputScope, proposal: UiOutputProposal) => Effect.Effect<void, UiOutputError>
}>()("efferent/ui/OutputAdmission") {}

/** A transaction must check ownership/fence, deduplicate operationId, persist
 * the immutable revision AND its journal/outbox event before returning.
 * Reusing an operationId with different content must fail with conflict.
 * Streaming hosts tail this journal; they never send speculative proposals. */
export class UiOutputJournal extends Context.Service<UiOutputJournal, {
  readonly commit: (scope: UiOutputScope, proposal: UiOutputProposal) => Effect.Effect<UiOutputReceipt, UiOutputError>
}>()("efferent/ui/OutputJournal") {}

export class UiOutputContext extends Context.Service<UiOutputContext, UiOutputScope>()("efferent/ui/OutputContext") {}

export class UiOutput extends Context.Service<UiOutput, {
  readonly emit: (proposal: UiOutputProposal) => Effect.Effect<UiOutputReceipt, UiOutputError>
}>()("efferent/ui/Output") {}

/** Separate from AgentTools so a UI plugin composes with domain tool plugins. */
export class UiOutputTools extends Context.Service<UiOutputTools, {
  readonly toolkit: typeof uiOutputToolkit
}>()("efferent/ui/OutputTools") {}
