// The one source of truth for lesson 3's plugin.ts: two plugins of the
// learner's own, an event plugin and a wrapper of memory (ADR 0005). The page
// shows the imports (read-only) above the code the learner edits, and runs
// that code as written; program.test.ts compiles and runs this exact text.

/** Read-only: what the plugins import. */
export const PLUGIN_IMPORTS = `import { Clock, Effect, Layer, Ref } from "effect"
import { assistantMessageEvent, Core, turnEndedEvent, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import { estimateTokens, hostNote, Memory, messageText } from "@xandreed/sdk/kernel"
import { Chat } from "./chat.ts"`

/** Everything before the editable part. */
export const PLUGIN_HEADER = `${PLUGIN_IMPORTS}\n\n`

/** What the learner edits: the two plugins. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_PLUGIN = `// An event plugin. On boot it hooks three events, as a Neovim autocmd does.
// It stores nothing and says nothing to the model: it counts what each answer cost, and shows it.
export const meter = Layer.effectDiscard(
  Effect.gen(function* () {
    const core = yield* Core
    const chat = yield* Chat
    const spent = yield* Ref.make({ turn: 0, total: 0 })

    // Each turn's start: name it on the status line while it runs.
    const named = (event) => chat.status(\`turn \${event.data.turn}\`)
    yield* core.on(turnStartedEvent, named, { name: "meter" })

    // Each answer stored: what the provider says it cost, else an estimate of its text.
    // wait: true: the turn waits for it, so the count is in before the turn ends.
    // Its failure would fail the turn.
    yield* core.on(
      assistantMessageEvent,
      (event) => {
        const said = event.message ? messageText(event.message) : ""
        const tokens = event.data.usage?.outputTokens ?? estimateTokens(said)
        return Ref.update(spent, (n) => ({ turn: n.turn + tokens, total: n.total + tokens }))
      },
      { name: "meter", wait: true },
    )

    // Each turn's end: show what it cost on the status line, and start the next count at zero.
    yield* core.on(
      turnEndedEvent,
      (event) =>
        Effect.flatMap(
          Ref.getAndUpdate(spent, (n) => ({ ...n, turn: 0 })),
          (n) => chat.status(\`turn \${event.data.turn}: ~\${n.turn} tok, ~\${n.total} in all\`),
        ),
      { name: "meter" },
    )
  }),
)

// A wrapper of memory: given the memory it wraps, it returns a memory.
// It asks the one below for the context, then adds a note after it, for this request only.
export const withClock = (inner) =>
  Layer.effect(
    Memory,
    Effect.gen(function* () {
      const memory = yield* Memory // the memory it wraps
      return Memory.of({
        context: (session) =>
          Effect.gen(function* () {
            const context = yield* memory.context(session)
            // Computed here, like the system text, and never stored: the next request gets its own.
            const now = new Date(yield* Clock.currentTimeMillis)
            const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            return [...context, { role: "user", content: hostNote(\`it is \${time}.\`) }]
          }),
      })
    }),
  ).pipe(Layer.provide(inner))`

/** The whole file as the learner reads it. */
export const pluginDocumentOf = (plugin: string): string => `${PLUGIN_HEADER}${plugin}\n`

/** The same file as a module a test can compile: what the page leaves untyped is typed. */
export const pluginModuleOf = (plugin: string): string => `${PLUGIN_HEADER}${plugin
  .replace("export const withClock = (inner) =>", "export const withClock = <E, R>(inner: Layer.Layer<Memory, E, R>): Layer.Layer<Memory, E, R> =>")
  .replace('{ role: "user", content:', '{ role: "user" as const, content:')
  .replace("const named = (event) =>", "const named = (event: { readonly data: { readonly turn: number } }) =>")}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const pluginBodyOf = (plugin: string): string => plugin.replace(/^export /gm, "")
