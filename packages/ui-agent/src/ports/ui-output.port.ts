import { Context } from "effect"
import type { Effect } from "effect"
import type { uiOutputToolkit } from "../ui-output.tools.js"
import type { UiOutputError, UiOutputProposal, UiOutputReceipt, UiOutputScope } from "../domain/ui-output.entity.js"

/** Exact release lookup + prop schema + evidence/permissions. Fail closed. */
export class UiOutputAdmission extends Context.Tag("efferent/ui/OutputAdmission")<UiOutputAdmission, {
  readonly validate: (scope: UiOutputScope, proposal: UiOutputProposal) => Effect.Effect<void, UiOutputError>
}>() {}

/** A transaction must check ownership/fence, deduplicate operationId, persist
 * the immutable revision AND its journal/outbox event before returning.
 * Reusing an operationId with different content must fail with conflict.
 * Streaming hosts tail this journal; they never send speculative proposals. */
export class UiOutputJournal extends Context.Tag("efferent/ui/OutputJournal")<UiOutputJournal, {
  readonly commit: (scope: UiOutputScope, proposal: UiOutputProposal) => Effect.Effect<UiOutputReceipt, UiOutputError>
}>() {}

export class UiOutputContext extends Context.Tag("efferent/ui/OutputContext")<UiOutputContext, UiOutputScope>() {}

export class UiOutput extends Context.Tag("efferent/ui/Output")<UiOutput, {
  readonly emit: (proposal: UiOutputProposal) => Effect.Effect<UiOutputReceipt, UiOutputError>
}>() {}

/** Separate from AgentTools so a UI plugin composes with domain tool plugins. */
export class UiOutputTools extends Context.Tag("efferent/ui/OutputTools")<UiOutputTools, {
  readonly toolkit: typeof uiOutputToolkit
}>() {}
