// Lesson 16's workspace.ts: the app's permission layer, a function of the
// page's workspace. As it starts it is a sandbox: it gives the agent the
// page's files as they are, and nothing is asked. The experiments wrap them
// (a folder whose writes are declined, writes answered late). The page runs
// the editable text as JavaScript; program.test.ts compiles and runs it.

/** Read-only: what the file imports. The starter uses none of the four: the experiments that wrap the files do. */
export const WORKSPACE_IMPORTS = `import { Effect, Layer } from "effect"
import { Files, FilesRefused } from "@xandreed/sdk/kernel"`

/** Everything before the editable part. */
export const WORKSPACE_HEADER = `${WORKSPACE_IMPORTS}\n\n`

/** The line that declares the function: the one line its typed module gives a type. */
export const DECLARATION = "export const workspace = (files) =>"

/** The sandbox: the comment that says so, and the function that hands the files on as they are. */
export const SANDBOX = `// As it starts, it is a sandbox: the agent may read and change any file, and nothing is asked.
${DECLARATION} files`

/** What the learner edits: the app's permission layer. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_WORKSPACE = `// The app decides here who may change a file: the file tools ask no one. \`files\` is the
// page's workspace, which the page gives: the same files whatever you build, until a reload.
${SANDBOX}`

/** The whole file as the learner reads it. */
export const workspaceDocumentOf = (workspace: string): string => `${WORKSPACE_HEADER}${workspace}\n`

/** The same file as a module a test can compile: the page's files typed as the contract is. */
export const workspaceModuleOf = (workspace: string): string =>
  `${WORKSPACE_HEADER}${workspace.replace(DECLARATION, "export const workspace = (files: Layer.Layer<Files>) =>")}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const workspaceBodyOf = (workspace: string): string => workspace.replace(/^export /gm, "")
