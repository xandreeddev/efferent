import { Schema } from "effect"

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
})
export type WorkspaceRoot = typeof WorkspaceRoot.Type
