import { homedir } from "node:os"
import { Effect, Option } from "effect"
import { BunRuntime } from "@effect/platform-bun"
import { ConversationId } from "@xandreed/core"
import { domainSession, Harness } from "@xandreed/sdk"
import { loadConfig, loadPlugins } from "@xandreed/runtime"
import { UiHost, UiPageStore } from "@xandreed/ui-agent"
import type { UiAgentEvent } from "@xandreed/ui-agent"
import { canvasAgent } from "./agent.js"
import { serveCanvas } from "./web/server.js"

const argValue = (flag: string) => Option.fromNullable(process.argv[process.argv.indexOf(flag) + 1]).pipe(Option.filter(() => process.argv.includes(flag)))
const cwd = process.cwd()
const program = Effect.gen(function* () {
  const preset = canvasAgent(cwd)
  const loaded = yield* loadConfig({ workspace: cwd, home: homedir(), preset: preset.config })
  const plugins = yield* loadPlugins(loaded.config, [...preset.plugins, ...loaded.plugins], cwd, homedir())
  const harness = yield* Harness.make({ workspace: cwd, config: loaded.config, plugins })
  const session = yield* Option.match(argValue("--resume"), { onNone: () => harness.create(), onSome: (id) => harness.resume(ConversationId.make(id)) })
  const view = domainSession<UiAgentEvent>(session, (value) => typeof value === "object" && value !== null && "type" in value ? Option.some(value as UiAgentEvent) : Option.none(), (message) => ({ type: "error", message }))
  const initialEvents = yield* session.use(UiPageStore, (store) => store.list(session.record.id))
  const port = Option.match(argValue("--port"), { onNone: () => 4655, onSome: Number })
  const pageStore = yield* session.use(UiPageStore, Effect.succeed)
  const host = yield* session.use(UiHost, Effect.succeed)
  const { url } = yield* serveCanvas({ session: view, port, initialEvents }).pipe(Effect.provideService(UiPageStore, pageStore), Effect.provideService(UiHost, host))
  console.log(`canvas: ${url} (session ${session.record.id})`)
  if (process.argv.includes("--open")) yield* Effect.sync(() => { Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" }) })
  yield* Effect.never
})
BunRuntime.runMain(Effect.scoped(program))
