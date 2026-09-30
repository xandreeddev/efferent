import { Effect, Layer, Schema } from "effect"
import { definePlugin, SessionEnvironment, SessionLog, SessionStore, TurnAdmission, TurnAdmissionOpen } from "@xandreed/core"
import { SessionStoreProjectionLive } from "./compatibility.adapter.js"
import { SessionLogSqliteLive } from "./session-log.adapter.js"

const Config = Schema.Struct({ path: Schema.String, legacyPaths: Schema.Array(Schema.String) })

/** @deprecated The historical store API is a projection over the unified log. */
export const SessionStoreLive = (path: string, options: { readonly legacyPaths?: ReadonlyArray<string>; readonly legacyOwner?: string } = {}) => Layer.mergeAll(
  SessionStoreProjectionLive.pipe(Layer.provideMerge(SessionLogSqliteLive(path, options))), TurnAdmissionOpen,
)

/** Storage and the open admission policy; compose sessionsPlugin explicitly in the host graph. */
export const sessionSqlitePlugin = definePlugin({
  id: "@xandreed/plugin-session-sqlite", version: "0.8.0-next.0", scope: "runtime",
  config: Config, defaults: { path: ".efferent/runtime/sessions.db", legacyPaths: [] }, requires: [SessionEnvironment], provides: [SessionLog, SessionStore, TurnAdmission],
  layer: ({ path, legacyPaths }) => Layer.unwrap(SessionEnvironment.pipe(Effect.map(({ workspace }) => SessionStoreLive(path, { legacyPaths, legacyOwner: workspace })))),
})
export default sessionSqlitePlugin

export { ConversationStoreProjectionLive, SqliteConversationStoreLive } from "./store/sqliteStore.js"
export { SessionStoreProjectionLive } from "./compatibility.adapter.js"
export { SessionLogSqliteLive, sessionLogSqlitePlugin } from "./session-log.adapter.js"
