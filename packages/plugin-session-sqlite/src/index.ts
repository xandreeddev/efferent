import { Layer, Schema } from "effect"
import { definePlugin, SessionLog, TurnAdmission, TurnAdmissionOpen } from "@xandreed/core"
import { SessionLogSqliteLive } from "./session-log.adapter.js"

const Config = Schema.Struct({ path: Schema.String })

/** Storage and the open admission policy; compose sessionsPlugin explicitly in the host graph. */
export const sessionSqlitePlugin = definePlugin({
  id: "@xandreed/plugin-session-sqlite", version: "0.13.0", scope: "runtime",
  config: Config, defaults: { path: ".efferent/runtime/sessions.db" }, provides: [SessionLog, TurnAdmission],
  layer: ({ path }) => Layer.merge(SessionLogSqliteLive(path), TurnAdmissionOpen),
})
export default sessionSqlitePlugin

export { SessionLogSqliteLive, sessionLogSqlitePlugin } from "./session-log.adapter.js"
