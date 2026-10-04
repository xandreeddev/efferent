import { Context } from "effect"
import type { Effect } from "effect"
import type { HarnessError } from "@xandreed/core"
import type { EditProposal, EditReceipt, VerificationCheck, WorkOrder } from "./edit.entity.js"

export class SmithFiles extends Context.Service<SmithFiles, {
  readonly read: (path: string) => Effect.Effect<string, HarnessError>
  readonly list: (path: string) => Effect.Effect<ReadonlyArray<string>, HarnessError>
  readonly glob: (pattern: string) => Effect.Effect<ReadonlyArray<string>, HarnessError>
  readonly grep: (pattern: string) => Effect.Effect<string, HarnessError>
}>()("smith/Files") {}
export class SmithEditor extends Context.Service<SmithEditor, {
  readonly write: (path: string, content: string) => Effect.Effect<void, HarnessError>
  readonly edit: (path: string, oldText: string, newText: string) => Effect.Effect<void, HarnessError>
  readonly remove: (path: string) => Effect.Effect<void, HarnessError>
  readonly submit: (summary: string) => Effect.Effect<EditProposal, HarnessError>
}>()("smith/Editor") {}
export class SmithEditing extends Context.Service<SmithEditing, {
  readonly delegate: (input: { readonly objective: string; readonly paths: ReadonlyArray<string> }) => Effect.Effect<EditProposal, HarnessError>
  readonly apply: (proposalId: string) => Effect.Effect<EditReceipt, HarnessError>
  readonly verify: (command: string) => Effect.Effect<VerificationCheck, HarnessError>
}>()("smith/Editing") {}
export interface EditOverlay {
  readonly files: SmithFiles["Service"]
  readonly editor: SmithEditor["Service"]
  readonly proposal: Effect.Effect<import("effect").Option.Option<EditProposal>>
  readonly workOrder: WorkOrder
}
