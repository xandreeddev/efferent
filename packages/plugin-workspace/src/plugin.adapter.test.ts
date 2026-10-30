import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Option } from "effect"
import { Bash, FileSystem, PluginInstanceId } from "@xandreed/core"
import { activateGraph, resolveGraph } from "@xandreed/runtime"
import { localSystemPlugin, LocalSystemPluginLive } from "./plugin.adapter.js"

const temporary = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "efferent-local-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
)

describe("localSystemPlugin", () => {
  test("activates at runtime scope and provides FileSystem and Bash over the same disk", async () => {
    const seen = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const graph = yield* resolveGraph({ version: 1, plugins: [{ id: PluginInstanceId.make("local"), use: localSystemPlugin.id, options: { exitGraceMs: 200 } }] }, [localSystemPlugin])
      const context = yield* activateGraph(graph, "runtime", Context.empty(), yield* Effect.scope)
      const root = yield* temporary
      const result = yield* Option.getOrThrow(Context.getOption(context, Bash)).exec("printf from-bash > made.txt; printf done", { cwd: root })
      const read = yield* Option.getOrThrow(Context.getOption(context, FileSystem)).read(join(root, "made.txt"))
      return { stdout: result.stdout, read }
    })))
    expect(seen).toEqual({ stdout: "done", read: "from-bash" })
  })

  test("is a typed layer too, and refuses unknown or out-of-range options and a shell that is not installed", async () => {
    const listed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const context = yield* Layer.build(LocalSystemPluginLive({ killBackground: false }))
      const root = yield* temporary
      return yield* Context.get(context, FileSystem).list(root)
    })))
    expect(listed).toEqual([])
    const refused = await Promise.all([
      { shell: "bash", extra: true },
      { exitGraceMs: -1 },
      { shell: "" },
    ].map((options) => Effect.runPromise(Effect.flip(resolveGraph({ version: 1, plugins: [{ id: PluginInstanceId.make("local"), use: localSystemPlugin.id, options }] }, [localSystemPlugin]))).then((error) => error.code)))
    expect(refused).toEqual(["config.options", "config.options", "config.options"])
    const missing = await Effect.runPromise(Effect.flip(Effect.scoped(Effect.gen(function* () {
      const graph = yield* resolveGraph({ version: 1, plugins: [{ id: PluginInstanceId.make("local"), use: localSystemPlugin.id, options: { shell: "efferent-no-such-shell" } }] }, [localSystemPlugin])
      return yield* activateGraph(graph, "runtime", Context.empty(), yield* Effect.scope)
    }))))
    expect([missing.code, missing.message.includes("no executable efferent-no-such-shell")]).toEqual(["plugin.activation", true])
  })
})
