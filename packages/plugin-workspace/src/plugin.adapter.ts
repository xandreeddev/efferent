import { Effect, Layer } from "effect"
import { Bash, Capabilities, definePlugin, FileSystem, SessionEnvironment } from "@xandreed/core"
import { BashLive } from "./bash.adapter.js"
import { FileSystemLive } from "./file-system.adapter.js"
import { LocalSystemConfig, localSystemDefaults } from "./local-system.entity.js"
import { workspaceTools } from "./workspace-tools.adapter.js"
import { WorkspaceToolsConfig, workspaceToolsDefaults } from "./workspace-tools.entity.js"

/**
 * The machine the agent runs on as its `FileSystem` and `Bash`: the local
 * disk (`FileSystemLive`) and commands run with the configured shell
 * (`BashLive`), built once per agent. Activation fails when the shell is not
 * installed. Commands inherit the host process's environment through
 * `resolveBashEnv`'s allowlist.
 */
export const localSystemPlugin = definePlugin({
  id: "@xandreed/plugin-workspace/local", version: "0.13.0", scope: "runtime",
  config: LocalSystemConfig, defaults: localSystemDefaults,
  provides: [FileSystem, Bash],
  layer: (config) => Layer.merge(FileSystemLive, BashLive(config)),
})
/** The local system as a typed layer: provides FileSystem and Bash; requires nothing. */
export const LocalSystemPluginLive = localSystemPlugin.live

/**
 * The workspace tools (`workspaceTools`): read, ls, find and grep always on,
 * write and edit behind `fs.write`, bash behind `shell.exec`, over the
 * `FileSystem`, `Bash` and `SessionEnvironment` of each call. Built once
 * per agent, so two sessions editing one file wait for each other. `Bash`
 * is optional: without it there is no `bash` tool. Hosts grant the
 * permissions through tool discovery's `grants` or a turn's
 * `PermissionGrants`.
 */
export const workspaceToolsPlugin = definePlugin({
  id: "@xandreed/plugin-workspace/tools", version: "0.13.0", scope: "runtime",
  config: WorkspaceToolsConfig, defaults: workspaceToolsDefaults,
  requires: [FileSystem, SessionEnvironment],
  optional: [Bash],
  provides: [],
  contributes: [Capabilities],
  layer: (config) => Layer.effect(Capabilities, workspaceTools(config).pipe(Effect.map((capability) => [capability]))),
})
/** The workspace tools as a typed layer: contributes their capability; its handlers need FileSystem and SessionEnvironment (and Bash for bash) where the tools are opened. */
export const WorkspaceToolsPluginLive = workspaceToolsPlugin.live
