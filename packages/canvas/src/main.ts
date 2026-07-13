import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { ConversationStore, ConversationId } from "@xandreed/engine"
import { UiPageStore } from "@xandreed/ui-agent"
import {
  LocalAuthStoreLive,
  LocalSettingsStoreLive,
  SqliteConversationStoreLive,
  TracingLive,
} from "@xandreed/providers"
import { makeCanvasSession } from "./session.js"
import { serveCanvas } from "./web/server.js"
import { DefaultUiHostLive } from "./adapters/default-ui-host.adapter.js"
import { SqliteUiPageStoreLive } from "./adapters/sqlite-ui-page-store.adapter.js"
import { SqliteUiComponentCatalogLive } from "./adapters/sqlite-ui-component-catalog.adapter.js"
import { SqliteUiThemeStoreLive } from "./adapters/sqlite-ui-theme-store.adapter.js"
import { UiAgentRuntimeLive } from "./adapters/ui-agent-runtime.adapter.js"

/**
 * The composition root: providers at the edge, one session, one server.
 * `bun run canvas [--port <n>] [--resume <conversationId>] [--open]`
 * Planner/composer/repair models come only from UI-agent's streaming-ui-v1 profile. Global
 * model roles and environment variables cannot silently change this evalled
 * execution profile.
 */

const argValue = (flag: string): Option.Option<string> => {
  const at = process.argv.indexOf(flag)
  const value = at >= 0 ? process.argv[at + 1] : undefined
  return value !== undefined && !value.startsWith("--")
    ? Option.some(value)
    : Option.none()
}

const cwd = process.cwd()
const port = Option.match(argValue("--port"), {
  onNone: () => 4655,
  onSome: (raw) => Number.parseInt(raw, 10),
})

const layers = Layer.mergeAll(
  SqliteConversationStoreLive(join(cwd, ".efferent", "canvas.db")),
  SqliteUiPageStoreLive(join(cwd, ".efferent", "canvas.db")),
  SqliteUiComponentCatalogLive(join(cwd, ".efferent", "canvas.db")),
  SqliteUiThemeStoreLive(join(cwd, ".efferent", "canvas.db")),
  DefaultUiHostLive,
  LocalAuthStoreLive(cwd, homedir()),
  LocalSettingsStoreLive(cwd, homedir()),
)

const program = Effect.gen(function* () {
  const store = yield* ConversationStore
  const conversationId = yield* Option.match(argValue("--resume"), {
    onNone: () => store.create(cwd),
    onSome: (id) => Effect.succeed(ConversationId.make(id)),
  })
  const session = yield* makeCanvasSession({ conversationId })
  const pageStore = yield* UiPageStore
  const initialEvents = yield* pageStore.list(conversationId).pipe(Effect.orDie)
  const { url } = yield* serveCanvas({ session, port, initialEvents })
  yield* Effect.sync(() => {
    console.log(`canvas: ${url}  (conversation ${conversationId})`)
  })
  yield* process.argv.includes("--open")
    ? Effect.sync(() => void Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" }))
    : Effect.void
  yield* Effect.never
})

await Effect.runPromise(
  program.pipe(
    Effect.provide(UiAgentRuntimeLive),
    Effect.provide(layers),
    Effect.provide(TracingLive("canvas")),
  ) as Effect.Effect<void>,
)
