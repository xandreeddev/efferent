import { Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/ai"
import { Capabilities, defineCapability, definePlugin, defineSkill, defineTool, Failure, FileSystem, SessionEnvironment, Shell } from "@xandreed/core"
import { bwrapArgs, LocalFileSystemLive, spawnBounded } from "@xandreed/plugin-tools-local"
import { EditProposal, EditReceipt, VerificationCheck } from "./edit.entity.js"
import { renderProposal } from "./edit.entity.functions.js"
import { SmithEditing, SmithEditor, SmithFiles } from "./editing.port.js"

const failed = (error: { readonly message: string }) => ({ error: "SmithToolFailure", message: error.message })
const Read = Tool.make("read_file", { description: "Read a workspace file; the editor sees its staged version.", parameters: Schema.Struct({ path: Schema.String }), success: Schema.Struct({ content: Schema.String, truncated: Schema.Boolean }), failure: Failure, failureMode: "return" })
const List = Tool.make("ls", { description: "List a workspace directory.", parameters: Schema.Struct({ path: Schema.String }), success: Schema.Array(Schema.String), failure: Failure, failureMode: "return" })
const Glob = Tool.make("glob", { description: "Find workspace files with a glob pattern, e.g. src/**/*.ts.", parameters: Schema.Struct({ pattern: Schema.String }), success: Schema.Array(Schema.String), failure: Failure, failureMode: "return" })
const Grep = Tool.make("grep", { description: "Search workspace text using a regular expression.", parameters: Schema.Struct({ pattern: Schema.String }), success: Schema.String, failure: Failure, failureMode: "return" })
const Delegate = Tool.make("delegate_edit", { description: "Ask the configured editor to stage a focused change. Give a concrete objective and exact files or directories it may change. Review the returned proposal before applying it.", parameters: Schema.Struct({ objective: Schema.NonEmptyString, paths: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)) }), success: EditProposal, failure: Failure, failureMode: "return" })
const Apply = Tool.make("apply_edit_proposal", { description: "Apply a reviewed editor proposal. Stale files are refused; delegate a fresh correction if the workspace changed.", parameters: Schema.Struct({ proposalId: Schema.String }), success: EditReceipt, failure: Failure, failureMode: "return" })
const Verify = Tool.make("verify", { description: "Run a verification command with the workspace read-only and network disabled. A nonzero exit is evidence, not success. Source changes must go through the editor.", parameters: Schema.Struct({ command: Schema.NonEmptyString }), success: VerificationCheck, failure: Failure, failureMode: "return" })
const Write = Tool.make("write_file", { description: "Stage a complete file body in the work order; the real workspace is unchanged.", parameters: Schema.Struct({ path: Schema.String, content: Schema.String }), success: Schema.Boolean, failure: Failure, failureMode: "return" })
const Edit = Tool.make("edit_file", { description: "Stage an exact replacement; oldText must match exactly once.", parameters: Schema.Struct({ path: Schema.String, oldText: Schema.String, newText: Schema.String }), success: Schema.Boolean, failure: Failure, failureMode: "return" })
const Delete = Tool.make("delete_file", { description: "Stage deletion of a file within the work order.", parameters: Schema.Struct({ path: Schema.String }), success: Schema.Boolean, failure: Failure, failureMode: "return" })
const Submit = Tool.make("submit_edits", { description: "Finish the work order and submit the staged changes with a short summary.", parameters: Schema.Struct({ summary: Schema.String }), success: Schema.Struct({ proposalId: Schema.String, paths: Schema.Array(Schema.String) }), failure: Failure, failureMode: "return" })
const readTools = [
  defineTool({ tool: Read, handler: ({ path }) => SmithFiles.pipe(Effect.flatMap((files) => files.read(path)), Effect.map((content) => ({ content: content.slice(0, 25_000), truncated: content.length > 25_000 })), Effect.mapError(failed)), annotations: { readOnly: true } }),
  defineTool({ tool: List, handler: ({ path }) => SmithFiles.pipe(Effect.flatMap((files) => files.list(path)), Effect.mapError(failed)), annotations: { readOnly: true } }),
  defineTool({ tool: Glob, handler: ({ pattern }) => SmithFiles.pipe(Effect.flatMap((files) => files.glob(pattern)), Effect.mapError(failed)), annotations: { readOnly: true } }),
  defineTool({ tool: Grep, handler: ({ pattern }) => SmithFiles.pipe(Effect.flatMap((files) => files.grep(pattern)), Effect.mapError(failed)), annotations: { readOnly: true } }),
]
export const smithCodingCapability = defineCapability({
  id: "smith.coding", version: "1.0.0",
  tools: [...readTools,
    defineTool({ tool: Delegate, handler: (input) => SmithEditing.pipe(Effect.flatMap((editing) => editing.delegate(input)), Effect.mapError(failed)), annotations: { permissions: ["smith.controller"], stage: Option.some("editing") }, view: { version: "1", render: renderProposal, compact: (proposal) => `${proposal.id}: ${proposal.summary}\n${proposal.changes.map((change) => change.path).join("\n")}` } }),
    defineTool({ tool: Apply, handler: ({ proposalId }) => SmithEditing.pipe(Effect.flatMap((editing) => editing.apply(proposalId)), Effect.mapError(failed)), annotations: { permissions: ["smith.controller"], stage: Option.some("applying") } }),
    defineTool({ tool: Verify, handler: ({ command }) => SmithEditing.pipe(Effect.flatMap((editing) => editing.verify(command)), Effect.mapError(failed)), annotations: { permissions: ["smith.verify"], stage: Option.some("verifying") } }),
    defineTool({ tool: Write, handler: ({ path, content }) => SmithEditor.pipe(Effect.flatMap((editor) => editor.write(path, content)), Effect.as(true), Effect.mapError(failed)), annotations: { permissions: ["smith.editor"] } }),
    defineTool({ tool: Edit, handler: ({ path, oldText, newText }) => SmithEditor.pipe(Effect.flatMap((editor) => editor.edit(path, oldText, newText)), Effect.as(true), Effect.mapError(failed)), annotations: { permissions: ["smith.editor"] } }),
    defineTool({ tool: Delete, handler: ({ path }) => SmithEditor.pipe(Effect.flatMap((editor) => editor.remove(path)), Effect.as(true), Effect.mapError(failed)), annotations: { permissions: ["smith.editor"] } }),
    defineTool({ tool: Submit, handler: ({ summary }) => SmithEditor.pipe(Effect.flatMap((editor) => editor.submit(summary)), Effect.map((proposal) => ({ proposalId: proposal.id, paths: proposal.changes.map((change) => change.path) })), Effect.mapError(failed)), annotations: { permissions: ["smith.editor"] } }),
  ],
  skills: [
    defineSkill({ id: "smith.read", summary: "Inspect a coding workspace.", tools: readTools.map((entry) => entry.tool.name) }),
    defineSkill({ id: "smith.controller", summary: "Delegate edits and apply reviewed proposals.", tools: [Delegate.name, Apply.name], permissions: ["smith.controller"] }),
    defineSkill({ id: "smith.verify", summary: "Verify workspace changes.", tools: [Verify.name], permissions: ["smith.verify"] }),
    defineSkill({ id: "smith.editor", summary: "Stage changes for a controller to review.", tools: [Write.name, Edit.name, Delete.name, Submit.name], permissions: ["smith.editor"] }),
  ],
})

/** The tools capability and IO are independent of the replaceable coding policy. */
export const smithCapabilitiesPlugin = definePlugin({
  id: "@xandreed/smith/capabilities", version: "1.0.0", scope: "runtime",
  config: Schema.Record(Schema.String, Schema.Never).annotate({ description: "No capability options. Configure readOnly on the Smith coding loop." }), defaults: {},
  requires: [SessionEnvironment], provides: [FileSystem, Shell], contributes: [Capabilities],
  layer: () => Layer.unwrap(SessionEnvironment.pipe(Effect.map(({ workspace }) => Layer.mergeAll(
    LocalFileSystemLive,
    Layer.succeed(Shell, { exec: (command, options) => spawnBounded(bwrapArgs(workspace, workspace, command, [workspace], false), undefined, options?.timeoutMs ?? 120_000, options?.onChunk) }),
    Layer.succeed(Capabilities, [smithCodingCapability]),
  )))),
})
