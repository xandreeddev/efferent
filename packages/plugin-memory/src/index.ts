import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, resolve, relative } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { definePlugin, HarnessError, Memory, MemoryEntry, SessionEnvironment } from "@xandreed/core"

const Config = Schema.Struct({ file: Schema.String, limit: Schema.Int.pipe(Schema.between(1, 100)) })
const Row = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("remember"), entry: MemoryEntry }),
  Schema.Struct({ kind: Schema.Literal("forget"), id: Schema.String }),
)

export const memoryPlugin = definePlugin({
  id: "@xandreed/plugin-memory", version: "0.2.0-next.0", requires: [SessionEnvironment], provides: [Memory],
  config: Config, defaults: { file: ".efferent/runtime/memory.jsonl", limit: 8 },
  layer: ({ file, limit }) => Layer.effect(Memory, Effect.gen(function* () {
    const { workspace } = yield* SessionEnvironment
    const path = resolve(workspace, file)
    if (relative(workspace, path).startsWith("..")) return yield* Effect.fail(new HarnessError({ code: "memory.path", message: "Memory file must be inside the workspace" }))
    const allowed = (requested: string) => requested === workspace ? Effect.void : Effect.fail(new HarnessError({ code: "memory.workspace", message: "Memory belongs to a different workspace" }))
    const gate = yield* Effect.makeSemaphore(1)
    const read = Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (error) => ({ error, missing: typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT" }),
    }).pipe(
      Effect.catchAll(({ error, missing }) => missing ? Effect.succeed("") : Effect.fail(new HarnessError({ code: "memory.read", message: String(error) }))),
      Effect.flatMap((text) => Effect.forEach(text.split("\n").filter(Boolean), (line) => Schema.decodeUnknown(Schema.parseJson(Row))(line))),
      Effect.map((rows) => rows.reduce((entries, row) => row.kind === "remember"
        ? [...entries.filter((entry) => entry.id !== row.entry.id), row.entry]
        : entries.filter((entry) => entry.id !== row.id), [] as ReadonlyArray<MemoryEntry>)),
      Effect.mapError((error) => new HarnessError({ code: "memory.read", message: String(error) })),
    )
    const append = (row: typeof Row.Type) => gate.withPermits(1)(Effect.tryPromise({
      try: async () => { await mkdir(dirname(path), { recursive: true }); await appendFile(path, `${JSON.stringify(row)}\n`, { mode: 0o600 }) },
      catch: (error) => new HarnessError({ code: "memory.write", message: String(error) }),
    }))
    return Memory.of({
      recall: (requested, query) => allowed(requested).pipe(Effect.zipRight(read),Effect.map((entries) => {
        const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 2)
        const score = (entry: MemoryEntry) => terms.filter((term) => entry.text.toLowerCase().includes(term)).length
        return entries.filter((entry) => entry.workspace === requested).sort((a, b) => score(b) - score(a) || b.createdAt - a.createdAt).slice(0, limit)
      })),
      remember: (requested, text) => {
        const entry: MemoryEntry = { id: crypto.randomUUID(), workspace: requested, text, createdAt: Date.now() }
        return text.trim().length === 0 ? Effect.fail(new HarnessError({ code: "memory.empty", message: "Memory cannot be empty" })) : allowed(requested).pipe(Effect.zipRight(append({ kind: "remember", entry })), Effect.as(entry))
      },
      forget: (requested, id) => allowed(requested).pipe(Effect.zipRight(append({ kind: "forget", id }))),
    })
  })),
})
export default memoryPlugin
