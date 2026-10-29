import { Layer } from "effect"
import { Bash, definePlugin, FileSystem } from "@xandreed/core"
import { BashLive } from "./bash.adapter.js"
import { FileSystemLive } from "./file-system.adapter.js"
import { LocalSystemConfig, localSystemDefaults } from "./local-system.entity.js"

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
