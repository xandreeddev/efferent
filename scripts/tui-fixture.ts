import { Effect, Layer, Schema } from "effect"
import { AgentLoop, definePlugin, Harness } from "@xandreed/sdk"
import sessions from "@xandreed/plugin-session-sqlite"
import { runTui } from "@xandreed/tui"
import { makeApprovalChannel } from "@xandreed/tui/approval"
const echo = definePlugin({ id: "fixture/echo", version: "1", config: Schema.Struct({}), defaults: {}, provides: [AgentLoop], layer: () => Layer.succeed(AgentLoop, { run: (input) => Effect.succeed({ text: `Received: ${input.prompt}`, outcome: "completed" }) }) })
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const workspace = process.argv[2]!
  const harness = yield* Harness.make({ workspace, plugins: [sessions, echo], config: { version: 1, plugins: [{ id: "store", use: sessions.id, options: { path: `${workspace}/sessions.db` } }, { id: "loop", use: echo.id }] } })
  const session = yield* harness.create()
  const approvals = yield* makeApprovalChannel
  yield* runTui({ harness, session, approvals })
})))
