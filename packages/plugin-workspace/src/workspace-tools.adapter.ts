import { Effect, Option, Path, RcMap, Result, Semaphore } from "effect"
import type { Scope } from "effect"
import { Bash, compileGlob, defineCapability, definePromptSection, defineSkill, HarnessError, SessionEnvironment } from "@xandreed/core"
import type { Capability, RegisteredTool } from "@xandreed/core"
import { bashTool } from "./bash-tool.adapter.js"
import { findTool, grepTool, lsTool, readTool, WORKSPACE_SERVICES } from "./read-tools.adapter.js"
import type { WorkspaceToolContext } from "./read-tools.adapter.js"
import { compileProtect, openWorkspace } from "./workspace-path.entity.functions.js"
import { WORKSPACE_PERMISSIONS } from "./workspace-tools.entity.js"
import type { WorkspaceSkillName, WorkspaceToolName, WorkspaceToolsConfig } from "./workspace-tools.entity.js"
import { environmentText, skillOfTool } from "./workspace-tools.entity.functions.js"
import { editTool, writeTool } from "./write-tools.adapter.js"

/** The tools in the order they are registered (and listed in their skills). */
const ORDER: ReadonlyArray<WorkspaceToolName> = ["read", "ls", "find", "grep", "write", "edit", "bash"]

const builders: Readonly<Record<WorkspaceToolName, (context: WorkspaceToolContext) => RegisteredTool>> = {
  read: readTool, ls: lsTool, find: findTool, grep: grepTool, write: writeTool, edit: editTool, bash: bashTool,
}

const skills: Readonly<Record<WorkspaceSkillName, { readonly id: string; readonly summary: string; readonly permissions: ReadonlyArray<string> }>> = {
  read: { id: "workspace.read", summary: "Read, list and search the workspace's files (read, ls, find, grep).", permissions: [] },
  edit: { id: "workspace.edit", summary: "Create and change files in the workspace (write, edit).", permissions: [WORKSPACE_PERMISSIONS.write] },
  shell: { id: "workspace.shell", summary: "Run shell commands in the workspace (bash).", permissions: [WORKSPACE_PERMISSIONS.exec] },
}

const invalid = (message: string) => new HarnessError({ code: "config.options", plugin: "@xandreed/plugin-workspace/tools", message })

/**
 * The workspace tools as one capability, for the workspace in each call's
 * `SessionEnvironment`, over each call's `FileSystem` and `Bash`: `read`,
 * `ls`, `find` and `grep` (skill `workspace.read`, read-only), `write` and
 * `edit` (`workspace.edit`, needing `fs.write`) and `bash`
 * (`workspace.shell`, needing `shell.exec`), plus the
 * `workspace.environment` prompt section, which reads the same services as
 * the tools, where the turn renders it. Built once (in a scope, which
 * holds the per-file write locks): `bash` and its skill are left out, with
 * a warning, when there is no `Bash` service here; `protect` and `exclude`
 * globs that do not compile fail with `config.options` (through the plugin,
 * `WorkspaceToolsConfig` refuses them already when its options are
 * decoded, so a graph refuses them before activating anything). Tools are never
 * given guidance as skill instructions: it is in their descriptions and the
 * section, since an always-on skill's instructions never reach the model.
 *
 * @public
 */
export const workspaceTools = Effect.fnUntraced(function* (config: WorkspaceToolsConfig): Effect.fn.Return<Capability, HarnessError, Scope.Scope> {
  const path = yield* Effect.service(Path.Path).pipe(Effect.provide(Path.layer))
  const protect = yield* Effect.fromResult(compileProtect(config.protect)).pipe(Effect.mapError(invalid))
  const badExclude = config.exclude.find((glob) => Result.isFailure(compileGlob(glob, { dot: true })))
  if (badExclude !== undefined) return yield* Effect.fail(invalid(`exclude glob ${badExclude} is not usable`))
  const locks = yield* RcMap.make({ lookup: (_path: string) => Semaphore.make(1), idleTimeToLive: "1 minute" })
  const hasBash = Option.isSome(yield* Effect.serviceOption(Bash))
  const wanted = ORDER.filter((tool) => config.tools.includes(tool))
  if (wanted.includes("bash") && !hasBash) {
    yield* Effect.logWarning("@xandreed/plugin-workspace/tools: there is no Bash service, so the bash tool and the workspace.shell skill are left out (add localSystemPlugin, or a Bash, to have them)")
  }
  const enabled = wanted.filter((tool) => tool !== "bash" || hasBash)
  const context: WorkspaceToolContext = { config, path, protect, locks }
  // The section reads the turn's workspace as the tools do, so it declares the same services.
  const section = definePromptSection({
    id: "workspace.environment", version: "2", tier: "session", order: config.sectionOrder,
    requires: WORKSPACE_SERVICES,
    render: () => openWorkspace(path).pipe(
      Effect.map((access) => access.root),
      Effect.catch(() => SessionEnvironment.pipe(Effect.map((environment) => path.resolve(environment.workspace)))),
      Effect.map((root) => Option.some(environmentText(root, config, enabled))),
    ),
  })
  return defineCapability({
    id: "@xandreed/plugin-workspace/tools",
    version: "1",
    tools: enabled.map((tool) => builders[tool](context)),
    skills: (["read", "edit", "shell"] as const).flatMap((name) => {
      const tools = enabled.filter((tool) => skillOfTool[tool] === name)
      return tools.length === 0 ? [] : [defineSkill({ ...skills[name], tools, always: config.always.includes(name) })]
    }),
    promptSections: config.environmentSection && enabled.length > 0 ? [section] : [],
  })
})
