import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { ConversationStore, ConversationId } from "@xandreed/engine"
import {
  LanguageModelLive,
  LocalAuthStoreLive,
  LocalSettingsStoreLive,
  SqliteConversationStoreLive,
  TracingLive,
} from "@xandreed/providers"
import { makeCanvasSession } from "./session.js"
import { serveCanvas } from "./web/server.js"

/**
 * The composition root: providers at the edge, one session, one server.
 * `bun run canvas [--port <n>] [--resume <conversationId>] [--open]`
 * Model comes from .efferent/config.json (the standing rule: EFFERENT_MODEL
 * is not read; the settings file owns selection).
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
  const { url } = yield* serveCanvas({ session, port })
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
    Effect.provide(LanguageModelLive),
    Effect.provide(layers),
    Effect.provide(TracingLive("canvas")),
  ) as Effect.Effect<void>,
)
