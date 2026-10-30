import { Layer } from "effect"
import { definePlugin, SessionLog, TurnAdmission, TurnAdmissionOpen } from "@xandreed/core"
import { SessionLogFilesLive } from "./session-log.adapter.js"
import { SessionFilesConfig, sessionFilesDefaults } from "./session-files.entity.js"

/**
 * The session log in a directory, as a plugin: provides `SessionLog`.
 *
 * @public
 */
export const sessionLogFilesPlugin = definePlugin({
  id: "@xandreed/plugin-session-files/log", version: "0.14.0", scope: "runtime",
  config: SessionFilesConfig, defaults: sessionFilesDefaults, provides: [SessionLog],
  layer: ({ path, stallMs }) => SessionLogFilesLive(path, { stallMs }),
})

/**
 * The session log in a directory and the open admission policy; compose
 * `sessionsPlugin` beside it in the host's graph.
 *
 * @public
 */
export const sessionFilesPlugin = definePlugin({
  id: "@xandreed/plugin-session-files", version: "0.14.0", scope: "runtime",
  config: SessionFilesConfig, defaults: sessionFilesDefaults, provides: [SessionLog, TurnAdmission],
  layer: ({ path, stallMs }) => Layer.merge(SessionLogFilesLive(path, { stallMs }), TurnAdmissionOpen),
})
