import { definePlugin, SessionLog, Sessions, TurnActivity, TurnAdmission } from "@xandreed/core"
import { SessionsConfig, sessionsDefaults } from "./sessions-state.entity.js"
import { SessionsLive } from "./sessions.adapter.js"

/**
 * Sessions over the host's SessionLog: one event log per session, one open
 * turn at a time, leases by lease or by process, the inbox and forks. The
 * host admits every turn (TurnAdmissionOpen admits all). It also provides
 * `TurnActivity`, the turns this process holds open or is beginning
 * (`processActivity`, `awaitIdle`). By default a turn's lease is 60 s, renewed by its writes and
 * by a keep-alive every 20 s.
 */
export const sessionsPlugin = definePlugin({
  id: "@xandreed/plugin-sessions", version: "0.13.0", scope: "runtime",
  config: SessionsConfig, defaults: sessionsDefaults,
  requires: [SessionLog, TurnAdmission],
  provides: [Sessions, TurnActivity],
  layer: SessionsLive,
})
/** Sessions as a typed layer: provides Sessions and TurnActivity; requires SessionLog and TurnAdmission. */
export const SessionsPluginLive = sessionsPlugin.live
export default sessionsPlugin
