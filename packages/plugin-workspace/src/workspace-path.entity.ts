import { Schema } from "effect"

/** Whether the file tools may only read a root, or may also change it. */
export const WorkspaceAccessMode = Schema.Literals(["read", "write"])
export type WorkspaceAccessMode = typeof WorkspaceAccessMode.Type

/** An extra file-tool root, absolute or relative to the session's workspace. */
export const WorkspaceAllowedRoot = Schema.Struct({ path: Schema.NonEmptyString, access: WorkspaceAccessMode })
export type WorkspaceAllowedRoot = typeof WorkspaceAllowedRoot.Type

/** An allowed root, resolved on the same file system as the workspace. */
export const AllowedRoot = Schema.Struct({ root: Schema.String, lexicalRoot: Schema.String, access: WorkspaceAccessMode })
export type AllowedRoot = typeof AllowedRoot.Type

/**
 * A path a tool was given, resolved in the workspace: `path` is where the
 * tool acts (absolute, every link on the way resolved, through the nearest
 * ancestor that exists), `display` is how the model wrote it, relative to
 * the workspace root (`.` for the root; absolute when outside it).
 */
export const WorkspaceTarget = Schema.Struct({
  path: Schema.String,
  display: Schema.String,
})
export type WorkspaceTarget = typeof WorkspaceTarget.Type

/**
 * The workspace a call works in: its root as configured, made absolute
 * (`lexicalRoot`), and as the file system resolves it (`root`, links
 * resolved). Paths are resolved against `root`.
 */
export const WorkspaceRoot = Schema.Struct({
  root: Schema.String,
  lexicalRoot: Schema.String,
  roots: Schema.Array(AllowedRoot),
})
export type WorkspaceRoot = typeof WorkspaceRoot.Type
